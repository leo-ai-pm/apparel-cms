"""Private, opt-in personal-preview queue. No real-provider transport lives here.

Authority is checked under the application write transaction before fixed locks
and then this separate SQLite store. These are single-host consistency cuts,
not a distributed transaction. Accepted snapshots never reread a saved profile.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import base64
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import threading
import time
import uuid

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.consumer_context import validate_authorization
from app.core.consumer_identity import ConsumerAuthorization, ConsumerOwner
from app.core.database import SessionLocal
from app.models.profile_snapshot import ConsumerSessionOwner
from app.schemas.consumer_profile import ProfileError

CONTRACT = "personal_outfit_preview_v1"
MARKER = "personal-preview-private-store-v1"
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_SLOTS = ("top", "bottom", "shoes")
_TABLES = {"preview_meta", "preview_confirmations", "preview_tasks", "preview_attempts",
           "preview_delete_actions", "preview_cleanup"}
_STORE = None
_STORE_CONFIG = None
_STORE_LOCK = threading.RLock()


class PreviewError(Exception):
    def __init__(self, code, message="本人效果请求未完成，请检查状态后重试。", status=409):
        self.code, self.message, self.status = code, message, status
        super().__init__(code)


def _require(condition, code="PREVIEW_INVALID_REQUEST", status=422, message=None):
    if not condition:
        raise PreviewError(code, message or "本人效果请求条件无效。", status)


def _canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise PreviewError("PREVIEW_INVALID_REQUEST", "请求字段无效。", 422) from None


def _hash(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def _epoch(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).timestamp() if value.tzinfo is None else value.timestamp()
    _require(type(value) in (int, float) and math.isfinite(value), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    return float(value)


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def _identifier(value):
    _require(isinstance(value, str) and bool(_ID.fullmatch(value)))
    return value


def _sha(value):
    _require(isinstance(value, str) and bool(_SHA.fullmatch(value)))
    return value


def _closed(body, keys):
    _require(type(body) is dict and set(body) == set(keys) and body.get("contract_version") == CONTRACT)


def _private_path(path):
    path = Path(path).expanduser()
    _require(path.is_absolute(), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    _require(not any(p.is_symlink() for p in (path, *path.parents)), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    return path


def capabilities():
    enabled = os.getenv("STYLING_PERSONAL_PREVIEW_ENABLED", "0") == "1"
    isolated = os.getenv("STYLING_PERSONAL_PREVIEW_ISOLATED", "0") == "1"
    provider = os.getenv("STYLING_PERSONAL_PREVIEW_PROVIDER", "disabled")
    from app.services.personal_preview_runninghub import configuration_ready, MODEL
    real = enabled and provider == 'runninghub' and configuration_ready()
    available = (enabled and isolated and provider == "mock") or real
    return {"contract_version": CONTRACT, "enabled": enabled, "available": available,
            "provider_mode": provider if provider in ("disabled", "mock", "runninghub") else "disabled",
            "is_mock": available and provider == 'mock', "real_provider_enabled": real,
            "provider_model": MODEL if real else None,
            "limits": {"max_photo_bytes": 5 * 1024 * 1024, "max_pixels": 20_000_000,
                       "max_edge": 8192, "daily_tasks": 10, "owner_concurrency": 1},
            "retention": {"input_seconds": 86400, "result_seconds": 30 * 86400,
                          "metadata_seconds": 90 * 86400, "confirmation_seconds": 600,
                          "provider_deletion": "unknown"},
            "reasons": [] if available else ["PREVIEW_DISABLED" if not enabled else "PREVIEW_PROVIDER_UNAVAILABLE"]}


class PreviewStore:
    def __init__(self, db_path, private_dir, *, session_factory=None, selection_reader=None,
                 clock=None, media=None, provider_mode="disabled", isolated=False, daily_limit=10):
        self.path, self.private_dir = _private_path(db_path), _private_path(private_dir)
        _require(self.path.parent == self.private_dir and self.path.suffix in (".db", ".sqlite", ".sqlite3"),
                 "PREVIEW_STORAGE_UNAVAILABLE", 503)
        _require(provider_mode in ("disabled", "mock", "runninghub") and (provider_mode != "mock" or isolated),
                 "PREVIEW_PROVIDER_UNAVAILABLE", 503)
        _require(type(daily_limit) is int and 1 <= daily_limit <= 100, "PREVIEW_STORAGE_UNAVAILABLE", 503)
        self.provider_mode, self.isolated, self.daily_limit = provider_mode, isolated, daily_limit
        self.session_factory = session_factory or SessionLocal
        self.selection_reader, self.clock = selection_reader, clock or time.time
        self.lock = threading.RLock()
        self.private_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.private_dir, 0o700)
        from app.services.personal_preview_media import PrivateMediaStore
        self.media = media or PrivateMediaStore(self.private_dir)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            os.close(fd)
            _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                     "PREVIEW_STORAGE_UNAVAILABLE", 503)
            os.chmod(self.path, 0o600)
            self.db = sqlite3.connect(str(self.path), timeout=10, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self._initialize()
            self.db.execute("PRAGMA secure_delete=ON")
            self.db.execute("PRAGMA journal_mode=DELETE")
        except (sqlite3.Error, OSError):
            raise PreviewError("PREVIEW_STORAGE_UNAVAILABLE", "私有任务存储暂不可用。", 503) from None

    def _initialize(self):
        names = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        _require(not names or names == _TABLES, "PREVIEW_STORAGE_UNAVAILABLE", 503)
        if not names:
            with self.db:
                self.db.execute("CREATE TABLE preview_meta(marker TEXT PRIMARY KEY, contract TEXT NOT NULL)")
                self.db.execute("INSERT INTO preview_meta VALUES(?,?)", (MARKER, CONTRACT))
                self.db.execute("""CREATE TABLE preview_confirmations(
                    confirmation_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, auth_instance TEXT NOT NULL,
                    token_digest TEXT NOT NULL UNIQUE, photo_sha TEXT NOT NULL, selection_digest TEXT NOT NULL,
                    snapshot TEXT NOT NULL, issued REAL NOT NULL, expires REAL NOT NULL, accepted_task TEXT)""")
                self.db.execute("""CREATE TABLE preview_tasks(
                    task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, owner_json TEXT NOT NULL,
                    identity_digest TEXT NOT NULL, auth_instance TEXT NOT NULL, request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, session_id TEXT NOT NULL, look_version_id TEXT NOT NULL,
                    snapshot TEXT NOT NULL, state TEXT NOT NULL, deletion_status TEXT NOT NULL,
                    deletion_generation INTEGER NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
                    input_expires REAL NOT NULL, expires REAL NOT NULL, metadata_expires REAL NOT NULL,
                    input_key TEXT, result_key TEXT, result_sha TEXT, result_created REAL,
                    error_code TEXT, error_message TEXT, UNIQUE(owner_key,request_id))""")
                self.db.execute("""CREATE TABLE preview_attempts(
                    attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, dispatch_id TEXT NOT NULL UNIQUE,
                    lease_epoch INTEGER NOT NULL, lease_until REAL NOT NULL, worker_id TEXT NOT NULL,
                    deletion_generation INTEGER NOT NULL, state TEXT NOT NULL,
                    provider_request_id TEXT, created REAL NOT NULL, updated REAL NOT NULL)""")
                self.db.execute("""CREATE TABLE preview_delete_actions(
                    owner_key TEXT NOT NULL, action_id TEXT NOT NULL, task_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(owner_key,action_id))""")
                self.db.execute("""CREATE TABLE preview_cleanup(
                    task_id TEXT NOT NULL, media_kind TEXT NOT NULL, media_key TEXT,
                    status TEXT NOT NULL, attempts INTEGER NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(task_id,media_kind))""")
        rows = self.db.execute("SELECT * FROM preview_meta").fetchall()
        _require(len(rows) == 1 and rows[0]["marker"] == MARKER and rows[0]["contract"] == CONTRACT,
                 "PREVIEW_STORAGE_UNAVAILABLE", 503)

    def now(self):
        return _epoch(self.clock())

    def close(self):
        with self.lock:
            self.db.close()

    @contextmanager
    def _transaction(self):
        try:
            with self.lock:
                self.db.execute("BEGIN IMMEDIATE")
                try:
                    yield self.db
                    self.db.commit()
                except BaseException:
                    self.db.rollback()
                    raise
        except sqlite3.Error:
            raise PreviewError("PREVIEW_STORAGE_UNAVAILABLE", "私有任务存储暂不可用。", 503) from None

    @contextmanager
    def _authority(self, owner, authorization, session_id=None):
        try:
            with self.session_factory() as db:
                if db.bind.dialect.name == "sqlite":
                    db.execute(text("BEGIN IMMEDIATE"))
                else:
                    db.begin()
                instance, expiry = validate_authorization(db, owner, authorization)
                _require(owner.scope_kind == "device", "PREVIEW_AUTH_NOT_SUPPORTED", 403,
                         "当前账号适配没有可持久重验的本人照片授权。")
                if session_id is not None:
                    own = db.get(ConsumerSessionOwner, session_id)
                    if own is None:
                        raise PreviewError("PREVIEW_SESSION_RESTART_REQUIRED", "请明确新建私有搭配会话。", 409)
                    if own.owner_key != owner.binding_key:
                        raise PreviewError("PREVIEW_NOT_FOUND", "该对象不存在或不属于当前空间。", 404)
                yield db, instance, _epoch(expiry)
                # This transaction only pins authorization/positive ownership.
                db.rollback()
        except SQLAlchemyError:
            raise PreviewError("PREVIEW_STORAGE_UNAVAILABLE", "身份权威存储暂不可用。", 503) from None

    @contextmanager
    def _selection_scope(self, db, owner, session_id, look_version_id, instance):
        if self.selection_reader is not None:
            raw = self.selection_reader(owner, session_id, look_version_id)
            yield self._snapshot(raw, owner, session_id, look_version_id, instance)
            return
        from app.services import fixed_styling as fixed, product_image_assets as assets
        try:
            service = fixed.get_service()
            sid = fixed._resolve_session_id(service, session_id)
            # Existing restoration takes its transport/session lock before app
            # admission. Do not take that reverse-order lock here. All durable
            # M2 row/resource commits are protected by service + store locks.
            with service.lock, service.store.lock:
                aliases = [sid] + [r[0] for r in service.store.db.execute(
                    "SELECT product_session_id FROM fixed_product_sessions WHERE fixed_session_id=?", (sid,))]
                positives = [db.get(ConsumerSessionOwner, a) for a in aliases]
                _require(any(p is not None and p.owner_key == owner.binding_key for p in positives),
                         "PREVIEW_SESSION_RESTART_REQUIRED", 409)
                _require(all(p is None or p.owner_key == owner.binding_key for p in positives), "PREVIEW_NOT_FOUND", 404)
                # Read only this session's persisted history, never service-wide LV ids.
                row = service.store.get(sid)
                _require(row is not None, "PREVIEW_NOT_FOUND", 404)
                version = next((v for v in row["history"] if v["look_version_id"] == look_version_id), None)
                _require(version is not None, "PREVIEW_NOT_FOUND", 404)
                resources = fixed._call(service.resources)
                look = resources.looks.get(version["look_id"])
                eligible = look is not None and look["active"] is True and look["items"] == version["items"]
                raw = {"session_id": session_id, "look_version_id": look_version_id,
                       "look_asset_id": version["look_id"], "items": [], "resources": deepcopy(resources.binding),
                       "scene": row["state"]["context"].get("scene"),
                       "effective_conditions": {"budget_max_fen": row["state"]["context"].get("budget_max_fen"),
                           "usual_sizes": deepcopy(row["state"]["profile"].get("usual_sizes", {}))},
                       "profile_summary": deepcopy(version.get("profile_snapshot")),
                       "current_look_version_id": row["state"].get("current_look_version_id"),
                       "active_constraints": deepcopy([c for c in row["state"].get("constraints", [])
                                                         if c.get("status") == "active"])}
                if type(version.get("version_no")) is int and version["version_no"] >= 1:
                    raw["look_version_no"] = version["version_no"]
                reasons = []
                if not eligible:
                    reasons.append("PREVIEW_LOOK_INELIGIBLE")
                else:
                    fixed._call(lambda: resources.check_image(look))
                    raw["fixed_image"] = {"asset_id": look["look_id"], "sha256": look["image_sha256"],
                                          "origin": deepcopy(look["origin"])}
                    for slot in _SLOTS:
                        sku_id = version["items"][slot]
                        sku, stock = resources.skus[sku_id], resources.stock[sku_id]
                        if (sku["sale_status"] != "sellable" or not resources.products[sku["product_id"]]["active"]
                                or not stock["sellable"] or stock["available_qty"] < 1
                                or sku["size"] != raw["effective_conditions"]["usual_sizes"].get(slot)):
                            reasons.append("PREVIEW_LOOK_INELIGIBLE")
                        ref = assets.current_ref(resources, sku["product_id"], sku_id)
                        item = {"slot": slot, "sku_id": sku_id, "product_id": sku["product_id"],
                                "size": deepcopy(sku["size"]), "price_fen": sku["price_fen"]}
                        if ref is None:
                            reasons.append("PREVIEW_REFERENCE_UNAVAILABLE")
                        else:
                            data, mime, digest = assets.image_bytes(ref["asset_id"], resources)
                            _require(digest == ref["image_sha256"] and _hash(data) == digest,
                                     "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                            item.update(reference_asset_id=ref["asset_id"], reference_version=ref["asset_version"],
                                        reference_sha256=digest)
                        raw["items"].append(item)
                    budget = raw["effective_conditions"]["budget_max_fen"]
                    if type(budget) is not int or sum(i["price_fen"] for i in raw["items"]) > budget:
                        reasons.append("PREVIEW_LOOK_INELIGIBLE")
                    for constraint in raw["active_constraints"]:
                        if constraint.get("strength") != "hard":
                            continue
                        kind, value, slot = constraint.get("kind"), constraint.get("value"), constraint.get("target_slot")
                        slots = [slot] if slot in _SLOTS else _SLOTS
                        violates = ((kind == "keep_sku" and slot in _SLOTS and look["items"][slot] != value)
                                    or (kind == "forbid_sku" and value in [look["items"][s] for s in slots])
                                    or (kind == "forbid_attribute" and resources.hit(look, value, slots) > 0)
                                    or (kind == "scene" and resources.hit(look, value) == 0))
                        if violates:
                            reasons.append("PREVIEW_LOOK_INELIGIBLE")
                raw["available"], raw["reasons"] = not reasons, sorted(set(reasons))
                yield self._snapshot(raw, owner, session_id, look_version_id, instance)
        except fixed.FixedStylingError:
            raise PreviewError("PREVIEW_LOOK_INELIGIBLE", "搭配版本或当前资源不可用。", 409) from None
        except (assets.ProductImageAssetError, OSError):
            raise PreviewError("PREVIEW_REFERENCE_UNAVAILABLE", "完整三槽参考图暂不可用。", 409) from None

    def _snapshot(self, raw, owner, session_id, look_version_id, instance):
        _require(type(raw) is dict and raw.get("session_id") == session_id
                 and raw.get("look_version_id") == look_version_id, "PREVIEW_NOT_FOUND", 404)
        raw = deepcopy(raw)
        items = raw.get("items", [])
        valid = (type(items) is list and len(items) == 3 and {i.get("slot") for i in items} == set(_SLOTS)
                 and all(all(k in i for k in ("sku_id", "product_id", "size", "price_fen", "reference_asset_id",
                                             "reference_version", "reference_sha256")) for i in items))
        if not valid:
            raw["available"] = False
            raw["reasons"] = sorted(set(raw.get("reasons", []) + ["PREVIEW_REFERENCE_UNAVAILABLE"]))
        raw.setdefault("available", True)
        raw.setdefault("reasons", [])
        from app.services.personal_preview_runninghub import configuration_ready, MODEL
        real = self.provider_mode == 'runninghub' and configuration_ready()
        if not real and (self.provider_mode != "mock" or not self.isolated):
            raw["available"] = False
            raw["reasons"] = sorted(set(raw["reasons"] + ["PREVIEW_PROVIDER_UNAVAILABLE"]))
        # Exclude body measurements and reduce any profile record to its version binding.
        profile = raw.get("profile_summary")
        raw["profile_summary"] = ({k: profile[k] for k in ("profile_id", "profile_version", "snapshot_id", "snapshot_digest")
                                    if k in profile} if isinstance(profile, dict) else None)
        conditions = raw.get("effective_conditions") or {}
        raw["effective_conditions"] = {k: deepcopy(conditions[k]) for k in ("budget_max_fen", "usual_sizes") if k in conditions}
        raw.update(prompt_version="personal_preview_prompt_v1", provider_mode=self.provider_mode,
                   config_version="personal_preview_config_v1", limit_version="personal_preview_limits_v1",
                   limits={"daily_tasks": self.daily_limit, "owner_concurrency": 1},
                   identity_fact={"owner_key": owner.binding_key, "auth_instance": instance})
        if real:
            raw.update(prompt_version='personal_preview_identity_four_refs_v1', provider_model=MODEL)
            raw['limits']['total_real_tasks'] = 1
        digest = _hash(_canonical(raw))
        raw["snapshot_id"], raw["snapshot_digest"] = "pvs-" + digest[:32], digest
        return raw

    @staticmethod
    def _public_selection(snapshot):
        allowed = ("snapshot_id", "snapshot_digest", "session_id", "look_version_id", "look_asset_id", "items",
                   "look_version_no", "fixed_image", "resources", "scene", "effective_conditions", "profile_summary", "prompt_version")
        return {k: deepcopy(snapshot[k]) for k in allowed if k in snapshot}

    def availability(self, owner, authorization, session_id, look_version_id):
        _identifier(session_id)
        _require(isinstance(look_version_id, str) and 0 < len(look_version_id) <= 150)
        with self._authority(owner, authorization, session_id) as (db, instance, _):
            with self._selection_scope(db, owner, session_id, look_version_id, instance) as snapshot:
                return {"contract_version": CONTRACT, "available": snapshot["available"],
                        "reasons": snapshot["reasons"], "selection_digest": snapshot["snapshot_digest"],
                        "selection": self._public_selection(snapshot)}

    def _available(self, snapshot):
        if not snapshot["available"]:
            code = snapshot["reasons"][0] if snapshot["reasons"] else "PREVIEW_REFERENCE_UNAVAILABLE"
            raise PreviewError(code, "当前版本或完整参考图尚不可生成本人效果。", 503 if "PROVIDER" in code else 409)

    def confirm(self, owner, authorization, body):
        _closed(body, {"contract_version", "session_id", "look_version_id", "selection_digest", "photo_sha256",
                       "confirmed_photo_rights", "confirmed_ai_reference"})
        _identifier(body["session_id"]); _sha(body["selection_digest"]); _sha(body["photo_sha256"])
        _require(body["confirmed_photo_rights"] is True and body["confirmed_ai_reference"] is True)
        with self._authority(owner, authorization, body["session_id"]) as (db, instance, identity_expiry):
            with self._selection_scope(db, owner, body["session_id"], body["look_version_id"], instance) as snapshot:
                self._available(snapshot)
                _require(body["selection_digest"] == snapshot["snapshot_digest"], "PREVIEW_SELECTION_CHANGED", 409)
                token, now = secrets.token_urlsafe(32), self.now()
                expiry = min(now + 600, identity_expiry)
                _require(expiry > now, "PROFILE_OWNER_INVALID", 403)
                confirmation_id = "pvc-" + uuid.uuid4().hex
                with self._transaction() as connection:
                    connection.execute("INSERT INTO preview_confirmations VALUES(?,?,?,?,?,?,?,?,?,NULL)",
                        (confirmation_id, owner.binding_key, instance, _hash(token), body["photo_sha256"],
                         snapshot["snapshot_digest"], _canonical(snapshot), now, expiry))
                return {"contract_version": CONTRACT, "confirmation_id": confirmation_id,
                        "confirmation_token": token, "issued_at": _iso(now), "expires_at": _iso(expiry),
                        "selection": self._public_selection(snapshot)}

    def _metadata(self, metadata):
        _closed(metadata, {"contract_version", "request_id", "session_id", "look_version_id", "selection_digest",
                           "photo_sha256", "confirmation_id", "confirmation_token"})
        for field in ("request_id", "session_id", "confirmation_id"):
            _identifier(metadata[field])
        _require(isinstance(metadata["look_version_id"], str) and 0 < len(metadata["look_version_id"]) <= 150)
        _sha(metadata["selection_digest"]); _sha(metadata["photo_sha256"])
        _require(isinstance(metadata["confirmation_token"], str) and bool(_TOKEN.fullmatch(metadata["confirmation_token"])))
        safe = dict(metadata)
        safe["confirmation_token"] = {"sha256": _hash(metadata["confirmation_token"])}
        return _hash(_canonical({"fingerprint_version": "preview_request_sha256_v1", "metadata": safe,
                                 "actual_photo_sha256": metadata["photo_sha256"]}))

    def submit(self, owner, authorization, metadata, normalized_photo, *, first_upload_at=None):
        fingerprint = self._metadata(metadata)
        _require(normalized_photo.raw_sha256 == metadata["photo_sha256"], "PREVIEW_HASH_MISMATCH", 422)
        _require(_hash(normalized_photo.data) == normalized_photo.sha256
                 and normalized_photo.mime_type == "image/jpeg", "PREVIEW_PHOTO_INVALID", 422)
        with self._authority(owner, authorization, metadata["session_id"]) as (db, instance, _):
            # Exact replay is a fact lookup before mutable Look/confirmation/limits.
            with self._transaction() as connection:
                old = connection.execute("SELECT * FROM preview_tasks WHERE owner_key=? AND request_id=?",
                                         (owner.binding_key, metadata["request_id"])).fetchone()
                if old:
                    _require(old["fingerprint"] == fingerprint, "PREVIEW_REQUEST_CONFLICT", 409)
                    return {"task": self._dto(old), "duplicate": True}
            with self._selection_scope(db, owner, metadata["session_id"], metadata["look_version_id"], instance) as snapshot:
                self._available(snapshot)
                _require(snapshot["snapshot_digest"] == metadata["selection_digest"], "PREVIEW_SELECTION_CHANGED", 409)
                now = self.now()
                uploaded = now if first_upload_at is None else _epoch(first_upload_at)
                _require(uploaded <= now + 5 and now < uploaded + 86400, "PREVIEW_PHOTO_INVALID", 422)
                key, task_id = "inputs/" + uuid.uuid4().hex + ".jpg", "pvt-" + uuid.uuid4().hex
                written = False
                try:
                    with self._transaction() as connection:
                        # Positive identity + fixed locks remain held through commit.
                        confirmation = connection.execute("SELECT * FROM preview_confirmations WHERE confirmation_id=?",
                                                          (metadata["confirmation_id"],)).fetchone()
                        _require(confirmation is not None and confirmation["owner_key"] == owner.binding_key
                                 and confirmation["auth_instance"] == instance
                                 and confirmation["token_digest"] == _hash(metadata["confirmation_token"]),
                                 "PREVIEW_CONFIRMATION_INVALID", 409)
                        _require(confirmation["expires"] > now, "PREVIEW_CONFIRMATION_EXPIRED", 409)
                        _require(confirmation["accepted_task"] is None, "PREVIEW_CONFIRMATION_INVALID", 409)
                        _require(confirmation["photo_sha"] == metadata["photo_sha256"]
                                 and confirmation["selection_digest"] == snapshot["snapshot_digest"]
                                 and confirmation["snapshot"] == _canonical(snapshot), "PREVIEW_SELECTION_CHANGED", 409)
                        busy = connection.execute("""SELECT 1 FROM preview_tasks t LEFT JOIN preview_attempts a ON a.task_id=t.task_id
                            WHERE t.owner_key=? AND ((t.deletion_status='active' AND t.state IN ('queued','running','provider_unknown'))
                            OR a.state='unknown') LIMIT 1""", (owner.binding_key,)).fetchone()
                        _require(busy is None, "PREVIEW_CONCURRENCY_LIMIT", 409)
                        start = int(now // 86400) * 86400
                        count = connection.execute("SELECT count(*) FROM preview_tasks WHERE owner_key=? AND created>=? AND created<?",
                                                   (owner.binding_key, start, start + 86400)).fetchone()[0]
                        _require(count < self.daily_limit, "PREVIEW_DAILY_LIMIT", 429)
                        if self.provider_mode == 'runninghub':
                            # Tombstones survive snapshot expiry. Never reset the
                            # authorized total when 90-day metadata is cleared.
                            total = connection.execute("SELECT count(*) FROM preview_tasks").fetchone()[0]
                            _require(total < 1, 'PREVIEW_TOTAL_LIMIT', 429)
                        self.media.put(key, normalized_photo.data)
                        written = True
                        connection.execute("""INSERT INTO preview_tasks VALUES(
                            ?,?,?,?,?,?,?,?,?,?,'queued','active',0,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)""",
                            (task_id, owner.binding_key, _canonical(owner.binding), authorization.identity_token_digest,
                             instance, metadata["request_id"], fingerprint, metadata["session_id"], metadata["look_version_id"],
                             confirmation["snapshot"], now, now, uploaded + 86400, now + 30 * 86400,
                             now + 90 * 86400, key))
                        connection.execute("UPDATE preview_confirmations SET accepted_task=? WHERE confirmation_id=?",
                                           (task_id, metadata["confirmation_id"]))
                        self._schedule(connection, task_id, "input", key, "retained")
                        task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task_id,)).fetchone()
                        dto = self._dto(task)
                    return {"task": dto, "duplicate": False}
                except BaseException:
                    if written:
                        try:
                            self.media.remove(key)
                        except Exception:
                            # The orphan is recovered by the private cleanup scan.
                            pass
                    raise

    def _task(self, connection, owner, task_id):
        row = connection.execute("SELECT * FROM preview_tasks WHERE task_id=? AND owner_key=?", (task_id, owner.binding_key)).fetchone()
        _require(row is not None, "PREVIEW_NOT_FOUND", 404)
        return row

    def _dto(self, task):
        snapshot = json.loads(task["snapshot"]) if task["snapshot"] else {}
        mode = snapshot.get("provider_mode", self.provider_mode)
        clean = self.db.execute("SELECT status FROM preview_cleanup WHERE task_id=? AND media_kind='input'", (task["task_id"],)).fetchone()
        attempts = self.db.execute("SELECT state,dispatch_id FROM preview_attempts WHERE task_id=?", (task["task_id"],)).fetchall()
        usage = {}
        if mode == 'runninghub' and attempts:
            from app.services.personal_preview_runninghub import public_usage
            usage = public_usage(self.private_dir / 'provider-ledger/runninghub.sqlite3', attempts[0]['dispatch_id'])
        available = task["deletion_status"] == "active" and task["state"] in ("output_pending_review", "succeeded") and task["expires"] > self.now() and bool(task["result_key"])
        if available:
            try:
                available = _hash(self.media.read(task["result_key"])) == task["result_sha"]
            except Exception:
                available = False
        state = task["state"]
        if task["expires"] <= self.now() and state != "failed":
            state = "expired"
        model_available = (task["deletion_status"] == "active" and task["expires"] > self.now()
                           and state != "expired" and bool(snapshot.get("fixed_image")))
        return {"contract_version": CONTRACT, "task_id": task["task_id"], "request_id": task["request_id"],
                "session_id": task["session_id"], "look_version_id": task["look_version_id"], "state": state,
                "deletion_status": task["deletion_status"], "created_at": _iso(task["created"]),
                "updated_at": _iso(task["updated"]), "expires_at": _iso(task["expires"]),
                "selection": self._public_selection(snapshot),
                "selection_status": "available" if snapshot else "content_cleared",
                "model_image_url": "/api/v1/personal-preview/tasks/" + task["task_id"] + "/model-image" if model_available else None,
                "is_mock": mode == "mock",
                "effect_kind": "mock_not_real" if mode == "mock" else ('ai_personal_reference' if mode == 'runninghub' and available else "unavailable"),
                "effective_personal_preview": False, "result_available": available,
                "result_url": "/api/v1/personal-preview/tasks/" + task["task_id"] + "/result" if available else None,
                "error": {"code": task["error_code"], "message": task["error_message"]} if task["error_code"] else None,
                "input_cleanup": {"status": clean[0] if clean else "not_present", "expires_at": _iso(task["input_expires"])},
                "usage": {"task_count": 1, "attempt_count": len(attempts),
                          "unknown_attempts": sum(a[0] == "unknown" for a in attempts),
                          "cost_status": "not_applicable_mock" if mode == "mock" else "unknown", **usage}}

    def lookup_request(self, owner, authorization, request_id):
        _identifier(request_id)
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                row = connection.execute("SELECT * FROM preview_tasks WHERE owner_key=? AND request_id=?", (owner.binding_key, request_id)).fetchone()
                _require(row is not None, "PREVIEW_NOT_FOUND", 404)
                return self._dto(row)

    def get(self, owner, authorization, task_id):
        _identifier(task_id)
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                return self._dto(self._task(connection, owner, task_id))

    def list(self, owner, authorization, limit=20, cursor=None):
        _require(type(limit) is int and 1 <= limit <= 50)
        pivot = None
        if cursor is not None:
            try:
                pivot = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                _require(type(pivot) is list and len(pivot) == 2 and type(pivot[0]) in (int, float))
                _identifier(pivot[1])
            except (ValueError, TypeError, UnicodeError):
                raise PreviewError("PREVIEW_INVALID_REQUEST", "分页游标无效。", 422) from None
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                query, args = "SELECT * FROM preview_tasks WHERE owner_key=?", [owner.binding_key]
                if pivot:
                    query += " AND (created<? OR (created=? AND task_id<?))"
                    args += [pivot[0], pivot[0], pivot[1]]
                rows = connection.execute(query + " ORDER BY created DESC,task_id DESC LIMIT ?", args + [limit + 1]).fetchall()
                page = rows[:limit]
                next_cursor = None
                if len(rows) > limit:
                    next_cursor = base64.urlsafe_b64encode(_canonical([page[-1]["created"], page[-1]["task_id"]]).encode()).decode().rstrip("=")
                return {"items": [self._dto(row) for row in page], "next_cursor": next_cursor}

    def result(self, owner, authorization, task_id):
        _identifier(task_id)
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                row = self._task(connection, owner, task_id)
                _require(row["deletion_status"] == "active", "PREVIEW_DELETED", 410)
                _require(row["expires"] > self.now() and row["state"] != "expired", "PREVIEW_RESULT_EXPIRED", 410)
                _require(row["state"] in ("output_pending_review", "succeeded") and row["result_key"], "PREVIEW_RESULT_NOT_READY", 409)
                try:
                    data = self.media.read(row["result_key"])
                    _require(_hash(data) == row["result_sha"], "PREVIEW_RESULT_NOT_READY", 409)
                except Exception as exc:
                    if isinstance(exc, PreviewError):
                        raise
                    raise PreviewError("PREVIEW_RESULT_NOT_READY", "私有结果暂不可读取。", 409) from None
                return data, "image/jpeg"

    def _model_binding(self, task):
        _require(task["deletion_status"] == "active", "PREVIEW_DELETED", 410)
        snapshot = json.loads(task["snapshot"]) if task["snapshot"] else {}
        _require(bool(snapshot), "PREVIEW_HISTORY_METADATA_UNAVAILABLE", 410)
        _require(task["expires"] > self.now() and task["state"] != "expired", "PREVIEW_RESULT_EXPIRED", 410)
        image = snapshot.get("fixed_image")
        _require(isinstance(image, dict) and isinstance(image.get("asset_id"), str)
                 and bool(image["asset_id"]) and isinstance(image.get("sha256"), str)
                 and bool(_SHA.fullmatch(image["sha256"])), "PREVIEW_REFERENCE_UNAVAILABLE", 409)
        return image

    def model_image(self, owner, authorization, task_id):
        """Return original fixed PNG bytes bound to this private task's snapshot.

        Never select today's Look, copy pixels into private storage, or rewrite
        an old snapshot. Release preview locks before the fixed asset reader.
        """
        _identifier(task_id)
        with self._authority(owner, authorization) as (db, _, _):
            with self._transaction() as connection:
                task = self._task(connection, owner, task_id)
                image = self._model_binding(task)
                original_snapshot = task["snapshot"]
                session_id = task["session_id"]
            positive = db.get(ConsumerSessionOwner, session_id)
            _require(positive is not None and positive.owner_key == owner.binding_key, "PREVIEW_NOT_FOUND", 404)
            from app.services import fixed_styling as fixed
            try:
                data = fixed.asset_bytes(image["asset_id"])
                _require(isinstance(data, bytes) and _hash(data) == image["sha256"]
                         and data.startswith(b"\x89PNG\r\n\x1a\n"), "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                from PIL import Image
                with Image.open(BytesIO(data)) as decoded:
                    _require(decoded.format == "PNG" and getattr(decoded, "n_frames", 1) == 1,
                             "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                    decoded.verify()
                with Image.open(BytesIO(data)) as decoded:
                    decoded.load()
            except (fixed.FixedStylingError, OSError, ValueError, SyntaxError):
                raise PreviewError("PREVIEW_REFERENCE_UNAVAILABLE", "原冻结模特图暂不可读取。", 409) from None
            with self._transaction() as connection:
                current = self._task(connection, owner, task_id)
                self._model_binding(current)
                _require(current["snapshot"] == original_snapshot, "PREVIEW_REFERENCE_UNAVAILABLE", 409)
            return data, "image/png"

    def _schedule(self, connection, task_id, kind, key, status="pending"):
        connection.execute("""INSERT INTO preview_cleanup VALUES(?,?,?,?,0,?)
            ON CONFLICT(task_id,media_kind) DO UPDATE SET media_key=excluded.media_key,status=excluded.status,updated=excluded.updated""",
                           (task_id, kind, key, status, self.now()))

    def _unlink(self, task_id):
        with self._transaction() as connection:
            rows = connection.execute("SELECT * FROM preview_cleanup WHERE task_id=? AND status IN ('pending','failed')", (task_id,)).fetchall()
            for row in rows:
                try:
                    if row["media_key"]:
                        self.media.remove(row["media_key"])
                    status = "deleted"
                except Exception:
                    status = "failed"
                connection.execute("UPDATE preview_cleanup SET status=?,attempts=attempts+1,updated=? WHERE task_id=? AND media_kind=?",
                                   (status, self.now(), task_id, row["media_kind"]))
                if status == "deleted":
                    column = "input_key" if row["media_kind"] == "input" else "result_key"
                    connection.execute("UPDATE preview_tasks SET " + column + "=NULL WHERE task_id=?", (task_id,))
            task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task_id,)).fetchone()
            if task and task["deletion_status"] == "deleting":
                pending = connection.execute("SELECT 1 FROM preview_cleanup WHERE task_id=? AND status!='deleted'", (task_id,)).fetchone()
                if pending is None:
                    connection.execute("UPDATE preview_tasks SET deletion_status='deleted',updated=? WHERE task_id=?", (self.now(), task_id))

    def delete(self, owner, authorization, task_id, body):
        _identifier(task_id)
        _closed(body, {"contract_version", "delete_action_id"})
        _identifier(body["delete_action_id"])
        digest = _hash(_canonical({"task_id": task_id, "body": body}))
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                row = self._task(connection, owner, task_id)
                old = connection.execute("SELECT * FROM preview_delete_actions WHERE owner_key=? AND action_id=?", (owner.binding_key, body["delete_action_id"])).fetchone()
                _require(old is None or (old["task_id"] == task_id and old["fingerprint"] == digest), "PREVIEW_ACTION_CONFLICT", 409)
                if old is None:
                    connection.execute("INSERT INTO preview_delete_actions VALUES(?,?,?,?,?)", (owner.binding_key, body["delete_action_id"], task_id, digest, self.now()))
                if row["deletion_status"] == "active":
                    connection.execute("UPDATE preview_tasks SET deletion_status='deleting',deletion_generation=deletion_generation+1,updated=? WHERE task_id=?", (self.now(), task_id))
                    for kind in ("input", "result"):
                        self._schedule(connection, task_id, kind, row[kind + "_key"])
            # Tombstone is committed before any physical unlink can fail.
            self._unlink(task_id)
            with self._transaction() as connection:
                return self._deletion_dto(self._task(connection, owner, task_id), duplicate=old is not None)

    def _deletion_dto(self, row, duplicate=False):
        statuses = {r["media_kind"]: r["status"] for r in self.db.execute("SELECT * FROM preview_cleanup WHERE task_id=?", (row["task_id"],))}
        return {"contract_version": CONTRACT, "task_id": row["task_id"], "deletion_status": row["deletion_status"],
                "duplicate": duplicate, "input_deletion": statuses.get("input", "not_present"),
                "result_deletion": statuses.get("result", "not_present"),
                "provider_cancel": "not_applicable_mock" if self.provider_mode == "mock" else "unknown",
                "provider_deletion": "not_applicable_mock" if self.provider_mode == "mock" else "unknown",
                "backup_deletion": "unknown"}

    def deletion(self, owner, authorization, task_id):
        _identifier(task_id)
        with self._authority(owner, authorization):
            with self._transaction() as connection:
                return self._deletion_dto(self._task(connection, owner, task_id))

    def _job_owner(self, task):
        owner = ConsumerOwner(**json.loads(task["owner_json"]))
        return owner, ConsumerAuthorization(owner, identity_token_digest=task["identity_digest"])

    def _peek(self, task_id=None):
        with self.lock:
            if task_id:
                return self.db.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task_id,)).fetchone()
            return self.db.execute("""SELECT t.* FROM preview_tasks t LEFT JOIN preview_attempts a ON a.task_id=t.task_id
                WHERE t.deletion_status='active' AND t.state IN ('queued','running','provider_unknown')
                AND (a.task_id IS NULL OR a.lease_until<=?) ORDER BY t.created,t.task_id LIMIT 1""", (self.now(),)).fetchone()

    def _invalidate(self, task_id, code="PROFILE_OWNER_INVALID"):
        with self._transaction() as connection:
            task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task_id,)).fetchone()
            if task is None:
                return
            connection.execute("UPDATE preview_tasks SET state='expired',deletion_generation=deletion_generation+1,error_code=?,error_message=?,updated=? WHERE task_id=?", (code, "原本人效果访问资格已失效。", self.now(), task_id))
            for kind in ("input", "result"):
                self._schedule(connection, task_id, kind, task[kind + "_key"])
        self._unlink(task_id)

    def claim_next(self, worker_id, now=None):
        _identifier(worker_id)
        task = self._peek()
        if task is None:
            return None
        owner, authorization = self._job_owner(task)
        try:
            with self._authority(owner, authorization, task["session_id"]):
                with self._transaction() as connection:
                    task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task["task_id"],)).fetchone()
                    at = self.now() if now is None else _epoch(now)
                    if task["deletion_status"] != "active" or task["state"] not in ("queued", "running", "provider_unknown"):
                        return None
                    if task["input_expires"] <= at or task["expires"] <= at:
                        connection.execute("UPDATE preview_tasks SET state='expired',deletion_generation=deletion_generation+1,updated=? WHERE task_id=?", (at, task["task_id"]))
                        for kind in ("input", "result"):
                            self._schedule(connection, task["task_id"], kind, task[kind + "_key"])
                        job = None
                    else:
                        attempt = connection.execute("SELECT * FROM preview_attempts WHERE task_id=?", (task["task_id"],)).fetchone()
                        if attempt and attempt["lease_until"] > at:
                            return None
                        recovery = attempt is not None
                        if attempt is None:
                            connection.execute("INSERT INTO preview_attempts VALUES(?,?,?,1,?,?,?,'dispatching',NULL,?,?)",
                                ("pva-" + uuid.uuid4().hex, task["task_id"], "pvd-" + uuid.uuid4().hex,
                                 at + 60, worker_id, task["deletion_generation"], at, at))
                        else:
                            connection.execute("UPDATE preview_attempts SET lease_epoch=lease_epoch+1,lease_until=?,worker_id=?,updated=? WHERE task_id=?", (at + 60, worker_id, at, task["task_id"]))
                        attempt = connection.execute("SELECT * FROM preview_attempts WHERE task_id=?", (task["task_id"],)).fetchone()
                        connection.execute("UPDATE preview_tasks SET state='running',updated=? WHERE task_id=?", (at, task["task_id"]))
                        job = {"task_id": task["task_id"], "attempt_id": attempt["attempt_id"], "dispatch_id": attempt["dispatch_id"],
                               "lease_epoch": attempt["lease_epoch"], "deletion_generation": attempt["deletion_generation"],
                               "snapshot": json.loads(task["snapshot"]), "input_key": task["input_key"],
                               "provider_id": self.provider_mode, "provider_request_id": attempt["provider_request_id"],
                               "recover_only": recovery}
                if job is None:
                    self._unlink(task["task_id"])
                return job
        except (ProfileError, PreviewError) as exc:
            if getattr(exc, "status", None) in (403, 404, 409):
                self._invalidate(task["task_id"], exc.code)
                return None
            raise

    def _lease(self, connection, job):
        task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (job["task_id"],)).fetchone()
        attempt = connection.execute("SELECT * FROM preview_attempts WHERE attempt_id=?", (job["attempt_id"],)).fetchone()
        valid = (task is not None and attempt is not None and attempt["task_id"] == task["task_id"]
                 and attempt["dispatch_id"] == job["dispatch_id"] and attempt["lease_epoch"] == job["lease_epoch"]
                 and attempt["deletion_generation"] == job["deletion_generation"]
                 and task["deletion_generation"] == job["deletion_generation"]
                 and task["deletion_status"] == "active" and task["state"] in ("running", "provider_unknown")
                 and task["input_expires"] > self.now() and task["expires"] > self.now())
        return task, attempt, valid

    def mark_unknown(self, job, provider_request_id=None):
        with self._transaction() as connection:
            task, attempt, valid = self._lease(connection, job)
            if not valid:
                return False
            connection.execute("UPDATE preview_attempts SET state='unknown',provider_request_id=coalesce(?,provider_request_id),lease_until=?,updated=? WHERE attempt_id=?", (provider_request_id, self.now() + 5 if self.provider_mode == 'runninghub' else 0, self.now(), attempt["attempt_id"]))
            connection.execute("UPDATE preview_tasks SET state='provider_unknown',updated=? WHERE task_id=?", (self.now(), task["task_id"]))
            return True

    def acknowledge(self, job, outcome):
        with self._transaction() as connection:
            task, attempt, valid = self._lease(connection, job)
            if not valid:
                return False
            connection.execute("UPDATE preview_attempts SET state='running',provider_request_id=coalesce(?,provider_request_id),lease_until=?,updated=? WHERE attempt_id=?", (outcome.get("provider_request_id"), self.now() + (5 if self.provider_mode == 'runninghub' else .25), self.now(), attempt["attempt_id"]))
            return True

    def reference_inputs(self, job):
        """Read the accepted exact assets, never reselect a current product image."""
        task = self._peek(job["task_id"])
        _require(task is not None, "PREVIEW_REFERENCE_UNAVAILABLE", 409)
        owner, authorization = self._job_owner(task)
        from app.services import product_image_assets as assets
        try:
            with self._authority(owner, authorization, task["session_id"]):
                with self._transaction() as connection:
                    task, _, valid = self._lease(connection, job)
                    _require(valid, "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                    snapshot = json.loads(task["snapshot"])
                    _require(snapshot["snapshot_digest"] == job["snapshot"]["snapshot_digest"],
                             "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                references = []
                for item in snapshot["items"]:
                    asset, data, _ = assets._load(item["reference_asset_id"])
                    _require(asset["asset_version"] == item["reference_version"]
                             and asset["product_id"] == item["product_id"]
                             and asset["sku_ids"] == [item["sku_id"]]
                             and asset["image_sha256"] == item["reference_sha256"]
                             and _hash(data) == item["reference_sha256"]
                             and asset["origin"]["rights_confirmed"] is True,
                             "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                    references.append({k: deepcopy(item[k]) for k in ("slot", "sku_id", "product_id",
                        "reference_asset_id", "reference_version", "reference_sha256")})
                    references[-1]["data"] = data
                _require(len(references) == 3 and {r["slot"] for r in references} == set(_SLOTS),
                         "PREVIEW_REFERENCE_UNAVAILABLE", 409)
                return references
        except (assets.ProductImageAssetError, OSError, KeyError):
            raise PreviewError("PREVIEW_REFERENCE_UNAVAILABLE", "原三槽参考图暂不可用。", 409) from None

    def finish(self, job, outcome):
        task = self._peek(job["task_id"])
        if task is None:
            return False
        owner, authorization = self._job_owner(task)
        key, written = None, False
        try:
            with self._authority(owner, authorization, task["session_id"]):
                with self._transaction() as connection:
                    task, attempt, valid = self._lease(connection, job)
                    if not valid:
                        return False
                    now = self.now()
                    failure = outcome.get("status") == "failed"
                    if not failure:
                        _require(outcome.get("snapshot_digest") == json.loads(task["snapshot"])["snapshot_digest"],
                                 "PREVIEW_SELECTION_CHANGED", 409)
                        from app.services.personal_preview_media import normalize_photo
                        try:
                            normalized = normalize_photo(outcome.get("data", b""))
                        except Exception:
                            failure = True
                    if failure:
                        state, code, message = "failed", outcome.get("error_code", "PREVIEW_PHOTO_INVALID"), "供应商输出未通过完整图片或搭配绑定检查。"
                        if not isinstance(code, str) or not re.fullmatch(r"PREVIEW_[A-Z_]{1,80}", code):
                            code = "PREVIEW_PHOTO_INVALID"
                        connection.execute("UPDATE preview_tasks SET state=?,error_code=?,error_message=?,updated=? WHERE task_id=?", (state, code, message, now, task["task_id"]))
                    else:
                        # Every mock/unreviewed result remains pending; no visual-success API exists.
                        key = "results/" + uuid.uuid4().hex + ".jpg"
                        self.media.put(key, normalized.data)
                        written = True
                        connection.execute("UPDATE preview_tasks SET state='output_pending_review',result_key=?,result_sha=?,result_created=?,expires=?,updated=? WHERE task_id=?", (key, normalized.sha256, now, now + 30 * 86400, now, task["task_id"]))
                        self._schedule(connection, task["task_id"], "result", key, "retained")
                    connection.execute("UPDATE preview_attempts SET state=?,provider_request_id=coalesce(?,provider_request_id),lease_until=0,updated=? WHERE attempt_id=?", ("failed" if failure else "completed", outcome.get("provider_request_id"), now, attempt["attempt_id"]))
                    self._schedule(connection, task["task_id"], "input", task["input_key"])
                self._unlink(task["task_id"])
                return True
        except (ProfileError, PreviewError) as exc:
            if written and key:
                try:
                    self.media.remove(key)
                except Exception:
                    pass
            if getattr(exc, "status", None) in (403, 404):
                self._invalidate(job["task_id"], exc.code)
                return False
            raise
        except BaseException:
            if written and key:
                try:
                    self.media.remove(key)
                except Exception:
                    pass
            raise

    def cleanup(self):
        # No preview lock is held while obtaining an application identity lock.
        now = self.now()
        with self.lock:
            ids = [row[0] for row in self.db.execute("SELECT task_id FROM preview_tasks")]
        for task_id in ids:
            task = self._peek(task_id)
            if task["deletion_status"] != "deleted":
                owner, authorization = self._job_owner(task)
                try:
                    with self._authority(owner, authorization):
                        with self._transaction() as connection:
                            task = connection.execute("SELECT * FROM preview_tasks WHERE task_id=?", (task_id,)).fetchone()
                            expire = task["expires"] <= now or (task["state"] in ("queued", "running", "provider_unknown") and task["input_expires"] <= now)
                            if expire and task["state"] != "expired":
                                connection.execute("UPDATE preview_tasks SET state='expired',deletion_generation=deletion_generation+1,updated=? WHERE task_id=?", (now, task_id))
                            if task["input_key"] and (task["input_expires"] <= now or task["state"] in ("failed", "output_pending_review", "succeeded", "expired")):
                                self._schedule(connection, task_id, "input", task["input_key"])
                            if task["result_key"] and (expire or task["deletion_status"] != "active"):
                                self._schedule(connection, task_id, "result", task["result_key"])
                except (ProfileError, PreviewError) as exc:
                    if getattr(exc, "status", None) == 403:
                        self._invalidate(task_id, exc.code)
                    else:
                        raise
            self._unlink(task_id)
        with self._transaction() as connection:
            # Deleted tasks have the same content-retention deadline. Tombstone
            # and original request fingerprint survive without the private Look.
            connection.execute("UPDATE preview_tasks SET snapshot='' WHERE metadata_expires<=?", (now,))
            connection.execute("DELETE FROM preview_confirmations WHERE (expires<=? AND accepted_task IS NULL) OR issued<=?", (now, now - 90 * 86400))
            used = {row[0] for row in connection.execute("SELECT input_key FROM preview_tasks WHERE input_key IS NOT NULL")}
            used |= {row[0] for row in connection.execute("SELECT result_key FROM preview_tasks WHERE result_key IS NOT NULL")}
            # Recover private orphans after a process died before commit. Their
            # keys and retry receipts stay only in this private cleanup table.
            orphans, orphan_failed, scan_failed = 0, 0, False
            try:
                files = self.media.list_files()
                self._schedule(connection, "pvo-scan", "scan", None, "deleted")
            except Exception:
                files, scan_failed = [], True
                self._schedule(connection, "pvo-scan", "scan", None, "failed")
                connection.execute("UPDATE preview_cleanup SET attempts=attempts+1 WHERE task_id='pvo-scan'")
            keys = {file["key"] if isinstance(file, dict) else file for file in files}
            keys |= {row[0] for row in connection.execute(
                "SELECT media_key FROM preview_cleanup WHERE task_id LIKE 'pvo-%' AND media_key IS NOT NULL AND status IN ('pending','failed')")}
            for key in sorted(keys - used):
                receipt = "pvo-" + _hash(key)[:32]
                self._schedule(connection, receipt, "orphan", key)
                try:
                    if self.media.remove(key):
                        orphans += 1
                    status = "deleted"
                except Exception:
                    status = "failed"
                    orphan_failed += 1
                connection.execute("UPDATE preview_cleanup SET status=?,attempts=attempts+1,updated=? WHERE task_id=? AND media_kind='orphan'",
                                   (status, now, receipt))
            temporary = 0
            temporary_failed = False
            if hasattr(self.media, "cleanup_temporary"):
                try:
                    temporary = self.media.cleanup_temporary(now - 86400)
                    self._schedule(connection, "pvo-temporary", "temporary", None, "deleted")
                except Exception:
                    temporary_failed = True
                    self._schedule(connection, "pvo-temporary", "temporary", None, "failed")
                    connection.execute("UPDATE preview_cleanup SET attempts=attempts+1 WHERE task_id='pvo-temporary'")
            pending = connection.execute("SELECT count(*) FROM preview_cleanup WHERE status IN ('pending','failed')").fetchone()[0]
        return {"tasks_checked": len(ids), "pending_cleanup": pending, "orphans_deleted": orphans,
                "orphans_failed": orphan_failed, "scan_failed": scan_failed,
                "temporary_deleted": temporary, "temporary_cleanup_failed": temporary_failed}


def get_store():
    global _STORE, _STORE_CONFIG
    _require(os.getenv("STYLING_PERSONAL_PREVIEW_ENABLED", "0") == "1", "PREVIEW_DISABLED", 503)
    raw_dir, raw_db = os.getenv("STYLING_PERSONAL_PREVIEW_DIR", ""), os.getenv("STYLING_PERSONAL_PREVIEW_DB", "")
    _require(bool(raw_dir) and bool(raw_db), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    directory, path = _private_path(raw_dir), _private_path(raw_db)
    from app.core.config import BASE_DIR, DATA_DIR, PRODUCT_IMAGE_DIR, settings
    excluded = [BASE_DIR, PRODUCT_IMAGE_DIR, DATA_DIR / "product-images", DATA_DIR / "tryon-results",
                Path(__file__).parents[1] / "static"]
    if os.getenv("STYLING_FIXED_ROOT"):
        excluded.append(Path(os.environ["STYLING_FIXED_ROOT"]))
    _require(not any(directory == p.resolve() or p.resolve() in directory.parents for p in excluded), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    database_paths = [os.getenv("STYLING_FIXED_DB", ""), os.getenv("STYLING_PRODUCT_IMAGE_DB", "")]
    if settings.database_url.startswith("sqlite:///"):
        database_paths.append(settings.database_url[10:])
    _require(not any(path == Path(p).resolve() for p in database_paths if p), "PREVIEW_STORAGE_UNAVAILABLE", 503)
    isolated = os.getenv("STYLING_PERSONAL_PREVIEW_ISOLATED", "0") == "1"
    mode = os.getenv("STYLING_PERSONAL_PREVIEW_PROVIDER", "disabled")
    try:
        limit = int(os.getenv("STYLING_PERSONAL_PREVIEW_DAILY_LIMIT", "10"))
    except ValueError:
        raise PreviewError("PREVIEW_STORAGE_UNAVAILABLE", "任务限额配置无效。", 503) from None
    config = (str(path), str(directory), isolated, mode, limit)
    with _STORE_LOCK:
        _require(_STORE is None or _STORE_CONFIG == config, "PREVIEW_STORAGE_UNAVAILABLE", 503,
                 "运行中不能切换本人照片存储或供应商配置。")
        if _STORE is None:
            _STORE = PreviewStore(path, directory, provider_mode=mode, isolated=isolated, daily_limit=limit)
            _STORE_CONFIG = config
        return _STORE


get_service = get_store
