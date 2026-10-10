"""COVER-01A immutable single-product image registry and display references.

Opt-in independent sqlite only. Registration is a controlled script operation,
never a consumer upload. Failures of this optional sidecar do not affect Look,
inventory, generation success or shopping-bag state.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import warnings

from PIL import Image


SCHEMA = "product_image_assets_v1"
_MARKER = "COVER-01A-product-images-sidecar-2-session-bound"
_SHA = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$")
_MAPPING = {
    "M1V2-P-T101": ("M1V2-T101-M", "PIMG-COV01-T101-v1", "top"),
    "M1V2-P-B101": ("M1V2-B101-M", "PIMG-COV01-B101-v1", "bottom"),
    "M1V2-P-S101": ("M1V2-S101-38", "PIMG-COV01-S101-v1", "shoes"),
}
_DISCLAIMER = "AI生成单品参考图·演示预览·待用户视觉确认"
_MESSAGES = {
    "PRODUCT_IMAGE_DISABLED": "独立单品图预览未开启",
    "PRODUCT_IMAGE_CONFIGURATION_INVALID": "独立单品图配置无效",
    "PRODUCT_IMAGE_INVALID": "单品图登记字段、映射或实际文件不符合契约",
    "PRODUCT_IMAGE_NOT_FOUND": "该独立单品图未登记或当前不可用",
    "PRODUCT_IMAGE_CONFLICT": "同一单品图或展示编号已有不同内容，原记录保持",
    "PRODUCT_IMAGE_REGISTRY_INVALID": "该数据库不是本产品的独立单品图注册库",
}


class ProductImageAssetError(Exception):
    def __init__(self, status, code, message=None):
        self.status, self.code, self.message = status, code, message or _MESSAGES[code]
        super().__init__(code)


def _require(condition, code="PRODUCT_IMAGE_INVALID", status=422):
    if not condition:
        raise ProductImageAssetError(status, code)


def _canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None


def _hash(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def _parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result)
            result[key] = value
        return result
    try:
        result = json.loads(raw, object_pairs_hook=pairs,
                            parse_constant=lambda _: _require(False))
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    _require(isinstance(result, dict))
    return result


def _text(value, *, identifier=False, empty=False):
    _require(isinstance(value, str) and len(value) <= 2000 and (empty or bool(value.strip())))
    if identifier:
        _require(bool(_ID.fullmatch(value)))
    _require(not re.search(r"/(?:Users|home|private|tmp|var|etc|root|opt)/|[A-Za-z]:[\\/]|"
                          r"(?:Bearer\s+\S+|Cookie\s*[:=]|api[_ -]?key\s*[:=]|password\s*[:=]|secret\s*[:=])", value, re.I))
    return value


def _keys(value, keys):
    _require(isinstance(value, dict) and set(value) == set(keys))


def _time(value):
    try:
        result = datetime.fromisoformat(_text(value).replace("Z", "+00:00"))
    except ValueError:
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    _require(result.tzinfo is not None)
    return result


def _sha(value):
    _require(isinstance(value, str) and bool(_SHA.fullmatch(value)))
    return value


def _integer(value, low, high):
    _require(type(value) is int and low <= value <= high)
    return value


def _config():
    _require(os.getenv("STYLING_PRODUCT_IMAGE_PREVIEW", "0") == "1", "PRODUCT_IMAGE_DISABLED", 503)
    manifest, registry = (os.getenv(key, "") for key in ("STYLING_PRODUCT_IMAGE_MANIFEST", "STYLING_PRODUCT_IMAGE_DB"))
    _require(bool(manifest) and bool(registry), "PRODUCT_IMAGE_CONFIGURATION_INVALID", 503)
    original_manifest, original_registry = Path(manifest), Path(registry)
    _require(original_manifest.is_absolute() and original_registry.is_absolute()
             and not original_manifest.is_symlink() and not original_registry.is_symlink(),
             "PRODUCT_IMAGE_CONFIGURATION_INVALID", 503)
    manifest_path, registry_path = original_manifest.resolve(), original_registry.resolve()
    _require(manifest_path != registry_path and registry_path.suffix in {".db", ".sqlite", ".sqlite3"},
             "PRODUCT_IMAGE_CONFIGURATION_INVALID", 503)
    # Even an empty former application database must never become this sidecar.
    excluded = [os.getenv("STYLING_FIXED_DB", "")]
    database_url = os.getenv("DATABASE_URL", "")
    if database_url.startswith("sqlite:///"):
        excluded.append(database_url[10:])
    root = os.getenv("STYLING_FIXED_ROOT", "")
    if root:
        excluded.extend(str(Path(root) / item) for item in
                        ("reports/m2/runtime/sessions.sqlite3", "reports/m2/runtime/local-preview.sqlite3"))
    _require(all(registry_path != Path(value).resolve() for value in excluded if value),
             "PRODUCT_IMAGE_CONFIGURATION_INVALID", 503)
    return manifest_path, registry_path


def _manifest(path):
    _require(path.is_file() and path.stat().st_size <= 1024 * 1024)
    try:
        data = _parse(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    _keys(data, {"schema", "assets"})
    _require(data["schema"] == SCHEMA and isinstance(data["assets"], list) and 1 <= len(data["assets"]) <= 3)
    ids = [_text(value.get("asset_id"), identifier=True) for value in data["assets"] if isinstance(value, dict)]
    _require(len(ids) == len(data["assets"]) and len(set(ids)) == len(ids))
    return data


def _resource_binding(resources):
    try:
        tenant, catalog = resources.data["tenant_id"], resources.catalog["catalog_version"]
        _text(tenant, identifier=True)
        _text(catalog, identifier=True)
        return tenant, catalog
    except (AttributeError, KeyError, TypeError):
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None


def _validate_asset(asset, resources=None):
    _keys(asset, {"asset_id", "asset_version", "tenant_id", "catalog_version", "product_id", "sku_ids",
        "kind", "representation", "file_name", "image_sha256", "mime_type", "width", "height", "byte_size",
        "origin", "reference", "generation_record", "state", "checks", "user_review", "accepted_by_user"})
    for field in ("asset_id", "tenant_id", "catalog_version", "product_id"):
        _text(asset[field], identifier=True)
    _require(asset["product_id"] in _MAPPING)
    sku, asset_id, slot = _MAPPING[asset["product_id"]]
    _require(asset["asset_id"] == asset_id and type(asset["asset_version"]) is int and asset["asset_version"] == 1
             and asset["sku_ids"] == [sku])
    _require(asset["kind"] == "product_single_image" and asset["representation"] == "style_color_reference")
    _sha(asset["image_sha256"])
    _require(asset["mime_type"] in ("image/jpeg", "image/png"))
    _integer(asset["width"], 1, 1024)
    _integer(asset["height"], 1, 1024)
    _integer(asset["byte_size"], 1, 1024 * 1024)
    filename = _text(asset["file_name"])
    _require(Path(filename).name == filename and "/" not in filename and "\\" not in filename
             and ".." not in filename and bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,180}", filename)))
    origin = asset["origin"]
    _keys(origin, {"origin_type", "source_name", "source_ref", "is_simulated", "rights_confirmed"})
    _require(origin["origin_type"] in ("ai_generated", "self_created", "open_license", "authorized")
             and origin["is_simulated"] is True and origin["rights_confirmed"] is True)
    _text(origin["source_name"])
    _text(origin["source_ref"])
    reference = asset["reference"]
    _keys(reference, {"look_id", "look_image_sha256", "visual_spec_sha256", "visual_spec_product_id", "prompt_version", "tool_version"})
    _require(reference["look_id"] == "M1V2-LOOK-101" and reference["visual_spec_product_id"] == asset["product_id"])
    _sha(reference["look_image_sha256"])
    _sha(reference["visual_spec_sha256"])
    _text(reference["prompt_version"])
    _text(reference["tool_version"])
    record = asset["generation_record"]
    _keys(record, {"provider", "model", "job_id", "requested_images", "returned_images", "attempts", "completed_at", "cost"})
    for field in ("provider", "model", "job_id"):
        _text(record[field])
    _integer(record["requested_images"], 0, 1)
    _integer(record["returned_images"], 0, 1)
    _integer(record["attempts"], 0, 4)
    if origin["origin_type"] == "ai_generated":
        _require(record["requested_images"] == 1 and record["returned_images"] == 1 and record["attempts"] >= 1)
    _time(record["completed_at"])
    cost = record["cost"]
    _keys(cost, {"status", "amount", "currency", "reason"})
    _text(cost["reason"])
    if cost["status"] == "unknown":
        _require(cost["amount"] is None and cost["currency"] is None)
    else:
        _require(cost["status"] == "known" and type(cost["amount"]) in (int, float)
                 and math.isfinite(cost["amount"]) and cost["amount"] >= 0)
        _text(cost["currency"], identifier=True)
    checks = asset["checks"]
    _keys(checks, {"checked_by", "checked_at", "technical_passed", "visual_passed", "evidence_ref"})
    _text(checks["checked_by"], identifier=True)
    _text(checks["evidence_ref"])
    _time(checks["checked_at"])
    _require(checks["technical_passed"] is True and checks["visual_passed"] is True
             and asset["state"] == "agent_checked_preview" and asset["user_review"] == "pending"
             and asset["accepted_by_user"] is False)
    if resources is not None:
        tenant, catalog = _resource_binding(resources)
        _require(asset["tenant_id"] == tenant and asset["catalog_version"] == catalog)
        try:
            product = resources.products[asset["product_id"]]
            variant = resources.skus[sku]
            look = resources.looks[reference["look_id"]]
            _require(product["active"] is True and product["slot"] == slot
                and product["tenant_id"] == tenant and product["catalog_version"] == catalog
                and variant["product_id"] == asset["product_id"] and variant["slot"] == slot
                and variant["tenant_id"] == tenant and variant["catalog_version"] == catalog
                and variant["size"] == {"system": "cn_shoe" if slot == "shoes" else "clothing_alpha",
                                          "value": "38" if slot == "shoes" else "M"}
                and look["active"] is True and look["items"][slot] == sku
                and look["image_sha256"] == reference["look_image_sha256"])
        except (KeyError, AttributeError, TypeError):
            raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
        resource_root = os.getenv("STYLING_FIXED_ROOT", "")
        _require(bool(resource_root) and Path(resource_root).is_absolute())
        spec_path = Path(resource_root).resolve() / "data/m1_v2/product_visual_specs.json"
        try:
            _require(spec_path.is_file() and not spec_path.is_symlink() and spec_path.stat().st_size <= 1024 * 1024)
            spec_bytes = spec_path.read_bytes()
            _require(_hash(spec_bytes) == reference["visual_spec_sha256"])
            specs = json.loads(spec_bytes)
            _require(isinstance(specs, list) and sum(isinstance(item, dict) and item.get("product_id") == asset["product_id"]
                                                    for item in specs) == 1)
        except (OSError, ValueError, UnicodeError, RecursionError):
            raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    return asset


def _file(asset, manifest):
    directory = manifest.parent / "assets"
    path = directory / asset["file_name"]
    _require(directory.is_dir() and not directory.is_symlink() and path.is_file() and not path.is_symlink()
             and path.resolve().parent == directory.resolve())
    try:
        _require(path.stat().st_size == asset["byte_size"])
        raw = path.read_bytes()
        _require(len(raw) == asset["byte_size"] and _hash(raw) == asset["image_sha256"])
        # Validate the actual container and then fully decode pixels. A fake
        # extension/MIME or valid-looking header is insufficient.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as image:
                _require(image.size == (asset["width"], asset["height"]) and getattr(image, "n_frames", 1) == 1)
                _require({"JPEG": "image/jpeg", "PNG": "image/png"}.get(image.format) == asset["mime_type"])
                image.verify()
            with Image.open(BytesIO(raw)) as image:
                image.load()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    return raw


@contextmanager
def _db(manifest, path, *, create=False, write=False, binding=None):
    _require(create or path.is_file(), "PRODUCT_IMAGE_NOT_FOUND", 404)
    try:
        if create:
            path.parent.mkdir(parents=True, exist_ok=True)
        mode = "rwc" if create else "rw" if write else "ro"
        connection = sqlite3.connect(path.as_uri() + "?mode=" + mode, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        expected = {"product_image_registry_meta", "product_image_assets", "product_image_displays"}
        _require(not names or names == expected, "PRODUCT_IMAGE_REGISTRY_INVALID", 409)
        if not names:
            _require(create and binding is not None, "PRODUCT_IMAGE_REGISTRY_INVALID", 409)
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("CREATE TABLE product_image_registry_meta(marker TEXT PRIMARY KEY, schema_name TEXT NOT NULL, tenant_id TEXT NOT NULL, catalog_version TEXT NOT NULL, manifest_directory TEXT NOT NULL)")
            connection.execute("CREATE TABLE product_image_assets(asset_id TEXT PRIMARY KEY, product_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, record_digest TEXT NOT NULL, registered_at TEXT NOT NULL)")
            connection.execute("CREATE TABLE product_image_displays(tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, look_version_id TEXT NOT NULL, binding_json TEXT NOT NULL, binding_digest TEXT NOT NULL, display_json TEXT NOT NULL, display_digest TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id,session_id,look_version_id))")
            connection.execute("INSERT INTO product_image_registry_meta VALUES(?,?,?,?,?)", (_MARKER, SCHEMA, *binding, str(manifest.parent)))
            connection.commit()
        rows = connection.execute("SELECT * FROM product_image_registry_meta").fetchall()
        _require(len(rows) == 1 and rows[0]["marker"] == _MARKER and rows[0]["schema_name"] == SCHEMA
                 and rows[0]["manifest_directory"] == str(manifest.parent), "PRODUCT_IMAGE_REGISTRY_INVALID", 409)
        if binding is not None:
            _require((rows[0]["tenant_id"], rows[0]["catalog_version"]) == binding, "PRODUCT_IMAGE_REGISTRY_INVALID", 409)
        yield connection, rows[0]
    except sqlite3.Error:
        raise ProductImageAssetError(409, "PRODUCT_IMAGE_REGISTRY_INVALID") from None
    finally:
        if "connection" in locals():
            connection.close()


def register_manifest(resources):
    """Explicit control-script registration only; immutable per-asset bytes."""
    manifest, path = _config()
    data = _manifest(manifest)
    binding = _resource_binding(resources)
    for asset in data["assets"]:
        _validate_asset(asset, resources)
        _file(asset, manifest)
    _require(sum(asset["generation_record"]["attempts"] for asset in data["assets"]) <= 4)
    result = []
    with _db(manifest, path, create=True, binding=binding) as (connection, _):
        connection.execute("BEGIN IMMEDIATE")
        for asset in data["assets"]:
            content = _canonical(asset)
            old = connection.execute("SELECT * FROM product_image_assets WHERE asset_id=?", (asset["asset_id"],)).fetchone()
            if old is not None:
                _require(old["record_json"] == content and old["record_digest"] == _hash(content), "PRODUCT_IMAGE_CONFLICT", 409)
            else:
                connection.execute("INSERT INTO product_image_assets VALUES(?,?,?,?,?)", (asset["asset_id"], asset["product_id"],
                    content, _hash(content), datetime.now(timezone.utc).isoformat()))
            result.append({"asset_id": asset["asset_id"], "duplicate": old is not None})
        connection.commit()
    return {"schema": SCHEMA, "registered_assets": result, "asset_count": len(result)}


def _load(asset_id, resources=None):
    manifest, path = _config()
    _text(asset_id, identifier=True)
    data = _manifest(manifest)
    asset = next((value for value in data["assets"] if value["asset_id"] == asset_id), None)
    _require(asset is not None, "PRODUCT_IMAGE_NOT_FOUND", 404)
    _validate_asset(asset, resources)
    binding = _resource_binding(resources) if resources is not None else (asset["tenant_id"], asset["catalog_version"])
    with _db(manifest, path, binding=binding) as (connection, _):
        record = connection.execute("SELECT * FROM product_image_assets WHERE asset_id=?", (asset_id,)).fetchone()
        _require(record is not None, "PRODUCT_IMAGE_NOT_FOUND", 404)
        content = _canonical(asset)
        _require(record["record_json"] == content and record["record_digest"] == _hash(content)
                 and record["product_id"] == asset["product_id"], "PRODUCT_IMAGE_CONFLICT", 409)
        registered_at = record["registered_at"]
    return asset, _file(asset, manifest), registered_at


def _public(asset, registered_at, sku_id=None):
    result = {key: deepcopy(asset[key]) for key in ("asset_id", "asset_version", "tenant_id", "catalog_version",
        "product_id", "sku_ids", "kind", "representation", "image_sha256", "mime_type", "width", "height", "byte_size", "state", "user_review", "origin")}
    result.update(sku_id=sku_id or asset["sku_ids"][0], image_url="/api/v1/outfits/product-assets/" + asset["asset_id"],
                  is_simulated=True, disclaimer=_DISCLAIMER, registration={"registered_at": registered_at})
    return result


def asset_ref(resources, asset_id, product_id, sku_id=None):
    """Optional public reference; unavailable mappings return None without writes."""
    try:
        asset, _, registered_at = _load(asset_id, resources)
        _require(asset["product_id"] == product_id and (sku_id is None or sku_id in asset["sku_ids"]))
        return _public(asset, registered_at, sku_id)
    except (ProductImageAssetError, OSError):
        return None


def current_ref(resources, product_id, sku_id=None):
    mapping = _MAPPING.get(product_id) if isinstance(product_id, str) else None
    return asset_ref(resources, mapping[1], product_id, sku_id) if mapping else None


def image_bytes(asset_id, resources=None):
    """Only immutable registered assets; path-like IDs are safe 404 errors."""
    try:
        asset, raw, _ = _load(asset_id, resources)
        return raw, asset["mime_type"], asset["image_sha256"]
    except (ProductImageAssetError, OSError):
        raise ProductImageAssetError(404, "PRODUCT_IMAGE_NOT_FOUND") from None


def _version_binding(version, resources=None):
    _require(isinstance(version, dict))
    _text(version.get("look_version_id"), identifier=True)
    _text(version.get("tenant_id"), identifier=True)
    _text(version.get("session_id"), identifier=True)
    resource_refs = version.get("resources")
    _require(isinstance(resource_refs, dict))
    catalog = _text(resource_refs.get("catalog_version"), identifier=True)
    items = version.get("items")
    _keys(items, {"top", "bottom", "shoes"})
    _require(len(set(_text(value, identifier=True) for value in items.values())) == 3)
    _text(version.get("look_id"), identifier=True)
    if resources is not None:
        _require((version["tenant_id"], catalog) == _resource_binding(resources))
        try:
            look = resources.looks[version["look_id"]]
            _require(look["items"] == items and look["active"] is True)
            for slot, sku_id in items.items():
                _require(resources.skus[sku_id]["slot"] == slot)
        except (AttributeError, KeyError, TypeError):
            raise ProductImageAssetError(422, "PRODUCT_IMAGE_INVALID") from None
    return {"look_version_id": version["look_version_id"], "tenant_id": version["tenant_id"], "session_id": version["session_id"],
            "catalog_version": catalog, "look_id": version["look_id"], "items": deepcopy(items)}


def _empty(version, *, recorded=False, status="history_unrecorded"):
    return {"recorded": recorded, "status": status,
            "look_version_id": version.get("look_version_id") if isinstance(version, dict) else None,
            "image_refs": {slot: None for slot in ("top", "bottom", "shoes")}, "is_simulated": True}


def _display_value(raw, binding):
    display = _parse(raw)
    _keys(display, {"recorded", "status", "look_version_id", "image_refs", "is_simulated"})
    _keys(display["image_refs"], {"top", "bottom", "shoes"})
    _require(display["recorded"] is True and display["is_simulated"] is True
             and display["status"] == "recorded" and display["look_version_id"] == binding["look_version_id"])
    _require(all(ref is None or isinstance(ref, dict) for ref in display["image_refs"].values()))
    return display


def freeze_display(version, resources):
    """Caller invokes only for newly created execution/restore history IDs.

    Read handlers never call this. Root integration owns old/new ID detection.
    """
    manifest, path = _config()
    binding = _version_binding(version, resources)
    encoded = _canonical(binding)
    scope_binding = _resource_binding(resources)
    with _db(manifest, path, write=True, binding=scope_binding) as (connection, _):
        connection.execute("BEGIN IMMEDIATE")
        key = (binding["tenant_id"], binding["session_id"], binding["look_version_id"])
        old = connection.execute("SELECT * FROM product_image_displays WHERE tenant_id=? AND session_id=? AND look_version_id=?", key).fetchone()
        if old is not None:
            _require(old["binding_json"] == encoded and old["binding_digest"] == _hash(encoded)
                     and old["display_digest"] == _hash(old["display_json"]), "PRODUCT_IMAGE_CONFLICT", 409)
            return _display_value(old["display_json"], binding)
        refs = {slot: current_ref(resources, resources.skus[sku_id]["product_id"], sku_id)
                for slot, sku_id in binding["items"].items()}
        display = {"recorded": True, "status": "recorded", "look_version_id": binding["look_version_id"],
                   "image_refs": refs, "is_simulated": True}
        content = _canonical(display)
        connection.execute("INSERT INTO product_image_displays VALUES(?,?,?,?,?,?,?,?)", (*key,
            encoded, _hash(encoded), content, _hash(content), datetime.now(timezone.utc).isoformat()))
        connection.commit()
        return display


def display_refs(version, resources=None):
    """Read-only frozen refs. Unknown historical versions are never backfilled."""
    try:
        manifest, path = _config()
        binding = _version_binding(version, resources)
        encoded = _canonical(binding)
        with _db(manifest, path, binding=(binding["tenant_id"], binding["catalog_version"])) as (connection, _):
            key = (binding["tenant_id"], binding["session_id"], binding["look_version_id"])
            row = connection.execute("SELECT * FROM product_image_displays WHERE tenant_id=? AND session_id=? AND look_version_id=?", key).fetchone()
            if row is None:
                return _empty(version)
            _require(row["binding_json"] == encoded and row["binding_digest"] == _hash(encoded)
                     and row["display_digest"] == _hash(row["display_json"]), "PRODUCT_IMAGE_CONFLICT", 409)
            display = _display_value(row["display_json"], binding)
        unavailable = False
        for slot, ref in display["image_refs"].items():
            if ref is None:
                continue
            try:
                asset, _, registered_at = _load(ref["asset_id"], resources)
                expected = _public(asset, registered_at, binding["items"][slot])
                _require(ref == expected and ref["sku_id"] == binding["items"][slot])
            except (ProductImageAssetError, OSError, KeyError, TypeError):
                display["image_refs"][slot] = None
                unavailable = True
        if unavailable:
            display["status"] = "unavailable"
        return display
    except (ProductImageAssetError, OSError, KeyError, TypeError):
        return _empty(version, status="unavailable")
