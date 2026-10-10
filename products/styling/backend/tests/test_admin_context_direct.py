"""SAC DIRECT technical seams: fresh own SQLite + in-process mock receiver only."""
import json
import uuid
from datetime import timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from app.core.admin_auth import StylingAdminPrincipal
from app.models.admin_context import AdminOperation
from app.models.demand import DemandAdminSession, DemandHandoff
from app.models.styling_account import StylingAccountSession
from app.models.styling_delivery import StylingDirectAction, StylingDirectAttempt, StylingDirectDelivery
from app.models.tryon import utcnow
from app.schemas.styling_direct import DirectSend, DirectAction, EvidenceAction
from app.services import admin_context as ac
from app.services import styling_delivery as sd
from tests.test_styling_delivery import env, factory, receiver
from tests.test_styling_evidence import ADMIN


@pytest.fixture
def sessions(factory, monkeypatch):
    monkeypatch.setenv('STYLING_ADMIN_CONTEXT_ENABLED', '1')
    monkeypatch.setenv('STYLING_ADMIN_PASSWORD', 'technical-fixture-password-2026')
    monkeypatch.setenv('STYLING_ADMIN_SECRET', 'technical-fixture-secret-' + 'a' * 32)
    monkeypatch.setenv('STYLING_ADMIN_ENABLED', '1')
    values = []
    for _ in range(2):
        sid = uuid.uuid4().hex
        principal = StylingAdminPrincipal(sid, ADMIN['subject'], ADMIN['scope'], ADMIN['source_instance_id'],
            'password_single_account', 'account_bound')
        with factory() as db:
            expires = utcnow() + timedelta(hours=1)
            db.add(DemandAdminSession(id=sid, expires_at=expires))
            db.add(StylingAccountSession(session_id=sid, subject=ADMIN['subject'], scope=ADMIN['scope'],
                source_instance_id=ADMIN['source_instance_id'], audience='personal_styling',
                auth_method='password_single_account', expires_at=expires))
            db.commit()
            db.execute(text('BEGIN IMMEDIATE'))
            me = ac.get_me(db, principal)
            db.commit()
        expected = {k: v for k, v in me['authorization_context'].items() if k != 'expires_at'}
        values.append(({**ADMIN, 'session_id': sid, 'role': 'styling-manager', 'audience': 'personal_styling'}, expected))
    return values


def body(context, request_id=None, include=True, revision=1):
    return DirectSend(admin_action_contract='styling_admin_action_v1',
        request_id=request_id or str(uuid.uuid4()), expected_admin_context=context,
        expected_revision=revision, include_supplement=include)


def send(factory, principal, request):
    with factory() as db:
        return sd.send(db, 'DH-synthetic-evidence', request.request_id, request.expected_revision,
            request.include_supplement, principal, admin_action=request)


def count(factory):
    with factory() as db:
        return tuple(db.query(cls).count() for cls in
            (AdminOperation, StylingDirectAction, StylingDirectDelivery, StylingDirectAttempt))


@pytest.mark.parametrize('kind', ['send', 'reconcile', 'supplement'])
def test_old_page_context_rejects_before_business_lease_and_mock_http(factory, receiver, sessions, kind):
    original, expected = sessions[0]
    new_principal, _ = sessions[1]
    request = body(expected)
    with pytest.raises(ac.AdminContextError) as caught:
        with factory() as db:
            if kind == 'send':
                sd.send(db, 'DH-synthetic-evidence', request.request_id, 1, True, new_principal, admin_action=request)
            else:
                call = sd.reconcile if kind == 'reconcile' else sd.append_supplement
                call(db, 'DH-synthetic-evidence', request.request_id, 1, new_principal,
                    admin_action=DirectAction(**request.model_dump(exclude={'include_supplement'})))
    assert caught.value.code == 'ADMIN_AUTH_CONTEXT_CHANGED'
    assert count(factory) == (0, 0, 0, 0)
    assert receiver['requests'] == []


def test_bound_send_completed_replay_and_session_context_conflicts(factory, receiver, sessions):
    principal, context = sessions[0]
    other, other_context = sessions[1]
    request = body(context)
    first = send(factory, principal, request)
    assert first['status'] == 'received'
    assert send(factory, principal, request) == first
    assert len(receiver['requests']) == 1 and count(factory) == (1, 1, 1, 1)
    assert 'expected_admin_context' not in json.loads(receiver['initial_body'])
    assert 'admin_action_contract' not in json.loads(receiver['initial_body'])
    with pytest.raises(ac.AdminContextError) as changed:
        send(factory, other, request)
    assert changed.value.code == 'ADMIN_AUTH_CONTEXT_CHANGED'
    with pytest.raises(ac.AdminContextError) as conflict:
        send(factory, other, body(other_context, request.request_id))
    assert conflict.value.code == 'ADMIN_ACTION_CONTEXT_CONFLICT'
    assert count(factory) == (1, 1, 1, 1) and len(receiver['requests']) == 1
    with factory() as db:
        metadata = ac.lookup_operation(db, other, request.request_id)
    assert metadata['state'] == 'completed' and metadata['outcome'] == 'received'
    assert metadata['actor_subject'] == principal['subject']
    assert metadata['context_binding'] == 'bound' and metadata['body_digest']


@pytest.mark.parametrize('change', ['revision', 'route', 'supplement'])
def test_same_id_body_or_route_conflict_precedes_qualification(factory, receiver, sessions, change):
    principal, context = sessions[0]
    request = body(context)
    send(factory, principal, request)
    with pytest.raises(ac.AdminContextError) as caught:
        if change == 'revision':
            send(factory, principal, body(context, request.request_id, revision=2))
        elif change == 'supplement':
            send(factory, principal, body(context, request.request_id, include=False))
        else:
            other = DirectAction(**request.model_dump(exclude={'include_supplement'}))
            with factory() as db:
                sd.reconcile(db, 'DH-synthetic-evidence', request.request_id, 1, principal, admin_action=other)
    assert caught.value.code == 'ADMIN_ACTION_BODY_CONFLICT'
    assert count(factory) == (1, 1, 1, 1) and len(receiver['requests']) == 1


def test_unconfirmed_same_body_and_new_send_do_not_query_or_resend(factory, receiver, sessions):
    principal, context = sessions[0]
    receiver['drop_send'] = True
    request = body(context)
    initial = send(factory, principal, request)
    assert initial['status'] == 'unconfirmed'
    receiver['drop_send'] = False
    assert send(factory, principal, request) == initial
    assert send(factory, principal, body(context))['status'] == 'unconfirmed'
    assert len(receiver['requests']) == 1 and count(factory) == (2, 2, 1, 1)
    reconcile = DirectAction(admin_action_contract='styling_admin_action_v1', request_id=str(uuid.uuid4()),
        expected_admin_context=context, expected_revision=1)
    with factory() as db:
        result = sd.reconcile(db, 'DH-synthetic-evidence', reconcile.request_id, 1, principal, admin_action=reconcile)
    assert result['status'] == 'received'
    assert [x.method for x in receiver['requests']] == ['POST', 'GET']
    assert count(factory) == (3, 3, 1, 2)


def test_network_receives_but_original_context_revoked_keeps_unconfirmed(factory, receiver, sessions):
    principal, context = sessions[0]
    request = body(context)
    def revoke():
        with factory() as db:
            db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
            db.get(StylingAccountSession, principal['session_id']).revoked_at = utcnow()
            db.commit()
    receiver['before_send'] = revoke
    with pytest.raises(ac.AdminContextError) as caught:
        send(factory, principal, request)
    assert caught.value.status == 401
    assert receiver['receipt'] is not None and len(receiver['requests']) == 1
    with factory() as db:
        delivery = db.query(StylingDirectDelivery).one()
        action = db.query(AdminOperation).one()
        attempt = db.query(StylingDirectAttempt).one()
        assert delivery.status == action.state == attempt.status == 'unconfirmed'
        assert delivery.receipt_json == 'null' and delivery.lease_token is None
        assert attempt.finished_at is not None and action.completed_at is not None
        assert ac.lookup_operation(db, sessions[1][0], request.request_id)['outcome'] == 'unconfirmed'


@pytest.mark.parametrize('payload', [
    {'request_id': 'old-id', 'expected_revision': 1},
    {'admin_action_contract': 'styling_admin_action_v1', 'request_id': str(uuid.uuid4()), 'expected_revision': True},
])
def test_new_mode_strict_direct_payload(sessions, payload):
    with pytest.raises(ValidationError):
        DirectSend.model_validate(payload)
    with pytest.raises(ValidationError):
        EvidenceAction.model_validate({**payload, 'extra': 'not allowed'})


def test_revocation_before_network_has_no_attempt_or_target_request(factory, receiver, sessions, monkeypatch):
    principal, context = sessions[0]
    original = ac.revalidate_context
    calls = 0
    def revoke_before_preflight(db, current, expected):
        nonlocal calls
        calls += 1
        if calls == 2:
            db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
            db.get(StylingAccountSession, principal['session_id']).revoked_at = utcnow()
            db.flush()
        return original(db, current, expected)
    monkeypatch.setattr(ac, 'revalidate_context', revoke_before_preflight)
    request = body(context)
    with pytest.raises(ac.AdminContextError) as caught:
        send(factory, principal, request)
    assert caught.value.status == 401 and receiver['requests'] == []
    assert count(factory) == (1, 1, 1, 0)
    with factory() as db:
        assert db.query(StylingDirectDelivery).one().lease_token is None
        assert db.query(AdminOperation).one().state == 'failed'
        assert db.query(AdminOperation).one().outcome == 'failed'


def test_committed_received_not_downgraded_by_later_revocation(factory, receiver, sessions, monkeypatch):
    principal, context = sessions[0]
    finish = ac.finish_action
    def finish_then_revoke(db, record, result, *args, **kwargs):
        value = finish(db, record, result, *args, **kwargs)
        db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
        db.get(StylingAccountSession, principal['session_id']).revoked_at = utcnow()
        return value
    monkeypatch.setattr(ac, 'finish_action', finish_then_revoke)
    request = body(context)
    with pytest.raises(ac.AdminContextError) as caught:
        send(factory, principal, request)
    assert caught.value.status == 401
    with factory() as db:
        delivery = db.query(StylingDirectDelivery).one()
        assert delivery.status == 'received' and delivery.receipt_json != 'null'
        assert db.query(StylingDirectAttempt).one().status == 'received'
        assert db.query(AdminOperation).one().state == 'completed'
        assert ac.lookup_operation(db, sessions[1][0], request.request_id)['outcome'] == 'received'
    assert len(receiver['requests']) == 1


def test_bound_late_supplement_replays_same_frozen_receipt(factory, receiver, sessions):
    principal, context = sessions[0]
    initial = send(factory, principal, body(context, include=False))
    request = DirectAction(admin_action_contract='styling_admin_action_v1', request_id=str(uuid.uuid4()),
        expected_admin_context=context, expected_revision=1)
    with factory() as db:
        value = sd.append_supplement(db, 'DH-synthetic-evidence', request.request_id, 1,
            principal, admin_action=request)
    assert value['receipt'] == initial['receipt']
    assert value['supplement_delivery']['status'] == 'received'
    with factory() as db:
        assert sd.append_supplement(db, 'DH-synthetic-evidence', request.request_id, 1,
            principal, admin_action=request) == value
    assert [x.method for x in receiver['requests']] == ['POST', 'POST']
    with factory() as db:
        metadata = ac.lookup_operation(db, principal, request.request_id)
    assert metadata['operation_kind'] == 'direct_supplement' and metadata['outcome'] == 'received'
    assert metadata['state'] == 'completed'


def test_evidence_post_bound_transaction_then_pure_read(factory, sessions, monkeypatch):
    import asyncio
    from app.api import styling_direct as api
    monkeypatch.setattr(api, 'SessionLocal', factory)
    original_principal, context = sessions[0]
    principal = StylingAdminPrincipal(original_principal['session_id'], original_principal['subject'],
        original_principal['scope'], original_principal['source_instance_id'],
        'password_single_account', 'account_bound')
    request = EvidenceAction(admin_action_contract='styling_admin_action_v1', request_id=str(uuid.uuid4()),
        expected_admin_context=context, expected_revision=1)
    response = asyncio.run(api.evidence_create('DH-synthetic-evidence', request, principal))
    value = json.loads(response.body)
    assert value['status'] == 'registered'
    assert response.headers['x-styling-admin-request-id'] == request.request_id
    assert json.loads(asyncio.run(api.evidence_create('DH-synthetic-evidence', request, principal)).body) == value
    before = count(factory)
    read = asyncio.run(api.evidence_read('DH-synthetic-evidence', principal))
    assert read.headers['x-content-sha256'] == value['digest']
    assert count(factory) == before == (1, 0, 0, 0)


def test_evidence_old_page_rejects_before_export(factory, sessions, monkeypatch):
    import asyncio
    from app.api import styling_direct as api
    from app.models.styling_direct import StylingEvidenceExport
    monkeypatch.setattr(api, 'SessionLocal', factory)
    request = EvidenceAction(admin_action_contract='styling_admin_action_v1', request_id=str(uuid.uuid4()),
        expected_admin_context=sessions[0][1], expected_revision=1)
    with pytest.raises(ac.AdminContextError) as caught:
        asyncio.run(api.evidence_create('DH-synthetic-evidence', request, sessions[1][0]))
    assert caught.value.code == 'ADMIN_AUTH_CONTEXT_CHANGED'
    with factory() as db:
        assert db.query(StylingEvidenceExport).count() == 0
    assert count(factory) == (0, 0, 0, 0)


def test_target_config_gap_revocation_rechecks_at_actual_dispatch(factory, receiver, sessions, monkeypatch):
    principal, context = sessions[0]
    target = sd._target
    calls = 0
    def target_then_revoke(current):
        nonlocal calls
        result = target(current)
        calls += 1
        if calls == 2:
            with factory() as db:
                db.get(DemandAdminSession, principal['session_id']).revoked_at = utcnow()
                db.get(StylingAccountSession, principal['session_id']).revoked_at = utcnow()
                db.commit()
        return result
    monkeypatch.setattr(sd, '_target', target_then_revoke)
    request = body(context)
    with pytest.raises(ac.AdminContextError) as caught:
        send(factory, principal, request)
    assert caught.value.status == 401 and receiver['requests'] == []
    with factory() as db:
        attempt = db.query(StylingDirectAttempt).one()
        assert attempt.status == 'not_sent' and attempt.finished_at is not None
        assert db.query(AdminOperation).one().state == 'failed'
        assert db.query(AdminOperation).one().outcome == 'failed'
        assert db.query(StylingDirectDelivery).one().lease_token is None


def test_configuration_retirement_at_response_gate_survives_restore(factory, receiver, sessions, monkeypatch):
    from app.models.admin_context import AdminSessionContext
    principal, context = sessions[0]
    request = body(context)
    send(factory, principal, request)
    check = ac.revalidate_context
    calls = 0
    def change_config_at_response(db, current, expected):
        nonlocal calls
        calls += 1
        if calls == 2:
            monkeypatch.setenv('STYLING_ADMIN_PUBLIC_ORIGIN', 'http://technical-new-config.localhost')
        return check(db, current, expected)
    monkeypatch.setattr(ac, 'revalidate_context', change_config_at_response)
    with pytest.raises(ac.AdminContextError) as caught:
        send(factory, principal, request)
    assert caught.value.code == 'ADMIN_AUTH_CONTEXT_CHANGED'
    monkeypatch.delenv('STYLING_ADMIN_PUBLIC_ORIGIN', raising=False)
    with factory() as db:
        assert db.get(AdminSessionContext, principal['session_id']).revoked_at is not None
        assert db.query(StylingDirectDelivery).one().status == 'received'
        assert db.query(AdminOperation).one().state == 'completed'
        with pytest.raises(ac.AdminContextError) as revoked:
            ac.get_me(db, principal)
        assert revoked.value.code == 'ADMIN_SESSION_REVOKED'
    assert len(receiver['requests']) == 1


def test_same_scope_technical_b_login_reads_frozen_but_cannot_claim_a_operation(factory, receiver, sessions, client, monkeypatch):
    from app.api import admin as admin_api, styling_direct as direct_api
    from app.core import database, admin_auth
    from app.models.styling_direct import StylingApprovalFact
    # All login, cookies, authoritative checks and HTTP handlers use this new
    # temporary source database. The target remains in-process MockTransport.
    for module in (database, admin_auth, admin_api, direct_api):
        monkeypatch.setattr(module, 'SessionLocal', factory)
    principal_a, context_a = sessions[0]
    receiver['drop_send'] = True
    a_request = body(context_a)
    original = send(factory, principal_a, a_request)
    assert original['status'] == 'unconfirmed'
    assert original['transmission_actor_subject'] == principal_a['subject']
    with factory() as db:
        frozen = db.get(DemandHandoff, 'DH-synthetic-evidence')
        protected = (frozen.payload_json, frozen.metadata_json)
        approval = db.query(StylingApprovalFact).one()
        original_approval_subject = approval.subject
    assert original_approval_subject == principal_a['subject']
    monkeypatch.setenv('STYLING_ADMIN_SUBJECT', 'synthetic-technical-B')
    monkeypatch.setenv('STYLING_ADMIN_COOKIE_SECURE', '0')
    client.cookies.clear()
    login = client.post('/api/v1/admin/login', json={'password': 'technical-fixture-password-2026'})
    assert login.status_code == 200
    me = client.get('/api/v1/admin/me')
    assert me.status_code == 200 and me.json()['subject'] == 'synthetic-technical-B'
    context_b = {k: v for k, v in me.json()['authorization_context'].items() if k != 'expires_at'}
    detail = client.get('/api/v1/admin/handoffs/DH-synthetic-evidence')
    assert detail.status_code == 200 and detail.json()['metadata']['approved_by'] == original_approval_subject
    current = client.get('/api/v1/admin/handoffs/DH-synthetic-evidence/direct-delivery')
    assert current.status_code == 200 and current.json()['transmission_actor_subject'] == principal_a['subject']
    before = count(factory)
    personal = client.get('/api/v1/admin/operations/' + a_request.request_id)
    assert personal.status_code == 404 and personal.json()['error']['code'] == 'ADMIN_OPERATION_NOT_FOUND'
    steal = DirectAction(admin_action_contract='styling_admin_action_v1', request_id=a_request.request_id,
        expected_admin_context=context_b, expected_revision=1)
    rejected = client.post('/api/v1/admin/handoffs/DH-synthetic-evidence/direct-reconcile', json=steal.model_dump(mode='json'))
    assert rejected.status_code == 404 and rejected.json()['error']['code'] == 'ADMIN_OPERATION_NOT_FOUND'
    assert count(factory) == before and len(receiver['requests']) == 1
    receiver['drop_send'] = False
    b_request = DirectAction(admin_action_contract='styling_admin_action_v1', request_id=str(uuid.uuid4()),
        expected_admin_context=context_b, expected_revision=1)
    reconciled = client.post('/api/v1/admin/handoffs/DH-synthetic-evidence/direct-reconcile', json=b_request.model_dump(mode='json'))
    assert reconciled.status_code == 200 and reconciled.json()['status'] == 'received'
    assert reconciled.json()['transmission_actor_subject'] == principal_a['subject']
    metadata = client.get('/api/v1/admin/operations/' + b_request.request_id)
    assert metadata.status_code == 200 and metadata.json()['actor_subject'] == 'synthetic-technical-B'
    assert metadata.json()['operation_kind'] == 'direct_reconcile' and metadata.json()['state'] == 'completed'
    assert [request.method for request in receiver['requests']] == ['POST', 'GET']
    with factory() as db:
        frozen = db.get(DemandHandoff, 'DH-synthetic-evidence')
        assert (frozen.payload_json, frozen.metadata_json) == protected
        assert db.query(StylingApprovalFact).one().subject == principal_a['subject']
        assert db.query(StylingDirectDelivery).one().actor_subject == principal_a['subject']
        assert db.query(AdminOperation).filter_by(request_id=a_request.request_id).one().actor_subject == principal_a['subject']
        assert db.query(AdminOperation).filter_by(request_id=b_request.request_id).one().actor_subject == 'synthetic-technical-B'
    assert 'transmission_actor_subject' not in json.loads(receiver['initial_body'])
    assert 'transmission_actor_subject' not in receiver['receipt']
