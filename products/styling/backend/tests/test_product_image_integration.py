"""Accepted fixed Look integration, isolated sidecar; no image/model API."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3

import pytest

from app.services import product_image_assets as assets
from tests.test_fixed_styling import adapter, turn_body, ROOT


@pytest.fixture
def registered(adapter, monkeypatch, tmp_path):
    fixed, _ = adapter
    source = ROOT / 'reports/cover-01-backend-20261010'
    directory = tmp_path / 'product-images'
    (directory / 'assets').mkdir(parents=True)
    data = json.loads((source / 'product-image-manifest-v1.json').read_text())
    for record in data['assets']:
        shutil.copyfile(source / 'assets' / record['file_name'], directory / 'assets' / record['file_name'])
    manifest = directory / 'manifest.json'
    manifest.write_text(json.dumps(data))
    monkeypatch.setenv('STYLING_PRODUCT_IMAGE_PREVIEW', '1')
    monkeypatch.setenv('STYLING_PRODUCT_IMAGE_MANIFEST', str(manifest))
    monkeypatch.setenv('STYLING_PRODUCT_IMAGE_DB', str(directory / 'registry.sqlite3'))
    assets.register_manifest(fixed.get_service().r)
    return fixed, directory


def test_registered_product_asset_http_is_exact_content(registered, client):
    fixed, _ = registered
    catalog = client.get('/api/v1/outfits/catalog').json()
    refs = [p['image_use_ref'] for p in catalog['products'] if p['image_use_ref']]
    assert len(refs) == 3 and len(catalog['products']) == 6 and len(catalog['skus']) == 28
    for ref in refs:
        response = client.get(ref['image_url'])
        assert response.status_code == 200
        assert response.headers['content-type'] == ref['mime_type']
        assert len(response.content) == ref['byte_size']
        assert hashlib.sha256(response.content).hexdigest() == ref['image_sha256']
        assert response.headers['x-content-sha256'] == ref['image_sha256']
        assert ref['user_review'] == 'pending'
    assert client.get('/api/v1/outfits/product-assets/unknown-asset').status_code == 404
    assert fixed.health()['accepted_look_count'] == 4


def test_history_is_not_backfilled_and_restore_records_new_display(registered, monkeypatch):
    fixed, directory = registered
    monkeypatch.setenv('STYLING_PRODUCT_IMAGE_PREVIEW', '0')
    view = fixed.create_session()
    result = fixed.turn(view['session_id'], turn_body(view, 'old-version'))
    original = deepcopy(fixed.get_service()._row(view['session_id'])['history'][0])
    monkeypatch.setenv('STYLING_PRODUCT_IMAGE_PREVIEW', '1')
    latest = fixed.session_view(view['session_id'])
    assert latest['history'][0]['product_image_display']['recorded'] is False
    assert all(item['image_url'] is None for item in latest['history'][0]['items'].values())
    body = {'action_id': 'restore-with-images', 'operation': 'restore_history',
            'target_look_version_id': result['outfit']['look_version_id'],
            'expected_state_revision': latest['state']['state_revision'],
            'expected_conversation_revision': latest['conversation_revision']}
    restored = fixed.action(view['session_id'], body)
    assert restored['outfit']['product_image_display']['recorded'] is True
    assert all(item['image_use_ref']['sku_id'] == item['sku_id'] for item in restored['outfit']['items'].values())
    assert fixed.get_service()._row(view['session_id'])['history'][0] == original
    assert fixed.session_view(view['session_id'])['history'][0]['product_image_display']['recorded'] is False
    with sqlite3.connect(directory / 'registry.sqlite3') as db:
        assert db.execute('SELECT count(*) FROM product_image_displays').fetchone()[0] == 1


def test_two_sessions_local_version_ids_get_separate_displays(registered):
    fixed, directory = registered
    for index in range(2):
        view = fixed.create_session()
        result = fixed.turn(view['session_id'], turn_body(view, 'separate-session-' + str(index)))
        assert result['outfit']['look_version_id'] == 'lv-1'
        assert result['outfit']['product_image_display']['recorded'] is True
    with sqlite3.connect(directory / 'registry.sqlite3') as db:
        assert db.execute('SELECT count(*) FROM product_image_displays').fetchone()[0] == 2


def test_optional_image_failure_does_not_change_complete_look(registered, monkeypatch):
    fixed, _ = registered
    def fail(*args):
        raise assets.ProductImageAssetError(503, 'PRODUCT_IMAGE_REGISTRY_INVALID')
    monkeypatch.setattr(assets, 'freeze_display', fail)
    view = fixed.create_session()
    result = fixed.turn(view['session_id'], turn_body(view, 'optional-failure'))
    assert result['outcome'] == 'complete_outfit'
    assert result['outfit']['image_kind'] == 'fixed_model_complete_outfit'
    assert result['outfit']['product_image_display']['recorded'] is False
    assert all(item['image_url'] is None for item in result['outfit']['items'].values())
    assert len(fixed.session_view(view['session_id'])['history']) == 1
