"""Offline adapter tests: controlled parsers never represent live model success."""
from copy import deepcopy
from contextlib import contextmanager
from pathlib import Path
import sys

import pytest

from app.services import fixed_styling as fixed

ROOT = Path('/Users/Admin/Documents/01项目/个人项目/永嘉农商杯')


class OfflineParser:
    configured = True
    name = 'offline-controlled-parser'
    mode = 'offline_test_double'

    def __init__(self):
        self.calls = 0

    @contextmanager
    def call_accounting(self, callback):
        # No model HTTP transport exists in this controlled offline parser.
        yield

    def parse(self, text, state, history, resources, dialog=None):
        self.calls += 1
        intent = resources.data.get('_unused') or {
            'operation': 'initial_recommendation',
            'updates': {'budget_max_fen': 80000, 'scene': 'scene:work_commute',
                        'usual_sizes': {'top': {'system': 'clothing_alpha', 'value': 'M'},
                                        'bottom': {'system': 'clothing_alpha', 'value': 'M'},
                                        'shoes': {'system': 'cn_shoe', 'value': '38'}}},
        }
        from m2.core import validate_intent
        return validate_intent(intent, resources), {
            'mode': self.mode, 'model': self.name, 'input_tokens': 0, 'output_tokens': 0,
            'tool_calls': 0, 'retries': 0, 'cost': 0,
        }


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    monkeypatch.setenv('STYLING_FIXED_ENABLED', '1')
    monkeypatch.setenv('STYLING_FIXED_ROOT', str(ROOT))
    monkeypatch.setenv('STYLING_FIXED_DB', str(tmp_path / 'fixed.sqlite3'))
    monkeypatch.setenv('STYLING_FIXED_MODEL_CALL_LIMIT', '12')
    parser = OfflineParser()
    monkeypatch.setattr(fixed, '_make_model', lambda: parser)
    fixed.close_service()
    yield fixed, parser
    fixed.close_service()


def turn_body(view, ident='first'):
    return {'contract_version': '0.1.0', 'request_id': ident, 'idempotency_key': ident,
            'turn_id': ident, 'expected_state_revision': view['state']['state_revision'],
            'expected_conversation_revision': view['conversation_revision'],
            'user_utterance': '离线合成输入：预算800，上下装M，鞋38，通勤搭配'}


def test_default_mode_is_off(monkeypatch):
    monkeypatch.delenv('STYLING_FIXED_ENABLED', raising=False)
    assert fixed.health()['enabled'] is False
    with pytest.raises(fixed.FixedStylingError, match='FIXED_STYLING_DISABLED'):
        fixed.get_service()


def test_accepted_assets_only_and_fresh_independent_snapshot(adapter):
    api, _ = adapter
    service = api.get_service()
    assert len(service.r.looks) == 4
    assert all(x['look_id'].startswith('M1V2-') for x in service.r.looks.values())
    assert service.r.inventory['inventory_snapshot_id'].startswith('inv-m2-sim-')
    service.r.fresh(service.clock())
    assert api.health()['accepted_look_count'] == 4
    assert api.health()['model_http_attempts'] == 0


def test_turn_exact_replay_and_conflict_preserve_one_version(adapter):
    api, parser = adapter
    view = api.create_session()
    body = turn_body(view)
    result = api.turn(view['session_id'], body)
    assert result['outcome'] == 'complete_outfit'
    assert result['outfit']['look_version_id'] == 'lv-1'
    assert set(result['outfit']['items']) == {'top', 'bottom', 'shoes'}
    assert all(v['sku_id'].startswith('M1V2-') for v in result['outfit']['items'].values())
    assert result['outfit']['image_url'].startswith('/api/v1/outfits/assets/')
    assert result['outfit']['look_asset_version'] == 'look_assets_m1_v2_002'
    assert api.turn(view['session_id'], body) == result
    assert parser.calls == 1
    with pytest.raises(fixed.FixedStylingError) as error:
        api.turn(view['session_id'], {**body, 'user_utterance': 'different input'})
    assert error.value.code == 'IDEMPOTENCY_CONFLICT'
    assert len(api.session_view(view['session_id'])['history']) == 1


def test_product_session_mapping_and_result_survive_restart(adapter):
    api, parser = adapter
    done = api.process_chat('product-session', 'request-1', '离线合成请求')
    assert done['session_id'] == 'product-session'
    assert done['outcome'] == 'complete_outfit'
    assert done['fixed_session_id'].startswith('session-')
    assert all(p.startswith('M1V2-P-') for p in done['product_ids'])
    api.close_service()
    restored = api.session_view('product-session')
    assert restored['session_id'] == done['fixed_session_id']
    assert restored['history'][0]['look_version_id'] == 'lv-1'
    assert api.process_chat('product-session', 'request-1', '离线合成请求') == done
    assert parser.calls == 1


def test_version_lookup_never_accepts_cross_session(adapter):
    api, _ = adapter
    one = api.create_session()
    two = api.create_session()
    api.turn(one['session_id'], turn_body(one))
    assert api.get_version(one['session_id'], 'lv-1')['look_version_id'] == 'lv-1'
    assert api.get_version(two['session_id'], 'lv-1') is None


def test_simulated_cart_add_cancel_and_idempotent_replay(adapter):
    api, _ = adapter
    view = api.create_session()
    first = api.turn(view['session_id'], turn_body(view))
    body = {'action_id': 'add-1', 'operation': 'add_bundle_to_cart',
            'expected_state_revision': first['state']['state_revision'],
            'expected_conversation_revision': first['conversation_revision'],
            'target_look_version_id': 'lv-1'}
    added = api.action(view['session_id'], body)
    assert len(added['cart_items']) == 3
    assert all(x['is_simulated'] for x in added['cart_items'])
    assert api.action(view['session_id'], body) == added
    before = api.session_view(view['session_id'])
    sid = first['outfit']['items']['top']['sku_id']
    cancel = {'action_id': 'cancel-1', 'operation': 'remove_item_from_cart', 'sku_id': sid,
              'expected_state_revision': before['state']['state_revision'],
              'expected_conversation_revision': before['conversation_revision']}
    removed = api.action(view['session_id'], cancel)
    assert len(removed['cart_items']) == 2
    assert api.action(view['session_id'], cancel) == removed
    assert api.get_version(view['session_id'], 'lv-1') == first['outfit']
    assert removed['state']['current_look_version_id'] == 'lv-1'
    assert any(e['event_type'] == 'cart_item_removed' for e in removed['events'])


def test_cart_cancel_revision_conflict_does_not_remove(adapter):
    api, _ = adapter
    view = api.create_session()
    api.turn(view['session_id'], turn_body(view))
    with pytest.raises(fixed.FixedStylingError) as error:
        api.action(view['session_id'], {'action_id': 'cancel', 'operation': 'remove_item_from_cart',
            'sku_id': 'M1V2-T101-M', 'expected_state_revision': 0,
            'expected_conversation_revision': 0})
    assert error.value.code == 'STATE_REVISION_CONFLICT'


def test_registered_assets_have_exact_source_bytes(adapter):
    api, _ = adapter
    import hashlib
    for look in api.get_service().r.looks.values():
        raw = api.asset_bytes(look['look_id'])
        assert hashlib.sha256(raw).hexdigest() == look['image_sha256']
    with pytest.raises(fixed.FixedStylingError):
        api.asset_bytes('M3-LOOK-LM-01')
    with pytest.raises(fixed.FixedStylingError):
        api.asset_bytes('../model.json')


def test_attempt_cap_is_atomic_total_and_survives_restart(adapter):
    api, _ = adapter
    service = api.get_service()
    for _ in range(12):
        service.limits.count_model_call(0)
    assert api.health()['model_http_attempts'] == 12
    with pytest.raises(Exception) as error:
        service.limits.count_model_call(86400)
    assert getattr(error.value, 'code') == 'MODEL_CALL_BUDGET_EXHAUSTED'
    api.close_service()
    assert api.health()['model_http_attempts'] == 12
    with pytest.raises(Exception):
        api.get_service().limits.count_model_call(172800)


def test_model_error_never_creates_outfit_or_success_history(adapter):
    api, parser = adapter
    def fail(*args):
        from m2.core import Fault
        raise Fault('MODEL_UNAVAILABLE', 'controlled offline failure')
    parser.parse = fail
    view = api.create_session()
    with pytest.raises(fixed.FixedStylingError) as error:
        api.turn(view['session_id'], turn_body(view))
    assert error.value.code == 'MODEL_UNAVAILABLE'
    after = api.session_view(view['session_id'])
    assert after['history'] == []
    assert after['messages'] == []


def test_restore_is_new_version_while_view_is_readonly(adapter):
    api, _ = adapter
    view = api.create_session()
    first = api.turn(view['session_id'], turn_body(view))
    common = {'expected_state_revision': first['state']['state_revision'],
              'expected_conversation_revision': first['conversation_revision'],
              'target_look_version_id': 'lv-1'}
    viewed = api.action(view['session_id'], {**common, 'action_id': 'view', 'operation': 'view_history'})
    assert len(viewed['history']) == 1
    restored = api.action(view['session_id'], {**common,
        'expected_state_revision': viewed['state']['state_revision'],
        'expected_conversation_revision': viewed['conversation_revision'],
        'action_id': 'restore', 'operation': 'restore_history'})
    assert len(restored['history']) == 2
    assert restored['outfit']['restored_from_look_version_id'] == 'lv-1'
    assert restored['outfit']['look_version_id'] == 'lv-2'


def test_assets_use_canonical_root_under_legacy_alias(adapter, monkeypatch):
    api, _ = adapter
    monkeypatch.setenv('STYLING_FIXED_ROOT', '/Users/Admin/Documents/项目/个人项目/永嘉农商杯')
    api.close_service()
    assert api.health()['assets_ready'] is True


def test_replay_old_bundle_action_after_restore_returns_original_snapshot(adapter):
    api, _ = adapter
    view = api.create_session()
    first = api.turn(view['session_id'], turn_body(view))
    add = {'action_id': 'bundle', 'operation': 'add_bundle_to_cart', 'target_look_version_id': 'lv-1',
           'expected_state_revision': first['state']['state_revision'],
           'expected_conversation_revision': first['conversation_revision']}
    old = api.action(view['session_id'], add)
    api.action(view['session_id'], {'action_id': 'restore', 'operation': 'restore_history',
        'target_look_version_id': 'lv-1', 'expected_state_revision': old['state']['state_revision'],
        'expected_conversation_revision': old['conversation_revision']})
    assert api.action(view['session_id'], add) == old
    with pytest.raises(fixed.FixedStylingError) as error:
        api.action(view['session_id'], {**add, 'target_look_version_id': 'lv-2'})
    assert error.value.code == 'IDEMPOTENCY_CONFLICT'


def test_concurrent_transport_retries_only_parse_once(adapter):
    api, parser = adapter
    import threading
    import time
    original = parser.parse
    def slow(*args):
        time.sleep(.05)
        return original(*args)
    parser.parse = slow
    view = api.create_session()
    body = turn_body(view)
    responses = []
    threads = [threading.Thread(target=lambda: responses.append(api.turn(view['session_id'], body))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2)
    assert len(responses) == 2
    assert responses[0] == responses[1]
    assert parser.calls == 1
    assert len(api.session_view(view['session_id'])['history']) == 1
    assert api.health()['model_http_attempts'] == 0


def test_irrelevant_action_fields_are_rejected_before_any_change(adapter):
    api, _ = adapter
    view = api.create_session()
    with pytest.raises(fixed.FixedStylingError) as error:
        api.action(view['session_id'], {'action_id': 'a', 'operation': 'view_history',
            'target_look_version_id': 'lv-1', 'sku_id': 'M1V2-T101-M',
            'expected_state_revision': 0, 'expected_conversation_revision': 0})
    assert error.value.code == 'INVALID_REQUEST'
    assert api.session_view(view['session_id'])['conversation_revision'] == 0


def test_initial_inventory_snapshot_is_frozen_in_outfit(adapter):
    api, _ = adapter
    service = api.get_service()
    initial = deepcopy(service.r.inventory)
    view = api.create_session()
    result = api.turn(view['session_id'], turn_body(view))
    frozen = result['outfit']['inventory_snapshot']
    assert frozen['recorded'] is True
    assert frozen['inventory_snapshot_id'] == initial['inventory_snapshot_id']
    assert frozen['captured_at'] == initial['captured_at']
    assert frozen['valid_until'] == initial['valid_until']
    assert frozen['is_simulated'] is True
    assert len(frozen['sha256']) == 64
    with service.store.lock:
        stored = service.store.db.execute('SELECT snapshot_json,sha256 FROM fixed_inventory_snapshots '
            'WHERE inventory_snapshot_id=?', (initial['inventory_snapshot_id'],)).fetchone()
    import json
    import hashlib
    assert json.loads(stored[0]) == initial
    assert hashlib.sha256(stored[0].encode()).hexdigest() == stored[1] == frozen['sha256']


def test_inventory_refresh_preserves_old_version_dates_and_restart(adapter):
    api, _ = adapter
    service = api.get_service()
    view = api.create_session()
    result = api.turn(view['session_id'], turn_body(view))
    frozen = deepcopy(result['outfit']['inventory_snapshot'])
    from datetime import datetime, timedelta
    future = (datetime.fromisoformat(frozen['valid_until']) + timedelta(minutes=1)).isoformat()
    service.clock = lambda: future
    current = api.health()
    assert current['inventory_snapshot_id'] != frozen['inventory_snapshot_id']
    assert current['valid_until'] != frozen['valid_until']
    assert api.get_version(view['session_id'], 'lv-1')['inventory_snapshot'] == frozen
    with service.store.lock:
        assert service.store.db.execute('SELECT count(*) FROM fixed_inventory_snapshots').fetchone()[0] == 2
    api.close_service()
    restored = api.get_version(view['session_id'], 'lv-1')
    assert restored['inventory_snapshot'] == frozen


def test_inventory_same_id_different_body_is_rejected_and_original_kept(adapter):
    api, _ = adapter
    service = api.get_service()
    original = deepcopy(service.r.inventory)
    changed = deepcopy(original)
    changed['items'][0]['available_qty'] += 1
    with pytest.raises(fixed.FixedStylingError) as error:
        api.register_inventory_snapshot(service, changed)
    assert error.value.code == 'INVENTORY_SNAPSHOT_CONFLICT'
    assert api.register_inventory_snapshot(service, original)['recorded'] is True
    import json
    with service.store.lock:
        stored = service.store.db.execute('SELECT snapshot_json FROM fixed_inventory_snapshots '
            'WHERE inventory_snapshot_id=?', (original['inventory_snapshot_id'],)).fetchone()
    assert json.loads(stored[0]) == original


def test_missing_historical_inventory_is_unrecorded_and_not_current(adapter):
    api, _ = adapter
    view = api.create_session()
    result = api.turn(view['session_id'], turn_body(view))
    service = api.get_service()
    # An isolated legacy fixture with a missing historical registry entry.
    with service.store.lock, service.store.db:
        service.store.db.execute('DELETE FROM fixed_inventory_snapshots WHERE inventory_snapshot_id=?',
                                 (result['outfit']['resources']['inventory_snapshot_id'],))
    historical = api.get_version(view['session_id'], 'lv-1')['inventory_snapshot']
    assert historical['recorded'] is False
    assert historical['captured_at'] is None
    assert historical['valid_until'] is None
    assert historical['sha256'] is None


def test_p_catalog_chat_bridge_is_rejected_before_model_parse(adapter):
    api, parser = adapter
    with pytest.raises(fixed.FixedStylingError) as error:
        api.process_chat('p-prefill-session', 'p-request', '我想围绕商品P001搭一套通勤穿搭')
    assert error.value.code == 'CATALOG_REFERENCE_UNSUPPORTED'
    assert parser.calls == 0
    assert api.health()['model_http_attempts'] == 0
    assert api.session_view('p-prefill-session')['history'] == []


def test_p_catalog_json_turn_is_rejected_before_model_parse(adapter):
    api, parser = adapter
    view = api.create_session()
    body = {**turn_body(view), 'user_utterance': '请比较（P001）与 P021，再搭一套'}
    with pytest.raises(fixed.FixedStylingError) as error:
        api.turn(view['session_id'], body)
    assert error.value.code == 'CATALOG_REFERENCE_UNSUPPORTED'
    assert parser.calls == 0
    assert api.health()['model_http_attempts'] == 0
    assert api.session_view(view['session_id'])['history'] == []


@pytest.mark.parametrize('text', ['请围绕M1V2-P-T101搭配', '资料编号XP001、P0010只是文本，请按M1V2-P-T101搭配'])
def test_legal_m1_catalog_and_ascii_substrings_are_not_rejected(adapter, text):
    api, parser = adapter
    view = api.create_session()
    result = api.turn(view['session_id'], {**turn_body(view), 'user_utterance': text})
    assert result['outcome'] == 'complete_outfit'
    assert parser.calls == 1
    assert result['outfit']['items']['top']['product_id'].startswith('M1V2-')


def test_catalog_returns_accepted_m1_mapping_without_parse_or_session(adapter):
    api, parser = adapter
    service = api.get_service()
    before_sessions = len(service.sessions)
    result = api.catalog()
    assert len(result['products']) == 6
    assert len(result['skus']) == 28
    assert all(p['product_id'].startswith('M1V2-P-') and p['image_url'] is None for p in result['products'])
    assert all(s['sku_id'].startswith('M1V2-') for s in result['skus'])
    sku_ids = {s['sku_id'] for s in result['skus']}
    assert len(result['accepted_looks']) == 4
    for look in result['accepted_looks']:
        assert look['look_id'].startswith('M1V2-LOOK-')
        assert set(look['items']) == {'top', 'bottom', 'shoes'}
        assert set(look['items'].values()) <= sku_ids
        assert look['image_url'] == '/api/v1/outfits/assets/' + look['look_id']
        assert look['acceptance_status'] == 'accepted_by_user'
        import hashlib
        assert hashlib.sha256(api.asset_bytes(look['look_id'])).hexdigest() == look['image_sha256']
    assert result['versions']['inventory_snapshot_id'] == result['inventory_snapshot']['inventory_snapshot_id']
    assert len(result['inventory_snapshot']['items']) == 28
    assert len(result['inventory_snapshot_sha256']) == 64
    assert parser.calls == 0
    assert api.health()['model_http_attempts'] == 0
    assert len(service.sessions) == before_sessions == 0
