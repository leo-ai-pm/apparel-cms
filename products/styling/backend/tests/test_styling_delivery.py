"""Direct protocol seam tests on fresh SQLite only; no real partner/models."""
import base64
import copy
from datetime import timedelta
import hashlib
import json
import threading
import uuid

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.chat import Base
from app.models.demand import DemandHandoff, DemandOccurrence, DemandSendAttempt
from app.models.styling_delivery import StylingDirectAction, StylingDirectAttempt, StylingDirectDelivery, StylingDirectSupplement
from app.models.tryon import utcnow
from app.services import styling_delivery as sd
from app.services import styling_evidence as se
from tests.test_styling_evidence import ADMIN, freeze


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


@pytest.fixture
def env(monkeypatch, tmp_path):
    target = {'authorized_scope': ADMIN['scope'], 'source_instance_id': ADMIN['source_instance_id'],
              'target_instance_id': 'synthetic-product-a', 'base_url': 'https://product.invalid',
              'sender_token': 'test-only-outfit-sender-' + 'x' * 32, 'enabled': True}
    path = tmp_path / 'private-config.json'
    path.write_text(json.dumps({'config_version': 1, 'targets': [target], 'verifiers': []}))
    path.chmod(0o600)
    monkeypatch.setenv('STYLING_DIRECT_ENABLED', '1')
    monkeypatch.setenv('STYLING_DIRECT_AUTH_FILE', str(path))
    monkeypatch.setenv('STYLING_DIRECT_INSTANCE_ID', ADMIN['source_instance_id'])
    monkeypatch.setenv('STYLING_ADMIN_SUBJECT', ADMIN['subject'])
    monkeypatch.setenv('STYLING_ADMIN_SCOPE', ADMIN['scope'])
    monkeypatch.setenv('STYLING_DIRECT_ALLOW_LOOPBACK_HTTP', '0')
    return path, target


@pytest.fixture
def factory(tmp_path, env):
    engine = create_engine(f"sqlite:///{tmp_path}/isolated-direct.db", connect_args={'check_same_thread': False, 'timeout': 1})
    Base.metadata.create_all(engine)
    value = sessionmaker(bind=engine, autoflush=False)
    with value() as db:
        row, _ = freeze(db, external=True)
        db.add(DemandOccurrence(id='o-target', turn_id='t-target', group_key='group-synthetic',
             title='合成宽松需求', description='合成资料', attributes_json='{}', revision=1,
             lifecycle='active', review_state='pending', reason=''))
        db.commit()
    yield value
    engine.dispose()


@pytest.fixture
def receiver(monkeypatch, factory):
    state = {'requests': [], 'receipt': None, 'initial_body': None, 'current': None,
             'supplement_receipt': None, 'supplement_body': None,
             'drop_send': False, 'drop_supplement': False, 'bad_receipt': None,
             'before_send': None, 'proof_db_write': False, 'lookup_error': False,
             'response_body': None, 'bad_late_receipt': None, 'response_status': None}
    real_client = httpx.Client

    def respond(request):
        state['requests'].append(request)
        assert request.headers.get('authorization') == 'Bearer test-only-outfit-sender-' + 'x' * 32
        assert 'cookie' not in request.headers
        path = request.url.path
        if request.method == 'GET':
            if state['lookup_error']:
                return httpx.Response(502, json={'error': {'code': 'SOURCE_UNREACHABLE'}})
            if state['receipt'] is None:
                return httpx.Response(404)
            return httpx.Response(200, json={'receipt': state['receipt'], 'current_supplement': state['current']})
        if path == '/api/integrations/styling/v1/handoffs':
            if state['before_send']:
                state['before_send']()
            raw = request.read()
            envelope = json.loads(raw)
            original = base64.b64decode(envelope['payload_base64'], validate=True)
            assert sha(original) == envelope['payload_digest']
            assert request.headers['idempotency-key'] == envelope['handoff_id'] + ':' + str(envelope['revision'])
            if state['proof_db_write']:
                # A callback can take the source write lock while sender awaits.
                with factory() as db:
                    row = db.get(DemandHandoff, envelope['handoff_id'])
                    row.last_error = 'synthetic-callback-wrote'
                    db.commit()
            duplicate = state['receipt'] is not None
            if duplicate:
                assert state['initial_body'] == raw
            else:
                state['initial_body'] = raw
                supplement = envelope['supplement']
                state['current'] = {'supplement_id': supplement['supplement_id'], 'digest': supplement['digest']} if supplement else None
                fields = ('transport_schema', 'source_product', 'target_product', 'source_instance_id',
                    'target_instance_id', 'authorized_scope', 'handoff_id', 'revision', 'payload_digest', 'source_approval_ref')
                state['receipt'] = {**{k: envelope[k] for k in fields},
                    'receipt_schema': 'pa-direct-receipt/1', 'direct_receive_id': 'DPRCV-synthetic-a',
                    'status': 'received', 'received_at': sd._aware(utcnow()).isoformat(),
                    'verification_id': 'VERIFY-synthetic-a',
                    'supplement_id': supplement['supplement_id'] if supplement else None,
                    'supplement_digest': supplement['digest'] if supplement else None}
            if state['drop_send']:
                raise httpx.ReadTimeout('synthetic lost receipt', request=request)
            if state['response_status']:
                return httpx.Response(state['response_status'], headers={'Location': 'https://other.invalid'}, json={})
            if state['response_body']:
                return httpx.Response(200, content=state['response_body'])
            receipt = {**state['receipt'], **(state['bad_receipt'] or {})}
            return httpx.Response(200 if duplicate else 201, json={'receipt': receipt, 'duplicate': duplicate})
        assert path.endswith('/DPRCV-synthetic-a/supplements')
        assert state['receipt'] is not None
        raw = request.read()
        body = json.loads(raw)
        supplement = body['supplement']
        assert request.headers['idempotency-key'] == 'DPRCV-synthetic-a:' + supplement['supplement_id']
        assert set(body) == {'handoff_id', 'revision', 'payload_digest', 'source_approval_ref', 'supplement'}
        assert body['payload_digest'] == state['receipt']['payload_digest']
        content = base64.b64decode(supplement['content_base64'], validate=True)
        assert sha(content) == supplement['digest']
        duplicate = state['supplement_receipt'] is not None
        if duplicate:
            assert raw == state['supplement_body']
        else:
            state['supplement_body'] = raw
            state['supplement_receipt'] = {'receipt_schema': 'pa-direct-supplement-receipt/1',
                'direct_receive_id': 'DPRCV-synthetic-a', 'supplement_id': supplement['supplement_id'],
                'digest': supplement['digest'], 'status': 'received',
                'received_at': sd._aware(utcnow()).isoformat(), 'verification_id': 'VERIFY-synthetic-late'}
            state['current'] = {'supplement_id': supplement['supplement_id'], 'digest': supplement['digest']}
        if state['drop_supplement']:
            raise httpx.ReadTimeout('synthetic lost late receipt', request=request)
        return httpx.Response(200 if duplicate else 201, json={'supplement_receipt': {**state['supplement_receipt'], **(state['bad_late_receipt'] or {})}, 'duplicate': duplicate})

    def build_client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return real_client(transport=httpx.MockTransport(respond), **kwargs)
    monkeypatch.setattr(sd.httpx, 'Client', build_client)
    return state


def do_send(factory, request='send-a', include=True, principal=ADMIN):
    with factory() as db:
        return sd.send(db, 'DH-synthetic-evidence', request, 1, include, principal)


def do_reconcile(factory, request='reconcile-a'):
    with factory() as db:
        return sd.reconcile(db, 'DH-synthetic-evidence', request, 1, ADMIN)


def do_append(factory, request='append-a'):
    with factory() as db:
        return sd.append_supplement(db, 'DH-synthetic-evidence', request, 1, ADMIN)


def must_error(code, call, status=None):
    with pytest.raises(sd.StylingDeliveryError) as caught:
        call()
    assert caught.value.code == code
    if status is not None:
        assert caught.value.status == status
    assert 'test-only-outfit-sender' not in caught.value.message


def test_real_http_request_builder_preserves_original_bytes_and_callback_lock(factory, receiver):
    receiver['proof_db_write'] = True
    with factory() as db:
        row = db.get(DemandHandoff, 'DH-synthetic-evidence')
        original = (row.payload_json, row.metadata_json, row.status)
    value = do_send(factory)
    assert value['status'] == 'received' and value['transport'] == 'direct'
    envelope = json.loads(receiver['initial_body'])
    assert base64.b64decode(envelope['payload_base64']).decode() == original[0]
    assert sha(base64.b64decode(envelope['supplement']['content_base64'])) == envelope['supplement']['digest']
    assert 'cms_instance_id' not in envelope and 'source_agent' not in envelope
    with factory() as db:
        row = db.get(DemandHandoff, 'DH-synthetic-evidence')
        assert (row.payload_json, row.metadata_json, row.status) == original
        assert row.last_error == 'synthetic-callback-wrote'
        assert db.query(DemandSendAttempt).count() == 0
        assert db.query(StylingDirectDelivery).count() == 1
        assert db.query(StylingDirectAttempt).count() == 1


def test_same_request_replays_and_changed_body_conflicts(factory, receiver):
    original = do_send(factory)
    assert do_send(factory) == original
    assert len(receiver['requests']) == 1
    must_error('DIRECT_IDENTITY_CONFLICT', lambda: do_send(factory, include=False), 409)
    must_error('DIRECT_REQUEST_CONFLICT', lambda: do_reconcile(factory, request='send-a'), 409)


def test_received_new_action_ignores_current_evidence_drift(factory, receiver):
    original = do_send(factory)
    with factory() as db:
        db.get(DemandOccurrence, 'o-target').lifecycle = 'excluded'
        db.commit()
    value = do_send(factory, request='send-b')
    assert value['receipt'] == original['receipt'] and len(receiver['requests']) == 1


def test_lost_receipt_lookup_recovers_without_second_post(factory, receiver):
    receiver['drop_send'] = True
    assert do_send(factory)['status'] == 'unconfirmed'
    original_body = receiver['initial_body']
    receiver['drop_send'] = False
    value = do_reconcile(factory)
    assert value['status'] == 'received'
    assert [r.method for r in receiver['requests']] == ['POST', 'GET']
    assert receiver['initial_body'] == original_body


def test_retry_looks_up_then_reuses_body_and_identity(factory, receiver):
    receiver['drop_send'] = True
    assert do_send(factory)['status'] == 'unconfirmed'
    original = receiver['initial_body']
    receiver.update(drop_send=False, receipt=None, current=None, initial_body=None)
    assert do_reconcile(factory)['status'] == 'unconfirmed'
    value = do_send(factory, request='explicit-retry-b')
    assert value['status'] == 'received'
    assert receiver['initial_body'] == original
    assert [r.method for r in receiver['requests']] == ['POST', 'GET', 'GET', 'POST']
    with factory() as db:
        assert db.query(StylingDirectDelivery).count() == 1


def test_retry_looks_up_receipt_even_after_evidence_drift(factory, receiver):
    receiver['drop_send'] = True
    do_send(factory)
    with factory() as db:
        db.get(DemandOccurrence, 'o-target').revision = 2
        db.commit()
    receiver['drop_send'] = False
    assert do_send(factory, request='retry-b')['status'] == 'received'
    assert [r.method for r in receiver['requests']] == ['POST', 'GET']


def test_retry_404_with_drift_never_posts_again(factory, receiver):
    receiver['drop_send'] = True
    do_send(factory)
    receiver.update(drop_send=False, receipt=None, current=None)
    with factory() as db:
        db.get(DemandOccurrence, 'o-target').lifecycle = 'excluded'
        db.commit()
    value = do_send(factory, request='retry-b')
    assert value['status'] == 'unconfirmed' and value['last_error'] == 'DIRECT_SEND_INELIGIBLE'
    assert [r.method for r in receiver['requests']] == ['POST', 'GET']


@pytest.mark.parametrize('field,value', [
    ('receipt_schema', 'pa-dh-receipt/1'), ('transport_schema', 'pa-dh-delivery/1'),
    ('source_product', 'wrong'), ('target_product', 'wrong'), ('source_instance_id', 'wrong'),
    ('target_instance_id', 'wrong'), ('authorized_scope', 'wrong'), ('handoff_id', 'wrong'),
    ('revision', True), ('payload_digest', '0' * 64),
    ('source_approval_ref', {'approval_record_id': 'forged'}), ('status', 'approved'),
    ('supplement_id', 'wrong'), ('supplement_digest', '0' * 64),
    ('verification_id', None), ('direct_receive_id', ''), ('received_at', 'not-a-time'),
    ('cms_receive_id', 'legacy')])
def test_every_receipt_binding_and_schema_is_checked(factory, receiver, field, value):
    receiver['bad_receipt'] = {field: value}
    result = do_send(factory)
    assert result['status'] == 'unconfirmed' and result['last_error'] == 'DIRECT_RECEIPT_MISMATCH'
    assert result['receipt'] is None
    assert do_reconcile(factory)['status'] == 'received'


def test_lookup_failure_never_triggers_retry_post(factory, receiver):
    receiver['drop_send'] = True
    do_send(factory)
    receiver['lookup_error'] = True
    result = do_send(factory, request='retry-b')
    assert result['status'] == 'unconfirmed'
    assert [r.method for r in receiver['requests']] == ['POST', 'GET']


def test_missing_initial_supplement_and_late_append_are_independent(factory, receiver):
    initial = do_send(factory, include=False)
    initial_body = receiver['initial_body']
    assert initial['receipt']['supplement_id'] is None and initial['current_supplement'] is None
    with factory() as db:
        db.get(DemandOccurrence, 'o-target').lifecycle = 'excluded'
        db.commit()
    late = do_append(factory)
    assert late['status'] == 'received' and late['supplement_delivery']['status'] == 'received'
    assert late['receipt'] == initial['receipt'] and receiver['initial_body'] == initial_body
    assert late['current_supplement']['supplement_id'] == late['supplement_delivery']['supplement_id']
    assert do_append(factory) == late
    assert do_append(factory, request='append-b')['supplement_delivery']['receipt'] == late['supplement_delivery']['receipt']
    assert len(receiver['requests']) == 2


def test_lost_late_receipt_queries_original_then_replays_original_append(factory, receiver):
    initial = do_send(factory, include=False)
    receiver['drop_supplement'] = True
    pending = do_append(factory)
    assert pending['status'] == 'received' and pending['supplement_delivery']['status'] == 'unconfirmed'
    body = receiver['supplement_body']
    receiver['drop_supplement'] = False
    done = do_append(factory, request='append-b')
    assert done['supplement_delivery']['status'] == 'received'
    assert done['receipt'] == initial['receipt'] and receiver['supplement_body'] == body
    assert [r.method for r in receiver['requests']] == ['POST', 'POST', 'GET', 'POST']


def test_initial_supplement_cannot_be_replaced_with_append(factory, receiver):
    do_send(factory)
    must_error('DIRECT_SUPPLEMENT_ALREADY_PRESENT', lambda: do_append(factory), 409)
    assert len(receiver['requests']) == 1


def test_append_requires_confirmed_initial_receipt(factory, receiver):
    must_error('DIRECT_RECEIPT_REQUIRED', lambda: do_append(factory), 409)
    receiver['drop_send'] = True
    do_send(factory, include=False)
    must_error('DIRECT_RECEIPT_REQUIRED', lambda: do_append(factory), 409)


def test_source_legacy_and_revision_fail_before_network(factory, receiver):
    from app.models.styling_direct import StylingApprovalFact
    with factory() as db:
        db.query(StylingApprovalFact).delete()
        db.commit()
    must_error('APPROVAL_IDENTITY_LEGACY', lambda: do_send(factory), 422)
    assert receiver['requests'] == []


def test_wrong_revision_principal_and_disabled_config_fail_before_network(factory, receiver, env):
    with factory() as db:
        must_error('DIRECT_REVISION_CONFLICT', lambda: sd.send(db, 'DH-synthetic-evidence', 'wrong', 2, True, ADMIN), 409)
    must_error('APPROVAL_IDENTITY_LEGACY', lambda: do_send(factory, principal={'scope': ADMIN['scope']}), 403)
    must_error('DIRECT_SCOPE_FORBIDDEN', lambda: do_send(factory, principal={**ADMIN, 'scope': 'wrong'}), 403)
    path, target = env
    path.write_text(json.dumps({'targets': [{**target, 'enabled': False}], 'verifiers': []}))
    must_error('DIRECT_TARGET_NOT_CONFIGURED', lambda: do_send(factory), 503)
    assert receiver['requests'] == []


def test_storage_reopen_keeps_original_response_and_body(factory, receiver):
    first = do_send(factory)
    factory.kw['bind'].dispose()
    with factory() as db:
        current = sd.status(db, 'DH-synthetic-evidence', ADMIN)
        assert current['receipt'] == first['receipt']
    assert do_send(factory) == first
    assert len(receiver['requests']) == 1


def test_concurrent_same_identity_has_one_outbound_attempt(factory, receiver):
    entered, release = threading.Event(), threading.Event()
    receiver['before_send'] = lambda: (entered.set(), release.wait(5))
    outcomes = []
    worker = threading.Thread(target=lambda: outcomes.append(do_send(factory)))
    worker.start()
    assert entered.wait(3)
    with factory() as db:
        current = sd.status(db, 'DH-synthetic-evidence', ADMIN)
        assert current['operation_in_progress'] is True and current['retry_after_seconds'] > 0
    try:
        must_error('DIRECT_SEND_IN_PROGRESS', lambda: do_send(factory, request='other'), 409)
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive() and outcomes[0]['status'] == 'received'
    assert len(receiver['requests']) == 1


def test_stale_worker_lease_recovers_by_lookup_and_not_new_handoff(factory, receiver):
    receiver['drop_send'] = True
    do_send(factory)
    with factory() as db:
        delivery = db.query(StylingDirectDelivery).one()
        delivery.lease_token, delivery.lease_until = 'synthetic-stale', utcnow() - timedelta(seconds=1)
        delivery.status = 'sending'
        db.commit()
    receiver['drop_send'] = False
    result = do_send(factory, request='restart-retry')
    assert result['status'] == 'received' and len(receiver['requests']) == 2
    with factory() as db:
        assert db.query(DemandHandoff).count() == 1 and db.query(StylingDirectDelivery).count() == 1


@pytest.mark.parametrize('url', ['http://remote.invalid', 'https://user:password@product.invalid',
    'https://product.invalid/?secret=yes', 'https://product.invalid/#fragment', 'https://product.invalid/elsewhere'])
def test_server_destination_cannot_redirect_or_take_arbitrary_path(factory, receiver, env, url):
    path, target = env
    path.write_text(json.dumps({'targets': [{**target, 'base_url': url}], 'verifiers': []}))
    must_error('DIRECT_TARGET_INVALID', lambda: do_send(factory), 503)
    assert receiver['requests'] == []


def test_explicit_loopback_http_requires_switch(factory, receiver, env, monkeypatch):
    path, target = env
    path.write_text(json.dumps({'targets': [{**target, 'base_url': 'http://127.0.0.1:9999'}], 'verifiers': []}))
    must_error('DIRECT_TARGET_INVALID', lambda: do_send(factory), 503)
    monkeypatch.setenv('STYLING_DIRECT_ALLOW_LOOPBACK_HTTP', '1')
    assert do_send(factory)['status'] == 'received'


@pytest.mark.parametrize('response', [b'not-json', b'{"receipt":{},"receipt":{}}', b'x' * 262145])
def test_invalid_oversized_or_duplicate_response_never_means_success(factory, receiver, response):
    receiver['response_body'] = response
    result = do_send(factory)
    assert result['status'] == 'unconfirmed' and result['receipt'] is None
    assert result['last_error'] == 'DIRECT_RESPONSE_INVALID'


def test_recorded_envelope_tamper_is_not_silently_overwritten(factory, receiver):
    do_send(factory)
    with factory() as db:
        db.query(StylingDirectDelivery).one().envelope_json += ' '
        db.commit()
    must_error('DIRECT_FROZEN_CONFLICT', lambda: do_send(factory, request='changed'), 409)
    assert len(receiver['requests']) == 1


@pytest.mark.parametrize('field,value', [
    ('receipt_schema', 'wrong'), ('direct_receive_id', 'wrong'), ('supplement_id', 'wrong'),
    ('digest', '0' * 64), ('status', 'approved'), ('verification_id', None),
    ('received_at', 'bad'), ('cms_receive_id', 'legacy')])
def test_late_receipt_all_fields_checked_without_rewriting_first(factory, receiver, field, value):
    initial = do_send(factory, include=False)
    receiver['bad_late_receipt'] = {field: value}
    result = do_append(factory)
    assert result['receipt'] == initial['receipt'] and result['status'] == 'received'
    assert result['supplement_delivery']['status'] == 'unconfirmed'
    assert result['supplement_delivery']['last_error'] == 'DIRECT_RECEIPT_MISMATCH'
    receiver['bad_late_receipt'] = None
    result = do_append(factory, request='append-recovery')
    assert result['receipt'] == initial['receipt']
    assert result['supplement_delivery']['status'] == 'received'


def technical_session(factory):
    from app.models.demand import DemandAdminSession
    from app.models.styling_account import StylingAccountSession
    identity = uuid.uuid4().hex
    with factory() as db:
        db.add(DemandAdminSession(id=identity, expires_at=utcnow() + timedelta(hours=1)))
        db.add(StylingAccountSession(session_id=identity, subject=ADMIN['subject'], scope=ADMIN['scope'],
            source_instance_id=ADMIN['source_instance_id'], auth_method=ADMIN['auth_method'],
            audience='personal_styling', expires_at=utcnow() + timedelta(hours=1)))
        db.commit()
    return {**ADMIN, 'session_id': identity}


def test_logout_during_remote_call_does_not_publish_late_receipt(factory, receiver):
    from app.models.demand import DemandAdminSession
    from app.models.styling_account import StylingAccountSession
    principal = technical_session(factory)
    def revoke():
        with factory() as db:
            db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
            db.get(StylingAccountSession, principal['session_id']).revoked_at = utcnow()
            db.commit()
    receiver['before_send'] = revoke
    must_error('DIRECT_SESSION_INVALID', lambda: do_send(factory, principal=principal), 401)
    assert receiver['receipt'] is not None
    with factory() as db:
        delivery = db.query(StylingDirectDelivery).one()
        assert delivery.status == 'unconfirmed' and delivery.receipt_json == 'null'
        assert delivery.last_error == 'DIRECT_SESSION_INVALID' and delivery.lease_token is None
    new_principal = technical_session(factory)
    receiver['before_send'] = None
    with factory() as db:
        result = sd.reconcile(db, 'DH-synthetic-evidence', 'new-manager-lookup', 1, new_principal)
    assert result['status'] == 'received'
    must_error('DIRECT_SESSION_INVALID', lambda: do_send(factory, principal=principal), 401)
    assert [r.method for r in receiver['requests']] == ['POST', 'GET']


def test_manager_disable_during_remote_call_remains_unconfirmed(factory, receiver, monkeypatch):
    receiver['before_send'] = lambda: monkeypatch.setenv('STYLING_ADMIN_ENABLED', '0')
    must_error('DIRECT_SCOPE_FORBIDDEN', lambda: do_send(factory), 403)
    assert receiver['receipt'] is not None
    with factory() as db:
        assert db.query(StylingDirectDelivery).one().status == 'unconfirmed'
    monkeypatch.setenv('STYLING_ADMIN_ENABLED', '1')
    receiver['before_send'] = None
    assert do_reconcile(factory)['status'] == 'received'


def test_target_disabled_during_remote_call_cannot_confirm(factory, receiver, env):
    path, target = env
    receiver['before_send'] = lambda: path.write_text(json.dumps({'targets': [{**target, 'enabled': False}], 'verifiers': []}))
    must_error('DIRECT_TARGET_NOT_CONFIGURED', lambda: do_send(factory), 503)
    with factory() as db:
        assert db.query(StylingDirectDelivery).one().receipt_json == 'null'
    path.write_text(json.dumps({'targets': [target], 'verifiers': []}))
    receiver['before_send'] = None
    assert do_reconcile(factory)['status'] == 'received'


def test_current_session_guard_applies_to_accepted_action_replay(factory, receiver):
    from app.models.demand import DemandAdminSession
    principal = technical_session(factory)
    assert do_send(factory, principal=principal)['status'] == 'received'
    with factory() as db:
        db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
        db.commit()
    must_error('DIRECT_SESSION_INVALID', lambda: do_send(factory, principal=principal), 401)
    assert len(receiver['requests']) == 1


def test_redirect_is_not_followed_or_accepted(factory, receiver):
    receiver['response_status'] = 302
    result = do_send(factory)
    assert result['status'] == 'unconfirmed' and result['last_error'] == 'DIRECT_REMOTE_REJECTED'
    assert len(receiver['requests']) == 1


def test_private_config_permissions_checked_before_network(factory, receiver, env):
    env[0].chmod(0o644)
    must_error('DIRECT_CONFIGURATION_INVALID', lambda: do_send(factory), 503)
    assert receiver['requests'] == []


def test_late_retry_lookup_failure_keeps_append_unconfirmed(factory, receiver):
    initial = do_send(factory, include=False)
    receiver['drop_supplement'] = True
    do_append(factory)
    receiver['drop_supplement'], receiver['lookup_error'] = False, True
    result = do_append(factory, request='append-recovery')
    assert result['receipt'] == initial['receipt'] and result['status'] == 'received'
    assert result['supplement_delivery']['status'] == 'unconfirmed'
    assert result['supplement_delivery']['last_error'] == 'DIRECT_REMOTE_REJECTED'
    assert result['operation_in_progress'] is False
    assert [r.method for r in receiver['requests']] == ['POST', 'POST', 'GET']


def test_database_error_is_not_empty_state_or_success(factory, receiver):
    from sqlalchemy import text
    with factory() as db:
        db.execute(text('DROP TABLE styling_direct_deliveries'))
        db.commit()
    with factory() as db:
        must_error('DIRECT_STORAGE_UNAVAILABLE', lambda: sd.status(db, 'DH-synthetic-evidence', ADMIN), 503)
    assert receiver['requests'] == []
