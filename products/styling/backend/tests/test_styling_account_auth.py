"""Styling single-account bindings, legacy compatibility and identity rejection."""
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import event, inspect
from starlette.requests import Request

from app.core import admin_auth
from app.core.database import SessionLocal, engine
from app.models.demand import DemandAdminSession
from app.models.styling_account import StylingAccountSession
from app.models.tryon import utcnow


@pytest.fixture(autouse=True)
def account_fixture(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-account-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-account-signing-key-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    for key in ("STYLING_ADMIN_SUBJECT", "STYLING_ADMIN_SCOPE", "STYLING_DIRECT_INSTANCE_ID",
                "STYLING_ADMIN_ENABLED", "STYLING_ADMIN_PUBLIC_ORIGIN"):
        monkeypatch.delenv(key, raising=False)
    with SessionLocal() as db:
        db.query(StylingAccountSession).delete()
        db.query(DemandAdminSession).delete()
        db.commit()


def bind_account(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_SUBJECT", "demo-styling-manager")
    monkeypatch.setenv("STYLING_ADMIN_SCOPE", "synthetic-enterprise")
    monkeypatch.setenv("STYLING_DIRECT_INSTANCE_ID", "styling-local-test")


def request(cookie=None, *, method="GET", extra_headers=(), host="127.0.0.1:8059",
            client="127.0.0.1", scheme="http"):
    headers = [(b"host", host.encode())]
    if cookie is not None:
        headers.append((b"cookie", f"{admin_auth.COOKIE}={cookie}".encode()))
    headers.extend((key.encode(), value.encode()) for key, value in extra_headers)
    return Request({"type": "http", "method": method, "headers": headers,
                    "scheme": scheme, "path": "/api/v1/admin/overview", "query_string": b"",
                    "server": ("127.0.0.1", 8059), "client": (client, 40404)})


def test_new_session_records_account_and_old_session_in_same_transaction(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    principal = admin_auth.require_account_bound(request(cookie))
    assert principal.subject == "demo-styling-manager"
    assert principal.scope == "synthetic-enterprise"
    assert principal.source_instance_id == "styling-local-test"
    assert principal.audience == "personal_styling"
    assert principal.auth_method == "password_single_account"
    assert principal.approval_identity_kind == "account_bound"
    with SessionLocal() as db:
        legacy = db.query(DemandAdminSession).one()
        account = db.query(StylingAccountSession).one()
        assert account.session_id == legacy.id == principal.session_id
        assert legacy.expires_at == account.expires_at
    # The old table has not gained account/person columns or a migrated identity.
    assert {column["name"] for column in inspect(engine).get_columns("demand_admin_sessions")} == {
        "id", "expires_at", "revoked_at", "created_at"}


def test_partial_account_configuration_is_not_silently_shared_role(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_SUBJECT", "demo-manager")
    with pytest.raises(HTTPException) as rejected:
        admin_auth.token()
    assert rejected.value.status_code == 503
    with SessionLocal() as db:
        assert db.query(DemandAdminSession).count() == db.query(StylingAccountSession).count() == 0


@pytest.mark.parametrize("value", ["", " manager ", "../../someone", "a" * 129])
def test_invalid_config_does_not_create_account_or_session(monkeypatch, value):
    bind_account(monkeypatch)
    monkeypatch.setenv("STYLING_ADMIN_SUBJECT", value)
    with pytest.raises(HTTPException) as rejected:
        admin_auth.token()
    assert rejected.value.status_code == 503
    with SessionLocal() as db:
        assert db.query(DemandAdminSession).count() == db.query(StylingAccountSession).count() == 0


def test_legacy_cookie_remains_legacy_after_enabling_new_account(monkeypatch):
    old_cookie = admin_auth.token()
    with SessionLocal() as db:
        old_row = db.query(DemandAdminSession).one()
        old_id, old_expiry = old_row.id, old_row.expires_at
    bind_account(monkeypatch)
    new_cookie = admin_auth.token()
    legacy = admin_auth.require_admin(request(old_cookie))
    assert legacy.approval_identity_kind == "legacy_shared_role"
    assert legacy.subject is legacy.scope is legacy.source_instance_id is None
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_account_bound(request(old_cookie))
    assert rejected.value.status_code == 403
    assert admin_auth.require_account_bound(request(new_cookie)).subject == "demo-styling-manager"
    with SessionLocal() as db:
        assert db.get(StylingAccountSession, old_id) is None
        assert db.get(DemandAdminSession, old_id).expires_at == old_expiry
        assert db.query(StylingAccountSession).count() == 1


def test_account_failure_rolls_back_legacy_session_creation(monkeypatch):
    bind_account(monkeypatch)
    def blocked_insert(*args):
        raise RuntimeError("synthetic account write failure")
    event.listen(StylingAccountSession, "before_insert", blocked_insert)
    try:
        with pytest.raises(RuntimeError):
            admin_auth.token()
    finally:
        event.remove(StylingAccountSession, "before_insert", blocked_insert)
    with SessionLocal() as db:
        assert db.query(DemandAdminSession).count() == db.query(StylingAccountSession).count() == 0


@pytest.mark.parametrize("changed", ["STYLING_ADMIN_SUBJECT", "STYLING_ADMIN_SCOPE", "STYLING_DIRECT_INSTANCE_ID"])
def test_configuration_switch_invalidates_bound_session_immediately(monkeypatch, changed):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    assert admin_auth.require_account_bound(request(cookie))
    monkeypatch.setenv(changed, "another-authorized-config")
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie))
    assert rejected.value.status_code == 401


def test_removing_account_config_cannot_downgrade_existing_session(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    for key in ("STYLING_ADMIN_SUBJECT", "STYLING_ADMIN_SCOPE", "STYLING_DIRECT_INSTANCE_ID"):
        monkeypatch.delenv(key)
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie))
    assert rejected.value.status_code == 401


@pytest.mark.parametrize("enabled", ["0", "false", "disabled", "typo"])
def test_service_disable_rejects_existing_session_and_new_login(monkeypatch, enabled, client):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    monkeypatch.setenv("STYLING_ADMIN_ENABLED", enabled)
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie))
    assert rejected.value.status_code == 503
    assert client.post("/api/v1/admin/login", json={"password": "test-account-password"}).status_code == 503


@pytest.mark.parametrize("field,value", [("audience", "product_management"),
                                         ("auth_method", "product_verifier"),
                                         ("subject", "other-manager"),
                                         ("scope", "other-enterprise"),
                                         ("source_instance_id", "other-instance")])
def test_other_product_and_corrupt_binding_facts_are_rejected(monkeypatch, field, value):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with SessionLocal() as db:
        setattr(db.query(StylingAccountSession).one(), field, value)
        db.commit()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie))
    assert rejected.value.status_code == 401


def test_expired_account_fact_rejects_even_while_legacy_session_unexpired(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with SessionLocal() as db:
        db.query(StylingAccountSession).one().expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie))
    assert rejected.value.status_code == 401


def test_logout_persistently_revokes_both_facts_after_reopen(monkeypatch, client):
    bind_account(monkeypatch)
    assert client.post("/api/v1/admin/login", json={"password": "test-account-password"}).status_code == 200
    cookie = client.cookies.get(admin_auth.COOKIE)
    principal = admin_auth.require_account_bound(request(cookie))
    assert client.post("/api/v1/admin/logout").status_code == 200
    engine.dispose()
    with SessionLocal() as db:
        old = db.get(DemandAdminSession, principal.session_id)
        account = db.get(StylingAccountSession, principal.session_id)
        assert old.revoked_at == account.revoked_at and account.revoked_at is not None
    assert client.get("/api/v1/admin/overview", headers={"Cookie": f"{admin_auth.COOKIE}={cookie}"}).status_code == 401


@pytest.mark.parametrize("headers", [[("authorization", "Bearer product-person-cookie")],
                                    [("authorization", "Bearer product-verifier-service")],
                                    [("authorization", "Basic fake")]])
def test_cookie_and_bearer_never_select_higher_privilege(monkeypatch, headers):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, extra_headers=headers))
    assert rejected.value.status_code == 401


@pytest.mark.parametrize("cookie_name", ["product_management_session", "styling_consumer_fixture"])
def test_other_product_or_consumer_cookie_cannot_replace_admin_cookie(client, cookie_name):
    response = client.get("/api/v1/admin/overview", headers={"Cookie": f"{cookie_name}=same-subject-same-scope"})
    assert response.status_code == 401


def test_bearer_alone_cannot_exchange_personal_management_access(client):
    response = client.get("/api/v1/admin/overview", headers={"Authorization": "Bearer styling-manager"})
    assert response.status_code == 401


def test_duplicate_manager_cookie_rejected_instead_of_selecting_one(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, extra_headers=[("cookie", f"{admin_auth.COOKIE}=untrusted")]))
    assert rejected.value.status_code == 401


def test_trusted_principal_is_not_taken_from_client_request_state(monkeypatch):
    bind_account(monkeypatch)
    untrusted = request()
    untrusted.state.styling_admin_principal = admin_auth.StylingAdminPrincipal(
        "fake", "demo-styling-manager", "synthetic-enterprise", "styling-local-test",
        "password_single_account", "account_bound")
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_account_bound(untrusted)
    assert rejected.value.status_code == 401


@pytest.mark.parametrize("origin", ["https://127.0.0.1:8059", "http://127.0.0.1:8060",
                                    "http://evil.example", "null", "http://127.0.0.1:8059/path",
                                    "http://someone@127.0.0.1:8059", "http://127.0.0.1:bad"])
def test_write_requires_exact_scheme_host_and_port(monkeypatch, origin):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, method="POST", extra_headers=[("origin", origin)]))
    assert rejected.value.status_code == 403


def test_proxy_public_host_is_only_trusted_from_loopback(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    headers = [("origin", "http://127.0.0.1:3026"), ("x-styling-public-host", "127.0.0.1:3026")]
    assert admin_auth.require_account_bound(request(cookie, method="POST", extra_headers=headers))
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, method="POST", extra_headers=headers, client="192.0.2.9"))
    assert rejected.value.status_code == 403


def test_explicit_public_origin_supports_https_proxy_without_relaxing_origin(monkeypatch):
    bind_account(monkeypatch)
    monkeypatch.setenv("STYLING_ADMIN_PUBLIC_ORIGIN", "https://styling.example")
    cookie = admin_auth.token()
    assert admin_auth.require_account_bound(request(cookie, method="POST", extra_headers=[("origin", "https://styling.example")]))
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, method="POST", extra_headers=[("origin", "http://styling.example")]))
    assert rejected.value.status_code == 403


def test_cross_site_metadata_rejected_even_without_origin(monkeypatch):
    bind_account(monkeypatch)
    cookie = admin_auth.token()
    with pytest.raises(HTTPException) as rejected:
        admin_auth.require_admin(request(cookie, method="POST", extra_headers=[("sec-fetch-site", "cross-site")]))
    assert rejected.value.status_code == 403
