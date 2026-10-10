"""Atomic identity/intent seams, separate from UI login and actual model tests."""
import hashlib
import json
from copy import deepcopy
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.core.consumer_identity import AuthenticatedConsumerPrincipal, consumer_cookie_name
from app.models.consumer_context import (ConsumerAuthorizationContext, ConsumerIdentityRevocation,
                                        ConsumerMutationToken, ConsumerOperationContext)
from app.models.consumer_profile import ConsumerProfileIdentity, ConsumerProfileOperation, SavedConsumerProfile
from app.models.tryon import utcnow
from app.services import consumer_profiles
from tests.test_consumer_profiles import PATH, action, bound_action, profile_env, saved


def response_code(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


def count_success(factory):
    with factory() as db:
        return db.query(SavedConsumerProfile).count(), db.query(ConsumerProfileOperation).count()


def test_two_empty_subjects_get_distinct_nonsecret_contexts(profile_env):
    app, first, factory = profile_env
    a = first.get(PATH).json()
    with TestClient(app) as second:
        b = second.get(PATH).json()
    assert a["profile_id"] is b["profile_id"] is None
    assert a["profile_version"] == b["profile_version"] == 0
    assert a["authorization_context"]["context_id"] != b["authorization_context"]["context_id"]
    assert set(a["authorization_context"]) == {"context_contract", "context_id", "operation_token", "issued_at", "expires_at"}
    with factory() as db:
        assert db.query(ConsumerAuthorizationContext).count() == 2
        token = a["authorization_context"]["operation_token"]
        assert db.get(ConsumerMutationToken, hashlib.sha256(token.encode()).hexdigest()) is not None
        assert token not in " ".join(str(row.__dict__) for row in db.query(ConsumerMutationToken))
    assert count_success(factory) == (0, 0)


def test_new_get_keeps_context_but_issues_short_nonrenewing_token(profile_env):
    _, client, factory = profile_env
    a = client.get(PATH).json()["authorization_context"]
    with factory() as db:
        identity_expiry = db.query(ConsumerProfileIdentity).one().expires_at
    b = client.get(PATH).json()["authorization_context"]
    assert a["context_id"] == b["context_id"] and a["operation_token"] != b["operation_token"]
    with factory() as db:
        assert db.query(ConsumerProfileIdentity).one().expires_at == identity_expiry
        assert all(0 < (token.expires_at - token.issued_at).total_seconds() <= 600 for token in db.query(ConsumerMutationToken))


def test_old_empty_intent_cannot_write_second_empty_subject(profile_env):
    app, first, factory = profile_env
    old_intent = bound_action(first)
    with TestClient(app) as second:
        second.get(PATH)
        response_code(second.post(PATH + "/mutations", json=old_intent), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    assert count_success(factory) == (0, 0)


def test_equal_version_subjects_and_get_then_cookie_swap_reject_old_intent(profile_env):
    app, first, factory = profile_env
    saved(first)
    old_intent = bound_action(first, action_id="a-update", version=1, operation="update",
                             patch={"base_profile": {"height_cm": 165}})
    with TestClient(app) as second:
        saved(second)
        assert second.get(PATH).json()["profile_version"] == first.get(PATH).json()["profile_version"] == 1
        other_cookie = second.cookies.get(consumer_cookie_name())
    first.cookies.clear()
    first.cookies.set(consumer_cookie_name(), other_cookie)
    response_code(first.post(PATH + "/mutations", json=old_intent), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    assert first.get(PATH).json()["base_profile"]["height_cm"] is None
    assert count_success(factory) == (2, 2)


def test_other_subject_existing_same_action_cannot_bypass_context_check(profile_env):
    app, first, factory = profile_env
    saved(first)
    old = first._profile_action_bodies["save-a"]
    with TestClient(app) as second:
        saved(second)
        response_code(second.post(PATH + "/mutations", json=old), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    assert count_success(factory) == (2, 2)


def test_old_action_404_does_not_authorize_new_subject_retry(profile_env):
    app, first, factory = profile_env
    old_intent = bound_action(first, action_id="never-accepted")
    with TestClient(app) as second:
        second.get(PATH)
        response_code(second.get(PATH + "/operations/never-accepted"), 404, "PROFILE_OPERATION_NOT_FOUND")
        response_code(second.post(PATH + "/mutations", json=old_intent), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    assert count_success(factory) == (0, 0)


def test_same_current_context_valid_original_after_404_can_accept_once(profile_env):
    _, client, factory = profile_env
    original = bound_action(client, action_id="pending-404")
    response_code(client.get(PATH + "/operations/pending-404"), 404, "PROFILE_OPERATION_NOT_FOUND")
    accepted = client.post(PATH + "/mutations", json=original)
    assert accepted.status_code == 200
    assert client.post(PATH + "/mutations", json=original).json() == accepted.json()
    assert count_success(factory) == (1, 1)


def test_context_survives_engine_reopen_and_same_browser_cookie(profile_env):
    app, client, factory = profile_env
    first = client.get(PATH).json()["authorization_context"]
    cookie = client.cookies.get(consumer_cookie_name())
    factory.kw["bind"].dispose()
    with TestClient(app) as reopened:
        reopened.cookies.set(consumer_cookie_name(), cookie)
        current = reopened.get(PATH).json()["authorization_context"]
    assert current["context_id"] == first["context_id"]
    assert current["operation_token"] != first["operation_token"]


def test_missing_context_old_pending_fails_validation_without_write(profile_env):
    _, client, factory = profile_env
    body = action()
    del body["expected_authorization_context"]
    response_code(client.post(PATH + "/mutations", json=body), 422, "INVALID_REQUEST")
    assert count_success(factory) == (0, 0)


@pytest.mark.parametrize("change", ["context_id", "operation_token", "context_contract", "unknown"])
def test_forged_or_unknown_context_never_writes(profile_env, change):
    _, client, factory = profile_env
    body = bound_action(client)
    context = body["expected_authorization_context"]
    if change == "context_id":
        context[change] = "nonexistent-context"
    elif change == "operation_token":
        context[change] = "x" * 43
    elif change == "context_contract":
        context[change] = "made-up-contract"
    else:
        context["owner_ref"] = "other-person"
    response = client.post(PATH + "/mutations", json=body)
    if change in {"context_contract", "unknown"}:
        response_code(response, 422, "INVALID_REQUEST")
    else:
        response_code(response, 403, "PROFILE_AUTH_CONTEXT_INVALID")
    assert count_success(factory) == (0, 0)


def test_pending_token_expired_and_success_receipt_replay_order(profile_env):
    _, client, factory = profile_env
    saved(client)
    original = client._profile_action_bodies["save-a"]
    pending = bound_action(client, action_id="pending", version=1, operation="update",
                           patch={"base_profile": {"height_cm": 165}})
    with factory() as db:
        db.query(ConsumerMutationToken).update({"expires_at": utcnow() - timedelta(seconds=1)})
        db.commit()
    response_code(client.post(PATH + "/mutations", json=pending), 409, "PROFILE_AUTH_CONTEXT_EXPIRED")
    assert client.post(PATH + "/mutations", json=original).json() == client.get(PATH + "/operations/save-a").json()
    assert count_success(factory) == (1, 1)


def test_clear_keeps_context_revokes_pending_and_old_success_cannot_restore(profile_env):
    _, client, factory = profile_env
    original_receipt = saved(client)
    original_body = client._profile_action_bodies["save-a"]
    pending = bound_action(client, action_id="pending", version=1, operation="update",
                           patch={"base_profile": {"height_cm": 165}})
    context_id = pending["expected_authorization_context"]["context_id"]
    saved(client, action_id="clear", version=1, operation="clear", patch={})
    current = client.get(PATH).json()
    assert current["authorization_context"]["context_id"] == context_id
    response_code(client.post(PATH + "/mutations", json=pending), 409, "PROFILE_AUTH_CONTEXT_INVALIDATED")
    assert client.post(PATH + "/mutations", json=original_body).json() == original_receipt
    assert client.get(PATH).json()["status"] == "cleared"
    assert count_success(factory) == (1, 2)
    with factory() as db:
        digest = hashlib.sha256(pending["expected_authorization_context"]["operation_token"].encode()).hexdigest()
        assert db.get(ConsumerMutationToken, digest).revoked_at is not None
        assert db.query(ConsumerOperationContext).count() == 2
        assert all(token.revoked_at is not None for token in db.query(ConsumerMutationToken)
                   if token.accepted_action_id in {"save-a", "clear"})


def test_same_action_with_new_token_is_body_conflict_not_rebound(profile_env):
    _, client, factory = profile_env
    saved(client)
    body = bound_action(client)
    response_code(client.post(PATH + "/mutations", json=body), 409, "PROFILE_ACTION_CONFLICT")
    assert count_success(factory) == (1, 1)


def test_clear_invalidates_other_valid_login_instance_tokens_of_same_owner(profile_env):
    app, client, factory = profile_env
    def principal(instance):
        return AuthenticatedConsumerPrincipal("personalized_styling", "synthetic-user",
            auth_instance_id=instance, expires_at=utcnow() + timedelta(hours=1), revalidate=lambda db: True)
    app.state.principal = principal("still-valid-one")
    saved(client)
    pending = bound_action(client, action_id="old-other-instance", version=1, operation="update",
                           patch={"base_profile": {"height_cm": 165}})
    app.state.principal = principal("still-valid-two")
    saved(client, action_id="clear", version=1, operation="clear", patch={})
    app.state.principal = principal("still-valid-one")
    response_code(client.post(PATH + "/mutations", json=pending), 409, "PROFILE_AUTH_CONTEXT_INVALIDATED")
    assert client.get(PATH).json()["status"] == "cleared"
    assert count_success(factory) == (1, 2)


def test_profile_and_safe_errors_are_no_store(profile_env):
    _, client, _ = profile_env
    initial = client.get(PATH)
    assert initial.headers["cache-control"] == "no-store"
    body = bound_action(client)
    mutation = client.post(PATH + "/mutations", json=body)
    assert mutation.status_code == 200 and mutation.headers["cache-control"] == "no-store"
    lookup = client.get(PATH + "/operations/save-a")
    assert lookup.headers["cache-control"] == "no-store"
    body["expected_authorization_context"]["context_id"] = "missing"
    rejected = client.post(PATH + "/mutations", json=body)
    assert rejected.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("failure", ["expiry", "revocation"])
def test_identity_invalidated_between_resolver_and_mutation_transaction_rejects(profile_env, monkeypatch, failure):
    _, client, factory = profile_env
    body = bound_action(client)
    original_lock = consumer_profiles._lock
    def invalidate_before_lock(db):
        with factory() as another:
            identity = another.query(ConsumerProfileIdentity).one()
            if failure == "expiry":
                identity.expires_at = utcnow() - timedelta(seconds=1)
            else:
                another.add(ConsumerIdentityRevocation(owner_ref=identity.owner_ref))
            another.commit()
        original_lock(db)
    monkeypatch.setattr(consumer_profiles, "_lock", invalidate_before_lock)
    response_code(client.post(PATH + "/mutations", json=body), 403, "PROFILE_OWNER_INVALID")
    assert count_success(factory) == (0, 0)


def test_invalid_identity_cannot_replay_success_or_query_receipt(profile_env):
    _, client, factory = profile_env
    saved(client)
    old_body = client._profile_action_bodies["save-a"]
    with factory() as db:
        db.add(ConsumerIdentityRevocation(owner_ref=db.query(ConsumerProfileIdentity).one().owner_ref))
        db.commit()
    response_code(client.post(PATH + "/mutations", json=old_body), 403, "PROFILE_OWNER_INVALID")
    response_code(client.get(PATH + "/operations/save-a"), 403, "PROFILE_OWNER_INVALID")


def test_old_no_context_success_is_query_only_and_never_backfilled(profile_env):
    _, client, factory = profile_env
    saved(client)
    original = client._profile_action_bodies["save-a"]
    old = deepcopy(original)
    del old["expected_authorization_context"]
    with factory() as db:
        record = db.query(ConsumerProfileOperation).one()
        db.query(ConsumerOperationContext).delete()
        record.payload_digest = hashlib.sha256(consumer_profiles._encoded(old).encode()).hexdigest()
        db.commit()
    assert client.get(PATH + "/operations/save-a").status_code == 200
    response_code(client.post(PATH + "/mutations", json=old), 422, "INVALID_REQUEST")
    response_code(client.post(PATH + "/mutations", json=original), 409, "PROFILE_ACTION_CONFLICT")
    with factory() as db:
        assert db.query(ConsumerOperationContext).count() == 0


def test_same_subject_new_trusted_auth_instance_rejects_old_intent(profile_env):
    app, client, factory = profile_env
    active = {"instance": "login-one", "enabled": True}
    def principal(instance):
        return AuthenticatedConsumerPrincipal("personalized_styling", "synthetic-user",
            auth_instance_id=instance, expires_at=utcnow() + timedelta(hours=1),
            revalidate=lambda db: active["enabled"] and active["instance"] == instance)
    app.state.principal = principal("login-one")
    old = bound_action(client)
    active["instance"] = "login-two"
    app.state.principal = principal("login-two")
    response_code(client.post(PATH + "/mutations", json=old), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    fresh = client.get(PATH).json()["authorization_context"]
    assert fresh["context_id"] != old["expected_authorization_context"]["context_id"]
    active["enabled"] = False
    response_code(client.get(PATH), 403, "PROFILE_OWNER_INVALID")
    assert count_success(factory) == (0, 0)


def test_trusted_subject_without_real_auth_instance_cannot_issue_mutation_token(profile_env):
    app, client, factory = profile_env
    app.state.principal = AuthenticatedConsumerPrincipal("personalized_styling", "legacy-read-adapter")
    response_code(client.get(PATH), 403, "PROFILE_AUTH_CONTEXT_INVALID")
    with factory() as db:
        assert db.query(ConsumerMutationToken).count() == 0


def test_scope_switch_rejects_original_context(profile_env, monkeypatch):
    _, client, factory = profile_env
    old = bound_action(client)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "new_application_scope")
    client.get(PATH)
    response_code(client.post(PATH + "/mutations", json=old), 403, "PROFILE_AUTH_CONTEXT_CHANGED")
    assert count_success(factory) == (0, 0)


def test_receipt_and_internal_prepare_read_have_no_context_or_secret(profile_env):
    _, client, factory = profile_env
    receipt = saved(client)
    token = client._profile_action_bodies["save-a"]["expected_authorization_context"]["operation_token"]
    assert "authorization_context" not in receipt and token not in json.dumps(receipt)
    from app.core.consumer_identity import ConsumerOwner
    with factory() as db:
        row = db.query(SavedConsumerProfile).one()
        owner = ConsumerOwner(row.app_scope, row.scope_kind, row.owner_ref)
        before = db.query(ConsumerMutationToken).count()
    internal = consumer_profiles.read_profile(owner)
    assert "authorization_context" not in internal
    with factory() as db:
        assert db.query(ConsumerMutationToken).count() == before
        assert token not in " ".join(str(row.__dict__) for row in db.query(ConsumerProfileOperation))


def test_context_record_write_failure_rolls_back_profile_and_operation(profile_env):
    _, client, factory = profile_env
    body = bound_action(client)
    def fail(*args):
        from sqlalchemy.exc import OperationalError
        raise OperationalError("synthetic context write failure", {}, RuntimeError("private body"))
    event.listen(ConsumerOperationContext, "before_insert", fail)
    try:
        response_code(client.post(PATH + "/mutations", json=body), 503, "PROFILE_STORAGE_UNAVAILABLE")
    finally:
        event.remove(ConsumerOperationContext, "before_insert", fail)
    assert count_success(factory) == (0, 0)
    with factory() as db:
        assert db.query(ConsumerOperationContext).count() == 0
        assert db.query(ConsumerMutationToken).one().accepted_action_id is None
