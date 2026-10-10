"""Real personal-preview routes, random Cookie and synthetic multipart bytes."""
import hashlib
import json
from uuid import uuid4

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
import pytest

from app.api import consumer_profiles as profile_api, personal_preview as api
from app.api.consumer_profiles import profile_error_handler
from app.core.consumer_identity import ConsumerAuthorization, ConsumerOwner, consumer_cookie_name
from app.models.consumer_context import ConsumerIdentityRevocation
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.profile_snapshot import ConsumerSessionOwner
from app.schemas.consumer_profile import ProfileError
from app.services import consumer_profiles
from app.services.personal_preview import PreviewError
from tests.test_personal_preview_core import (CONTRACT, SCOPE, preview_env, synthetic_photo,
                                       confirmation, complete, assert_no_business,
                                       model_asset, clear_history_content)

PREFIX = "/api/v1/personal-preview"


def multipart(metadata, photo, *, boundary=None, filename="synthetic.png", reverse=False):
    boundary = boundary or "isolated-" + uuid4().hex
    parts = [("metadata", "application/json", json.dumps(metadata).encode(), None),
             ("photo", "image/png", photo, filename)]
    if reverse:
        parts.reverse()
    content = b""
    for name, mime, data, file_name in parts:
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if file_name:
            disposition += f'; filename="{file_name}"'
        content += (f"--{boundary}\r\n{disposition}\r\nContent-Type: {mime}\r\n\r\n").encode()
        content += data + b"\r\n"
    content += f"--{boundary}--\r\n".encode()
    return content, {"Content-Type": "multipart/form-data; boundary=" + boundary}


@pytest.fixture
def api_env(preview_env, monkeypatch):
    ctx = preview_env
    monkeypatch.setattr(consumer_profiles, "SessionLocal", ctx["db"])
    monkeypatch.setattr(api, "get_store", lambda: ctx["store"])
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_ENABLED", "1")
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_ISOLATED", "1")
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_PROVIDER", "mock")
    app = FastAPI()
    app.include_router(profile_api.router)
    app.include_router(api.router)
    app.add_exception_handler(PreviewError, api.preview_error_handler)
    app.add_exception_handler(ProfileError, profile_error_handler)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, _error):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST"}},
                            headers={"Cache-Control": "no-store"})

    a, b = TestClient(app), TestClient(app)
    # Each browser initializes using the unmodified opaque Cookie resolver.
    assert a.get("/api/v1/consumer-profile").status_code == 200
    assert b.get("/api/v1/consumer-profile").status_code == 200
    token = a.cookies.get(consumer_cookie_name())
    with ctx["db"]() as db:
        row = db.query(ConsumerProfileIdentity).filter_by(token_hash=hashlib.sha256(token.encode()).hexdigest()).one()
        owner = ConsumerOwner(SCOPE, "device", row.owner_ref)
        auth = ConsumerAuthorization(owner, identity_token_digest=row.token_hash)
        db.get(ConsumerSessionOwner, ctx["sid"]).owner_key = owner.binding_key
        db.commit()
    ctx.update(owner=owner, auth=auth, client=a, other_client=b, app=app)
    yield ctx
    a.close()
    b.close()


def rejected(response, status, code):
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert response.headers.get("cache-control") == "no-store"


def upload(ctx, metadata=None, raw=None, **options):
    if metadata is None:
        metadata, _ = confirmation(ctx)
    raw = raw or synthetic_photo()
    body, headers = multipart(metadata, raw, **options)
    return ctx["client"].post(PREFIX + "/tasks", content=body, headers=headers), metadata, raw


def task(ctx):
    response, metadata, raw = upload(ctx)
    assert response.status_code == 202
    assert response.headers.get("cache-control") == "no-store"
    data = response.json()
    assert data["duplicate"] is False and data["task"]["state"] == "queued"
    return data["task"], metadata, raw


def test_capabilities_does_not_create_cookie_or_open_store(api_env, monkeypatch):
    ctx = api_env
    count = len(ctx["client"].cookies)
    with ctx["db"]() as db:
        identities = db.query(ConsumerProfileIdentity).count()

    def forbidden():
        raise AssertionError("capabilities must not initialize a store")

    monkeypatch.setattr(api, "get_store", forbidden)
    fresh = TestClient(ctx["app"])
    response = fresh.get(PREFIX + "/capabilities")
    assert response.status_code == 200 and response.headers.get("cache-control") == "no-store"
    assert response.headers.get("set-cookie") is None and len(fresh.cookies) == 0
    assert response.json()["is_mock"] is True and response.json()["real_provider_enabled"] is False
    assert len(ctx["client"].cookies) == count
    with ctx["db"]() as db:
        assert db.query(ConsumerProfileIdentity).count() == identities
    fresh.close()


def test_multipart_boundary_and_filename_do_not_change_request_identity(api_env):
    ctx = api_env
    original, metadata, raw = task(ctx)
    duplicate, _, _ = upload(ctx, metadata, raw, filename="another-name.png")
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"] is True
    assert duplicate.json()["task"]["task_id"] == original["task_id"]
    query = ctx["client"].get(PREFIX + "/requests/" + metadata["request_id"])
    assert query.status_code == 200 and query.json()["task_id"] == original["task_id"]
    assert_no_business(ctx)


@pytest.mark.parametrize("field,value", [("owner", "untrusted"), ("sku_ids", ["untrusted"]),
                                        ("image_url", "https://invalid.example/private"),
                                        ("provider", "untrusted"), ("path", "/private/untrusted")])
def test_metadata_extra_fields_never_assign_authority(api_env, field, value):
    ctx = api_env
    metadata, _ = confirmation(ctx)
    response, _, _ = upload(ctx, {**metadata, field: value})
    rejected(response, 422, "PREVIEW_INVALID_REQUEST")
    assert "untrusted" not in response.text
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


def test_photo_before_metadata_is_rejected_without_spooling(api_env):
    ctx = api_env
    metadata, _ = confirmation(ctx)
    response, _, _ = upload(ctx, metadata, reverse=True)
    rejected(response, 422, "PREVIEW_INVALID_REQUEST")
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


@pytest.mark.parametrize("field,value", [("confirmed_photo_rights", False), ("confirmed_ai_reference", 1)])
def test_confirmation_requires_exact_explicit_true(api_env, field, value):
    ctx = api_env
    available = ctx["client"].get(PREFIX + "/availability", params={"session_id": ctx["sid"], "look_version_id": "lv-1"}).json()
    body = {"contract_version": CONTRACT, "session_id": ctx["sid"], "look_version_id": "lv-1",
            "selection_digest": available["selection_digest"],
            "photo_sha256": hashlib.sha256(synthetic_photo()).hexdigest(),
            "confirmed_photo_rights": True, "confirmed_ai_reference": True}
    rejected(ctx["client"].post(PREFIX + "/confirmations", json={**body, field: value}),
             422, "PREVIEW_INVALID_REQUEST")
    assert ctx["media"].list_files() == []


def test_confirm_then_cookie_changes_cannot_submit_original(api_env):
    ctx = api_env
    metadata, _ = confirmation(ctx)
    body, headers = multipart(metadata, synthetic_photo())
    rejected(ctx["other_client"].post(PREFIX + "/tasks", content=body, headers=headers),
             404, "PREVIEW_NOT_FOUND")
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


@pytest.mark.parametrize("kind", ["task", "request", "result", "deletion", "delete"])
def test_private_objects_and_direct_result_urls_reject_second_cookie(api_env, kind):
    ctx = api_env
    original, metadata, _ = task(ctx)
    complete(ctx)
    suffix = "/tasks/" + original["task_id"]
    if kind == "request":
        suffix = "/requests/" + metadata["request_id"]
    elif kind != "task":
        suffix += "/" + kind
    if kind == "delete":
        response = ctx["other_client"].post(PREFIX + suffix, json={"contract_version": CONTRACT, "delete_action_id": uuid4().hex})
    else:
        response = ctx["other_client"].get(PREFIX + suffix)
    rejected(response, 404, "PREVIEW_NOT_FOUND")
    assert ctx["other_client"].get(PREFIX + "/tasks").json()["items"] == []
    assert_no_business(ctx)


def test_mock_result_private_jpeg_and_delete_original_retry(api_env):
    ctx = api_env
    original, metadata, raw = task(ctx)
    complete(ctx)
    current = ctx["client"].get(PREFIX + "/tasks/" + original["task_id"])
    assert current.status_code == 200 and current.headers.get("cache-control") == "no-store"
    dto = current.json()
    assert dto["state"] == "output_pending_review" and dto["effective_personal_preview"] is False
    assert dto["result_url"].startswith(PREFIX + "/tasks/")
    forbidden = (ctx["owner"].owner_ref, metadata["photo_sha256"], metadata["confirmation_token"], str(ctx["private"]))
    assert all(value not in current.text for value in forbidden)
    image = ctx["client"].get(dto["result_url"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
    assert image.headers.get("cache-control") == "no-store"
    deletion = ctx["client"].post(PREFIX + "/tasks/" + original["task_id"] + "/delete",
                                   json={"contract_version": CONTRACT, "delete_action_id": uuid4().hex})
    assert deletion.status_code == 200 and deletion.headers.get("cache-control") == "no-store"
    assert ctx["media"].list_files() == []
    rejected(ctx["client"].get(dto["result_url"]), 410, "PREVIEW_DELETED")
    duplicate, _, _ = upload(ctx, metadata, raw)
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"] is True
    assert duplicate.json()["task"]["deletion_status"] == "deleted"
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


def test_revoked_cookie_rejects_new_upload_and_result_read(api_env):
    ctx = api_env
    original, metadata, raw = task(ctx)
    complete(ctx)
    with ctx["db"]() as db:
        db.add(ConsumerIdentityRevocation(owner_ref=ctx["owner"].owner_ref))
        db.commit()
    rejected(ctx["client"].get(PREFIX + "/tasks/" + original["task_id"] + "/result"),
             403, "PROFILE_OWNER_INVALID")
    response, _, _ = upload(ctx, metadata, raw)
    rejected(response, 403, "PROFILE_OWNER_INVALID")
    assert_no_business(ctx)


def test_availability_rejects_unknown_client_owner_query_field(api_env):
    ctx = api_env
    response = ctx["client"].get(PREFIX + "/availability", params={
        "session_id": ctx["sid"], "look_version_id": "lv-1", "owner": "untrusted-owner",
    })
    rejected(response, 422, "PREVIEW_INVALID_REQUEST")
    assert "untrusted-owner" not in response.text
    assert_no_business(ctx)


def test_scope_change_cannot_read_result_or_reuse_old_confirmation(api_env, monkeypatch):
    ctx = api_env
    original, metadata, raw = task(ctx)
    complete(ctx)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "personal_preview_other_scope")
    rejected(ctx["client"].get(PREFIX + "/tasks/" + original["task_id"] + "/result"),
             404, "PREVIEW_NOT_FOUND")
    rejected(ctx["client"].get(PREFIX + "/requests/" + metadata["request_id"]),
             404, "PREVIEW_NOT_FOUND")
    response, _, _ = upload(ctx, metadata, raw)
    rejected(response, 404, "PREVIEW_NOT_FOUND")
    assert ctx["client"].get(PREFIX + "/tasks").json()["items"] == []
    assert_no_business(ctx)


def test_capabilities_reports_configured_daily_limit_without_initializing_store(api_env, monkeypatch):
    ctx = api_env
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_DAILY_LIMIT", "3")

    def forbidden():
        raise AssertionError("capability configuration must not open private storage")

    monkeypatch.setattr(api, "get_store", forbidden)
    fresh = TestClient(ctx["app"])
    response = fresh.get(PREFIX + "/capabilities")
    assert response.status_code == 200
    assert response.json()["limits"]["daily_tasks"] == 3
    assert response.headers.get("set-cookie") is None
    fresh.close()


def test_model_image_has_private_exact_png_headers_and_task_projection(api_env, monkeypatch):
    ctx = api_env
    raw, _, _ = model_asset(ctx, monkeypatch)
    original, metadata, _ = task(ctx)
    assert original["selection_status"] == "available"
    expected = PREFIX + "/tasks/" + original["task_id"] + "/model-image"
    assert original["model_image_url"] == expected
    response = ctx["client"].get(expected)
    assert response.status_code == 200 and response.content == raw
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-content-sha256"] == hashlib.sha256(raw).hexdigest()
    # This fixed model read remains available even before the photo worker
    # runs, and does not create a provider attempt or alter the original task.
    current = ctx["client"].get(PREFIX + "/requests/" + metadata["request_id"])
    assert current.status_code == 200 and current.json()["selection"] == original["selection"]
    assert current.json()["usage"]["attempt_count"] == 0
    assert_no_business(ctx)


def test_model_image_direct_url_is_404_for_other_real_cookie(api_env, monkeypatch):
    ctx = api_env
    _, _, reads = model_asset(ctx, monkeypatch)
    original, _, _ = task(ctx)
    response = ctx["other_client"].get(PREFIX + "/tasks/" + original["task_id"] + "/model-image")
    rejected(response, 404, "PREVIEW_NOT_FOUND")
    assert reads == []
    assert_no_business(ctx)


@pytest.mark.parametrize("condition,code", [
    ("deleted", "PREVIEW_DELETED"),
    ("expired", "PREVIEW_RESULT_EXPIRED"),
    ("content_cleared", "PREVIEW_HISTORY_METADATA_UNAVAILABLE"),
])
def test_model_image_real_route_lifecycle_errors_are_private(api_env, monkeypatch, condition, code):
    ctx = api_env
    _, _, reads = model_asset(ctx, monkeypatch)
    original, _, _ = task(ctx)
    if condition == "deleted":
        response = ctx["client"].post(PREFIX + "/tasks/" + original["task_id"] + "/delete",
            json={"contract_version": CONTRACT, "delete_action_id": uuid4().hex})
        assert response.status_code == 200
    elif condition == "expired":
        with ctx["store"]._transaction() as db:
            db.execute("UPDATE preview_tasks SET expires=? WHERE task_id=?",
                       (ctx["now"][0] - 1, original["task_id"]))
    else:
        clear_history_content(ctx, original["task_id"])
    response = ctx["client"].get(PREFIX + "/tasks/" + original["task_id"] + "/model-image")
    rejected(response, 410, code)
    assert reads == []
    assert_no_business(ctx)


def test_model_image_route_rejects_query_without_asset_read(api_env, monkeypatch):
    ctx = api_env
    _, _, reads = model_asset(ctx, monkeypatch)
    original, _, _ = task(ctx)
    response = ctx["client"].get(PREFIX + "/tasks/" + original["task_id"] + "/model-image?owner=forged")
    rejected(response, 422, "PREVIEW_INVALID_REQUEST")
    assert reads == []


def test_cleared_history_real_route_keeps_other_valid_items(api_env, monkeypatch):
    ctx = api_env
    model_asset(ctx, monkeypatch)
    old, original, raw = task(ctx)
    complete(ctx)
    ctx["now"][0] += 1
    fresh, _, _ = task(ctx)
    complete(ctx)
    clear_history_content(ctx, old["task_id"])
    response = ctx["client"].get(PREFIX + "/tasks")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    items = {value["task_id"]: value for value in response.json()["items"]}
    assert set(items) == {old["task_id"], fresh["task_id"]}
    assert items[old["task_id"]]["selection_status"] == "content_cleared"
    assert items[old["task_id"]]["selection"] == {}
    assert items[old["task_id"]]["model_image_url"] is None
    assert items[fresh["task_id"]]["selection_status"] == "available"
    assert items[fresh["task_id"]]["model_image_url"].endswith("/model-image")
    duplicate, _, _ = upload(ctx, original, raw)
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"] is True
    assert duplicate.json()["task"]["task_id"] == old["task_id"]
    assert duplicate.json()["task"]["selection_status"] == "content_cleared"
    assert_no_business(ctx)
