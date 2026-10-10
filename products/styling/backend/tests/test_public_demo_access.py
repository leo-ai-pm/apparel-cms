"""Explicit HTTPS demo behind loopback BFF, isolated synthetic SQLite only."""
import json
import hashlib
import uuid

import pytest
from fastapi.testclient import TestClient

from tests.test_demo_access import demo, business_counts
from app.main import app
from app.core import admin_auth
from app.core.consumer_identity import consumer_cookie_name

ORIGIN = 'https://public-demo.example'


@pytest.fixture
def public(demo):
    old, factory, patch = demo
    for key, value in {
        'STYLING_DEMO_ACCESS_MODE': 'public',
        'STYLING_PUBLIC_DEMO_SUBJECT': 'styling-public-20261010',
        'STYLING_PUBLIC_DEMO_SCOPE': 'public-three-agent-20261010',
        'STYLING_PUBLIC_DEMO_INSTANCE_ID': 'styling-public-20261010',
        'STYLING_ADMIN_SUBJECT': 'styling-public-20261010',
        'STYLING_ADMIN_SCOPE': 'public-three-agent-20261010',
        'STYLING_DIRECT_INSTANCE_ID': 'styling-public-20261010',
        'CONSUMER_APP_SCOPE': 'styling-public-20261010',
        'CONSUMER_ALLOWED_ORIGINS': ORIGIN,
        'STYLING_ADMIN_PUBLIC_ORIGIN': ORIGIN,
        'STYLING_ADMIN_COOKIE_SECURE': '1', 'CONSUMER_COOKIE_SECURE': '1',
    }.items():
        patch.setenv(key, value)
    client = TestClient(app, base_url=ORIGIN, client=('127.0.0.1', 45501))
    yield client, factory, patch
    client.close()


def enter(client, role='styling-manager', headers=None):
    return client.post('/api/v1/demo-access/enter', json={'role': role},
                       headers={'Origin': ORIGIN} if headers is None else headers)


def test_public_enter_fixed_identity_and_context_reuse(public):
    client, factory, _ = public
    before = business_counts(factory)
    cap = client.get('/api/v1/demo-access')
    assert cap.status_code == 200 and cap.json()['mode'] == 'public_demo'
    r = enter(client)
    assert r.status_code == 200
    cookie = r.headers['set-cookie'].lower()
    assert 'secure' in cookie and 'httponly' in cookie and 'samesite=strict' in cookie
    me = client.get('/api/v1/admin/me').json()
    assert (me['subject'], me['scope'], me['source_instance_id'], me['auth_method']) == (
        'styling-public-20261010', 'public-three-agent-20261010', 'styling-public-20261010', 'demo_server')
    assert enter(client).status_code == 200
    assert client.get('/api/v1/admin/me').json() == me
    assert client.get('/api/v1/admin/overview').status_code == 200
    assert business_counts(factory) == before


def test_consumer_cookie_secure_even_on_http_bff_and_headers_cannot_override(public):
    _, factory, patch = public
    http = TestClient(app, client=('127.0.0.1', 45502))
    r = enter(http, 'consumer', {'Origin': ORIGIN, 'Forwarded': 'proto=http;host=evil.example',
                               'X-Forwarded-Proto': 'http'})
    assert r.status_code == 200 and 'Secure' in r.headers['set-cookie']
    assert 'HttpOnly' in r.headers['set-cookie']
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '0')
    patch.setenv('CONSUMER_COOKIE_SECURE', '0')
    assert 'Secure' not in http.get('/api/v1/consumer-profile').headers['set-cookie']
    patch.delenv('CONSUMER_COOKIE_SECURE')
    assert 'Secure' not in http.get('/api/v1/consumer-profile', headers={'X-Forwarded-Proto': 'https'}).headers['set-cookie']
    http.close()


@pytest.mark.parametrize('headers', [{}, {'Origin': 'https://evil.example'},
    {'Origin': ORIGIN+'/'}, {'Origin': ORIGIN, 'Sec-Fetch-Site': 'cross-site'},
    {'Origin': ORIGIN, 'Authorization': 'Bearer forged'}])
def test_public_enter_rejects_missing_or_foreign_origin_and_bearer(public, headers):
    client, factory, _ = public
    assert enter(client, headers=headers).status_code == 403
    assert business_counts(factory)['demand_turns'] == 0


@pytest.mark.parametrize('key,value', [
    ('STYLING_DEMO_ACCESS_MODE', 'invalid'), ('STYLING_ADMIN_PUBLIC_ORIGIN', 'http://public-demo.example'),
    ('STYLING_ADMIN_PUBLIC_ORIGIN', ORIGIN+'/v2/styling'),
    ('STYLING_ADMIN_PUBLIC_ORIGIN', 'https://localhost'),
    ('STYLING_ADMIN_SCOPE', 'old-private-scope'), ('STYLING_ADMIN_SUBJECT', 'old-person'),
    ('CONSUMER_APP_SCOPE', 'old-consumer'), ('STYLING_DIRECT_INSTANCE_ID', 'old-source'),
    ('CONSUMER_ALLOWED_ORIGINS', ORIGIN+',https://evil.example'),
    ('STYLING_ADMIN_COOKIE_SECURE', '0'), ('CONSUMER_COOKIE_SECURE', '0'),
    ('STYLING_PUBLIC_DEMO_SCOPE', ''),
])
def test_public_invalid_configuration_fails_closed(public, key, value):
    client, _, patch = public
    patch.setenv(key, value)
    r = enter(client)
    assert r.status_code == 503 and r.json()['error']['code'] == 'DEMO_ACCESS_NOT_CONFIGURED'
    assert not r.headers.get('set-cookie')


def test_public_nonloopback_cannot_use_forwarded_headers_or_copied_cookie(public):
    client, _, _ = public
    assert enter(client).status_code == 200
    remote = TestClient(app, base_url=ORIGIN, client=('192.0.2.4', 45503))
    remote.cookies.set(admin_auth.COOKIE, client.cookies.get(admin_auth.COOKIE))
    spoof = {'Origin': ORIGIN, 'X-Forwarded-For': '127.0.0.1', 'Forwarded': 'for=127.0.0.1;proto=https'}
    assert enter(remote, headers=spoof).status_code == 403
    assert remote.get('/api/v1/admin/me', headers=spoof).status_code == 403
    assert remote.get('/api/v1/consumer-profile', headers=spoof).status_code == 403
    remote.close()


def test_public_consumer_mutation_requires_origin_and_preserves_scope(public):
    client, factory, _ = public
    before = business_counts(factory)
    assert enter(client, 'consumer').status_code == 200
    assert client.get('/api/v1/admin/me').status_code == 401
    profile = client.get('/api/v1/consumer-profile').json()
    body = {'profile_action_id': uuid.uuid4().hex, 'operation': 'save', 'expected_profile_version': 0,
        'expected_authorization_context': {k:profile['authorization_context'][k] for k in
            ('context_contract', 'context_id', 'operation_token')},
        'patch': {'base_profile': {'usual_sizes': {'shoes': {'system': 'cn_shoe', 'value': '38'}}}},
        'explicit_save': True}
    assert client.post('/api/v1/consumer-profile/mutations', json=body).status_code == 403
    assert client.post('/api/v1/consumer-profile/mutations', json=body, headers={'Origin':ORIGIN}).status_code == 200
    assert client.cookies.get(consumer_cookie_name())
    assert business_counts(factory) == before


def test_public_mode_change_retires_old_context_and_closing_flag_restores_login(public):
    client, _, patch = public
    assert enter(client).status_code == 200
    old = client.get('/api/v1/admin/me').json()
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '0')
    assert client.get('/api/v1/demo-access').json()['mode'] == 'authenticated'
    assert client.get('/api/v1/admin/me').status_code == 401
    assert client.post('/api/v1/admin/login', json={'password':'synthetic-password-only'},
                       headers={'Origin':ORIGIN}).status_code == 200
    assert client.get('/api/v1/admin/me').json()['auth_method'] == 'password_single_account'
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '1')
    assert enter(client).status_code == 200
    assert client.get('/api/v1/admin/me').json()['authorization_context'] != old['authorization_context']


def test_legacy_uncontrolled_generation_blocked_before_validation_or_transport(public):
    client, _, patch = public
    r = client.post('/api/v1/tryon', content=b'not even multipart')
    assert r.status_code == 403 and r.json()['error']['code'] == 'PUBLIC_DEMO_LEGACY_GENERATION_DISABLED'
    assert r.headers['cache-control'] == 'no-store'
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '0')
    assert client.post('/api/v1/tryon', content=b'not even multipart').status_code == 422


def test_public_origin_gate_also_covers_legacy_chat_before_body_validation(public):
    client, factory, _ = public
    before = business_counts(factory)
    assert client.post('/api/v1/chat', json={}).status_code == 403
    assert client.post('/api/v1/chat', json={}, headers={'Origin':'https://evil.example'}).status_code == 403
    assert client.post('/api/v1/chat', json={}, headers={'Origin':ORIGIN}).status_code == 422
    assert business_counts(factory) == before


def test_machine_proof_cannot_exchange_demo_cookie_for_bearer(public, tmp_path):
    client, _, patch = public
    patch.setenv('STYLING_DIRECT_ENABLED', '1')
    proof = tmp_path/'direct-only.json'
    bearer = 'synthetic-independent-proof-only-token'
    proof.write_text(json.dumps({'verifiers':[{'enabled':True,
        'token_sha256':hashlib.sha256(bearer.encode()).hexdigest(),
        'subject':'synthetic-product-verifier','authorized_scope':'public-three-agent-20261010',
        'source_instance_id':'styling-public-20261010','target_instance_id':'product-public-20261010'}],
        'targets':[]}))
    proof.chmod(0o600)
    patch.setenv('STYLING_DIRECT_AUTH_FILE', str(proof))
    assert enter(client).status_code == 200
    r = client.post('/api/integrations/product-management/v1/verify-approval', json={})
    assert r.status_code == 403 and r.json()['error']['code'] == 'DIRECT_AUTH_CONFLICT'
    client.cookies.clear()
    assert client.post('/api/integrations/product-management/v1/verify-approval', json={}).status_code == 401
    assert client.post('/api/integrations/product-management/v1/verify-approval', json={},
                       headers={'Authorization':'Bearer '+bearer}).status_code == 422
