"""Temporary synthetic images/DB only; no generated user assets or provider API."""
from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace

from PIL import Image
import pytest

from app.services import product_image_assets as assets


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded_image(color, size=(32, 32), fmt="JPEG"):
    out = BytesIO()
    Image.new("RGB", size, color).save(out, format=fmt)
    return out.getvalue()


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    directory = tmp_path / "sidecar"
    image_directory = directory / "assets"
    image_directory.mkdir(parents=True)
    resource_root = tmp_path / "resource-root"
    spec_path = resource_root / "data/m1_v2/product_visual_specs.json"
    spec_path.parent.mkdir(parents=True)
    specs = [{"product_id": product, "required_features": ["Synthetic test only"]} for product in assets._MAPPING]
    spec_path.write_text(json.dumps(specs), encoding="utf-8")
    products, skus = {}, {}
    refs = []
    for index, (product, (sku, asset_id, slot)) in enumerate(assets._MAPPING.items()):
        raw = encoded_image((40 + index * 50, 80, 120))
        filename = asset_id + ".jpg"
        (image_directory / filename).write_bytes(raw)
        products[product] = {"product_id": product, "slot": slot, "tenant_id": "tenant-synthetic",
                            "catalog_version": "catalog-synthetic", "active": True}
        skus[sku] = {"sku_id": sku, "product_id": product, "slot": slot, "tenant_id": "tenant-synthetic",
                    "catalog_version": "catalog-synthetic", "size": {"system": "cn_shoe" if slot == "shoes" else "clothing_alpha",
                    "value": "38" if slot == "shoes" else "M"}}
        refs.append({"asset_id": asset_id, "asset_version": 1, "tenant_id": "tenant-synthetic",
            "catalog_version": "catalog-synthetic", "product_id": product, "sku_ids": [sku],
            "kind": "product_single_image", "representation": "style_color_reference", "file_name": filename,
            "image_sha256": sha(raw), "mime_type": "image/jpeg", "width": 32, "height": 32, "byte_size": len(raw),
            "origin": {"origin_type": "ai_generated", "source_name": "Synthetic unit-test fixture, no API",
                       "source_ref": "synthetic-job-" + slot, "is_simulated": True, "rights_confirmed": True},
            "reference": {"look_id": "M1V2-LOOK-101", "look_image_sha256": "a" * 64,
                          "visual_spec_sha256": sha(spec_path.read_bytes()), "visual_spec_product_id": product,
                          "prompt_version": "synthetic-test-v1", "tool_version": "synthetic-test-v1"},
            "generation_record": {"provider": "synthetic_test", "model": "synthetic_test", "job_id": "synthetic-job-" + slot,
                "requested_images": 1, "returned_images": 1, "attempts": 1, "completed_at": "2026-10-10T04:00:00+08:00",
                "cost": {"status": "unknown", "amount": None, "currency": None, "reason": "Test fixture, no supplier call"}},
            "state": "agent_checked_preview", "checks": {"checked_by": "synthetic_test", "checked_at": "2026-10-09T20:00:01Z",
                "technical_passed": True, "visual_passed": True, "evidence_ref": "synthetic-check.json"},
            "user_review": "pending", "accepted_by_user": False})
    resources = SimpleNamespace(data={"tenant_id": "tenant-synthetic"}, catalog={"catalog_version": "catalog-synthetic"},
        products=products, skus=skus, looks={"M1V2-LOOK-101": {"active": True, "image_sha256": "a" * 64,
            "items": {slot: sku for _, (sku, _, slot) in assets._MAPPING.items()}}})
    manifest = directory / "manifest.json"
    db = directory / "product-images.sqlite3"
    data = {"schema": assets.SCHEMA, "assets": refs}
    manifest.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setenv("STYLING_PRODUCT_IMAGE_PREVIEW", "1")
    monkeypatch.setenv("STYLING_PRODUCT_IMAGE_MANIFEST", str(manifest))
    monkeypatch.setenv("STYLING_PRODUCT_IMAGE_DB", str(db))
    monkeypatch.setenv("STYLING_FIXED_ROOT", str(resource_root))
    return SimpleNamespace(resources=resources, manifest=manifest, db=db, data=data, image_directory=image_directory,
                           spec_path=spec_path, monkeypatch=monkeypatch)


def write(fixture):
    fixture.manifest.write_text(json.dumps(fixture.data), encoding="utf-8")


def counts(path):
    with sqlite3.connect(path) as db:
        return tuple(db.execute(f"SELECT count(*) FROM {name}").fetchone()[0] for name in
                     ("product_image_assets", "product_image_displays"))


def version(fixture, vid="look-version-new"):
    return {"look_version_id": vid, "tenant_id": "tenant-synthetic", "session_id": "session-new", "look_id": "M1V2-LOOK-101",
            "items": deepcopy(fixture.resources.looks["M1V2-LOOK-101"]["items"]),
            "resources": {"catalog_version": "catalog-synthetic"}, "created_at": "2026-10-10T01:00:00Z"}


def expect(code, call, status=422):
    with pytest.raises(assets.ProductImageAssetError) as caught:
        call()
    assert (caught.value.code, caught.value.status) == (code, status)
    assert "/private" not in caught.value.message and "/Users" not in caught.value.message


def test_registration_catalog_and_actual_bytes_match_without_resource_mutation(fixture):
    before = deepcopy(fixture.resources.__dict__)
    assert assets.register_manifest(fixture.resources)["asset_count"] == 3
    for record in fixture.data["assets"]:
        ref = assets.current_ref(fixture.resources, record["product_id"], record["sku_ids"][0])
        assert ref["asset_id"] == record["asset_id"] and ref["sku_id"] == record["sku_ids"][0]
        assert ref["user_review"] == "pending" and ref["state"] == "agent_checked_preview"
        assert ref["kind"] == "product_single_image" and ref["representation"] == "style_color_reference"
        assert ref["image_url"].endswith(record["asset_id"])
        assert "file_name" not in ref and str(fixture.image_directory) not in json.dumps(ref)
        raw, mime, digest = assets.image_bytes(record["asset_id"], fixture.resources)
        assert (sha(raw), mime, digest, len(raw)) == (record["image_sha256"], record["mime_type"], record["image_sha256"], record["byte_size"])
    assert fixture.resources.__dict__ == before
    assert counts(fixture.db) == (3, 0)


def test_re_registration_and_reopen_keep_same_identifiers_and_timestamps(fixture):
    assets.register_manifest(fixture.resources)
    before = [assets.current_ref(fixture.resources, record["product_id"]) for record in fixture.data["assets"]]
    result = assets.register_manifest(fixture.resources)
    assert all(row["duplicate"] for row in result["registered_assets"])
    after = [assets.current_ref(fixture.resources, record["product_id"]) for record in fixture.data["assets"]]
    assert before == after and counts(fixture.db) == (3, 0)


def test_unregistered_catalog_reads_do_not_create_db_or_use_existing_file(fixture):
    assert assets.current_ref(fixture.resources, "M1V2-P-T101") is None
    expect("PRODUCT_IMAGE_NOT_FOUND", lambda: assets.image_bytes("PIMG-COV01-T101-v1"), 404)
    assert not fixture.db.exists()


@pytest.mark.parametrize("change", ["closed", "missing_config", "relative_manifest", "same_application_db", "same_fixed_db"])
def test_configuration_refuses_closed_relative_or_existing_business_db(fixture, change):
    if change == "closed":
        fixture.monkeypatch.setenv("STYLING_PRODUCT_IMAGE_PREVIEW", "0")
        code = "PRODUCT_IMAGE_DISABLED"
    elif change == "missing_config":
        fixture.monkeypatch.delenv("STYLING_PRODUCT_IMAGE_DB")
        code = "PRODUCT_IMAGE_CONFIGURATION_INVALID"
    elif change == "relative_manifest":
        fixture.monkeypatch.setenv("STYLING_PRODUCT_IMAGE_MANIFEST", "manifest.json")
        code = "PRODUCT_IMAGE_CONFIGURATION_INVALID"
    elif change == "same_application_db":
        fixture.monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(fixture.db))
        code = "PRODUCT_IMAGE_CONFIGURATION_INVALID"
    else:
        fixture.monkeypatch.setenv("STYLING_FIXED_DB", str(fixture.db))
        code = "PRODUCT_IMAGE_CONFIGURATION_INVALID"
    expect(code, lambda: assets.register_manifest(fixture.resources), 503)
    assert assets.current_ref(fixture.resources, "M1V2-P-T101") is None
    assert not fixture.db.exists()


@pytest.mark.parametrize("change", ["wrong_sku", "extra_sku", "wrong_product", "wrong_tenant", "wrong_catalog", "full_look_kind", "wrong_sha", "wrong_mime", "wrong_size", "over_size", "over_bytes", "pending", "accepted", "no_rights", "no_visual_check", "not_simulated", "spec_sha", "reference_sha", "private_path", "too_many_attempts"])
def test_invalid_asset_fields_or_exact_mapping_are_rejected(fixture, change):
    record = fixture.data["assets"][0]
    if change == "wrong_sku":
        record["sku_ids"] = ["M1V2-T101-S"]
    elif change == "extra_sku":
        record["sku_ids"].append("M1V2-T101-S")
    elif change == "wrong_product":
        record["product_id"] = "M1V2-P-T102"
    elif change == "wrong_tenant":
        record["tenant_id"] = "other-tenant"
    elif change == "wrong_catalog":
        record["catalog_version"] = "other-catalog"
    elif change == "full_look_kind":
        record["kind"] = "complete_outfit"
    elif change == "wrong_sha":
        record["image_sha256"] = "b" * 64
    elif change == "wrong_mime":
        record["mime_type"] = "image/png"
    elif change == "wrong_size":
        record["width"] = 31
    elif change == "over_size":
        record["width"] = 1025
    elif change == "over_bytes":
        record["byte_size"] = 1024 * 1024 + 1
    elif change == "pending":
        record["state"] = "pending_check"
    elif change == "accepted":
        record["accepted_by_user"] = True
    elif change == "no_rights":
        record["origin"]["rights_confirmed"] = False
    elif change == "no_visual_check":
        record["checks"]["visual_passed"] = False
    elif change == "not_simulated":
        record["origin"]["is_simulated"] = False
    elif change == "spec_sha":
        record["reference"]["visual_spec_sha256"] = "b" * 64
    elif change == "reference_sha":
        record["reference"]["look_image_sha256"] = "b" * 64
    elif change == "private_path":
        record["origin"]["source_ref"] = "/Users/synthetic/private-source.png"
    else:
        record["generation_record"]["attempts"] = 4  # plus the other two exceeds whole-batch four
    write(fixture)
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.register_manifest(fixture.resources))
    assert assets.current_ref(fixture.resources, record["product_id"]) is None
    assert not fixture.db.exists()


@pytest.mark.parametrize("filename", ["../private.jpg", "/tmp/private.jpg", "..\\private.jpg", "evil/inner.jpg"])
def test_manifest_filename_cannot_select_arbitrary_path(fixture, filename):
    fixture.data["assets"][0]["file_name"] = filename
    write(fixture)
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.register_manifest(fixture.resources))
    expect("PRODUCT_IMAGE_NOT_FOUND", lambda: assets.image_bytes(filename), 404)


def test_asset_file_and_directory_symlinks_are_refused(fixture, tmp_path):
    record = fixture.data["assets"][0]
    path = fixture.image_directory / record["file_name"]
    target = tmp_path / "private.jpg"
    target.write_bytes(path.read_bytes())
    path.unlink()
    path.symlink_to(target)
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.register_manifest(fixture.resources))
    assert assets.current_ref(fixture.resources, record["product_id"]) is None


def test_valid_header_without_decodable_image_is_rejected(fixture):
    record = fixture.data["assets"][0]
    raw = b"\xff\xd8\xff\xe0not-an-image\xff\xd9"
    (fixture.image_directory / record["file_name"]).write_bytes(raw)
    record["byte_size"] = len(raw)
    record["image_sha256"] = sha(raw)
    write(fixture)
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.register_manifest(fixture.resources))


def test_unknown_database_marker_does_not_write_or_convert_other_db(fixture):
    with sqlite3.connect(fixture.db) as db:
        db.execute("CREATE TABLE private_business(id INTEGER)")
        db.execute("INSERT INTO private_business VALUES(42)")
        db.commit()
    before = fixture.db.read_bytes()
    expect("PRODUCT_IMAGE_REGISTRY_INVALID", lambda: assets.register_manifest(fixture.resources), 409)
    assert fixture.db.read_bytes() == before


def test_same_asset_identity_different_metadata_conflicts_and_preserves_registration(fixture):
    assets.register_manifest(fixture.resources)
    with sqlite3.connect(fixture.db) as db:
        before = db.execute("SELECT * FROM product_image_assets ORDER BY asset_id").fetchall()
    fixture.data["assets"][0]["origin"]["source_name"] = "Other otherwise-legal source"
    write(fixture)
    expect("PRODUCT_IMAGE_CONFLICT", lambda: assets.register_manifest(fixture.resources), 409)
    assert assets.current_ref(fixture.resources, "M1V2-P-T101") is None
    with sqlite3.connect(fixture.db) as db:
        assert db.execute("SELECT * FROM product_image_assets ORDER BY asset_id").fetchall() == before


@pytest.mark.parametrize("failure", ["missing_file", "changed_bytes", "wrong_manifest", "registry_tamper", "preview_off"])
def test_failure_returns_null_without_changing_resource_or_image_success(fixture, failure):
    assets.register_manifest(fixture.resources)
    before = deepcopy(fixture.resources.__dict__)
    record = fixture.data["assets"][0]
    if failure == "missing_file":
        (fixture.image_directory / record["file_name"]).unlink()
    elif failure == "changed_bytes":
        path = fixture.image_directory / record["file_name"]
        path.write_bytes(b"x" + path.read_bytes()[1:])
    elif failure == "wrong_manifest":
        record["sku_ids"] = ["M1V2-T101-S"]
        write(fixture)
    elif failure == "registry_tamper":
        with sqlite3.connect(fixture.db) as db:
            db.execute("UPDATE product_image_assets SET record_digest=? WHERE asset_id=?", ("b" * 64, record["asset_id"]))
            db.commit()
    else:
        fixture.monkeypatch.setenv("STYLING_PRODUCT_IMAGE_PREVIEW", "0")
    assert assets.current_ref(fixture.resources, record["product_id"]) is None
    expect("PRODUCT_IMAGE_NOT_FOUND", lambda: assets.image_bytes(record["asset_id"]), 404)
    assert fixture.resources.__dict__ == before


def test_only_exact_registered_sku_uses_ref_even_when_product_matches(fixture):
    assets.register_manifest(fixture.resources)
    assert assets.current_ref(fixture.resources, "M1V2-P-T101", "M1V2-T101-S") is None
    assert assets.current_ref(fixture.resources, "M1V2-P-S101", "M1V2-S101-39") is None
    assert assets.current_ref(fixture.resources, "M1V2-P-T102") is None


def test_old_history_never_gets_implicit_backfill_and_new_refs_freeze(fixture):
    assets.register_manifest(fixture.resources)
    old = version(fixture, "look-version-old")
    assert assets.display_refs(old, fixture.resources) == {"recorded": False, "status": "history_unrecorded",
        "look_version_id": "look-version-old", "image_refs": {"top": None, "bottom": None, "shoes": None}, "is_simulated": True}
    assert counts(fixture.db) == (3, 0)
    new = version(fixture)
    before = deepcopy(new)
    recorded = assets.freeze_display(new, fixture.resources)
    assert recorded["recorded"] is True and all(recorded["image_refs"].values())
    assert recorded == assets.freeze_display(new, fixture.resources)
    assert recorded == assets.display_refs(new, fixture.resources)
    assert new == before and counts(fixture.db) == (3, 1)
    assert assets.display_refs(old, fixture.resources)["status"] == "history_unrecorded"


def test_same_display_identity_different_sku_binding_conflicts(fixture):
    assets.register_manifest(fixture.resources)
    new = version(fixture)
    preserved = assets.freeze_display(new, fixture.resources)
    altered = deepcopy(new)
    altered["items"]["top"], altered["items"]["bottom"] = altered["items"]["bottom"], altered["items"]["top"]
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.freeze_display(altered, fixture.resources))
    assert assets.display_refs(new, fixture.resources) == preserved
    assert assets.display_refs(altered, fixture.resources)["image_refs"]["top"] is None


def test_reopen_keeps_frozen_refs_and_file_failure_does_not_replace_them(fixture):
    assets.register_manifest(fixture.resources)
    new = version(fixture)
    first = assets.freeze_display(new, fixture.resources)
    with sqlite3.connect(fixture.db) as db:
        before = db.execute("SELECT display_json,display_digest FROM product_image_displays").fetchone()
    assert assets.display_refs(new) == first
    path = fixture.image_directory / fixture.data["assets"][0]["file_name"]
    path.unlink()
    assert assets.display_refs(new)["status"] == "unavailable"
    assert assets.freeze_display(new, fixture.resources) == first
    with sqlite3.connect(fixture.db) as db:
        assert db.execute("SELECT display_json,display_digest FROM product_image_displays").fetchone() == before


def test_new_partial_display_does_not_substitute_another_product_image(fixture):
    fixture.data["assets"] = fixture.data["assets"][:1]
    write(fixture)
    assets.register_manifest(fixture.resources)
    frozen = assets.freeze_display(version(fixture), fixture.resources)
    assert frozen["image_refs"]["top"] is not None
    assert frozen["image_refs"]["bottom"] is None and frozen["image_refs"]["shoes"] is None


@pytest.mark.parametrize("bad", ["duplicate_keys", "invalid_utf8", "nan", "unknown_field"])
def test_malformed_manifest_is_safe_null_and_registration_error(fixture, bad):
    if bad == "duplicate_keys":
        fixture.manifest.write_text('{"schema":"x","schema":"product_image_assets_v1","assets":[]}', encoding="utf-8")
    elif bad == "invalid_utf8":
        fixture.manifest.write_bytes(b"\xff\xfe")
    elif bad == "nan":
        fixture.manifest.write_text('{"schema":"product_image_assets_v1","assets":NaN}', encoding="utf-8")
    else:
        fixture.data["private"] = "must not appear"
        write(fixture)
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.register_manifest(fixture.resources))
    assert assets.current_ref(fixture.resources, "M1V2-P-T101") is None
    assert not fixture.db.exists()


def test_same_local_lv_id_in_two_sessions_has_independent_sku_refs(fixture):
    assets.register_manifest(fixture.resources)
    first = version(fixture, "lv-1")
    first["session_id"] = "session-a"
    first_ref = assets.freeze_display(first, fixture.resources)
    other_sku = "M1V2-T102-M"
    fixture.resources.skus[other_sku] = {"sku_id": other_sku, "product_id": "M1V2-P-T102", "slot": "top"}
    other_items = {**first["items"], "top": other_sku}
    fixture.resources.looks["M1V2-LOOK-112"] = {"active": True, "items": other_items}
    second = version(fixture, "lv-1")
    second.update(session_id="session-b", look_id="M1V2-LOOK-112", items=other_items)
    second_ref = assets.freeze_display(second, fixture.resources)
    assert first_ref["image_refs"]["top"]["sku_id"] == "M1V2-T101-M"
    assert second_ref["image_refs"]["top"] is None
    assert first_ref == assets.display_refs(first, fixture.resources)
    assert second_ref == assets.display_refs(second, fixture.resources)
    assert counts(fixture.db) == (3, 2)
    assert "session_id" not in first_ref and "session_id" not in second_ref


def test_old_session_lv1_stays_unrecorded_after_new_session_lv1_freeze(fixture):
    assets.register_manifest(fixture.resources)
    old = version(fixture, "lv-1")
    old["session_id"] = "old-session"
    new = version(fixture, "lv-1")
    new["session_id"] = "new-session"
    assert assets.display_refs(old, fixture.resources)["status"] == "history_unrecorded"
    assets.freeze_display(new, fixture.resources)
    assert assets.display_refs(new, fixture.resources)["recorded"] is True
    assert assets.display_refs(old, fixture.resources)["status"] == "history_unrecorded"
    assert counts(fixture.db) == (3, 1)


def test_version_without_session_binding_never_creates_display(fixture):
    assets.register_manifest(fixture.resources)
    value = version(fixture)
    del value["session_id"]
    expect("PRODUCT_IMAGE_INVALID", lambda: assets.freeze_display(value, fixture.resources))
    assert assets.display_refs(value, fixture.resources)["image_refs"]["top"] is None
    assert counts(fixture.db) == (3, 0)
