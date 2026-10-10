"""Real temp SQLite + FastAPI identity/revision tests; no model calls or main data."""
import json
import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.consumer_profiles import profile_error_handler, router
from app.core import consumer_identity
from app.core.consumer_identity import AuthenticatedConsumerPrincipal, ConsumerAuthorization, ConsumerOwner, consumer_cookie_name
from app.models.cart import CartItem
from app.models.chat import Base
from app.models.consumer_event import ConsumerEvent
from app.models.consumer_profile import ConsumerProfileIdentity, ConsumerProfileOperation, SavedConsumerProfile
from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.models.tryon import utcnow
from app.schemas.consumer_profile import ProfileError, ProfileMutation
from app.services import consumer_profiles

PATH = "/api/v1/consumer-profile"
SIZES = {"top": {"system": "clothing_alpha", "value": "M"},
         "bottom": {"system": "clothing_alpha", "value": "M"},
         "shoes": {"system": "cn_shoe", "value": "38"}}


@pytest.fixture
def profile_env(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path}/profiles.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "personalized_styling")
    monkeypatch.setattr(consumer_identity, "SessionLocal", factory)
    monkeypatch.setattr(consumer_profiles, "SessionLocal", factory)
    monkeypatch.setattr(consumer_profiles, "_invalidate_prepared", lambda db, owner: 0)
    app = FastAPI()
    app.include_router(router)
    app.add_exception_handler(ProfileError, profile_error_handler)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, _error):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST", "message": "资料字段无效"}})

    @app.middleware("http")
    async def trusted_adapter(request, call_next):
        if getattr(app.state, "principal", None) is not None:
            request.state.consumer_principal = app.state.principal
        return await call_next(request)

    client = TestClient(app)
    yield app, client, factory
    client.close()
    engine.dispose()


def action(action_id="save-a", version=0, operation="save", patch=None, **extra):
    return {"profile_action_id": action_id, "operation": operation, "expected_profile_version": version,
            "expected_authorization_context": {"context_contract": "consumer_profile_mutation_context_v1",
                "context_id": "validation-placeholder", "operation_token": "x" * 43},
            "patch": patch if patch is not None else {"base_profile": {"usual_sizes": SIZES}},
            "explicit_save": True, **extra}


def saved(client, **kwargs):
    body = bound_action(client, **kwargs)
    response = client.post(PATH + "/mutations", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def bound_action(client, **kwargs):
    context = client.get(PATH).json()["authorization_context"]
    body = action(**kwargs, expected_authorization_context={key: context[key] for key in
                 ("context_contract", "context_id", "operation_token")})
    if not hasattr(client, "_profile_action_bodies"):
        client._profile_action_bodies = {}
    client._profile_action_bodies[body["profile_action_id"]] = body
    return body


def trusted_principal(subject):
    return AuthenticatedConsumerPrincipal("personalized_styling", subject,
        auth_instance_id="synthetic-auth-" + subject, expires_at=utcnow() + timedelta(hours=1),
        revalidate=lambda db: True)


def test_empty_anonymous_cookie_and_explicit_save_counts(profile_env):
    _, client, factory = profile_env
    initial = client.get(PATH)
    assert initial.status_code == 200
    assert initial.json()["status"] == "empty" and initial.json()["profile_version"] == 0
    assert initial.json()["base_profile"]["usual_sizes"] == {"top": None, "bottom": None, "shoes": None}
    cookie = initial.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Path=/" in cookie and "Max-Age=" in cookie
    receipt = saved(client)
    assert receipt["profile_version"] == 1 and receipt["profile_status"] == "saved"
    assert receipt["changed_field_names"] == ["base_profile.usual_sizes.bottom", "base_profile.usual_sizes.shoes", "base_profile.usual_sizes.top"]
    assert "base_profile" not in receipt
    current = client.get(PATH).json()
    assert current["base_profile"]["usual_sizes"] == SIZES
    assert current["base_profile"]["height_cm"] is None
    with factory() as db:
        assert db.query(ConsumerProfileOperation).count() == 1
        assert all(db.query(table).count() == 0 for table in (DemandTurn, GenerationRequest, ConsumerEvent, CartItem))
        identity = db.scalars(select(ConsumerProfileIdentity)).one()
        assert identity.token_hash != client.cookies.get(consumer_cookie_name())
        assert len(identity.token_hash) == 64


def test_same_browser_new_client_and_service_read_keep_profile(profile_env):
    app, client, factory = profile_env
    receipt = saved(client)
    cookie = client.cookies.get(consumer_cookie_name())
    with TestClient(app) as reopened:
        reopened.cookies.set(consumer_cookie_name(), cookie)
        assert reopened.get(PATH).json()["profile_id"] == receipt["profile_id"]
        assert reopened.get(PATH).json()["profile_version"] == 1
    with factory() as db:
        row = db.scalars(select(SavedConsumerProfile)).one()
        owner = ConsumerOwner(row.app_scope, row.scope_kind, row.owner_ref)
    # New sessions still read only persisted values, not any process cache.
    assert consumer_profiles.read_profile(owner)["base_profile"]["usual_sizes"] == SIZES


def test_two_browsers_and_client_identity_injection_do_not_share(profile_env):
    app, client, _ = profile_env
    receipt = saved(client)
    with TestClient(app) as second:
        assert second.get(PATH + "?user_id=other&device_id=other").json()["status"] == "empty"
        assert second.get(PATH + "/operations/save-a").status_code == 404
        spoof = second.post(PATH + "/mutations", json={**action(), "profile_id": receipt["profile_id"], "user_id": "other"})
        assert spoof.status_code == 422
        assert second.get(PATH, headers={"X-Consumer-User": "other"}).json()["status"] == "empty"
    assert client.get(PATH).json()["profile_version"] == 1


def test_authenticated_server_fixture_user_scope_and_logout_are_isolated(profile_env):
    app, client, _ = profile_env
    app.state.principal = trusted_principal("trusted-user-a")
    first = saved(client)
    assert client.get(PATH).json()["scope_kind"] == "user"
    app.state.principal = trusted_principal("trusted-user-b")
    assert client.get(PATH).json()["status"] == "empty"
    assert client.get(PATH + "/operations/save-a").status_code == 404
    app.state.principal = None
    assert client.get(PATH).json()["scope_kind"] == "device"
    assert client.get(PATH).json()["status"] == "empty"
    app.state.principal = trusted_principal("trusted-user-a")
    assert client.get(PATH).json()["profile_id"] == first["profile_id"]


@pytest.mark.parametrize("principal", [{"app_scope": "personalized_styling", "subject_id": "spoof"},
                                       AuthenticatedConsumerPrincipal("other-space", "user-a")])
def test_untrusted_state_or_wrong_authorization_space_is_rejected(profile_env, principal):
    app, client, _ = profile_env
    app.state.principal = principal
    response = client.get(PATH)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PROFILE_OWNER_INVALID"


def test_app_spaces_have_different_identity_cookie_and_profile_binding(profile_env, monkeypatch):
    _, client, _ = profile_env
    first = saved(client)
    a_cookie = consumer_cookie_name()
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "other_app")
    assert consumer_cookie_name() != a_cookie
    assert client.get(PATH).json()["status"] == "empty"
    second = saved(client)
    assert second["profile_id"] != first["profile_id"]
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "personalized_styling")
    assert client.get(PATH).json()["profile_id"] == first["profile_id"]


def test_https_secure_cookie_and_cross_site_mutation_rejection(profile_env):
    app, client, factory = profile_env
    with TestClient(app, base_url="https://testserver") as secure:
        response = secure.get(PATH)
        assert "Secure" in response.headers["set-cookie"]
        assert secure.post(PATH + "/mutations", json=action(), headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post(PATH + "/mutations", json=action(), headers={"sec-fetch-site": "cross-site"}).status_code == 403
    with factory() as db:
        assert db.query(SavedConsumerProfile).count() == 0


def test_missing_explicit_save_and_default_budget_confirmation_do_not_write(profile_env):
    _, client, factory = profile_env
    assert client.post(PATH + "/mutations", json=action(explicit_save=False)).status_code == 422
    body = action(patch={"default_budget_fen": 80000})
    assert client.post(PATH + "/mutations", json=body).status_code == 422
    assert saved(client, patch={"default_budget_fen": 80000}, explicit_default_budget=True)["profile_version"] == 1
    assert client.get(PATH).json()["default_budget_fen"] == 80000
    with factory() as db:
        assert db.query(ConsumerProfileOperation).count() == 1


def test_partial_update_null_and_monotonic_clear_without_old_body_receipts(profile_env):
    _, client, factory = profile_env
    first = saved(client, patch={"base_profile": {"height_cm": 168.5, "weight_kg": 58.5, "usual_sizes": SIZES},
                                 "default_budget_fen": 80000}, explicit_default_budget=True)
    partial = saved(client, action_id="update-a", version=1, operation="update", patch={"base_profile": {"height_cm": None}})
    current = client.get(PATH).json()
    assert partial["profile_version"] == 2
    assert current["base_profile"]["height_cm"] is None and current["base_profile"]["weight_kg"] == 58.5
    assert current["base_profile"]["usual_sizes"] == SIZES and current["default_budget_fen"] == 80000
    clear = saved(client, action_id="clear-a", version=2, operation="clear", patch={})
    current = client.get(PATH).json()
    assert clear["profile_version"] == 3 and current["status"] == "cleared"
    assert current["profile_id"] == first["profile_id"]
    assert current["base_profile"] == {"height_cm": None, "weight_kg": None, "usual_sizes": {"top": None, "bottom": None, "shoes": None}}
    assert current["default_budget_fen"] is None
    with factory() as db:
        row = db.scalars(select(SavedConsumerProfile)).one()
        assert "58.5" not in row.base_profile_json and "168.5" not in row.base_profile_json
        for record in db.scalars(select(ConsumerProfileOperation)):
            assert "58.5" not in record.result_json and "168.5" not in record.result_json
            assert not hasattr(record, "patch_json")


def test_replay_old_save_returns_original_receipt_without_reviving_clear(profile_env):
    _, client, factory = profile_env
    first = saved(client)
    original = client._profile_action_bodies["save-a"]
    assert client.post(PATH + "/mutations", json=original).json() == first
    saved(client, action_id="clear-a", version=1, operation="clear", patch={})
    assert client.post(PATH + "/mutations", json=original).json() == first
    assert client.get(PATH + "/operations/save-a").json() == first
    current = client.get(PATH).json()
    assert current["profile_version"] == 2 and current["status"] == "cleared"
    with factory() as db:
        assert db.query(ConsumerProfileOperation).count() == 2


def test_same_action_changed_body_and_stale_version_conflict(profile_env):
    _, client, _ = profile_env
    saved(client)
    changed = bound_action(client, patch={"base_profile": {"height_cm": 165}})
    assert client.post(PATH + "/mutations", json=changed).json()["error"]["code"] == "PROFILE_ACTION_CONFLICT"
    stale = bound_action(client, action_id="new-a", operation="update", patch={"base_profile": {"height_cm": 165}})
    response = client.post(PATH + "/mutations", json=stale)
    assert response.status_code == 409 and response.json()["error"]["code"] == "PROFILE_VERSION_CONFLICT"
    assert client.get(PATH).json()["profile_version"] == 1


def test_true_concurrent_different_actions_have_one_winner(profile_env):
    _, _, factory = profile_env
    principal = trusted_principal("trusted-concurrent-user")
    owner = ConsumerOwner(principal.app_scope, "user", hashlib.sha256((principal.app_scope + "\0" + principal.subject_id).encode()).hexdigest())
    authorization = ConsumerAuthorization(owner, principal=principal)
    context = consumer_profiles.read_profile(owner, authorization=authorization)["authorization_context"]
    expected = {key: context[key] for key in ("context_contract", "context_id", "operation_token")}
    def save_one(ident):
        try:
            # Each explicit concurrent intent has a separately issued operation token.
            current = consumer_profiles.read_profile(owner, authorization=authorization)["authorization_context"]
            own_expected = {key: current[key] for key in expected}
            return consumer_profiles.mutate_profile(owner, ProfileMutation.model_validate(action(action_id=ident,
                expected_authorization_context=own_expected)), authorization=authorization)
        except ProfileError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save_one, ["concurrent-a", "concurrent-b"]))
    assert sum(isinstance(item, dict) for item in results) == 1
    assert "PROFILE_VERSION_CONFLICT" in results
    with factory() as db:
        assert db.query(SavedConsumerProfile).count() == db.query(ConsumerProfileOperation).count() == 1


def test_true_concurrent_same_action_replays_one_receipt(profile_env):
    _, _, factory = profile_env
    principal = trusted_principal("trusted-concurrent-user")
    owner = ConsumerOwner(principal.app_scope, "user", hashlib.sha256((principal.app_scope + "\0" + principal.subject_id).encode()).hexdigest())
    authorization = ConsumerAuthorization(owner, principal=principal)
    context = consumer_profiles.read_profile(owner, authorization=authorization)["authorization_context"]
    request = ProfileMutation.model_validate(action(expected_authorization_context={key: context[key] for key in
                ("context_contract", "context_id", "operation_token")}))
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: consumer_profiles.mutate_profile(owner, request, authorization=authorization), range(2)))
    assert results[0] == results[1]
    with factory() as db:
        assert db.query(ConsumerProfileOperation).count() == 1
        assert db.scalars(select(SavedConsumerProfile)).one().profile_version == 1


def test_null_group_and_default_clear_do_not_delete_other_fields(profile_env):
    _, client, _ = profile_env
    saved(client, patch={"base_profile": {"height_cm": 168.5, "usual_sizes": SIZES}, "default_budget_fen": 80000}, explicit_default_budget=True)
    saved(client, action_id="clear-size-budget", version=1, operation="update",
          patch={"base_profile": {"usual_sizes": None}, "default_budget_fen": None}, explicit_default_budget=True)
    current = client.get(PATH).json()
    assert current["base_profile"]["usual_sizes"] == {"top": None, "bottom": None, "shoes": None}
    assert current["base_profile"]["height_cm"] == 168.5 and current["default_budget_fen"] is None


def test_clear_and_any_null_delete_invalidate_in_same_transaction(profile_env, monkeypatch):
    _, client, _ = profile_env
    seen = []
    def invalidate(db, owner):
        assert db.in_transaction()
        seen.append(owner.binding_key)
        return 1
    monkeypatch.setattr(consumer_profiles, "_invalidate_prepared", invalidate)
    saved(client)
    saved(client, action_id="height-a", version=1, operation="update", patch={"base_profile": {"height_cm": 165}})
    assert seen == []
    saved(client, action_id="null-a", version=2, operation="update", patch={"base_profile": {"height_cm": None}})
    saved(client, action_id="clear-a", version=3, operation="clear", patch={})
    assert len(seen) == 2 and seen[0] == seen[1]


def test_invalidation_storage_failure_rolls_back_clear_and_receipt(profile_env, monkeypatch):
    from sqlalchemy.exc import OperationalError
    _, client, factory = profile_env
    saved(client)
    before = client.get(PATH).json()
    def broken(db, owner):
        raise OperationalError("storage unavailable", {}, RuntimeError("synthetic failure"))
    monkeypatch.setattr(consumer_profiles, "_invalidate_prepared", broken)
    response = client.post(PATH + "/mutations", json=bound_action(client, action_id="bad-clear", version=1, operation="clear", patch={}))
    assert response.status_code == 503
    after = client.get(PATH).json()
    assert after["authorization_context"]["context_id"] == before["authorization_context"]["context_id"]
    assert {key: value for key, value in after.items() if key != "authorization_context"} == {
        key: value for key, value in before.items() if key != "authorization_context"}
    with factory() as db:
        assert db.query(ConsumerProfileOperation).count() == 1


def test_corrupt_stored_body_is_unavailable_not_empty(profile_env):
    _, client, factory = profile_env
    saved(client)
    with factory() as db:
        row = db.scalars(select(SavedConsumerProfile)).one()
        row.base_profile_json = '{"height_cm":"corrupt-private-value"}'
        db.commit()
    response = client.get(PATH)
    assert response.status_code == 503 and "corrupt-private-value" not in response.text


def test_expiry_clears_values_increments_marker_and_records_only_metadata(profile_env):
    _, client, factory = profile_env
    saved(client, patch={"base_profile": {"height_cm": 168.5}})
    with factory() as db:
        row = db.scalars(select(SavedConsumerProfile)).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    current = client.get(PATH).json()
    assert current["status"] == "expired" and current["profile_version"] == 2
    assert current["base_profile"]["height_cm"] is None
    with factory() as db:
        expire = db.query(ConsumerProfileOperation).filter_by(operation_type="expire").one()
        assert "168.5" not in expire.result_json


def test_expired_or_forged_cookie_never_recovers_another_subject(profile_env):
    _, client, factory = profile_env
    saved(client)
    with factory() as db:
        row = db.scalars(select(ConsumerProfileIdentity)).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.get(PATH).json()["status"] == "empty"
    client.cookies.clear()
    client.cookies.set(consumer_cookie_name(), "x" * 43)
    assert client.get(PATH).json()["status"] == "empty"


@pytest.mark.parametrize("field,value", [("height_cm", 99.5), ("height_cm", 250.5), ("height_cm", 168.2),
                                         ("height_cm", True), ("height_cm", "168"), ("weight_kg", 19.5),
                                         ("weight_kg", 300.5), ("weight_kg", float("nan")), ("weight_kg", float("inf"))])
def test_measurement_invalid_bounds_and_types(field, value):
    with pytest.raises(ValidationError):
        ProfileMutation.model_validate(action(patch={"base_profile": {field: value}}))


@pytest.mark.parametrize("patch", [{"base_profile": {"usual_sizes": {"top": {"system": "cn_shoe", "value": "38"}}}},
                                  {"base_profile": {"usual_sizes": {"shoes": {"system": "cn_shoe", "value": "35.5"}}}},
                                  {"base_profile": {"usual_sizes": {"shoes": {"system": "cn_shoe", "value": 38}}}},
                                  {"default_budget_fen": True}, {"default_budget_fen": 80000.0},
                                  {"default_budget_fen": 0}, {"base_profile": {"scene": "通勤"}},
                                  {"base_profile": {}}, {}])
def test_invalid_slot_budget_scope_or_empty_patch(patch):
    with pytest.raises(ValidationError):
        ProfileMutation.model_validate(action(patch=patch, explicit_default_budget=True))


def test_legal_uncovered_sizes_save_without_generation(profile_env):
    _, client, factory = profile_env
    sizes = {"top": {"system": "clothing_alpha", "value": "S"},
             "bottom": {"system": "clothing_alpha", "value": "XL"},
             "shoes": {"system": "cn_shoe", "value": "39"}}
    saved(client, patch={"base_profile": {"usual_sizes": sizes}})
    assert client.get(PATH).json()["base_profile"]["usual_sizes"] == sizes
    with factory() as db:
        assert db.query(GenerationRequest).count() == db.query(DemandTurn).count() == 0


def test_storage_failure_is_not_empty_or_save_success(profile_env, monkeypatch):
    from sqlalchemy.exc import OperationalError
    _, client, _ = profile_env
    client.get(PATH)
    def unavailable():
        raise OperationalError("storage unavailable", {}, RuntimeError("synthetic failure"))
    monkeypatch.setattr(consumer_profiles, "SessionLocal", unavailable)
    response = client.get(PATH)
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROFILE_STORAGE_UNAVAILABLE"
    response = client.post(PATH + "/mutations", json=action())
    assert response.status_code == 503
