"""Local demo session authorization against wholly separate synthetic databases."""
import json
import sys
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.core import admin_auth, database
from app.core.consumer_identity import consumer_cookie_name
from app.models.chat import Base
from app.models.demand import DemandAdminSession
from app.models.styling_account import StylingAccountSession
from app.models.admin_context import AdminSessionContext
from app.models.tryon import utcnow
from app.services import styling_delivery, admin_context

ORIGIN = 'http://personal-preview.localhost:3084'


@pytest.fixture
def demo(tmp_path, monkeypatch):
    old_factory, old_engine = database.SessionLocal, database.engine
    engine = create_engine(f'sqlite:///{tmp_path}/demo-only.db', connect_args={'check_same_thread': False})
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    for name, module in list(sys.modules.items()):
        if name.startswith('app.') and module:
            if getattr(module, 'SessionLocal', None) is old_factory:
                monkeypatch.setattr(module, 'SessionLocal', factory)
            if getattr(module, 'engine', None) is old_engine:
                monkeypatch.setattr(module, 'engine', engine)
    for key, value in {
        'STYLING_DEMO_ACCESS_ENABLED': '1', 'STYLING_ADMIN_ENABLED': '1',
        'STYLING_ADMIN_CONTEXT_ENABLED': '1', 'STYLING_ADMIN_PASSWORD': 'synthetic-password-only',
        'STYLING_ADMIN_SECRET': 'synthetic-signing-secret-' * 3, 'STYLING_ADMIN_SUBJECT': 'ordinary-manager',
        'STYLING_ADMIN_SCOPE': 'demo-test', 'STYLING_DIRECT_INSTANCE_ID': 'demo-source',
        'STYLING_ADMIN_PUBLIC_ORIGIN': ORIGIN, 'STYLING_ADMIN_COOKIE_SECURE': '0',
        'CONSUMER_APP_SCOPE': 'demo-isolated', 'CONSUMER_ALLOWED_ORIGINS': ORIGIN,
        'STYLING_FIXED_ENABLED': '0', 'STYLING_PERSONAL_PREVIEW_ENABLED': '0',
    }.items():
        monkeypatch.setenv(key, value)
    client = TestClient(app, client=('127.0.0.1', 45000))
    yield client, factory, monkeypatch
    client.close()
    engine.dispose()


def enter(client, role='styling-manager'):
    return client.post('/api/v1/demo-access/enter', json={'role': role}, headers={'Origin': ORIGIN})


def business_counts(factory):
    from sqlalchemy import text
    with factory() as db:
        return {t: db.execute(text(f'SELECT count(*) FROM {t}')).scalar_one() for t in
                ['demand_turns', 'demand_occurrences', 'demand_handoffs', 'generation_requests',
                 'styling_direct_deliveries', 'styling_direct_attempts']}


def test_capability_read_is_no_store_and_creates_no_identity(demo):
    client, factory, _ = demo
    before = business_counts(factory)
    r = client.get('/api/v1/demo-access')
    assert r.status_code == 200 and r.headers['cache-control'] == 'no-store'
    assert r.json() == {'contract_version': 'styling_demo_access_v1', 'mode': 'local_demo',
        'login_required': False, 'shared_demo': True,
        'roles': [{'role': 'consumer', 'entry_path': '/'}, {'role': 'styling-manager', 'entry_path': '/admin'}]}
    assert not r.headers.get('set-cookie')
    with factory() as db:
        assert db.query(DemandAdminSession).count() == 0
    assert business_counts(factory) == before


def test_real_manager_cookie_context_and_overview_reused(demo):
    client, factory, _ = demo
    before = business_counts(factory)
    r = enter(client)
    assert r.status_code == 200 and r.json()['entry_path'] == '/admin'
    assert 'httponly' in r.headers['set-cookie'].lower()
    first_cookie = client.cookies.get(admin_auth.COOKIE)
    me = client.get('/api/v1/admin/me')
    assert me.status_code == 200
    assert me.json()['subject'] == 'styling-demo-manager' and me.json()['auth_method'] == 'demo_server'
    assert me.json()['approval_identity_kind'] == 'account_bound'
    assert enter(client).status_code == 200
    assert client.cookies.get(admin_auth.COOKIE) == first_cookie
    assert client.get('/api/v1/admin/me').json() == me.json()
    assert client.get('/api/v1/admin/overview').status_code == 200
    with factory() as db:
        assert db.query(StylingAccountSession).count() == db.query(AdminSessionContext).count() == 1
        assert db.query(StylingAccountSession).one().auth_method == 'demo_server'
    assert business_counts(factory) == before


def test_consumer_preserves_owner_and_manager_entry_does_not_claim_it(demo):
    client, factory, _ = demo
    before = business_counts(factory)
    assert enter(client, 'consumer').status_code == 200
    cookie = client.cookies.get(consumer_cookie_name())
    assert cookie and client.get('/api/v1/admin/me').status_code == 401
    profile = client.get('/api/v1/consumer-profile').json()
    body = {'profile_action_id': uuid.uuid4().hex, 'operation': 'save', 'expected_profile_version': 0,
        'expected_authorization_context': {k:profile['authorization_context'][k] for k in
            ['context_contract', 'context_id', 'operation_token']},
        'patch': {'base_profile': {'usual_sizes': {'shoes': {'system': 'cn_shoe', 'value': '38'}}}},
        'explicit_save': True}
    assert client.post('/api/v1/consumer-profile/mutations', json=body, headers={'Origin': ORIGIN}).status_code == 200
    assert enter(client).status_code == 200
    assert enter(client, 'consumer').status_code == 200
    assert client.cookies.get(consumer_cookie_name()) == cookie
    saved = client.get('/api/v1/consumer-profile').json()
    assert saved['profile_version'] == 1 and saved['base_profile']['usual_sizes']['shoes']['value'] == '38'
    outsider = TestClient(app, client=('127.0.0.1', 45001))
    assert enter(outsider, 'consumer').status_code == 200
    assert outsider.get('/api/v1/consumer-profile').json()['status'] == 'empty'
    current = client.get('/api/v1/consumer-profile').json()
    clear = {'profile_action_id': uuid.uuid4().hex, 'operation': 'clear', 'expected_profile_version': 1,
        'expected_authorization_context': {k:current['authorization_context'][k] for k in
            ['context_contract', 'context_id', 'operation_token']}, 'patch': {}}
    assert client.post('/api/v1/consumer-profile/mutations', json=clear, headers={'Origin': ORIGIN}).status_code == 200
    assert client.get('/api/v1/consumer-profile').json()['profile_version'] == 2
    assert business_counts(factory) == before
    outsider.close()


@pytest.mark.parametrize('body', [{'role': 'employee'}, {'role': 'styling-manager', 'subject': 'victim'},
                                 {'role': 'consumer', 'scope': 'other'}, {}, {'role': 1}])
def test_enter_strict_body_cannot_select_identity_or_scope(demo, body):
    client, factory, _ = demo
    r = client.post('/api/v1/demo-access/enter', json=body, headers={'Origin': ORIGIN})
    assert r.status_code == 422 and r.headers['cache-control'] == 'no-store'
    with factory() as db:
        assert db.query(DemandAdminSession).count() == 0


@pytest.mark.parametrize('headers', [{}, {'Origin':'http://evil.invalid'},
                                   {'Origin':ORIGIN,'Sec-Fetch-Site':'cross-site'},
                                   {'Origin':ORIGIN,'Authorization':'Bearer forged'}])
def test_origin_and_mixed_identity_rejected(demo, headers):
    client, _, _ = demo
    r = client.post('/api/v1/demo-access/enter', json={'role':'styling-manager'}, headers=headers)
    assert r.status_code == 403 and not r.headers.get('set-cookie')


def test_duplicate_json_and_query_rejected(demo):
    client, _, _ = demo
    assert client.post('/api/v1/demo-access/enter', content='{"role":"consumer","role":"styling-manager"}',
                       headers={'Origin':ORIGIN}).status_code == 422
    assert client.get('/api/v1/demo-access?role=styling-manager').status_code == 422


def test_nonloopback_cannot_bootstrap_or_use_copied_demo_cookie(demo):
    client, _, _ = demo
    assert enter(client).status_code == 200
    remote = TestClient(app, client=('192.0.2.3', 50000))
    remote.cookies.set(admin_auth.COOKIE, client.cookies.get(admin_auth.COOKIE))
    assert enter(remote).status_code == 403
    assert remote.get('/api/v1/admin/me').status_code == 403
    assert remote.get('/api/v1/demo-access').status_code == 403
    remote.close()


def test_closing_flag_invalidates_session_and_old_context_without_deleting_history(demo):
    client, factory, patch = demo
    assert enter(client).status_code == 200
    me = client.get('/api/v1/admin/me').json()
    old_cookie = client.cookies.get(admin_auth.COOKIE)
    with factory() as db:
        account = db.query(StylingAccountSession).one()
        principal = admin_auth.StylingAdminPrincipal(account.session_id, account.subject, account.scope,
            account.source_instance_id, account.auth_method, 'account_bound')
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '0')
    assert client.get('/api/v1/demo-access').json()['mode'] == 'authenticated'
    assert enter(client).status_code == 403
    assert client.get('/api/v1/admin/me').status_code == 401
    with factory() as db:
        with pytest.raises(admin_context.AdminContextError):
            admin_auth.revalidate_principal(db, principal, account_required=True)
        assert db.query(StylingAccountSession).count() == 1
    assert client.post('/api/v1/admin/login', json={'password':'synthetic-password-only'},
                       headers={'Origin':ORIGIN}).status_code == 200
    assert client.get('/api/v1/admin/me').json()['auth_method'] == 'password_single_account'
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED', '1')
    client.cookies.clear();client.cookies.set(admin_auth.COOKIE, old_cookie, domain='testserver.local')
    assert client.get('/api/v1/admin/me').status_code == 401  # retired, never revived
    assert enter(client).status_code == 200
    assert client.get('/api/v1/admin/me').json()['authorization_context'] != me['authorization_context']


def test_demo_login_does_not_require_a_password_or_claim_password_auth(demo):
    client, _, _ = demo
    for body in [{}, {'password':''}, {'password':'incorrect'}]:
        r = client.post('/api/v1/admin/login', json=body, headers={'Origin':ORIGIN})
        assert r.status_code == 409 and r.json()['error']['code'] == 'DEMO_LOGIN_NOT_REQUIRED'
        assert r.json()['entry_path'] == '/admin'
        assert not r.headers.get('set-cookie')


def test_expired_session_can_enter_again_but_old_context_cannot_be_replayed(demo):
    client, factory, _ = demo
    enter(client);me = client.get('/api/v1/admin/me').json()
    with factory() as db:
        db.query(DemandAdminSession).update({'expires_at':utcnow()-timedelta(seconds=1)})
        db.query(StylingAccountSession).update({'expires_at':utcnow()-timedelta(seconds=1)})
        db.commit()
    assert enter(client).status_code == 200
    new_me = client.get('/api/v1/admin/me').json()
    assert new_me['subject'] == me['subject']
    assert new_me['authorization_context'] != me['authorization_context']
    r = client.post('/api/v1/admin/logout', json={'admin_action_contract':'styling_admin_action_v1',
        'request_id':str(uuid.uuid4()), 'expected_admin_context':{k:me['authorization_context'][k] for k in
            ['context_contract','context_id']}}, headers={'Origin':ORIGIN})
    assert r.status_code == 409 and r.json()['error']['code'] == 'ADMIN_AUTH_CONTEXT_CHANGED'


def test_direct_identity_accepts_only_fixed_demo_subject_while_enabled(demo):
    client, factory, patch = demo
    enter(client)
    with factory() as db:
        account = db.query(StylingAccountSession).one()
        p = {k:getattr(account,k) for k in ['subject','scope','source_instance_id','auth_method','session_id']}
        p['approval_identity_kind'] = 'account_bound'
        styling_delivery._principal(p);styling_delivery._session(db,p)
        with pytest.raises(styling_delivery.StylingDeliveryError):
            styling_delivery._principal({**p, 'subject':'ordinary-manager'})
    patch.setenv('STYLING_DEMO_ACCESS_ENABLED','0')
    with pytest.raises(styling_delivery.StylingDeliveryError):
        styling_delivery._principal(p)


def test_missing_config_is_failure_not_empty_or_success(demo):
    client, _, patch = demo
    patch.setenv('STYLING_ADMIN_PUBLIC_ORIGIN','https://public.invalid')
    assert enter(client).status_code == 503
    assert not client.cookies.get(admin_auth.COOKIE)
