"""Real application API shape with isolated synthetic account approvals."""
import hashlib
import json
import uuid
from datetime import timedelta
import pytest
from app.core.database import SessionLocal, init_db
from app.models.demand import DemandHandoff
from app.models.styling_direct import StylingApprovalFact, StylingEvidenceExport
from app.models.styling_verification import StylingApprovalVerification
from app.models.tryon import utcnow
from app.services.demand import record_turn


@pytest.fixture
def direct_fixture(client, monkeypatch, tmp_path):
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    verifier = uuid.uuid4().hex + uuid.uuid4().hex
    source = 'styling-' + uuid.uuid4().hex
    target = 'product-' + uuid.uuid4().hex
    scope = 'demo-' + uuid.uuid4().hex
    for key, value in {'STYLING_ADMIN_PASSWORD': secret, 'STYLING_ADMIN_SECRET': secret,
                      'STYLING_ADMIN_SUBJECT': 'synthetic-single-manager', 'STYLING_ADMIN_SCOPE': scope,
                      'STYLING_ADMIN_ENABLED': '1', 'STYLING_ADMIN_COOKIE_SECURE': '0',
                      'STYLING_DIRECT_ENABLED': '1', 'STYLING_DIRECT_INSTANCE_ID': source}.items():
        monkeypatch.setenv(key, value)
    config = tmp_path / 'private.json'
    config.write_text(json.dumps({'verifiers': [{'subject': 'product-verifier', 'enabled': True,
        'token_sha256': hashlib.sha256(verifier.encode()).hexdigest(), 'authorized_scope': scope,
        'source_instance_id': source, 'target_instance_id': target}], 'targets': []}))
    config.chmod(0o600)
    monkeypatch.setenv('STYLING_DIRECT_AUTH_FILE', str(config))
    init_db()
    client.cookies.clear()
    assert client.post('/api/v1/admin/login', json={'password': secret}).status_code == 200
    request_id = uuid.uuid4().hex
    assert record_turn('direct-fixture-' + request_id, request_id, '希望秋天通勤穿宽松长裤')
    from app.models.demand import DemandOccurrence, DemandTurn
    with SessionLocal() as db:
        turn = db.query(DemandTurn).filter_by(request_id=request_id).one()
        occurrence = db.query(DemandOccurrence).filter_by(turn_id=turn.id).one()
        key = occurrence.group_key
    base = client.get('/api/v1/admin/groups/' + key + '/approval-set').json()
    body = {'note': '合成隔离技术批准，不代表实际经营审批', 'days': 7,
            'expected_occurrence_ids': base['expected_occurrence_ids'], 'expected_revisions': base['expected_revisions'],
            'expected_evidence_digest': base['evidence_digest'],
            'window_start': base['window_start'], 'window_end': base['window_end']}
    result = client.post('/api/v1/admin/groups/' + key + '/approve', json=body)
    assert result.status_code == 200, result.text
    handoff = result.json()
    assert handoff['approval_identity_kind'] == 'account_bound'
    handoff_id = handoff['id']
    assert client.post(f'/api/v1/admin/handoffs/{handoff_id}/evidence-export').status_code == 200
    with SessionLocal() as db:
        fact = db.query(StylingApprovalFact).filter_by(handoff_id=handoff_id).one()
        export = db.query(StylingEvidenceExport).filter_by(handoff_id=handoff_id).one()
        proof = {'proof_schema': 'pa-direct-approval-proof/1', 'verification_purpose': 'initial_delivery',
            'nonce': uuid.uuid4().hex + uuid.uuid4().hex, 'source_product': 'personal_styling',
            'target_product': 'product_management', 'source_instance_id': source,
            'target_instance_id': target, 'authorized_scope': scope,
            'source_approval_ref': {'approval_record_id': fact.approval_record_id},
            'handoff_id': handoff_id, 'revision': fact.revision, 'payload_digest': fact.payload_digest,
            'supplement_id': export.supplement_id, 'supplement_digest': export.digest}
    client.cookies.clear()
    return client, proof, {'Authorization': 'Bearer ' + verifier}


URL = '/api/integrations/product-management/v1/verify-approval'


def test_api_proves_real_record_and_replays_nonce(direct_fixture):
    client, body, headers = direct_fixture
    first = client.post(URL, json=body, headers=headers)
    assert first.status_code == 200, first.text
    proof = first.json()
    assert proof['approved_by'] == 'synthetic-single-manager'
    assert proof['approval_identity_kind'] == 'account_bound'
    assert proof['operation_eligible'] is True
    assert proof['nonce'] == body['nonce']
    assert proof['metadata_digest'] != proof['supplement_digest']
    assert client.post(URL, json=body, headers=headers).json() == proof
    assert first.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('field,value,status', [
    ('nonce', 'short', 422), ('revision', True, 422),
    ('target_instance_id', 'another-product', 403), ('authorized_scope', 'another-scope', 403),
    ('payload_digest', 'a' * 64, 422), ('source_approval_ref', {'approval_record_id': 'fake'}, 422),
    ('supplement_digest', 'b' * 64, 422), ('cms_instance_id', 'forbidden', 422),
])
def test_api_callback_rejects_claimed_bindings(direct_fixture, field, value, status):
    client, body, headers = direct_fixture
    response = client.post(URL, json={**body, field: value}, headers=headers)
    assert response.status_code == status, response.text
    with SessionLocal() as db:
        assert db.query(StylingApprovalVerification).filter_by(nonce=body['nonce']).count() == 0


def test_api_callback_cookie_is_not_machine_auth(direct_fixture):
    client, body, headers = direct_fixture
    response = client.post(URL, json=body, headers={**headers, 'Cookie': 'styling_admin_v1=irrelevant'})
    assert response.status_code == 403


def test_sending_received_do_not_erase_independent_approval(direct_fixture):
    client, body, headers = direct_fixture
    for state in ['sending', 'received']:
        with SessionLocal() as db:
            db.get(DemandHandoff, body['handoff_id']).status = state
            db.commit()
        response = client.post(URL, json={**body, 'nonce': uuid.uuid4().hex + uuid.uuid4().hex}, headers=headers)
        assert response.status_code == 200, response.text


def test_callback_nonce_expiry_and_another_body(direct_fixture):
    client, body, headers = direct_fixture
    assert client.post(URL, json=body, headers=headers).status_code == 200
    other = {**body, 'verification_purpose': 'supplement_append'}
    assert client.post(URL, json=other, headers=headers).status_code == 409
    with SessionLocal() as db:
        row = db.query(StylingApprovalVerification).filter_by(nonce=body['nonce']).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.post(URL, json=body, headers=headers).status_code == 422
