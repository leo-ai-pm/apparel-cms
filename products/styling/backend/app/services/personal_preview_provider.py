"""Provider boundary. Real photo/model transport is intentionally unavailable.

The explicitly isolated mock persists dispatch facts independently of the API
queue. Recovery only queries a prior dispatch; it never resubmits it.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import uuid

from PIL import Image, ImageDraw


class ProviderError(Exception):
    def __init__(self, code="PREVIEW_PROVIDER_UNAVAILABLE"):
        self.code = code
        super().__init__(code)


class ProviderSubmissionUnknown(ProviderError):
    def __init__(self, provider_request_id=None):
        self.provider_request_id = provider_request_id
        super().__init__("PREVIEW_PROVIDER_UNKNOWN")


class DisabledProvider:
    mode = "disabled"
    is_mock = False

    def submit(self, *args, **kwargs):
        raise ProviderError()

    def query(self, *args, **kwargs):
        raise ProviderSubmissionUnknown()


_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_BEHAVIORS = {"complete", "accepted_timeout", "pending", "failed", "invalid_output", "known_mismatch"}


class MockProvider:
    mode = "mock"
    is_mock = True

    def __init__(self, ledger_path, *, behavior="complete", isolated=False):
        # Tests must opt in explicitly too. An environment typo cannot enable
        # mock generation on a normal consumer/production instance.
        if isolated is not True or behavior not in _BEHAVIORS:
            raise ProviderError()
        self.path = Path(ledger_path)
        self.behavior = behavior
        if not self.path.is_absolute() or self.path.is_symlink() or self.path.parent.is_symlink():
            raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE")
        try:
            if not self.path.parent.exists():
                self.path.parent.mkdir(parents=True, mode=0o700)
                os.chmod(self.path.parent, 0o700)
            if self.path.parent.stat().st_mode & 0o077:
                raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE")
            if self.path.exists():
                info = self.path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_nlink != 1:
                    raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE")
            else:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(fd)
            with self._db() as db:
                db.execute("CREATE TABLE IF NOT EXISTS mock_dispatches (dispatch_id TEXT PRIMARY KEY, "
                           "snapshot_digest TEXT NOT NULL, provider_request_id TEXT NOT NULL UNIQUE, "
                           "behavior TEXT NOT NULL, submit_count INTEGER NOT NULL DEFAULT 1, "
                           "query_count INTEGER NOT NULL DEFAULT 0, reference_count INTEGER NOT NULL, "
                           "reference_binding_sha256 TEXT NOT NULL)")
        except (OSError, sqlite3.Error):
            raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE") from None

    @contextmanager
    def _db(self):
        if self.path.is_symlink() or self.path.lstat().st_mode & 0o077:
            raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE")
        db = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def submit(self, dispatch_id, snapshot, input_bytes, references=None):
        if (not isinstance(dispatch_id, str) or not _ID.fullmatch(dispatch_id)
                or not isinstance(snapshot, dict) or not _SHA.fullmatch(snapshot.get("snapshot_digest", ""))
                or not isinstance(input_bytes, bytes) or not input_bytes):
            raise ProviderError("PREVIEW_PROVIDER_UNAVAILABLE")
        binding_digest = reference_binding(references)
        # This mock never sends, stores or transforms the consumer's pixels.
        # Only a dispatch/snapshot digest is persisted in its technical ledger.
        try:
            with self._db() as db:
                existing = db.execute("SELECT * FROM mock_dispatches WHERE dispatch_id=?", (dispatch_id,)).fetchone()
                if existing is not None:
                    # Repeated submit is refused, even if the caller accidentally
                    # tries it after a lost acknowledgement. Query is required.
                    raise ProviderSubmissionUnknown(existing["provider_request_id"])
                provider_id = "MOCK_" + uuid.uuid4().hex
                db.execute("INSERT INTO mock_dispatches(dispatch_id,snapshot_digest,provider_request_id,behavior,"
                           "reference_count,reference_binding_sha256) VALUES(?,?,?,?,?,?)",
                           (dispatch_id, snapshot["snapshot_digest"], provider_id, self.behavior, 3, binding_digest))
            row = {"provider_request_id": provider_id, "snapshot_digest": snapshot["snapshot_digest"],
                   "behavior": self.behavior, "reference_count": 3, "reference_binding_sha256": binding_digest}
            if self.behavior == "accepted_timeout":
                raise ProviderSubmissionUnknown(provider_id)
            return self._outcome(row)
        except sqlite3.Error:
            raise ProviderSubmissionUnknown() from None

    def query(self, dispatch_id, provider_request_id=None):
        if not isinstance(dispatch_id, str) or not _ID.fullmatch(dispatch_id):
            raise ProviderSubmissionUnknown()
        try:
            with self._db() as db:
                row = db.execute("SELECT * FROM mock_dispatches WHERE dispatch_id=?", (dispatch_id,)).fetchone()
                if row is None or (provider_request_id is not None and provider_request_id != row["provider_request_id"]):
                    raise ProviderSubmissionUnknown(provider_request_id)
                db.execute("UPDATE mock_dispatches SET query_count=query_count+1 WHERE dispatch_id=?", (dispatch_id,))
            return self._outcome(row)
        except sqlite3.Error:
            raise ProviderSubmissionUnknown(provider_request_id) from None

    @staticmethod
    def _outcome(row):
        result = {"status": "output_pending_review", "provider_request_id": row["provider_request_id"],
                  "snapshot_digest": row["snapshot_digest"], "semantic_verified": False,
                  "is_mock": True, "effect_kind": "mock_not_real", "cost_status": "not_applicable_mock",
                  "cost_amount": None, "cost_currency": None, "reference_count": row["reference_count"],
                  "reference_binding_sha256": row["reference_binding_sha256"]}
        behavior = row["behavior"]
        if behavior == "pending":
            result["status"] = "running"
        elif behavior in {"failed", "known_mismatch"}:
            result.update(status="failed", error_code="PREVIEW_OUTPUT_INVALID" if behavior == "known_mismatch"
                          else "PREVIEW_PROVIDER_FAILED")
        elif behavior == "invalid_output":
            result["data"] = b"explicit-mock-invalid-output"
        else:
            # A new synthetic diagnostic image. It is neither a user-photo copy
            # nor an old fixed Look image and cannot prove personal outfit effect.
            image = Image.new("RGB", (320, 480), (233, 235, 238))
            drawing = ImageDraw.Draw(image)
            drawing.rectangle((12, 12, 307, 467), outline=(90, 95, 105), width=3)
            drawing.text((34, 200), "MOCK - NOT REAL", fill=(30, 30, 30))
            drawing.text((34, 230), "NO MODEL / NO PHOTO EFFECT", fill=(30, 30, 30))
            stream = BytesIO()
            image.save(stream, format="JPEG", quality=90)
            image.close()
            result["data"] = stream.getvalue()
        return result


def reference_binding(references):
    """Validate actual three input buffers and return their immutable binding."""
    if not isinstance(references, list) or len(references) != 3:
        raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
    binding, slots = [], set()
    for reference in references:
        if not isinstance(reference, dict):
            raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
        slot, data = reference.get("slot"), reference.get("data")
        digest = reference.get("reference_sha256")
        if (slot not in {"top", "bottom", "shoes"} or slot in slots
                or not isinstance(data, bytes) or not 0 < len(data) <= 5*1024*1024
                or not isinstance(digest, str) or not _SHA.fullmatch(digest)
                or hashlib.sha256(data).hexdigest() != digest):
            raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
        required = {"slot", "sku_id", "product_id", "reference_asset_id", "reference_version", "reference_sha256"}
        if any(not isinstance(reference.get(key), (str, int)) or isinstance(reference.get(key), bool)
               or reference.get(key) == "" for key in required):
            raise ProviderError("PREVIEW_REFERENCE_UNAVAILABLE")
        slots.add(slot)
        binding.append({key: reference[key] for key in sorted(required)})
    encoded = json.dumps(sorted(binding, key=lambda item: item["slot"]), ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def get_provider():
    configured = os.getenv("STYLING_PERSONAL_PREVIEW_PROVIDER", "disabled")
    if configured == "disabled":
        return DisabledProvider()
    if configured == 'runninghub':
        from app.services.personal_preview_runninghub import RunningHubProvider, configuration_ready
        if os.getenv('STYLING_PERSONAL_PREVIEW_ENABLED') != '1' or not configuration_ready():
            raise ProviderError()
        directory = os.getenv('STYLING_PERSONAL_PREVIEW_DIR', '')
        if not directory:
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        return RunningHubProvider(Path(directory) / 'provider-ledger' / 'runninghub.sqlite3',
                                  key=os.environ['RUNNINGHUB_API_KEY'])
    if (configured != "mock" or os.getenv("STYLING_PERSONAL_PREVIEW_ISOLATED", "0") != "1"
            or os.getenv("STYLING_PERSONAL_PREVIEW_ENABLED", "0") != "1"):
        raise ProviderError()
    directory = os.getenv("STYLING_PERSONAL_PREVIEW_DIR", "")
    if not directory:
        raise ProviderError("PREVIEW_STORAGE_UNAVAILABLE")
    return MockProvider(Path(directory) / "provider-ledger" / "mock.sqlite3", isolated=True,
                        behavior=os.getenv("STYLING_PERSONAL_PREVIEW_MOCK_BEHAVIOR", "complete"))
