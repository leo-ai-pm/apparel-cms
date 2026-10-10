"""Core SAC intent/ownership checks in a wholly new temporary source database."""
from datetime import timedelta
import json
import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core import admin_auth
from app.models.chat import Base
from app.models.demand import DemandAdminSession
from app.models.styling_account import StylingAccountSession
from app.models.admin_context import AdminOperation, AdminSessionContext
from app.models.styling_delivery import StylingDirectAction, StylingDirectDelivery
from app.models.tryon import utcnow
from app.schemas.admin_context import AdminActionFields, AdminOperationMetadata, EmptyAdminAction
from app.services import admin_context as context


@pytest.fixture
def setup(tmp_path, monkeypatch):
    for key, value in {
        "STYLING_ADMIN_CONTEXT_ENABLED": "1", "STYLING_ADMIN_ENABLED": "1",
        "STYLING_ADMIN_PASSWORD": "isolated-unit-password", "STYLING_ADMIN_SECRET": "x" * 48,
        "STYLING_ADMIN_SUBJECT": "technical-A", "STYLING_ADMIN_SCOPE": "sac-unit",
        "STYLING_DIRECT_INSTANCE_ID": "isolated-sourcesac", "STYLING_ADMIN_PUBLIC_ORIGIN": "",
    }.items():
        monkeypatch.setenv(key, value)
    engine = create_engine(f"sqlite:///{tmp_path}/new-only.db")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(admin_auth, "SessionLocal", factory)
    # generation observer imports the authoritative factory only at call time.
    from app.core import database
    monkeypatch.setattr(database, "SessionLocal", factory)
    return factory, monkeypatch


def actor(factory, subject="technical-A", scope="sac-unit", instance="isolated-sourcesac"):
    sid = uuid.uuid4().hex
    expiry = utcnow() + timedelta(hours=8)
    principal = admin_auth.StylingAdminPrincipal(sid, subject, scope, instance,
                                                "password_single_account", "account_bound")
    with factory() as db:
        db.add(DemandAdminSession(id=sid, expires_at=expiry))
        db.add(StylingAccountSession(session_id=sid, subject=subject, scope=scope,
            source_instance_id=instance, audience="personal_styling", auth_method="password_single_account",
            expires_at=expiry))
        db.flush()
        value = context.get_me(db, principal)
        db.commit()
    return principal, value


def body(me, request_id=None):
    auth = me["authorization_context"]
    return EmptyAdminAction(admin_action_contract="styling_admin_action_v1",
        request_id=request_id or str(uuid.uuid4()), expected_admin_context={
            "context_contract": auth["context_contract"], "context_id": auth["context_id"]})


def assert_error(code, callback):
    with pytest.raises(context.AdminContextError) as exc:
        callback()
    assert exc.value.code == code


def test_me_stable_expiry_and_two_sessions(setup):
    factory, _ = setup
    a, first = actor(factory)
    b, second = actor(factory)
    with factory() as db:
        again = context.get_me(db, a)
        assert again == first
        assert first["expires_at"] == first["authorization_context"]["expires_at"]
        assert first["authorization_context"] != second["authorization_context"]
        assert len(first["authorization_context"]["context_id"]) == 43
        assert not set(first).intersection({"session_id", "password", "secret", "cookie"})
        assert_error("ADMIN_AUTH_CONTEXT_CHANGED", lambda: context.begin_action(db, b, body(first),
            "POST", "/api/v1/admin/logout", "logout"))
        assert db.query(AdminOperation).count() == 0


def test_original_snapshot_pending_completed_body_route_and_context_conflicts(setup):
    factory, _ = setup
    a, me = actor(factory)
    request = body(me)
    path = "/api/v1/admin/turns/T-1/retry"
    with factory() as db:
        record, replay = context.begin_action(db, a, request, "POST", path, "retry")
        assert replay is None
        db.commit()
    with factory() as db:
        assert_error("ADMIN_ACTION_IN_PROGRESS", lambda: context.begin_action(db, a, request, "POST", path, "retry"))
        record = db.query(AdminOperation).one()
        context.finish_action(db, record, {"state": "fixed", "private_dto": "safe restricted original"},
            outcome="completed", result_ref={"kind": "demand_turn", "id": "T-1", "revision": None})
        db.commit()
    with factory() as db:
        record, replay = context.begin_action(db, a, request, "POST", path, "retry")
        assert replay["state"] == "fixed"
        assert record.response_status == 200
        assert "safe restricted original" not in record.result_ref_json
        assert_error("ADMIN_ACTION_BODY_CONFLICT", lambda: context.begin_action(db, a, request,
            "POST", "/api/v1/admin/turns/T-2/retry", "retry"))
    anew, menew = actor(factory)
    with factory() as db:
        assert_error("ADMIN_AUTH_CONTEXT_CHANGED", lambda: context.begin_action(db, anew, request, "POST", path, "retry"))
        assert_error("ADMIN_ACTION_CONTEXT_CONFLICT", lambda: context.begin_action(db, anew,
            body(menew, request.request_id), "POST", path, "retry"))
        before = db.query(AdminOperation).count()
        metadata = context.lookup_operation(db, anew, request.request_id)
        assert metadata["actor_subject"] == "technical-A" and metadata["state"] == "completed"
        assert metadata["operation_context_ref"] == record.operation_context_ref
        assert "private_dto" not in json.dumps(metadata)
        assert db.query(AdminOperation).count() == before


@pytest.mark.parametrize("state,status,outcome", [("failed", 502, "failed"), ("unconfirmed", 502, "unconfirmed")])
def test_failed_and_unconfirmed_replay_stored_status_without_reexecution(setup, state, status, outcome):
    factory, _ = setup
    a, me = actor(factory)
    request = body(me)
    with factory() as db:
        record, _ = context.begin_action(db, a, request, "POST", "/api/v1/admin/handoffs/DH-1/direct-send", "direct_send")
        context.finish_action(db, record, {"error": {"code": "technical_failure"}},
            status_code=status, state=state, outcome=outcome)
        db.commit()
    with factory() as db:
        record, replay = context.begin_action(db, a, request, "POST", "/api/v1/admin/handoffs/DH-1/direct-send", "direct_send")
        assert record.response_status == status and replay["error"]["code"] == "technical_failure"
        assert context.lookup_operation(db, a, request.request_id)["state"] == state
        assert db.query(AdminOperation).count() == 1


def test_configuration_generation_restore_never_revives_but_restart_unchanged_does(setup):
    factory, patch = setup
    a, first = actor(factory)
    context.observe_authorization_generation()
    with factory() as db:
        assert context.get_me(db, a) == first  # new DB session simulates reload of persistence
    patch.setenv("STYLING_ADMIN_SECRET", "y" * 48)
    context.observe_authorization_generation()
    patch.setenv("STYLING_ADMIN_SECRET", "x" * 48)
    context.observe_authorization_generation()
    with factory() as db:
        assert db.get(AdminSessionContext, a.session_id).revoked_at is not None
        assert_error("ADMIN_AUTH_CONTEXT_CHANGED", lambda: context.revalidate_context(db, a,
            body(first).expected_admin_context))
        assert_error("ADMIN_SESSION_REVOKED", lambda: context.get_me(db, a))


def test_actual_asgi_startup_observes_change_without_any_management_http(setup):
    """A changed deployment started without requests must still retire old intent."""
    import asyncio
    import app.main as main
    factory, patch = setup
    a, _ = actor(factory)
    # Every startup dependency is isolated; the real lifespan generation hook runs.
    patch.setattr(main, "init_db", lambda: None)
    patch.setattr(main, "recover_interrupted_generations", lambda: None)
    patch.setattr(main.generation, "interrupted", lambda: None)
    patch.setattr(main.fixed_styling, "close_service", lambda: None)

    async def start_and_stop():
        async with main.lifespan(main.app):
            pass  # deliberately no TestClient, HTTP or business calls

    patch.setenv("STYLING_ADMIN_SECRET", "z" * 48)
    asyncio.run(start_and_stop())
    patch.setenv("STYLING_ADMIN_SECRET", "x" * 48)
    asyncio.run(start_and_stop())
    with factory() as db:
        assert db.get(AdminSessionContext, a.session_id).revoked_at is not None
        assert_error("ADMIN_SESSION_REVOKED", lambda: context.get_me(db, a))
        assert db.query(AdminOperation).count() == 0


def test_logout_completion_and_precise_session_revocation(setup):
    factory, _ = setup
    a, me = actor(factory)
    other, _ = actor(factory)
    request = body(me)
    with factory() as db:
        record, _ = context.begin_action(db, a, request, "POST", "/api/v1/admin/logout", "logout")
        context.finish_action(db, record, {"logged_out": True})
        admin_auth.revoke_session(None, db=db, principal=a)
        db.commit()
        assert db.get(DemandAdminSession, a.session_id).revoked_at is not None
        assert db.get(DemandAdminSession, other.session_id).revoked_at is None
        assert_error("ADMIN_SESSION_REVOKED", lambda: context.begin_action(db, a, request,
            "POST", "/api/v1/admin/logout", "logout"))
    with factory() as db:
        metadata = context.lookup_operation(db, other, request.request_id)
        assert metadata["state"] == "completed" and metadata["result_ref"] is None


def test_strict_action_and_metadata_reject_bool_extra_and_missing_context(setup):
    with pytest.raises(ValidationError, match="ADMIN_CONTEXT_REQUIRED"):
        EmptyAdminAction()
    with pytest.raises(ValidationError):
        EmptyAdminAction.model_validate({"admin_action_contract": "styling_admin_action_v1", "request_id": True,
            "expected_admin_context": {"context_contract": "styling_admin_context_v1", "context_id": "x" * 43}})
    with pytest.raises(ValidationError):
        EmptyAdminAction.model_validate({"expected_admin_context": {"context_contract": "styling_admin_context_v1", "context_id": "x" * 43, "subject": "A"}})
    with pytest.raises(ValidationError):
        AdminOperationMetadata.model_validate({"operation_contract": "styling_admin_action_v1", "request_id": "old-action",
            "actor_subject": "technical-A", "operation_kind": "direct_send", "context_binding": "legacy_unbound",
            "operation_context_ref": None, "body_digest": None, "state": "completed", "outcome": "received",
            "accepted_at": None, "completed_at": None,
            "result_ref": {"kind": "direct_delivery", "id": "D-1", "revision": True}})


def legacy(factory, request_id):
    with factory() as db:
        db.add(StylingDirectDelivery(id="D-legacy", handoff_id="DH-old", revision=1, scope="sac-unit",
            source_instance_id="isolated-sourcesac", target_instance_id="fixture-target", approval_record_id="AP-old",
            actor_subject="technical-A", envelope_json="{}", envelope_digest="1" * 64, payload_digest="2" * 64))
        db.add(StylingDirectAction(id="A-legacy", delivery_id="D-legacy", scope="sac-unit", actor_subject="technical-A",
            request_id=request_id, operation="send", request_digest="9" * 64,
            response_json='{"status":"received"}', finished_at=utcnow()))
        db.commit()


def test_legacy_metadata_null_digest_and_new_action_blocked(setup):
    factory, _ = setup
    a, me = actor(factory)
    request_id = 'legacy.tech:01'
    legacy(factory, request_id)
    with factory() as db:
        metadata = context.lookup_operation(db, a, request_id)
        assert metadata["context_binding"] == "legacy_unbound"
        assert metadata["operation_context_ref"] is None and metadata["body_digest"] is None
        assert_error("ADMIN_ACTION_LEGACY_UNBOUND", lambda: context.begin_action(db, a, body(me, request_id),
            "POST", "/api/v1/admin/handoffs/DH-old/direct-send", "direct_send"))
        assert db.query(AdminOperation).count() == 0
        assert_error("ADMIN_ACTION_INVALID", lambda: context.begin_action(db, a, body(me, 'new.nonuuid'),
            "POST", "/api/v1/admin/handoffs/DH-old/direct-send", "direct_send"))


def test_global_other_actor_id_never_becomes_another_action(setup):
    factory, patch = setup
    a, me = actor(factory)
    request = body(me)
    with factory() as db:
        record, _ = context.begin_action(db, a, request, "POST", "/api/v1/admin/turns/T-1/retry", "retry")
        context.finish_action(db, record, {"ok": True})
        db.commit()
    patch.setenv("STYLING_ADMIN_SUBJECT", "technical-B")
    b, mb = actor(factory, subject="technical-B")
    with factory() as db:
        assert_error("ADMIN_OPERATION_NOT_FOUND", lambda: context.begin_action(db, b, body(mb, request.request_id),
            "POST", "/api/v1/admin/turns/T-1/retry", "retry"))
        assert_error("ADMIN_OPERATION_NOT_FOUND", lambda: context.lookup_operation(db, b, request.request_id))
        assert_error("ADMIN_OPERATION_NOT_FOUND", lambda: context.lookup_operation(db, b, "never-existed"))
        assert db.query(AdminOperation).count() == 1


def test_legacy_other_actor_id_refuses_globally(setup):
    factory, patch = setup
    request_id = str(uuid.uuid4())
    legacy(factory, request_id)
    patch.setenv("STYLING_ADMIN_SUBJECT", "technical-B")
    b, mb = actor(factory, subject="technical-B")
    with factory() as db:
        assert_error("ADMIN_OPERATION_NOT_FOUND", lambda: context.begin_action(db, b, body(mb, request_id),
            "POST", "/api/v1/admin/handoffs/DH-old/direct-send", "direct_send"))
        assert db.query(AdminOperation).count() == 0


def test_missing_response_fails_closed(setup):
    factory, _ = setup
    a, me = actor(factory)
    request = body(me)
    with factory() as db:
        record, _ = context.begin_action(db, a, request, "POST", "/api/v1/admin/turns/T-1/retry", "retry")
        record.state, record.outcome, record.completed_at = "completed", "completed", utcnow()
        db.commit()
        assert_error("ADMIN_OPERATION_STORAGE_UNAVAILABLE", lambda: context.begin_action(db, a, request,
            "POST", "/api/v1/admin/turns/T-1/retry", "retry"))
