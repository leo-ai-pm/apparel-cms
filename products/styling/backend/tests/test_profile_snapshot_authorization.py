"""Real opaque Cookie + temporary SQLite authorization seams; no model network."""
from datetime import timedelta
import json
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError, OperationalError
from sqlalchemy.orm import sessionmaker

from app.api import chat, consumer_profiles as profile_api, profile_snapshots as snapshot_api
from app.api.consumer_profiles import profile_error_handler
from app.core import consumer_identity, request_admission
from app.core.config import settings
from app.core.consumer_identity import AuthenticatedConsumerPrincipal
from app.core.cost_guard import CostGuard
from app.models.chat import Base, DailyUsage
from app.models.consumer_context import ConsumerIdentityRevocation
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.models.profile_snapshot import ConsumerProfileSnapshot
from app.models.tryon import utcnow
from app.schemas.consumer_profile import ProfileError
from app.services import agent, consumer_profiles, demand, generation, profile_snapshots

PATH = "/api/v1/consumer-profile"
SCOPE = "profile_snapshot_authorization_test"


@pytest.fixture
def authorized_env(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path}/authorization.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    for module in (consumer_identity, consumer_profiles, profile_snapshots, chat,
                   request_admission, agent, demand, generation):
        monkeypatch.setattr(module, "SessionLocal", factory)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", SCOPE)
    monkeypatch.setenv("STYLING_FIXED_ENABLED", "0")
    monkeypatch.setenv("CONSUMER_ALLOWED_ORIGINS", "http://testserver")
    monkeypatch.setattr(settings, "deepseek_api_key", "")
    monkeypatch.setattr(settings, "daily_call_limit", 100)
    monkeypatch.setattr(chat, "cost_guard", CostGuard())
    downstream = []

    async def offline_events(session_id, *_args, **_kwargs):
        # A failed authorization gate may reach this deliberately offline stub.
        # It has no provider adapter, images, model transport, or paid call.
        downstream.append(session_id)
        yield {"type": "done", "session_id": session_id, "content": "离线权限测试终态",
               "outcome": "clarification", "product_ids": []}

    monkeypatch.setattr(agent, "run_agent_events", offline_events)
    app = FastAPI()
    app.include_router(profile_api.router)
    app.include_router(snapshot_api.router)
    app.include_router(chat.router)
    app.add_exception_handler(ProfileError, profile_error_handler)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, _error):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST"}},
                            headers={"Cache-Control": "no-store"})

    @app.exception_handler(SQLAlchemyError)
    async def unhandled_storage(_request, _error):
        # A route must translate its own storage error to the promised 503.
        return JSONResponse(status_code=500, content={"error": {"code": "UNHANDLED_STORAGE"}})

    @app.middleware("http")
    async def trusted_adapter(request, call_next):
        principal = getattr(app.state, "principal", None)
        if principal is not None:
            request.state.consumer_principal = principal
        return await call_next(request)

    client = TestClient(app, raise_server_exceptions=False)
    yield {"app": app, "client": client, "db": factory, "downstream": downstream}
    client.close()
    engine.dispose()


def code(response):
    return response.json().get("error", {}).get("code")


def rejected(response, status, expected):
    assert (response.status_code, code(response)) == (status, expected)
    assert response.headers.get("cache-control") == "no-store"


def raw_request():
    return {"session_id": "private-" + uuid4().hex, "request_id": uuid4().hex,
            "message": "离线资料授权边界测试"}


def prepare(ctx, body=None):
    body = body or raw_request()
    response = ctx["client"].post(PATH + "/prepare", json={
        "operation": "chat", "session_id": body["session_id"],
        "request_id": body["request_id"], "request_body": body})
    assert response.status_code == 200, (response.status_code, code(response))
    return body, response.json(), response


def payload(body):
    return {"operation": "chat", "session_id": body["session_id"],
            "request_id": body["request_id"], "request_body": body}


def initialize(ctx):
    response = ctx["client"].get(PATH)
    assert response.status_code == 200, (response.status_code, code(response))
    return response.json()


def revoke(ctx):
    with ctx["db"]() as db:
        owner_ref = db.query(ConsumerProfileIdentity).one().owner_ref
        if db.get(ConsumerIdentityRevocation, owner_ref) is None:
            db.add(ConsumerIdentityRevocation(owner_ref=owner_ref))
            db.commit()


def business_counts(ctx):
    with ctx["db"]() as db:
        return tuple(db.query(model).count() for model in
                     (DemandTurn, GenerationRequest, DemandRequestAdmission)) + (
            sum(row.count for row in db.query(DailyUsage)),)


def test_legal_prepare_lookup_is_private_and_not_formal_business(authorized_env):
    ctx = authorized_env
    initialize(ctx)
    _, prepared, created = prepare(ctx)
    snapshot_id = prepared["profile_binding"]["snapshot_id"]
    read = ctx["client"].get(PATH + "/snapshots/" + snapshot_id)
    assert read.status_code == 200
    assert read.json()["profile_binding"] == prepared["profile_binding"]
    assert created.headers.get("cache-control") == "no-store"
    assert read.headers.get("cache-control") == "no-store"
    assert business_counts(ctx) == (0, 0, 0, 0)
    assert ctx["downstream"] == []


@pytest.mark.parametrize("operation", ["new_prepare", "duplicate_prepare", "snapshot", "bound_chat"])
def test_revoked_cookie_cannot_prepare_read_or_formally_send(authorized_env, operation):
    ctx = authorized_env
    initialize(ctx)
    body, prepared, _ = prepare(ctx)
    binding = prepared["profile_binding"]
    revoke(ctx)
    before = business_counts(ctx)
    with ctx["db"]() as db:
        original_snapshot_count = db.query(ConsumerProfileSnapshot).count()
        original_identity_count = db.query(ConsumerProfileIdentity).count()
    if operation == "new_prepare":
        response = ctx["client"].post(PATH + "/prepare", json=payload(raw_request()))
    elif operation == "duplicate_prepare":
        response = ctx["client"].post(PATH + "/prepare", json=payload(body))
    elif operation == "snapshot":
        response = ctx["client"].get(PATH + "/snapshots/" + binding["snapshot_id"])
    else:
        response = ctx["client"].post("/api/v1/chat", json={**body, "profile_binding": binding})
    rejected(response, 403, "PROFILE_OWNER_INVALID")
    assert business_counts(ctx) == before == (0, 0, 0, 0)
    assert ctx["downstream"] == []
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileSnapshot).count() == original_snapshot_count
        assert db.query(ConsumerProfileIdentity).count() == original_identity_count


@pytest.mark.parametrize("failure", ["revocation", "expiry"])
def test_prepare_rechecks_identity_after_resolver_before_write_transaction(authorized_env, monkeypatch, failure):
    ctx = authorized_env
    initialize(ctx)
    original_lock = profile_snapshots._lock
    changed = []

    def invalidate_then_lock(db):
        if not changed:
            with ctx["db"]() as another:
                identity = another.query(ConsumerProfileIdentity).one()
                if failure == "revocation":
                    another.add(ConsumerIdentityRevocation(owner_ref=identity.owner_ref))
                else:
                    identity.expires_at = utcnow() - timedelta(seconds=1)
                another.commit()
            changed.append(True)
        original_lock(db)

    monkeypatch.setattr(profile_snapshots, "_lock", invalidate_then_lock)
    response = ctx["client"].post(PATH + "/prepare", json=payload(raw_request()))
    rejected(response, 403, "PROFILE_OWNER_INVALID")
    assert changed == [True]
    assert business_counts(ctx) == (0, 0, 0, 0)
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileSnapshot).count() == 0


def test_binding_admission_rechecks_revocation_after_legal_replay_check(authorized_env, monkeypatch):
    ctx = authorized_env
    initialize(ctx)
    body, prepared, _ = prepare(ctx)
    original_factory = request_admission.SessionLocal
    calls = []

    def revoked_before_admission(*args, **kwargs):
        revoke(ctx)
        calls.append(True)
        return original_factory(*args, **kwargs)

    monkeypatch.setattr(request_admission, "SessionLocal", revoked_before_admission)
    response = ctx["client"].post("/api/v1/chat", json={**body, "profile_binding": prepared["profile_binding"]})
    rejected(response, 403, "PROFILE_OWNER_INVALID")
    assert calls == [True]
    assert business_counts(ctx) == (0, 0, 0, 0)
    assert ctx["downstream"] == []
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileSnapshot).one().state == "prepared"


@pytest.mark.parametrize("operation", ["prepare", "snapshot"])
def test_trusted_principal_is_revalidated_in_private_snapshot_transaction(authorized_env, operation):
    ctx = authorized_env
    allowed = [True]
    checked_transactions = []

    def revalidate(db):
        checked_transactions.append(db.in_transaction())
        return allowed[0]

    ctx["app"].state.principal = AuthenticatedConsumerPrincipal(
        SCOPE, "synthetic-authenticated-owner", auth_instance_id="synthetic-real-instance",
        expires_at=utcnow() + timedelta(hours=1), revalidate=revalidate)
    initialize(ctx)
    body, prepared, _ = prepare(ctx)
    checked_transactions.clear()
    allowed[0] = False
    if operation == "prepare":
        response = ctx["client"].post(PATH + "/prepare", json=payload(body))
    else:
        response = ctx["client"].get(PATH + "/snapshots/" + prepared["profile_binding"]["snapshot_id"])
    rejected(response, 403, "PROFILE_OWNER_INVALID")
    assert checked_transactions and all(checked_transactions)
    assert business_counts(ctx) == (0, 0, 0, 0)


def test_other_real_cookie_cannot_read_or_prepare_original_private_snapshot(authorized_env):
    ctx = authorized_env
    initialize(ctx)
    body, prepared, _ = prepare(ctx)
    with TestClient(ctx["app"], raise_server_exceptions=False) as second:
        assert second.get(PATH).status_code == 200
        read = second.get(PATH + "/snapshots/" + prepared["profile_binding"]["snapshot_id"])
        rejected(read, 404, "PROFILE_SNAPSHOT_NOT_FOUND")
        foreign_prepare = second.post(PATH + "/prepare", json=payload(body))
        rejected(foreign_prepare, 404, "PROFILE_SCOPE_FORBIDDEN")
    assert business_counts(ctx) == (0, 0, 0, 0)
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileSnapshot).count() == 1


@pytest.mark.parametrize("operation", ["prepare", "snapshot"])
def test_snapshot_storage_failure_is_safe_503_not_empty(authorized_env, monkeypatch, operation):
    ctx = authorized_env
    initialize(ctx)
    body, prepared, _ = prepare(ctx)

    def unavailable():
        raise OperationalError("synthetic storage failure", {}, RuntimeError("not a body or credential"))

    monkeypatch.setattr(profile_snapshots, "SessionLocal", unavailable)
    if operation == "prepare":
        response = ctx["client"].post(PATH + "/prepare", json=payload(body))
    else:
        response = ctx["client"].get(PATH + "/snapshots/" + prepared["profile_binding"]["snapshot_id"])
    rejected(response, 503, "PROFILE_STORAGE_UNAVAILABLE")
    assert "snapshot" not in response.json()
    assert business_counts(ctx) == (0, 0, 0, 0)


def test_current_identity_can_replay_accepted_after_clear_but_revocation_cannot(authorized_env):
    ctx = authorized_env
    initial = initialize(ctx)
    body, prepared, _ = prepare(ctx)
    original = {**body, "profile_binding": prepared["profile_binding"]}
    first = ctx["client"].post("/api/v1/chat", json=original)
    assert first.status_code == 200
    assert "event: done" in first.text
    context = initial["authorization_context"]
    clear = ctx["client"].post(PATH + "/mutations", json={
        "profile_action_id": uuid4().hex, "operation": "clear", "expected_profile_version": 0,
        "expected_authorization_context": {key: context[key] for key in
                                           ("context_contract", "context_id", "operation_token")},
        "patch": {}, "explicit_save": True})
    assert clear.status_code == 200, (clear.status_code, code(clear))
    replay = ctx["client"].post("/api/v1/chat", json=original)
    assert replay.status_code == 200
    # Saved JSON is canonicalized; serialization key order is not SSE content.
    first_data = [json.loads(line[6:]) for line in first.text.splitlines() if line.startswith("data: ")]
    replay_data = [json.loads(line[6:]) for line in replay.text.splitlines() if line.startswith("data: ")]
    assert replay_data == first_data
    assert len(ctx["downstream"]) == 1
    before = business_counts(ctx)
    revoke(ctx)
    rejected(ctx["client"].post("/api/v1/chat", json=original), 403, "PROFILE_OWNER_INVALID")
    assert business_counts(ctx) == before
    assert len(ctx["downstream"]) == 1
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileSnapshot).one().state == "accepted"
