"""Personal-preview state/authorization proofs; synthetic media and isolated DBs."""
from copy import deepcopy
from io import BytesIO
import time
import hashlib
import sqlite3
from uuid import uuid4

from PIL import Image
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import consumer_identity
from app.core.consumer_identity import ConsumerOwner
from app.models.chat import Base, DailyUsage
from app.models.consumer_context import ConsumerIdentityRevocation
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.models.profile_snapshot import ConsumerSessionOwner
from app.services.personal_preview import PreviewStore, PreviewError
from app.services.personal_preview_media import PrivateMediaStore, normalize_photo
from tests.profile_context_fixture import device_authorization

CONTRACT = "personal_outfit_preview_v1"
SCOPE = "personal_preview_test"


class PreviewContext(dict):
    def __repr__(self):
        # Pytest may show fixture values on a failure. Keep synthetic Cookie
        # identity/confirmation facts and private paths out of public logs.
        return "<isolated synthetic preview context: private facts omitted>"


def synthetic_photo(color="white"):
    buffer = BytesIO()
    Image.new("RGB", (48, 64), color).save(buffer, format="PNG")
    return buffer.getvalue()


def selection(sid="owned-session", version="lv-1"):
    sizes = {"top": {"system": "clothing_alpha", "value": "M"},
             "bottom": {"system": "clothing_alpha", "value": "M"},
             "shoes": {"system": "cn_shoe", "value": "38"}}
    items = [{"slot": slot, "sku_id": "synthetic-" + slot,
              "product_id": "synthetic-product-" + slot, "size": sizes[slot],
              "price_fen": price, "reference_asset_id": "synthetic-ref-" + slot,
              "reference_version": 1, "reference_sha256": char * 64}
             for slot, price, char in (("top", 29900, "a"), ("bottom", 19900, "b"), ("shoes", 23900, "c"))]
    return {"session_id": sid, "look_version_id": version, "look_asset_id": "synthetic-look-101",
            "items": items, "fixed_image": {"asset_id": "synthetic-full-look", "sha256": "d" * 64,
                       "origin": {"is_simulated": True, "rights_confirmed": True}},
            "resources": {"catalog_version": "synthetic-v1", "inventory_snapshot_id": "synthetic-v1",
                          "look_asset_version": "synthetic-v1"},
            "scene": "scene:work_commute", "effective_conditions": {"budget_max_fen": 80000,
                        "usual_sizes": sizes}, "profile_summary": None}


@pytest.fixture
def preview_env(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path}/app.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", SCOPE)
    monkeypatch.setattr(consumer_identity, "SessionLocal", factory)
    owner = ConsumerOwner(SCOPE, "device", "synthetic-owner-a")
    auth = device_authorization(owner, factory)
    other = ConsumerOwner(SCOPE, "device", "synthetic-owner-b")
    other_auth = device_authorization(other, factory)
    sid = "owned-" + uuid4().hex
    with factory() as db:
        db.add(ConsumerSessionOwner(session_id=sid, owner_key=owner.binding_key))
        db.commit()
    current = {"selection": selection(sid), "reads": 0}
    now = [time.time()]

    def reader(_owner, requested_sid, version):
        current["reads"] += 1
        result = deepcopy(current["selection"])
        result["session_id"], result["look_version_id"] = requested_sid, version
        return result

    private = tmp_path / "private"
    media = PrivateMediaStore(private)
    options = {"session_factory": factory, "selection_reader": reader, "clock": lambda: now[0],
               "media": media, "provider_mode": "mock", "isolated": True}
    store = PreviewStore(private / "preview.sqlite3", private, **options)
    yield PreviewContext({"store": store, "db": factory, "owner": owner, "auth": auth,
           "other": other, "other_auth": other_auth, "sid": sid, "current": current,
           "now": now, "media": media, "private": private, "options": options})
    store.close()
    engine.dispose()


def confirmation(ctx, *, request_id=None, photo=None):
    photo = photo or normalize_photo(synthetic_photo())
    available = ctx["store"].availability(ctx["owner"], ctx["auth"], ctx["sid"], "lv-1")
    assert available["available"] is True
    body = {"contract_version": CONTRACT, "session_id": ctx["sid"], "look_version_id": "lv-1",
            "selection_digest": available["selection_digest"], "photo_sha256": photo.raw_sha256,
            "confirmed_photo_rights": True, "confirmed_ai_reference": True}
    confirmed = ctx["store"].confirm(ctx["owner"], ctx["auth"], body)
    metadata = {k: body[k] for k in ("contract_version", "session_id", "look_version_id",
                                   "selection_digest", "photo_sha256")}
    metadata.update(request_id=request_id or uuid4().hex,
                    confirmation_id=confirmed["confirmation_id"],
                    confirmation_token=confirmed["confirmation_token"])
    return metadata, photo


def accepted(ctx):
    metadata, photo = confirmation(ctx)
    result = ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo)
    assert result["duplicate"] is False
    return result["task"], metadata, photo


def complete(ctx, job=None):
    job = job or ctx["store"].claim_next("synthetic-worker")
    assert job is not None
    data = normalize_photo(synthetic_photo("blue")).data
    outcome = {"status": "output_pending_review", "data": data,
               "snapshot_digest": job["snapshot"]["snapshot_digest"],
               "semantic_verified": False, "is_mock": True,
               "provider_request_id": "synthetic-provider-" + job["dispatch_id"]}
    ctx["store"].finish(job, outcome)
    return job, data


def assert_error(code, call):
    with pytest.raises(PreviewError) as error:
        call()
    assert error.value.code == code


def assert_no_business(ctx):
    with ctx["db"]() as db:
        assert tuple(db.query(model).count() for model in
                     (DemandTurn, GenerationRequest, DemandRequestAdmission, DailyUsage)) == (0, 0, 0, 0)


def test_positive_owner_required_not_legacy_ownerless(preview_env):
    ctx = preview_env
    with ctx["db"]() as db:
        db.delete(db.get(ConsumerSessionOwner, ctx["sid"]))
        db.commit()
    assert_error("PREVIEW_SESSION_RESTART_REQUIRED", lambda: ctx["store"].availability(
        ctx["owner"], ctx["auth"], ctx["sid"], "lv-1"))
    assert ctx["current"]["reads"] == 0
    assert_no_business(ctx)


def test_foreign_owner_cannot_inspect_selection(preview_env):
    ctx = preview_env
    assert_error("PREVIEW_NOT_FOUND", lambda: ctx["store"].availability(
        ctx["other"], ctx["other_auth"], ctx["sid"], "lv-1"))
    assert ctx["current"]["reads"] == 0


def test_confirmation_rechecks_drift_before_acceptance(preview_env):
    ctx = preview_env
    metadata, photo = confirmation(ctx)
    ctx["current"]["selection"]["resources"]["inventory_snapshot_id"] = "synthetic-v2"
    assert_error("PREVIEW_SELECTION_CHANGED", lambda: ctx["store"].submit(
        ctx["owner"], ctx["auth"], metadata, photo))
    assert ctx["media"].list_files() == []
    assert ctx["store"].list(ctx["owner"], ctx["auth"])["items"] == []
    assert_no_business(ctx)


def test_original_request_replays_before_new_selection_or_expired_confirmation(preview_env):
    ctx = preview_env
    task, metadata, photo = accepted(ctx)
    original = deepcopy(task["selection"])
    ctx["now"][0] += 601
    ctx["current"]["selection"]["resources"]["catalog_version"] = "synthetic-v2"
    before = ctx["current"]["reads"]
    duplicate = ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo)
    assert duplicate["duplicate"] is True
    assert duplicate["task"]["task_id"] == task["task_id"]
    assert duplicate["task"]["selection"] == original
    assert ctx["current"]["reads"] == before
    assert_no_business(ctx)


def test_same_request_with_different_photo_is_conflict(preview_env):
    ctx = preview_env
    _, metadata, _ = accepted(ctx)
    changed = normalize_photo(synthetic_photo("red"))
    modified = {**metadata, "photo_sha256": changed.raw_sha256}
    assert_error("PREVIEW_REQUEST_CONFLICT", lambda: ctx["store"].submit(
        ctx["owner"], ctx["auth"], modified, changed))
    assert len(ctx["media"].list_files()) == 1


def test_unknown_attempt_restarts_only_as_query(preview_env):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    job = ctx["store"].claim_next("worker-before-restart")
    assert job["recover_only"] is False
    ctx["store"].mark_unknown(job, "synthetic-provider-id")
    old = ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])
    assert old["state"] == "provider_unknown"
    assert old["usage"]["unknown_attempts"] == 1
    recovered = PreviewStore(ctx["private"] / "preview.sqlite3", ctx["private"], **ctx["options"])
    ctx["now"][0] += 601
    query_job = recovered.claim_next("worker-after-restart")
    assert query_job["recover_only"] is True
    assert query_job["dispatch_id"] == job["dispatch_id"]
    assert query_job["provider_request_id"] == "synthetic-provider-id"
    assert recovered.get(ctx["owner"], ctx["auth"], task["task_id"])["usage"]["attempt_count"] == 1
    recovered.close()


def test_unknown_occupies_concurrency_without_creating_second_task(preview_env):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    ctx["store"].mark_unknown(ctx["store"].claim_next("synthetic-worker"))
    metadata, photo = confirmation(ctx)
    assert_error("PREVIEW_CONCURRENCY_LIMIT", lambda: ctx["store"].submit(
        ctx["owner"], ctx["auth"], metadata, photo))
    assert len(ctx["store"].list(ctx["owner"], ctx["auth"])["items"]) == 1
    assert ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])["state"] == "provider_unknown"


def test_mock_output_is_pending_review_and_unlinks_input(preview_env):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    assert len(ctx["media"].list_files()) == 1
    _, data = complete(ctx)
    output = ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])
    assert output["state"] == "output_pending_review"
    assert output["is_mock"] is True and output["effective_personal_preview"] is False
    assert output["effect_kind"] == "mock_not_real"
    assert [item["key"].split("/")[0] for item in ctx["media"].list_files()] == ["results"]
    assert ctx["store"].result(ctx["owner"], ctx["auth"], task["task_id"]) == (data, "image/jpeg")
    assert_no_business(ctx)


@pytest.mark.parametrize("read", ["get", "result", "lookup_request", "deletion"])
def test_private_task_and_result_cross_owner_are_404(preview_env, read):
    ctx = preview_env
    task, metadata, _ = accepted(ctx)
    complete(ctx)
    key = metadata["request_id"] if read == "lookup_request" else task["task_id"]
    assert_error("PREVIEW_NOT_FOUND", lambda: getattr(ctx["store"], read)(
        ctx["other"], ctx["other_auth"], key))
    assert ctx["store"].list(ctx["other"], ctx["other_auth"])["items"] == []


@pytest.mark.parametrize("state", ["queued", "running", "provider_unknown"])
def test_delete_makes_late_result_and_restart_nonreviving(preview_env, state):
    ctx = preview_env
    task, metadata, photo = accepted(ctx)
    job = None
    if state != "queued":
        job = ctx["store"].claim_next("before-delete")
        if state == "provider_unknown":
            ctx["store"].mark_unknown(job, "synthetic-provider-id")
    body = {"contract_version": CONTRACT, "delete_action_id": uuid4().hex}
    ctx["store"].delete(ctx["owner"], ctx["auth"], task["task_id"], body)
    assert ctx["media"].list_files() == []
    if job:
        complete(ctx, job)
        assert ctx["media"].list_files() == []
    restarted = PreviewStore(ctx["private"] / "preview.sqlite3", ctx["private"], **ctx["options"])
    stored = restarted.get(ctx["owner"], ctx["auth"], task["task_id"])
    assert stored["deletion_status"] == "deleted"
    assert stored["result_available"] is False and stored["result_url"] is None
    assert restarted.claim_next("after-delete") is None
    duplicate = restarted.submit(ctx["owner"], ctx["auth"], metadata, photo)
    assert duplicate["duplicate"] is True and duplicate["task"]["deletion_status"] == "deleted"
    assert ctx["media"].list_files() == []
    assert_error("PREVIEW_DELETED", lambda: restarted.result(ctx["owner"], ctx["auth"], task["task_id"]))
    restarted.close()


def test_expired_unknown_input_hard_limit_rejects_late_output(preview_env):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    job = ctx["store"].claim_next("before-expiry")
    ctx["store"].mark_unknown(job, "synthetic-provider-id")
    ctx["now"][0] += 24 * 3600 + 1
    ctx["store"].cleanup()
    assert ctx["media"].list_files() == []
    complete(ctx, job)
    stored = ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])
    assert stored["state"] == "expired" and stored["result_available"] is False
    assert ctx["media"].list_files() == []


def test_revoked_identity_cannot_read_or_accept_and_late_output_is_discarded(preview_env):
    ctx = preview_env
    task, metadata, photo = accepted(ctx)
    job = ctx["store"].claim_next("before-revocation")
    with ctx["db"]() as db:
        db.add(ConsumerIdentityRevocation(owner_ref=ctx["owner"].owner_ref))
        db.commit()
    # ProfileError stays a profile authorization failure; it is not a fake
    # preview NOT_FOUND or an excuse to create a replacement owner.
    from app.schemas.consumer_profile import ProfileError
    for call in (lambda: ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"]),
                 lambda: ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo)):
        with pytest.raises(ProfileError) as error:
            call()
        assert error.value.code == "PROFILE_OWNER_INVALID"
    complete(ctx, job)
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


def test_result_expires_without_extending_on_reads(preview_env):
    ctx = preview_env
    task, metadata, photo = accepted(ctx)
    complete(ctx)
    old = ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])
    for _ in range(2):
        assert ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])["expires_at"] == old["expires_at"]
    ctx["now"][0] += 30 * 24 * 3600 + 1
    ctx["store"].cleanup()
    assert ctx["media"].list_files() == []
    assert_error("PREVIEW_RESULT_EXPIRED", lambda: ctx["store"].result(
        ctx["owner"], ctx["auth"], task["task_id"]))
    duplicate = ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo)
    assert duplicate["duplicate"] is True and duplicate["task"]["state"] == "expired"


def test_deleted_snapshot_content_expires_but_request_tombstone_does_not(preview_env):
    ctx = preview_env
    task, metadata, photo = accepted(ctx)
    complete(ctx)
    ctx["store"].delete(ctx["owner"], ctx["auth"], task["task_id"],
                        {"contract_version": CONTRACT, "delete_action_id": uuid4().hex})
    ctx["now"][0] += 90 * 24 * 3600 + 1
    ctx["store"].cleanup()
    with sqlite3.connect(ctx["private"] / "preview.sqlite3") as db:
        snapshot = db.execute("SELECT snapshot FROM preview_tasks WHERE task_id=?", (task["task_id"],)).fetchone()[0]
    assert snapshot == ""
    duplicate = ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo)
    assert duplicate["duplicate"] is True
    assert duplicate["task"]["task_id"] == task["task_id"]
    assert duplicate["task"]["deletion_status"] == "deleted"
    assert ctx["media"].list_files() == []


def test_physical_unlink_failure_remains_pending_until_retry(preview_env, monkeypatch):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    complete(ctx)
    original = ctx["media"].remove

    def permission_denied(_key):
        raise PermissionError("safe isolated cleanup failure")

    monkeypatch.setattr(ctx["media"], "remove", permission_denied)
    body = {"contract_version": CONTRACT, "delete_action_id": uuid4().hex}
    deletion = ctx["store"].delete(ctx["owner"], ctx["auth"], task["task_id"], body)
    assert deletion["deletion_status"] == "deleting"
    assert deletion["result_deletion"] == "failed"
    assert ctx["media"].list_files()
    assert_error("PREVIEW_DELETED", lambda: ctx["store"].result(ctx["owner"], ctx["auth"], task["task_id"]))
    monkeypatch.setattr(ctx["media"], "remove", original)
    ctx["store"].cleanup()
    assert ctx["media"].list_files() == []
    assert ctx["store"].deletion(ctx["owner"], ctx["auth"], task["task_id"])["deletion_status"] == "deleted"


def test_old_lease_output_does_not_override_recovery_lease(preview_env):
    ctx = preview_env
    task, _, _ = accepted(ctx)
    old = ctx["store"].claim_next("old-worker")
    ctx["now"][0] += 61
    new = ctx["store"].claim_next("new-worker")
    assert new["recover_only"] is True and new["lease_epoch"] > old["lease_epoch"]
    complete(ctx, old)
    assert all(row["key"].startswith("inputs/") for row in ctx["media"].list_files())
    complete(ctx, new)
    assert ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])["state"] == "output_pending_review"
    assert len(ctx["media"].list_files()) == 1


def actual_reference_fixture(ctx, monkeypatch):
    refs = []
    for item, color in zip(ctx["current"]["selection"]["items"], ("red", "green", "blue")):
        data = normalize_photo(synthetic_photo(color)).data
        item["reference_sha256"] = hashlib.sha256(data).hexdigest()
        refs.append({**{k: item[k] for k in ("slot", "sku_id", "product_id", "reference_asset_id",
                                            "reference_version", "reference_sha256")}, "data": data})
    monkeypatch.setattr(ctx["store"], "reference_inputs", lambda _job: deepcopy(refs))
    return refs


def test_actual_mock_timeout_persists_dispatch_and_restart_only_queries(preview_env, monkeypatch):
    from app.services.personal_preview_provider import MockProvider
    from app.services.personal_preview_worker import run_once
    ctx = preview_env
    actual_reference_fixture(ctx, monkeypatch)
    task, _, _ = accepted(ctx)
    ledger = ctx["private"] / "provider-ledger" / "mock.sqlite3"
    provider = MockProvider(ledger, behavior="accepted_timeout", isolated=True)
    assert run_once(ctx["store"], provider, "worker-before-restart") is True
    assert ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])["state"] == "provider_unknown"
    with sqlite3.connect(ledger) as db:
        assert db.execute("SELECT submit_count,query_count FROM mock_dispatches").fetchone() == (1, 0)
    restarted = PreviewStore(ctx["private"] / "preview.sqlite3", ctx["private"], **ctx["options"])
    reopened_provider = MockProvider(ledger, behavior="complete", isolated=True)
    assert run_once(restarted, reopened_provider, "worker-after-restart") is True
    recovered = restarted.get(ctx["owner"], ctx["auth"], task["task_id"])
    assert recovered["state"] == "output_pending_review" and recovered["usage"]["attempt_count"] == 1
    with sqlite3.connect(ledger) as db:
        assert db.execute("SELECT submit_count,query_count FROM mock_dispatches").fetchone() == (1, 1)
    assert all(row["key"].startswith("results/") for row in ctx["media"].list_files())
    restarted.close()
    assert_no_business(ctx)


@pytest.mark.parametrize("behavior", ["invalid_output", "known_mismatch", "failed"])
def test_actual_worker_failures_do_not_replace_output_with_fixed_image(preview_env, monkeypatch, behavior):
    from app.services.personal_preview_provider import MockProvider
    from app.services.personal_preview_worker import run_once
    ctx = preview_env
    actual_reference_fixture(ctx, monkeypatch)
    task, _, _ = accepted(ctx)
    original = deepcopy(task["selection"])
    provider = MockProvider(ctx["private"] / "provider-ledger" / "mock.sqlite3", behavior=behavior, isolated=True)
    assert run_once(ctx["store"], provider, "synthetic-worker") is True
    failed = ctx["store"].get(ctx["owner"], ctx["auth"], task["task_id"])
    assert failed["state"] == "failed" and failed["result_available"] is False and failed["result_url"] is None
    assert failed["selection"] == original
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


def test_unaccepted_expired_confirmation_never_creates_task(preview_env):
    ctx = preview_env
    metadata, photo = confirmation(ctx)
    ctx["now"][0] += 601
    assert_error("PREVIEW_CONFIRMATION_EXPIRED", lambda: ctx["store"].submit(
        ctx["owner"], ctx["auth"], metadata, photo))
    assert ctx["media"].list_files() == []
    assert ctx["store"].list(ctx["owner"], ctx["auth"])["items"] == []
    assert_no_business(ctx)


def test_missing_reference_slot_is_unavailable_without_upload(preview_env):
    ctx = preview_env
    del ctx["current"]["selection"]["items"][0]["reference_asset_id"]
    available = ctx["store"].availability(ctx["owner"], ctx["auth"], ctx["sid"], "lv-1")
    assert available["available"] is False
    assert "PREVIEW_REFERENCE_UNAVAILABLE" in available["reasons"]
    assert ctx["media"].list_files() == []
    assert_no_business(ctx)


def test_provider_accepted_then_process_loss_without_ack_recovers_by_dispatch(preview_env, monkeypatch):
    from app.services.personal_preview_provider import MockProvider
    from app.services.personal_preview_worker import run_once
    ctx = preview_env
    refs = actual_reference_fixture(ctx, monkeypatch)
    task, _, _ = accepted(ctx)
    original = ctx["store"].claim_next("process-before-loss")
    ledger = ctx["private"] / "provider-ledger" / "mock.sqlite3"
    provider = MockProvider(ledger, behavior="complete", isolated=True)
    provider.submit(original["dispatch_id"], original["snapshot"],
                    ctx["media"].read(original["input_key"]), refs)
    # The ledger accepted once, but the local process lost the acknowledgement
    # before it persisted a provider request ID. No second submit is authorized.
    ctx["now"][0] += 61
    restarted = PreviewStore(ctx["private"] / "preview.sqlite3", ctx["private"], **ctx["options"])
    assert run_once(restarted, MockProvider(ledger, isolated=True), "process-after-loss") is True
    restored = restarted.get(ctx["owner"], ctx["auth"], task["task_id"])
    assert restored["state"] == "output_pending_review"
    assert restored["usage"]["attempt_count"] == 1
    with sqlite3.connect(ledger) as db:
        assert db.execute("SELECT submit_count,query_count FROM mock_dispatches").fetchone() == (1, 1)
    restarted.close()
    assert_no_business(ctx)


def test_input_hard_ttl_starts_at_first_upload_not_admission(preview_env):
    ctx = preview_env
    metadata, photo = confirmation(ctx)
    old_upload = ctx["now"][0] - 24 * 3600 + 60
    stored = ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo, first_upload_at=old_upload)["task"]
    ctx["now"][0] += 61
    assert ctx["store"].claim_next("after-hard-upload-ttl") is None
    assert ctx["media"].list_files() == []
    assert ctx["store"].get(ctx["owner"], ctx["auth"], stored["task_id"])["state"] == "expired"


def test_daily_limit_rejects_without_input_attempt_or_second_task(preview_env):
    ctx = preview_env
    ctx["store"].daily_limit = 1
    accepted(ctx)
    complete(ctx)
    metadata, photo = confirmation(ctx)
    before = ctx["media"].list_files()
    assert_error("PREVIEW_DAILY_LIMIT", lambda: ctx["store"].submit(ctx["owner"], ctx["auth"], metadata, photo))
    assert ctx["media"].list_files() == before
    assert len(ctx["store"].list(ctx["owner"], ctx["auth"])["items"]) == 1
    assert_no_business(ctx)


def test_delete_action_id_cannot_delete_another_task(preview_env):
    ctx = preview_env
    first, _, _ = accepted(ctx)
    complete(ctx)
    second, _, _ = accepted(ctx)
    complete(ctx)
    action = {"contract_version": CONTRACT, "delete_action_id": uuid4().hex}
    ctx["store"].delete(ctx["owner"], ctx["auth"], first["task_id"], action)
    assert_error("PREVIEW_ACTION_CONFLICT", lambda: ctx["store"].delete(
        ctx["owner"], ctx["auth"], second["task_id"], action))
    assert ctx["store"].get(ctx["owner"], ctx["auth"], second["task_id"])["result_available"] is True


def test_task_cursor_reads_all_original_tasks_once(preview_env):
    ctx = preview_env
    task_ids = []
    for _ in range(3):
        task_ids.append(accepted(ctx)[0]["task_id"])
        complete(ctx)
    received, cursor = [], None
    while True:
        page = ctx["store"].list(ctx["owner"], ctx["auth"], limit=1, cursor=cursor)
        received.extend(item["task_id"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
        assert len(received) <= 3
    assert len(received) == 3 and set(received) == set(task_ids)
    assert_no_business(ctx)


def test_orphan_unlink_failure_is_persistent_and_retries_after_restart(preview_env, monkeypatch):
    ctx = preview_env
    key = "inputs/synthetic-orphan.jpg"
    ctx["media"].put(key, normalize_photo(synthetic_photo()).data)
    remove = ctx["media"].remove

    def denied(_key):
        raise PermissionError("safe isolated orphan failure")

    monkeypatch.setattr(ctx["media"], "remove", denied)
    ctx["store"].cleanup()
    with sqlite3.connect(ctx["private"] / "preview.sqlite3") as db:
        assert db.execute("SELECT status FROM preview_cleanup WHERE media_kind='orphan'").fetchone()[0] == "failed"
    restarted = PreviewStore(ctx["private"] / "preview.sqlite3", ctx["private"], **ctx["options"])
    monkeypatch.setattr(ctx["media"], "remove", remove)
    # A restart/restricted scan can omit the former orphan. Its persisted
    # receipt must still retry the original key without a new upload.
    monkeypatch.setattr(ctx["media"], "list_files", lambda: [])
    restarted.cleanup()
    assert not (ctx["private"] / key).exists()
    with sqlite3.connect(ctx["private"] / "preview.sqlite3") as db:
        assert db.execute("SELECT status FROM preview_cleanup WHERE media_kind='orphan'").fetchone()[0] == "deleted"
    restarted.close()
    assert_no_business(ctx)


def test_private_cleanup_scan_failure_is_recorded_until_success(preview_env, monkeypatch):
    ctx = preview_env
    scan = ctx["media"].list_files

    def denied():
        raise PermissionError("safe isolated private scan failure")

    monkeypatch.setattr(ctx["media"], "list_files", denied)
    ctx["store"].cleanup()
    with sqlite3.connect(ctx["private"] / "preview.sqlite3") as db:
        assert db.execute("SELECT status FROM preview_cleanup WHERE media_kind='scan'").fetchone()[0] == "failed"
    monkeypatch.setattr(ctx["media"], "list_files", scan)
    ctx["store"].cleanup()
    with sqlite3.connect(ctx["private"] / "preview.sqlite3") as db:
        assert db.execute("SELECT status FROM preview_cleanup WHERE media_kind='scan'").fetchone()[0] == "deleted"
    assert_no_business(ctx)


def model_asset(ctx, monkeypatch):
    """A real temporary PNG replaces only the fixed catalogue byte reader."""
    from app.services import fixed_styling
    raw = synthetic_photo("green")
    path = ctx["private"].parent / "fixed-model.png"
    path.write_bytes(raw)
    asset_id = ctx["current"]["selection"]["fixed_image"]["asset_id"]
    ctx["current"]["selection"]["fixed_image"]["sha256"] = hashlib.sha256(raw).hexdigest()
    reads = []

    def read(requested_id):
        reads.append(requested_id)
        assert requested_id == asset_id
        return path.read_bytes()

    monkeypatch.setattr(fixed_styling, "asset_bytes", read)
    return raw, path, reads


def clear_history_content(ctx, task_id):
    # Set only this synthetic row's retention timestamps into the past. The
    # real cleanup must clear its snapshot while keeping request tombstones.
    with ctx["store"]._transaction() as db:
        db.execute("UPDATE preview_tasks SET metadata_expires=?,expires=? WHERE task_id=?",
                   (ctx["now"][0] - 1, ctx["now"][0] - 1, task_id))
    ctx["store"].cleanup()


def test_cleared_history_is_explicit_and_does_not_poison_other_list_items(preview_env, monkeypatch):
    ctx = preview_env
    model_asset(ctx, monkeypatch)
    old, original, photo = accepted(ctx)
    complete(ctx)
    ctx["now"][0] += 1
    fresh, _, _ = accepted(ctx)
    complete(ctx)
    clear_history_content(ctx, old["task_id"])
    page = ctx["store"].list(ctx["owner"], ctx["auth"])
    items = {item["task_id"]: item for item in page["items"]}
    assert set(items) == {old["task_id"], fresh["task_id"]}
    assert items[old["task_id"]]["selection_status"] == "content_cleared"
    assert items[old["task_id"]]["selection"] == {}
    assert items[old["task_id"]]["model_image_url"] is None
    assert items[fresh["task_id"]]["selection_status"] == "available"
    assert len(items[fresh["task_id"]]["selection"]["items"]) == 3
    assert items[fresh["task_id"]]["model_image_url"].endswith("/model-image")
    duplicate = ctx["store"].submit(ctx["owner"], ctx["auth"], original, photo)
    assert duplicate["duplicate"] is True
    assert duplicate["task"]["task_id"] == old["task_id"]
    assert duplicate["task"]["selection_status"] == "content_cleared"
    assert_no_business(ctx)


def test_model_image_reads_exact_frozen_png_after_current_look_changes(preview_env, monkeypatch):
    ctx = preview_env
    raw, _, reads = model_asset(ctx, monkeypatch)
    created, _, _ = accepted(ctx)
    frozen = created["selection"]
    # A new current selection may use a different asset; reading this task
    # must not invoke selection_reader or target the new current version.
    ctx["current"]["selection"]["fixed_image"] = {"asset_id": "new-current-model", "sha256": "e" * 64}
    ctx["current"]["selection"]["current_look_version_id"] = "new-current-version"
    previous_reads = ctx["current"]["reads"]
    data, mime = ctx["store"].model_image(ctx["owner"], ctx["auth"], created["task_id"])
    assert data == raw and mime == "image/png"
    assert hashlib.sha256(data).hexdigest() == frozen["fixed_image"]["sha256"]
    assert ctx["current"]["reads"] == previous_reads
    assert reads == [frozen["fixed_image"]["asset_id"]]
    current = ctx["store"].get(ctx["owner"], ctx["auth"], created["task_id"])
    assert current["selection"] == frozen
    assert "look_version_no" not in current["selection"]  # old snapshots are not guessed
    assert_no_business(ctx)


@pytest.mark.parametrize("failure", ["changed_bytes", "unreadable"])
def test_model_image_never_falls_back_when_original_asset_changes(preview_env, monkeypatch, failure):
    ctx = preview_env
    _, path, _ = model_asset(ctx, monkeypatch)
    created, _, _ = accepted(ctx)
    if failure == "changed_bytes":
        path.write_bytes(synthetic_photo("red"))
    else:
        path.unlink()
    assert_error("PREVIEW_REFERENCE_UNAVAILABLE", lambda: ctx["store"].model_image(
        ctx["owner"], ctx["auth"], created["task_id"]))
    assert ctx["store"].db.execute("SELECT count(*) FROM preview_attempts").fetchone()[0] == 0
    assert_no_business(ctx)


@pytest.mark.parametrize("condition,code", [
    ("deleted", "PREVIEW_DELETED"),
    ("expired", "PREVIEW_RESULT_EXPIRED"),
    ("content_cleared", "PREVIEW_HISTORY_METADATA_UNAVAILABLE"),
])
def test_model_image_lifecycle_disallows_original_png(preview_env, monkeypatch, condition, code):
    ctx = preview_env
    _, _, reads = model_asset(ctx, monkeypatch)
    created, _, _ = accepted(ctx)
    if condition == "deleted":
        ctx["store"].delete(ctx["owner"], ctx["auth"], created["task_id"],
                            {"contract_version": CONTRACT, "delete_action_id": uuid4().hex})
    elif condition == "expired":
        with ctx["store"]._transaction() as db:
            db.execute("UPDATE preview_tasks SET expires=? WHERE task_id=?",
                       (ctx["now"][0] - 1, created["task_id"]))
    else:
        clear_history_content(ctx, created["task_id"])
    assert_error(code, lambda: ctx["store"].model_image(ctx["owner"], ctx["auth"], created["task_id"]))
    assert reads == []
    assert ctx["store"].get(ctx["owner"], ctx["auth"], created["task_id"])["model_image_url"] is None
    assert_no_business(ctx)
