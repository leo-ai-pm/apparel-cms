"""Synthetic-only preview media/provider/worker security and durable recovery."""
import asyncio
from hashlib import sha256
from io import BytesIO
import os
from pathlib import Path
import sqlite3

from PIL import Image
import pytest

from app.services.personal_preview_media import (MediaError, PhotoLimits, PrivateMediaStore,
                                                normalize_photo, read_upload)
from app.services.personal_preview_provider import (DisabledProvider, MockProvider, ProviderError,
                                                   ProviderSubmissionUnknown, get_provider)
from app.services.personal_preview_worker import run_once


def image_bytes(fmt="PNG", size=(48, 64), **kwargs):
    image = Image.new("RGB", size, (100, 150, 200))
    stream = BytesIO()
    image.save(stream, format=fmt, **kwargs)
    image.close()
    return stream.getvalue()


def references():
    raw = image_bytes("PNG", (16, 24))
    return [{"slot": slot, "sku_id": "SKU_" + slot, "product_id": "PRODUCT_" + slot,
             "reference_asset_id": "ASSET_" + slot, "reference_version": "v1",
             "reference_sha256": sha256(raw).hexdigest(), "data": raw}
            for slot in ("top", "bottom", "shoes")]


def snapshot(digest="a"*64):
    return {"snapshot_digest": digest,
            "items": [{key: value for key, value in item.items() if key != "data"} for item in references()]}


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_full_decode_safe_jpeg_and_raw_fingerprint(fmt):
    raw = image_bytes(fmt)
    result = normalize_photo(raw)
    assert result.raw_sha256 == sha256(raw).hexdigest()
    assert result.sha256 == sha256(result.data).hexdigest()
    assert result.byte_size == len(result.data)
    assert result.mime_type == "image/jpeg"
    with Image.open(BytesIO(result.data)) as image:
        image.load()
        assert image.format == "JPEG" and image.mode == "RGB" and image.size == (48, 64)
        assert not image.getexif() and not image.info.get("icc_profile")


def test_exif_orientation_is_applied_and_private_metadata_removed():
    exif = Image.Exif()
    exif[274] = 6
    exif[271] = "SYNTHETIC-PRIVATE-CAMERA"
    raw = image_bytes("JPEG", (48, 64), exif=exif, icc_profile=b"synthetic-private-profile")
    result = normalize_photo(raw)
    assert (result.width, result.height) == (64, 48)
    assert b"SYNTHETIC-PRIVATE-CAMERA" not in result.data
    assert b"synthetic-private-profile" not in result.data
    with Image.open(BytesIO(result.data)) as image:
        assert not image.getexif()


@pytest.mark.parametrize("raw,code,status", [
    (b"", "PREVIEW_PHOTO_INVALID", 422),
    (b"\x89PNG\r\n\x1a\nonly-fake-header", "PREVIEW_PHOTO_INVALID", 422),
    (image_bytes("GIF"), "PREVIEW_FORMAT_UNSUPPORTED", 415),
])
def test_bad_or_unsupported_container_is_rejected(raw, code, status):
    with pytest.raises(MediaError) as error:
        normalize_photo(raw)
    assert (error.value.code, error.value.status) == (code, status)


def test_incomplete_pixel_data_is_rejected():
    raw = image_bytes("PNG")
    with pytest.raises(MediaError) as error:
        normalize_photo(raw[:len(raw)//2])
    assert error.value.code == "PREVIEW_PHOTO_INVALID"


@pytest.mark.parametrize("limits", [PhotoLimits(max_pixels=100), PhotoLimits(max_edge=47)])
def test_dimensions_are_limited_before_loading(limits):
    with pytest.raises(MediaError) as error:
        normalize_photo(image_bytes(), limits)
    assert error.value.code == "PREVIEW_PIXELS_EXCEEDED"


def test_animation_is_rejected_even_for_supported_webp():
    one, two = Image.new("RGB", (8, 8), "red"), Image.new("RGB", (8, 8), "blue")
    stream = BytesIO()
    one.save(stream, format="WEBP", save_all=True, append_images=[two], duration=10, loop=0)
    with pytest.raises(MediaError) as error:
        normalize_photo(stream.getvalue())
    assert error.value.code == "PREVIEW_PHOTO_INVALID"


def test_stream_upload_stops_at_byte_limit_without_unbounded_read():
    class Upload:
        def __init__(self):
            self.requests = []
        async def read(self, n):
            self.requests.append(n)
            assert 0 < n <= 64*1024
            return b"x" * n
    upload = Upload()
    with pytest.raises(MediaError) as error:
        asyncio.run(read_upload(upload, PhotoLimits(max_bytes=100)))
    assert error.value.code == "PREVIEW_UPLOAD_TOO_LARGE" and upload.requests == [101]


def test_upload_limit_is_checked_before_decode():
    with pytest.raises(MediaError) as error:
        normalize_photo(b"x"*101, PhotoLimits(max_bytes=100))
    assert (error.value.status, error.value.code) == (413, "PREVIEW_UPLOAD_TOO_LARGE")


def test_private_write_read_delete_and_immutable_paths(tmp_path):
    media = PrivateMediaStore(tmp_path / "private")
    raw = normalize_photo(image_bytes()).data
    media.put("inputs/PHOTO_1.jpg", raw)
    file = media.root / "inputs/PHOTO_1.jpg"
    assert file.stat().st_mode & 0o777 == 0o600
    assert media.root.stat().st_mode & 0o777 == 0o700
    assert media.read("inputs/PHOTO_1.jpg") == raw
    with pytest.raises(MediaError):
        media.put("inputs/PHOTO_1.jpg", b"replacement")
    assert media.read("inputs/PHOTO_1.jpg") == raw
    assert media.remove("inputs/PHOTO_1.jpg") is True
    assert not file.exists() and media.remove("inputs/PHOTO_1.jpg") is False
    assert media.list_files() == []


@pytest.mark.parametrize("key", ["../secret.jpg", "inputs/../../secret.jpg", "/tmp/secret.jpg", "results/foo.png",
                               "inputs/a/b.jpg", "http://elsewhere/image.jpg"])
def test_client_paths_and_urls_are_never_keys(tmp_path, key):
    media = PrivateMediaStore(tmp_path / "private")
    with pytest.raises(MediaError):
        media.put(key, b"synthetic")
    with pytest.raises(MediaError):
        media.read(key)


def test_symlink_file_or_directory_never_reads_target(tmp_path):
    media = PrivateMediaStore(tmp_path / "private")
    target = tmp_path / "outside.jpg"
    target.write_bytes(b"OUTSIDE-SECRET")
    (media.root / "inputs/PHOTO.jpg").symlink_to(target)
    with pytest.raises(MediaError):
        media.read("inputs/PHOTO.jpg")
    assert media.remove("inputs/PHOTO.jpg") and target.read_bytes() == b"OUTSIDE-SECRET"
    (media.root / "results").rmdir()
    (media.root / "results").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(MediaError):
        media.put("results/OUT.jpg", b"synthetic")
    assert not (tmp_path / "OUT.jpg").exists()


def test_permissive_and_symlink_roots_are_refused(tmp_path):
    root = tmp_path / "public"
    root.mkdir(mode=0o755)
    with pytest.raises(MediaError):
        PrivateMediaStore(root)
    link = tmp_path / "link"
    link.symlink_to(root, target_is_directory=True)
    with pytest.raises(MediaError):
        PrivateMediaStore(link)


def test_abandoned_temporary_files_have_real_hard_cleanup(tmp_path):
    media = PrivateMediaStore(tmp_path / "private")
    old = media.root / ("inputs/.tmp-" + "a"*32)
    recent = media.root / ("results/.tmp-" + "b"*32)
    old.write_bytes(b"synthetic-pixels")
    recent.write_bytes(b"synthetic-pixels")
    os.utime(old, (1, 1))
    assert media.cleanup_temporary(2) == 1
    assert not old.exists() and recent.exists()


def test_real_provider_disabled_and_mock_needs_explicit_isolation(tmp_path, monkeypatch):
    monkeypatch.delenv("STYLING_PERSONAL_PREVIEW_PROVIDER", raising=False)
    provider = get_provider()
    assert isinstance(provider, DisabledProvider)
    with pytest.raises(ProviderError):
        provider.submit("dispatch", {}, b"synthetic")
    with pytest.raises(ProviderError):
        MockProvider(tmp_path / "ledger.db")
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_PROVIDER", "mock")
    monkeypatch.setenv("STYLING_PERSONAL_PREVIEW_ISOLATED", "0")
    with pytest.raises(ProviderError):
        get_provider()


def test_durable_mock_timeout_recovery_queries_original_once(tmp_path):
    ledger = tmp_path / "private" / "provider.db"
    provider = MockProvider(ledger, behavior="accepted_timeout", isolated=True)
    frozen = snapshot()
    with pytest.raises(ProviderSubmissionUnknown) as error:
        provider.submit("DISPATCH_1", frozen, b"synthetic-input-not-retained", references())
    provider_id = error.value.provider_request_id
    del provider
    restarted = MockProvider(ledger, isolated=True)
    outcome = restarted.query("DISPATCH_1", provider_id)
    assert outcome["status"] == "output_pending_review" and outcome["is_mock"] is True
    assert outcome["provider_request_id"] == provider_id and outcome["semantic_verified"] is False
    assert normalize_photo(outcome["data"]).width == 320
    with pytest.raises(ProviderSubmissionUnknown):
        restarted.submit("DISPATCH_1", frozen, b"synthetic-input-not-retained", references())
    with sqlite3.connect(ledger) as db:
        row = db.execute("SELECT submit_count,query_count,reference_count FROM mock_dispatches").fetchone()
        assert row == (1, 1, 3)
    assert outcome["cost_status"] == "not_applicable_mock" and outcome["cost_amount"] is None
    assert b"synthetic-input-not-retained" not in ledger.read_bytes()
    assert ledger.stat().st_mode & 0o777 == 0o600


def test_missing_or_mismatched_provider_query_never_resubmits(tmp_path):
    provider = MockProvider(tmp_path / "private" / "provider.db", isolated=True)
    with pytest.raises(ProviderSubmissionUnknown):
        provider.query("MISSING")
    outcome = provider.submit("DISPATCH", snapshot("b"*64), b"synthetic", references())
    with pytest.raises(ProviderSubmissionUnknown):
        provider.query("DISPATCH", "WRONG_ID")
    assert outcome["status"] == "output_pending_review"
    with sqlite3.connect(provider.path) as db:
        assert db.execute("SELECT submit_count,query_count FROM mock_dispatches").fetchone() == (1, 0)


def test_worker_unknown_recovers_without_second_submit(tmp_path):
    provider = MockProvider(tmp_path / "provider" / "mock.db", behavior="accepted_timeout", isolated=True)
    media = PrivateMediaStore(tmp_path / "private")
    media.put("inputs/PHOTO.jpg", normalize_photo(image_bytes()).data)
    class Store:
        def __init__(self):
            self.media = media
            self.job = {"task_id": "TASK", "attempt_id": "ATTEMPT", "dispatch_id": "DISPATCH", "lease_epoch": 1,
                        "deletion_generation": 0, "snapshot": snapshot("c"*64), "input_key": "inputs/PHOTO.jpg",
                        "provider_id": None, "recover_only": False}
            self.final = None
        def claim_next(self, worker_id):
            return self.job if self.final is None else None
        def mark_unknown(self, job, provider_request_id=None):
            self.job.update(recover_only=True, provider_request_id=provider_request_id)
        def acknowledge(self, job, outcome):
            raise AssertionError("This outcome is not running")
        def reference_inputs(self, job):
            return references()
        def finish(self, job, outcome):
            self.final = outcome
            self.media.remove(job["input_key"])
    store = Store()
    assert run_once(store, provider) and store.job["recover_only"] is True
    assert run_once(store, provider) and store.final["status"] == "output_pending_review"
    assert store.final["semantic_verified"] is False and not (media.root / "inputs/PHOTO.jpg").exists()
    assert run_once(store, provider) is False
    with sqlite3.connect(provider.path) as db:
        assert db.execute("SELECT submit_count,query_count FROM mock_dispatches").fetchone() == (1, 1)


def test_worker_corrupt_output_is_failed_not_input_or_old_look(tmp_path):
    provider = MockProvider(tmp_path / "provider" / "mock.db", behavior="invalid_output", isolated=True)
    media = PrivateMediaStore(tmp_path / "private")
    media.put("inputs/PHOTO.jpg", normalize_photo(image_bytes()).data)
    class Store:
        def __init__(self):
            self.media, self.final = media, None
        def claim_next(self, _):
            return {"task_id": "TASK", "dispatch_id": "DISPATCH", "snapshot": snapshot("d"*64),
                    "input_key": "inputs/PHOTO.jpg", "recover_only": False}
        def reference_inputs(self, job):
            return references()
        def finish(self, job, outcome):
            self.final = outcome
            self.media.remove(job["input_key"])
    store = Store()
    assert run_once(store, provider)
    assert store.final["status"] == "failed" and store.final["error_code"] == "PREVIEW_OUTPUT_INVALID"
    assert not (media.root / "inputs/PHOTO.jpg").exists() and "data" not in store.final


@pytest.mark.parametrize("broken", ["missing", "hash", "mapping"])
def test_worker_missing_or_mutated_reference_fails_before_mock_submit(tmp_path, broken):
    provider = MockProvider(tmp_path / "provider" / "mock.db", isolated=True)
    media = PrivateMediaStore(tmp_path / "private")
    media.put("inputs/PHOTO.jpg", normalize_photo(image_bytes()).data)
    class Store:
        def __init__(self):
            self.media, self.final = media, None
        def claim_next(self, _):
            return {"dispatch_id": "DISPATCH", "snapshot": snapshot(), "input_key": "inputs/PHOTO.jpg",
                    "recover_only": False}
        def reference_inputs(self, job):
            values = references()
            if broken == "missing":
                return values[:2]
            if broken == "hash":
                values[0]["data"] = b"mutated-ref"
            if broken == "mapping":
                values[0]["sku_id"] = "REPLACEMENT_SKU"
            return values
        def finish(self, job, outcome):
            self.final = outcome
            self.media.remove(job["input_key"])
    store = Store()
    assert run_once(store, provider) is True
    assert store.final["status"] == "failed" and store.final["error_code"] == "PREVIEW_REFERENCE_UNAVAILABLE"
    with sqlite3.connect(provider.path) as db:
        assert db.execute("SELECT count(*) FROM mock_dispatches").fetchone()[0] == 0
