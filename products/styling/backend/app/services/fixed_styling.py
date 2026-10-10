"""Opt-in fixed-model outfits using accepted assets and a separate persistent store.

This adapter does not generate image pixels, promote candidate assets, mutate the
original inventory, or turn transport completion into an outfit success.
"""
from copy import deepcopy
import hashlib
import importlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import threading


class FixedStylingError(Exception):
    def __init__(self, code, message='固定搭配请求未完成，请检查状态后重试。'):
        self.code, self.message = code, message
        super().__init__(code)


_LOCK = threading.RLock()
_SERVICE = None
_FINGERPRINT = None
_ROOT = None
_SESSION_LOCKS = {}


def enabled():
    return os.getenv('STYLING_FIXED_ENABLED', '0') == '1'


def _require(condition, code='INVALID_REQUEST', message='请求字段无效。'):
    if not condition:
        raise FixedStylingError(code, message)


def _m2():
    _require(enabled(), 'FIXED_STYLING_DISABLED', '固定搭配服务尚未开启。')
    configured = os.getenv('STYLING_FIXED_ROOT', '') or str(Path(__file__).resolve().parents[2] / 'demo_resources')
    root = Path(configured).expanduser().resolve()
    _require((root / 'm2/core.py').is_file(), 'FIXED_CONFIGURATION_INVALID', '固定搭配资源根无效。')
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    core = importlib.import_module('m2.core')
    _require(Path(core.ROOT).resolve() == root, 'FIXED_CONFIGURATION_INVALID', '固定搭配模块与资源根不一致。')
    return root, core


def _make_model():
    if os.getenv('STYLING_FIXED_OFFLINE_DEMO', '0') == '1':
        from app.services.offline_demo_model import OfflineDemoParser
        return OfflineDemoParser()
    from m2.model import CompatibleModel
    model = CompatibleModel()
    _require(model.provider == 'deepseek' and model.base.rstrip('/') == 'https://api.deepseek.com',
             'MODEL_PROVIDER_NOT_AUTHORIZED', '本轮只使用已授权的DeepSeek官方模型配置。')
    return model


def close_service():
    global _SERVICE, _FINGERPRINT, _ROOT
    with _LOCK:
        if _SERVICE is not None:
            _SERVICE.close()
        _SERVICE = None
        _FINGERPRINT = None
        _ROOT = None


def _get_service():
    global _SERVICE, _FINGERPRINT, _ROOT
    root, core = _m2()
    path = os.getenv('STYLING_FIXED_DB', '')
    _require(bool(path), 'FIXED_CONFIGURATION_INVALID', '固定搭配须使用显式的独立数据库。')
    db_path = Path(path).expanduser().resolve()
    _require(db_path != (root / 'reports/m2/runtime/sessions.sqlite3').resolve() and
             db_path != (root / 'reports/m2/runtime/local-preview.sqlite3').resolve(),
             'FIXED_CONFIGURATION_INVALID', '不能写入既有M2数据库。')
    from app.core.config import settings
    if settings.database_url.startswith('sqlite:///'):
        _require(db_path != Path(settings.database_url[10:]).resolve(),
                 'FIXED_CONFIGURATION_INVALID', '固定搭配须与产品业务数据库分离。')
    try:
        limit = int(os.getenv('STYLING_FIXED_MODEL_CALL_LIMIT', '12'))
    except ValueError:
        raise FixedStylingError('FIXED_CONFIGURATION_INVALID', '模型尝试上限无效。') from None
    _require(1 <= limit <= 12, 'FIXED_CONFIGURATION_INVALID', '本轮实际模型HTTP尝试上限不得超过12。')
    fingerprint = (str(root), str(db_path), limit, os.getenv('STYLING_FIXED_OFFLINE_DEMO', '0'))
    with _LOCK:
        if _SERVICE is not None and _FINGERPRINT == fingerprint:
            return _SERVICE
        if _SERVICE is not None:
            _SERVICE.close()
        from m2.runtime import RequestLimits
        from m2.service import Service

        class BoundedAttempts(RequestLimits):
            def __init__(self):
                super().__init__(per_minute=20, model_concurrency=1)

            def _count_model_call(self, day):
                # Every primary/guard HTTP attempt calls this BEFORE transport.
                # Persist a total cap, not a midnight-reset quota. Failed HTTP
                # attempts are included; no credential or input is recorded.
                with self.store.lock, self.store.db:
                    self.store.db.execute('BEGIN IMMEDIATE')
                    row = self.store.db.execute("SELECT value FROM metadata WHERE key='fixed_model_http_attempts'").fetchone()
                    count = int(json.loads(row[0])) if row else 0
                    core.require(count < limit, 'MODEL_CALL_BUDGET_EXHAUSTED',
                                 '本轮模型验收调用额度已用完，未继续调用。')
                    self.store.db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('fixed_model_http_attempts',?)",
                                          (json.dumps(count + 1),))

        service = Service(core.demo_resources(save=False), model=_make_model(), db_path=db_path,
                          remember_messages=True,
                          refresh_factory=lambda at: core.demo_resources(at, save=False),
                          limits=BoundedAttempts())
        # Bridge identifiers and exact original turn bodies survive service restart.
        with service.store.lock, service.store.db:
            service.store.db.execute('CREATE TABLE IF NOT EXISTS fixed_product_sessions '
                                     '(product_session_id TEXT PRIMARY KEY, fixed_session_id TEXT NOT NULL UNIQUE)')
            service.store.db.execute('CREATE TABLE IF NOT EXISTS fixed_chat_bridges '
                                     '(request_id TEXT PRIMARY KEY, product_session_id TEXT NOT NULL, '
                                     'text_digest TEXT NOT NULL, body_json TEXT NOT NULL)')
            service.store.db.execute('CREATE TABLE IF NOT EXISTS fixed_inventory_snapshots '
                                     '(inventory_snapshot_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, '
                                     'sha256 TEXT NOT NULL)')
        # Register the actually loaded snapshot, which may have survived a restart.
        # Do not register the throwaway fresh factory snapshot as historical truth.
        register_inventory_snapshot(service, service.r.inventory)
        refresh_resources = service.resources

        def registered_resources():
            resources = refresh_resources()
            register_inventory_snapshot(service, resources.inventory)
            return resources

        service.resources = registered_resources
        _SERVICE, _FINGERPRINT, _ROOT = service, fingerprint, root
        return service


def _call(callback):
    try:
        return callback()
    except FixedStylingError:
        raise
    except Exception as error:
        if hasattr(error, 'code') and hasattr(error, 'message'):
            raise FixedStylingError(error.code, error.message) from None
        raise


def get_service():
    return _call(_get_service)


def _snapshot_summary(snapshot_id, encoded=None, digest=None):
    if encoded is None:
        return {'recorded': False, 'inventory_snapshot_id': snapshot_id,
                'captured_at': None, 'valid_until': None, 'sha256': None,
                'is_simulated': True}
    snapshot = json.loads(encoded)
    return {'recorded': True, 'inventory_snapshot_id': snapshot_id,
            'captured_at': snapshot['captured_at'], 'valid_until': snapshot['valid_until'],
            'sha256': digest, 'is_simulated': snapshot['origin']['is_simulated']}


def register_inventory_snapshot(service, inventory):
    """Persist each exact runtime snapshot once; equal IDs cannot change content."""
    _require(type(inventory) is dict and type(inventory.get('inventory_snapshot_id')) is str
             and type(inventory.get('captured_at')) is str and type(inventory.get('valid_until')) is str
             and inventory.get('origin', {}).get('is_simulated') is True,
             'INVENTORY_SNAPSHOT_INVALID', '模拟库存快照字段不完整。')
    snapshot_id = inventory['inventory_snapshot_id']
    try:
        encoded = json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError):
        raise FixedStylingError('INVENTORY_SNAPSHOT_INVALID', '模拟库存快照字段无效。') from None
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    with service.store.lock, service.store.db:
        service.store.db.execute('BEGIN IMMEDIATE')
        old = service.store.db.execute('SELECT snapshot_json,sha256 FROM fixed_inventory_snapshots '
                                       'WHERE inventory_snapshot_id=?', (snapshot_id,)).fetchone()
        if old:
            _require(old == (encoded, digest), 'INVENTORY_SNAPSHOT_CONFLICT',
                     '同一库存快照编号的内容不一致，不能覆盖历史快照。')
        else:
            service.store.db.execute('INSERT INTO fixed_inventory_snapshots VALUES(?,?,?)',
                                     (snapshot_id, encoded, digest))
    return _snapshot_summary(snapshot_id, encoded, digest)


def _historical_inventory_snapshot(service, snapshot_id):
    with service.store.lock:
        row = service.store.db.execute('SELECT snapshot_json,sha256 FROM fixed_inventory_snapshots '
                                       'WHERE inventory_snapshot_id=?', (snapshot_id,)).fetchone()
    return _snapshot_summary(snapshot_id, *(row or (None, None)))


def _session_lock(service, sid):
    # One local application process is supported. Serialize a session's exact
    # transport retry before model execution, so concurrent duplicates also reuse
    # its M2 cache rather than paying for two parses before the first commit.
    with _LOCK:
        return _SESSION_LOCKS.setdefault((id(service), sid), threading.RLock())


def health():
    if not enabled():
        return {'enabled': False, 'ready': False, 'assets_ready': False, 'model_configured': False,
                'code': 'FIXED_STYLING_DISABLED', 'model_http_attempts': 0, 'model_http_attempt_limit': 12}
    try:
        service = get_service()
        resources = _call(service.resources)
        attempts = service.store.value('fixed_model_http_attempts', 0)
        configured = bool(service.model.configured)
        return {'enabled': True, 'ready': configured and attempts < _FINGERPRINT[2],
                'assets_ready': True, 'model_configured': configured, 'model': service.model.name,
                'mode': getattr(service.model, 'mode', 'live_model'),
                'live_model_verified': bool(service.store.value('fixed_live_model_verified', False)),
                'accepted_look_count': len(resources.looks), 'accepted_asset_version': resources.binding['look_asset_version'],
                'inventory_snapshot_id': resources.inventory['inventory_snapshot_id'],
                'captured_at': resources.inventory['captured_at'], 'valid_until': resources.inventory['valid_until'],
                'is_simulated': True, 'image_generation': 'accepted_pre_generated_assets',
                'supported_sizes': {'top': 'M', 'bottom': 'M', 'shoes': '38'},
                'minimum_complete_price_fen': min(resources.total(look) for look in resources.looks.values()),
                'model_http_attempts': attempts, 'model_http_attempt_limit': _FINGERPRINT[2],
                'code': 'OK' if configured and attempts < _FINGERPRINT[2] else
                        'MODEL_CALL_BUDGET_EXHAUSTED' if attempts >= _FINGERPRINT[2] else 'MODEL_NOT_CONFIGURED'}
    except FixedStylingError as error:
        return {'enabled': True, 'ready': False, 'assets_ready': False, 'model_configured': False,
                'code': error.code, 'message': error.message}
    except Exception:
        return {'enabled': True, 'ready': False, 'assets_ready': False, 'model_configured': False,
                'code': 'FIXED_CONFIGURATION_INVALID', 'message': '固定搭配配置或资源暂时不可读取。'}


def _resolve_session_id(service, session_id):
    with service.store.lock:
        row = service.store.db.execute('SELECT fixed_session_id FROM fixed_product_sessions WHERE product_session_id=?',
                                       (session_id,)).fetchone()
    return row[0] if row else session_id


def authorize_session(owner, session_id):
    """Protect both product IDs and their internally mapped fixed IDs."""
    from app.services import profile_snapshots
    profile_snapshots.authorize_session(owner, session_id)
    if enabled():
        service = get_service()
        with service.store.lock:
            aliases = service.store.db.execute('SELECT product_session_id FROM fixed_product_sessions '
                                               'WHERE fixed_session_id=?', (session_id,)).fetchall()
        for row in aliases:
            profile_snapshots.authorize_session(owner, row[0])


def requires_profile_binding(session_id):
    from app.models.profile_snapshot import ConsumerSessionOwner
    from app.services import profile_snapshots
    aliases = [session_id]
    if enabled():
        service = get_service()
        with service.store.lock:
            aliases += [r[0] for r in service.store.db.execute(
                'SELECT product_session_id FROM fixed_product_sessions WHERE fixed_session_id=?', (session_id,)).fetchall()]
    with profile_snapshots.SessionLocal() as db:
        return any(db.get(ConsumerSessionOwner, sid) is not None for sid in aliases)


def _outfit(service, version):
    look = service.r.looks.get(version['look_id'])
    _require(look is not None and look['active'] and look['items'] == version['items'],
             'LOOK_MAPPING_MISMATCH', '历史搭配与注册素材不一致。')
    _call(lambda: service.r.check_image(look))
    result = deepcopy(version)
    result['items'] = {
        slot: {'sku_id': sid, 'product_id': service.r.skus[sid]['product_id'],
               'name': service.r.products[service.r.skus[sid]['product_id']]['name'],
               'slot': slot, 'size': deepcopy(service.r.skus[sid]['size']),
               'price_fen': version['item_prices_fen'][sid], 'is_simulated': True}
        for slot, sid in version['items'].items()
    }
    result.update(image_url='/api/v1/outfits/assets/' + look['look_id'],
                  image_sha256=look['image_sha256'], look_asset_version=look['look_asset_version'],
                  model_asset_version=look['model_asset_version'], model_identity_id=look['model_identity_id'],
                  pose_id=look['pose_id'], background_id=look['background_id'], view=look['view'],
                  origin=deepcopy(look['origin']), is_simulated=True, rights_confirmed=True,
                  acceptance_status='accepted_by_user', image_kind='fixed_model_complete_outfit',
                  disclaimer='AI搭配示意图，不代表用户本人实际试穿或尺码效果',
                  sku_ids=[version['items'][slot] for slot in ('top', 'bottom', 'shoes')])
    result['inventory_snapshot'] = _historical_inventory_snapshot(
        service, version['resources']['inventory_snapshot_id'])
    from app.services import product_image_assets
    display = product_image_assets.display_refs(version, service.r)
    result['product_image_display'] = display
    for slot, item in result['items'].items():
        ref = display['image_refs'].get(slot)
        item['image_use_ref'] = ref
        item['image_url'] = ref['image_url'] if ref else None
    return result


def _cart_id(row, entry, index):
    if entry.get('cart_action_id'):
        return entry['cart_action_id']
    # The request that appended the cart entry is present in the same atomic M2
    # cache commit. Derive its stable ID without adding another write transaction.
    for _, result in row.get('cache', {}).values():
        if (len(result.get('cart', [])) == index + 1 and result.get('cart', [])[-1:] == [entry]
                and result.get('decision', {}).get('action') == entry):
            return 'cart-' + result['decision']['request_id']
    return 'cart-' + hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:32]


def _cart_items(service, row):
    items = []
    versions = {v['look_version_id']: v for v in row['history']}
    for index, entry in enumerate(row['cart']):
        version = versions.get(entry.get('target_look_version_id'))
        for sid in entry.get('sku_ids', []):
            sku = service.r.skus[sid]
            price = entry.get('unit_price_fen')
            if price is None:
                price = (version or {}).get('item_prices_fen', {}).get(sid)
            _require(price is not None, 'CART_PRICE_NOT_RECORDED', '这次加购缺少当时价格，不能按当前价格补造。')
            quantity = entry.get('quantity', 1)
            items.append({'cart_action_id': _cart_id(row, entry, index), 'sku_id': sid,
                          'product_id': sku['product_id'], 'name': service.r.products[sku['product_id']]['name'],
                          'slot': sku['slot'], 'size': deepcopy(sku['size']), 'quantity': quantity,
                          'unit_price_fen': price, 'line_price_fen': price * quantity,
                          'look_version_id': entry.get('target_look_version_id'),
                          'resources': deepcopy(entry['resources']), 'is_simulated': True})
    return items


def _view(service, sid):
    view = _call(lambda: service.view(sid))
    row = _call(lambda: service._row(sid))
    view['session_id'] = sid
    view['contract_version'] = '0.1.0'
    view['history'] = [_outfit(service, version) for version in view['history']]
    view['cart_items'] = _cart_items(service, row)
    view['is_simulated'] = True
    if 'profile_field_sources' in view['state']:
        view['profile_field_sources'] = deepcopy(view['state']['profile_field_sources'])
    return view


def create_session(demo_profile=False):
    _require(type(demo_profile) is bool)
    service = get_service()
    created = _call(lambda: service.create(demo_profile))
    return _view(service, created['state']['session_id'])


def catalog():
    """The fixed service's registered catalog, separate from the P browse catalog."""
    service = get_service()
    resources = _call(service.resources)
    products = [deepcopy(product) for product in resources.products.values() if product['active']]
    active_ids = {product['product_id'] for product in products}
    for product in products:
        from app.services import product_image_assets
        ref = product_image_assets.current_ref(resources, product['product_id'])
        product['image_use_ref'] = ref
        product['image_url'] = ref['image_url'] if ref else None
    skus = [deepcopy(sku) for sku in resources.skus.values() if sku['product_id'] in active_ids]
    accepted_looks = []
    for look in resources.looks.values():
        if not look['active']:
            continue
        _call(lambda look=look: resources.check_image(look))
        accepted = deepcopy(look)
        accepted.update(image_url='/api/v1/outfits/assets/' + look['look_id'],
                        sku_ids=[look['items'][slot] for slot in ('top', 'bottom', 'shoes')],
                        acceptance_status='accepted_by_user')
        accepted_looks.append(accepted)
    frozen = _historical_inventory_snapshot(service, resources.inventory['inventory_snapshot_id'])
    return {'contract_version': '0.1.0', 'is_simulated': True,
            'products': products, 'skus': skus, 'inventory_snapshot': deepcopy(resources.inventory),
            'inventory_snapshot_sha256': frozen['sha256'], 'versions': deepcopy(resources.binding),
            'accepted_looks': accepted_looks}


def session_view(session_id):
    service = get_service()
    return _view(service, _resolve_session_id(service, session_id))


def get_version(session_id, look_version_id):
    service = get_service()
    sid = _resolve_session_id(service, session_id)
    try:
        row = _call(lambda: service.view(sid))
    except FixedStylingError as error:
        if error.code == 'SESSION_NOT_FOUND':
            return None
        raise
    version = next((v for v in row['history'] if v['look_version_id'] == look_version_id), None)
    return _outfit(service, version) if version else None


def _profile_context(raw):
    state = raw['state']
    sizes = state.get('profile', {}).get('usual_sizes', {})
    conditions = state.get('context', {})
    fields = ['scene', 'budget_max_fen', 'usual_sizes.top', 'usual_sizes.bottom', 'usual_sizes.shoes']
    known = {'scene': conditions.get('scene'), 'budget_max_fen': conditions.get('budget_max_fen')}
    known.update({'usual_sizes.' + slot: sizes.get(slot, {}).get('value') for slot in ('top', 'bottom', 'shoes')})
    missing = [field for field in fields if known[field] is None]
    sources = {field: source for field, source in state.get('profile_field_sources', {}).items()
               if field in fields and known[field] is not None}
    clarification = raw['decision'].get('clarification')
    if clarification is not None:
        field = clarification['field']
        target = {'top_size': 'usual_sizes.top', 'bottom_size': 'usual_sizes.bottom',
                  'shoes_size': 'usual_sizes.shoes'}.get(field, field)
        next_field = (next((v for v in missing if v.startswith('usual_sizes.')), None)
                      if field == 'usual_sizes' else target if target in missing else None)
        clarification = {'field': field, 'next_field': next_field, 'question': clarification['question']}
    return {'field_sources': sources, 'missing_fields': missing, 'clarification': clarification}


def _result(service, sid, raw, profile_use=None):
    result = deepcopy(raw)
    result.pop('profile_effective', None)
    if profile_use is not None:
        result['profile_context'] = _profile_context(raw)
    result['session_id'] = sid
    status = raw['decision']['status']
    result['outcome'] = {'recommendation': 'complete_outfit', 'scope_redirect': 'refusal'}.get(status, status)
    result['history'] = [_outfit(service, version) for version in raw['history']]
    version = raw.get('recommendation', {}).get('look_version') or raw['decision'].get('recommendation', {}).get('look_version')
    if version:
        result['outfit'] = _outfit(service, version)
    elif raw['decision'].get('action', {}).get('operation') == 'view_history':
        target = raw['decision']['action'].get('target_look_version_id')
        version = next((v for v in raw['history'] if v['look_version_id'] == target), None)
        result['outfit'] = _outfit(service, version) if version else None
    else:
        result['outfit'] = None
    result['is_simulated'] = True
    # Use the cached cart state at the moment of this result, not today's cart.
    result['cart_items'] = _cart_items(service, {**service.sessions[sid], 'cart': raw['cart'], 'history': raw['history']})
    if result['outfit']:
        result['response']['image_url'] = result['outfit']['image_url']
    return result


def _record_profile(result, profile_use):
    if profile_use is not None:
        from app.services import profile_snapshots
        profile_snapshots.record_effective(profile_use['snapshot_id'], result['profile_effective'])


def _freeze_new_product_displays(service, previous_ids, result):
    if os.getenv('STYLING_PRODUCT_IMAGE_PREVIEW', '0') != '1':
        return
    from app.services import product_image_assets
    for version in result.get('history', []):
        if version['look_version_id'] in previous_ids:
            continue
        try:
            product_image_assets.freeze_display(version, service.r)
        except (product_image_assets.ProductImageAssetError, OSError):
            # The complete Look is already committed. Optional image registration
            # cannot turn it into a failed recommendation or rewrite its history.
            logging.getLogger(__name__).warning('Optional product image display unavailable')


def turn(session_id, body, *, profile_use=None):
    service = get_service()
    sid = _resolve_session_id(service, session_id)
    utterance = body.get('user_utterance') if isinstance(body, dict) else None
    if isinstance(utterance, str) and re.search(r'(?<![A-Za-z0-9])P[0-9]{3}(?![A-Za-z0-9])', utterance):
        raise FixedStylingError(
            'CATALOG_REFERENCE_UNSUPPORTED',
            '你引用的是浏览目录中的P编号商品；当前固定搭配服务使用M1V2六款商品，两个目录不同。'
            '请使用固定搭配商品编号或直接描述穿搭需求，不会把P商品换成另一款商品。')
    with _session_lock(service, sid):
        previous_ids = {v['look_version_id'] for v in _call(lambda: service._row(sid))['history']}
        result = _call(lambda: service.turn(sid, deepcopy(body), profile_use=profile_use))
        _freeze_new_product_displays(service, previous_ids, result)
        _record_profile(result, profile_use)
        if result.get('metrics', {}).get('mode') == 'live_model':
            service.store.set_value('fixed_live_model_verified', True)
        return _result(service, sid, result, profile_use)


def _action_body(body):
    allowed = {'action_id', 'operation', 'expected_state_revision', 'expected_conversation_revision',
               'target_look_version_id', 'sku_id', 'quantity', 'cart_size', 'target_cart_action_id',
               'profile_binding', 'request_conditions'}
    _require(type(body) is dict and not set(body) - allowed)
    _require(type(body.get('action_id')) is str and bool(re.fullmatch(r'[A-Za-z0-9_-]{1,100}', body['action_id'])))
    _require(type(body.get('expected_state_revision')) is int and body['expected_state_revision'] >= 0)
    _require(type(body.get('expected_conversation_revision')) is int and body['expected_conversation_revision'] >= 0)
    _require(body.get('operation') in {'view_history', 'restore_history', 'add_bundle_to_cart',
                                      'add_item_to_cart', 'remove_item_from_cart'})
    common = {'action_id', 'operation', 'expected_state_revision', 'expected_conversation_revision'}
    fields = {'view_history': {'target_look_version_id'}, 'restore_history': {'target_look_version_id', 'profile_binding', 'request_conditions'},
              'add_bundle_to_cart': {'target_look_version_id'},
              'add_item_to_cart': {'sku_id', 'quantity', 'cart_size'},
              'remove_item_from_cart': {'sku_id', 'target_cart_action_id'}}
    _require(set(body) <= common | fields[body['operation']])
    return body


def _remove(service, sid, body):
    from m2.core import json_hash, now, uid
    digest = json_hash(body)
    key = 'fixed-action-' + body['action_id']
    with service.lock:
        row = _call(lambda: service._row(sid))
        if key in row['cache']:
            old_digest, old_result = row['cache'][key]
            _require(old_digest == digest, 'IDEMPOTENCY_CONFLICT', '此动作编号已用于不同内容。')
            return deepcopy(old_result)
        _require(row['state']['state_revision'] == body['expected_state_revision'] and
                 row['conversation_revision'] == body['expected_conversation_revision'],
                 'STATE_REVISION_CONFLICT', '会话已变化，请重新读取后再取消。')
        sid_to_remove = body.get('sku_id')
        _require(type(sid_to_remove) is str and sid_to_remove in service.r.skus,
                 'REFERENCE_NOT_FOUND', '商品SKU未登记。')
        target = body.get('target_cart_action_id')
        if target is not None:
            _require(type(target) is str and 0 < len(target) <= 160)
        committed = deepcopy(row)
        remaining, removed = [], []
        for index, entry in enumerate(row['cart']):
            identity = _cart_id(row, entry, index)
            modified = deepcopy(entry)
            modified['cart_action_id'] = identity
            if sid_to_remove in entry.get('sku_ids', []) and (target is None or target == identity):
                removed.append({'cart_action_id': identity, 'sku_id': sid_to_remove, 'quantity': entry.get('quantity', 1)})
                modified['sku_ids'] = [s for s in entry['sku_ids'] if s != sid_to_remove]
                modified['item_count'] = len(modified['sku_ids']) * entry.get('quantity', 1)
                prices = {item['sku_id']: item['line_price_fen'] for item in _cart_items(service, {**row, 'cart': [entry]})}
                modified['cart_value_fen'] = sum(prices[s] for s in modified['sku_ids'])
            if modified.get('sku_ids'):
                remaining.append(modified)
        _require(bool(removed), 'CART_ITEM_NOT_FOUND', '当前模拟购物袋没有这项加购。')
        at = now()
        event = {'contract_version': '0.1.0', 'event_id': uid('event'), 'event_type': 'cart_item_removed',
                 'occurred_at': at, 'tenant_id': row['state']['tenant_id'], 'session_id': sid,
                 'subject_id': row['state']['subject_id'], 'turn_id': body['action_id'],
                 'decision_id': uid('decision'), 'look_version_id': row['state']['current_look_version_id'],
                 'is_simulated_session': True, 'payload': {'action_id': body['action_id'], 'removed': removed,
                                                          'is_simulated': True, 'resources': deepcopy(service.r.binding)}}
        committed['cart'] = remaining
        committed['events'].append(event)
        committed['conversation_revision'] += 1
        raw = {'decision': {'status': 'action_completed', 'request_id': body['action_id'],
                            'action': {'operation': 'remove_item_from_cart', 'removed': removed}},
               'response': {'text': '已取消这项模拟加购，未生成真实订单。'},
               'state': deepcopy(committed['state']), 'history': deepcopy(committed['history']),
               'cart': deepcopy(remaining), 'events': [event], 'conversation_revision': committed['conversation_revision'],
               'metrics': {'mode': 'deterministic_action', 'api_calls': 0, 'cost': 0}}
        committed['cache'][key] = (digest, deepcopy(raw))
        service.store.save(committed, expected=row['conversation_revision'])
        service.sessions[sid] = committed
        return raw


def _action(service, sid, body, profile_use=None):
    body = deepcopy(_action_body(body))
    if body['operation'] == 'remove_item_from_cart':
        return _result(service, sid, _remove(service, sid, body))
    operation = body['operation']
    data = {'operation': operation}
    target = body.get('target_look_version_id')
    if operation in {'view_history', 'restore_history'}:
        _require(type(target) is str and 0 < len(target) < 150)
        data['target_look_version_id'] = target
    elif operation == 'add_bundle_to_cart':
        # M2 adds the current version only; never silently replace an explicit
        # historical target with the current outfit.
        _require(type(target) is str and 0 < len(target) < 150)
        data['target_look_version_id'] = target
    else:
        sku = body.get('sku_id')
        _require(type(sku) is str and sku in service.r.skus, 'REFERENCE_NOT_FOUND', '商品SKU未登记。')
        data.update(inquiry={'topic': 'purchase', 'reference': 'catalog', 'sku_id': sku, 'whole_look': False},
                    quantity=body.get('quantity', 1), accepted=False)
        if body.get('cart_size') is not None:
            data['cart_size'] = body['cart_size']
    turn_body = {'contract_version': '0.1.0', 'request_id': body['action_id'],
                 'idempotency_key': 'fixed-action-' + body['action_id'], 'turn_id': body['action_id'],
                 'expected_state_revision': body['expected_state_revision'],
                 'expected_conversation_revision': body['expected_conversation_revision'], 'action': data}
    row = _call(lambda: service._row(sid))
    cached = turn_body['idempotency_key'] in row['cache']
    if operation == 'add_bundle_to_cart' and not cached:
        current = row['state']['current_look_version_id']
        _require(target == current and target is not None, 'REFERENCE_NOT_FOUND', '整套加购必须明确指向当前版本。')
    raw = _call(lambda: service.turn(sid, turn_body, profile_use=profile_use))
    _freeze_new_product_displays(service, {v['look_version_id'] for v in row['history']}, raw)
    _record_profile(raw, profile_use)
    return _result(service, sid, raw, profile_use)


def action(session_id, body, *, profile_owner=None, profile_authorization=None):
    _action_body(body)
    service = get_service()
    sid = _resolve_session_id(service, session_id)
    with _session_lock(service, sid):
        use = None
        binding = body.get('profile_binding')
        if body['operation'] == 'restore_history' and binding is None and requires_profile_binding(session_id):
            raise FixedStylingError('PROFILE_BINDING_REQUIRED', '本次恢复需要先准备资料快照。')
        if 'request_conditions' in body and binding is None:
            raise FixedStylingError('PROFILE_BINDING_REQUIRED', '恢复条件需要先准备资料快照。')
        if binding is not None:
            from app.services import profile_snapshots
            from app.schemas.profile_snapshot import RequestConditions
            if 'request_conditions' in body:
                RequestConditions.model_validate(body['request_conditions'])
            with profile_snapshots.SessionLocal() as db:
                profile_snapshots._lock(db)
                profile_snapshots.accept_binding(db, profile_owner, session_id, body['action_id'],
                                                 binding, body, expected_operation='restore',
                                                 authorization=profile_authorization)
                db.commit()
            use = profile_snapshots.get_use(profile_owner, session_id, body['action_id'], binding)
        return _action(service, sid, body, use)


def process_chat(session_id, request_id, text, *, profile_use=None):
    _require(type(session_id) is str and 0 < len(session_id) <= 64)
    _require(type(request_id) is str and 0 < len(request_id) <= 64)
    _require(type(text) is str and 0 < len(text.strip()) <= 3000)
    service = get_service()
    text_digest = hashlib.sha256(text.encode()).hexdigest()
    # Serialize the short bridge creation only. The model runs outside this lock.
    with service.lock:
        with service.store.lock:
            existing = service.store.db.execute('SELECT product_session_id,text_digest,body_json FROM fixed_chat_bridges '
                                                'WHERE request_id=?', (request_id,)).fetchone()
        if existing:
            _require(existing[:2] == (session_id, text_digest), 'IDEMPOTENCY_CONFLICT', '此请求编号已用于不同内容。')
            body = json.loads(existing[2])
            sid = _resolve_session_id(service, session_id)
        else:
            sid = _resolve_session_id(service, session_id)
            # A freshly created profile fixed session is already a server session.
            if sid == session_id and service.store.get(sid) is None:
                created = _call(lambda: service.create())
                sid = created['state']['session_id']
                with service.store.lock, service.store.db:
                    service.store.db.execute('INSERT INTO fixed_product_sessions VALUES(?,?)', (session_id, sid))
            view = _call(lambda: service.view(sid))
            body = {'contract_version': '0.1.0', 'request_id': request_id, 'idempotency_key': 'chat-' + request_id,
                    'turn_id': request_id, 'expected_state_revision': view['state']['state_revision'],
                    'expected_conversation_revision': view['conversation_revision'], 'user_utterance': text}
            with service.store.lock, service.store.db:
                service.store.db.execute('INSERT INTO fixed_chat_bridges VALUES(?,?,?,?)',
                                         (request_id, session_id, text_digest, json.dumps(body, ensure_ascii=False)))
    result = turn(sid, body, profile_use=profile_use)
    outfit = result['outfit']
    payload = {'session_id': session_id, 'request_id': request_id, 'fixed_session_id': sid,
            'content': result['response']['text'], 'signal_id': None,
            'product_ids': [item['product_id'] for item in outfit['items'].values()] if outfit else [],
            'outcome': result['outcome'], 'outfit': outfit, 'metrics': result['metrics'],
            'state_revision': result['state']['state_revision'],
            'conversation_revision': result['conversation_revision']}
    if profile_use is not None:
        payload['profile_context'] = result['profile_context']
    return payload


def asset_bytes(look_id):
    service = get_service()
    look = service.r.looks.get(look_id)
    _require(look is not None and look['active'], 'NOT_FOUND', '仅提供已登记并接受的固定搭配图。')
    _call(lambda: service.r.check_image(look))
    return (_ROOT / look['image_url'].lstrip('/')).read_bytes()
