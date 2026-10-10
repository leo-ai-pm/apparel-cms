"""Deterministic P0 state transitions. No natural-language keyword parser."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
SLOTS = ['top', 'bottom', 'shoes']
LABELS = {'top': '上衣', 'bottom': '下装', 'shoes': '鞋子'}
DISCLAIMER = 'AI 搭配示意图，不代表用户本人实际试穿或尺码效果'
VERSION = '0.1.0'


def now():
    return datetime.now(timezone.utc).isoformat()


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class Fault(Exception):
    def __init__(self, code, message='请求未完成，请检查条件后重试。'):
        self.code, self.message = code, message
        super().__init__(code)


def require(ok, code='TYPE_INVALID', message='输入格式不正确，请重新表达。'):
    if not ok:
        raise Fault(code, message)


def uid(prefix):
    return prefix + '-' + uuid4().hex


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def size(slot, value):
    return {'system': 'cn_shoe' if slot == 'shoes' else 'clothing_alpha', 'value': value}


def validate_size(slot, value):
    require(type(value) is dict and set(value) == {'system', 'value'}, 'SIZE_SYSTEM_MISMATCH')
    require(value['system'] == size(slot, '')['system'], 'SIZE_SYSTEM_MISMATCH')
    require(value['value'] in (['35','36','37','38','39','40'] if slot == 'shoes' else ['S','M','L','XL']), 'SIZE_SYSTEM_MISMATCH')


class Resources:
    def __init__(self, fixture, display=False, preview=False):
        self.data = deepcopy(fixture)
        self.binding = self.data['resource_binding']
        self.catalog = self.data['catalog']
        self.inventory = self.data['inventory_snapshot']
        self.skus = self.index(self.catalog['skus'], 'sku_id')
        self.products = self.index(self.catalog['products'], 'product_id')
        self.stock = self.index(self.inventory['items'], 'sku_id')
        self.looks = self.index(self.data['look_assets'], 'look_id')
        self.vocab = self.data['attribute_vocabulary']
        self.rules = self.data.get('styling_rules', [])
        self.display = display
        self.preview = preview
        self.validate()

    def clone(self, fixture):
        return Resources(fixture, display=self.display, preview=self.preview)

    @staticmethod
    def index(rows, key):
        result = {x[key]: x for x in rows}
        require(len(result) == len(rows), 'REFERENCE_NOT_FOUND')
        return result

    def validate(self):
        require(self.data['contract_version'] == VERSION, 'CONTRACT_VERSION_UNSUPPORTED')
        tenant = self.data['tenant_id']
        require(self.catalog['catalog_version'] == self.binding['catalog_version'], 'LOOK_MAPPING_MISMATCH')
        require(self.inventory['inventory_snapshot_id'] == self.binding['inventory_snapshot_id'], 'LOOK_MAPPING_MISMATCH')
        require(set(self.stock) == set(self.skus), 'INVENTORY_ITEM_MISSING')
        require(self.vocab['attribute_vocabulary_version'] == self.binding['attribute_vocabulary_version'], 'LOOK_MAPPING_MISMATCH')
        signatures, urls = set(), set()
        identities = set()
        for obj in [*self.products.values(), *self.skus.values(), *self.looks.values(), self.inventory]:
            require(obj['contract_version'] == VERSION, 'CONTRACT_VERSION_UNSUPPORTED')
            require(obj['tenant_id'] == tenant, 'TENANT_REFERENCE_MISMATCH')
            require(obj['catalog_version'] == self.binding['catalog_version'], 'LOOK_MAPPING_MISMATCH')
            origin = obj.get('origin', {})
            require(origin.get('rights_confirmed') is True and origin.get('is_simulated') is True and bool(origin.get('source_name')), 'PROVENANCE_MISSING_OR_UNCONFIRMED')
            require(origin.get('origin_type') in ['self_created','ai_generated','open_licensed','authorized'], 'ENUM_INVALID')
            if origin['origin_type'] in ['open_licensed','authorized']:
                require(bool(origin.get('source_ref')), 'PROVENANCE_MISSING_OR_UNCONFIRMED')
        for p in self.products.values():
            require(type(p['active']) is bool and p['slot'] in SLOTS, 'ENUM_INVALID')
        for s in self.skus.values():
            require(s['product_id'] in self.products, 'REFERENCE_NOT_FOUND')
            require(s['slot'] in SLOTS and self.products[s['product_id']]['slot'] == s['slot'], 'SKU_SLOT_MISMATCH')
            validate_size(s['slot'], s['size'])
            require(type(s['price_fen']) is int and s['price_fen'] >= 0, 'MONEY_INVALID')
            require(s['sale_status'] in ['sellable','not_sellable'], 'ENUM_INVALID')
            stock = self.stock[s['sku_id']]
            require(type(stock['available_qty']) is int and stock['available_qty'] >= 0 and type(stock['sellable']) is bool, 'TYPE_INVALID')
        for l in self.looks.values():
            require(set(l['items']) == set(SLOTS), 'LOOK_SLOT_INCOMPLETE')
            require(l['look_asset_version'] == self.binding['look_asset_version'], 'LOOK_MAPPING_MISMATCH')
            require(type(l['active']) is bool and l['view'] == 'front_full_body' and l['disclaimer_code'] == 'ai_styling_reference_not_fit', 'ENUM_INVALID')
            for slot, sku in l['items'].items():
                require(sku in self.skus and self.skus[sku]['slot'] == slot, 'SKU_SLOT_MISMATCH')
            sig = tuple(l['items'][s] for s in SLOTS)
            require(sig not in signatures and l['image_url'] not in urls, 'LOOK_MAPPING_MISMATCH')
            signatures.add(sig); urls.add(l['image_url'])
            if l['active']:
                identities.add(tuple(l[k] for k in ['model_identity_id','model_asset_version','pose_id','background_id','view']))
            if self.display:
                roots=('/data/m1_v2/assets/','/data/m3_draft/assets/') if self.preview else ('/data/m1_v2/assets/',)
                require(l['image_url'].startswith(roots), 'LOOK_MAPPING_MISMATCH')
                self.check_image(l)
        require(len(identities) <= 1, 'LOOK_MAPPING_MISMATCH')
        require(instant(self.inventory['captured_at']) < instant(self.inventory['valid_until']), 'INVENTORY_SNAPSHOT_STALE')
        for rule in self.rules:
            require(rule['rule_set_version'] == self.binding['rule_set_version'], 'LOOK_MAPPING_MISMATCH')

    def check_image(self, look):
        path = (ROOT / look['image_url'].lstrip('/')).resolve()
        parents={(ROOT / 'data/m1_v2/assets').resolve()}
        if self.preview:parents.add((ROOT / 'data/m3_draft/assets').resolve())
        require(path.parent in parents, 'LOOK_MAPPING_MISMATCH')
        require(path.is_file(), 'LOOK_MAPPING_MISMATCH', '搭配图片暂时不可读取，请稍后重试。')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == look['image_sha256'], 'LOOK_MAPPING_MISMATCH')

    def fresh(self, at):
        require(instant(self.inventory['captured_at']) <= instant(at) < instant(self.inventory['valid_until']), 'INVENTORY_SNAPSHOT_STALE', '模拟库存快照已过期，请重新启动演示以生成并校验新快照。')

    def tokens(self, sku):
        s = self.skus[sku]
        return self.normalize(set(s['attribute_tokens']) | set(self.products[s['product_id']]['attribute_tokens']) | {s['color_token']})

    def normalize(self, tokens):
        aliases = {'style:commute':'scene:work_commute', 'style:comfortable':'comfort:comfortable', **self.vocab.get('aliases', {})}
        return {aliases.get(t,t) for t in tokens}

    def hit(self, look, token, slots=SLOTS):
        token = next(iter(self.normalize([token])))
        expanded = self.vocab.get('expansions', {}).get(token, ['color:white','color:ivory','color:beige','color:pink'] if token == 'color:light' else [token])
        return sum(bool(self.tokens(look['items'][s]) & set(expanded)) for s in slots)

    def total(self, look):
        return sum(self.skus[x]['price_fen'] for x in look['items'].values())


def demo_resources(at=None, save=True):
    at = at or now()
    d = ROOT / 'data/m1_v2'
    read = lambda name: json.loads((d / (name + '.json')).read_text())
    manifest = read('manifest')
    approval = json.loads((d / 'provenance/user_visual_acceptance.json').read_text())
    looks = read('look_assets')
    require(manifest['acceptance_status'] == 'accepted_by_user' and approval['asset_version'] == manifest['look_asset_version'], 'PROVENANCE_MISSING_OR_UNCONFIRMED')
    require({l['look_id']: l['image_sha256'] for l in looks if l['active']} == approval['look_image_sha256'], 'LOOK_MAPPING_MISMATCH')
    inv = read('inventory')
    inv.update(inventory_snapshot_id=uid('inv-m2-sim'), captured_at=at, valid_until=(instant(at)+timedelta(hours=12)).isoformat())
    inv['origin'] = dict(inv['origin'], source_ref='m2_fresh_simulated_snapshot', source_name='M2 独立模拟库存快照')
    binding = dict(manifest['resource_binding'], inventory_snapshot_id=inv['inventory_snapshot_id'])
    fixture = dict(contract_version=VERSION, tenant_id=manifest['tenant_id'], resource_binding=binding,
                   catalog=read('catalog'), inventory_snapshot=inv, look_assets=looks,
                   attribute_vocabulary=read('attribute_vocabulary'), styling_rules=read('styling_rules'))
    r = Resources(fixture, display=True)
    r.fresh(at)
    if save:
        out = ROOT / 'reports/m2/runtime'; out.mkdir(parents=True, exist_ok=True)
        (out / (inv['inventory_snapshot_id'] + '.json')).write_text(json.dumps({'snapshot': inv, 'resources':binding, 'validated_at':at}, ensure_ascii=False, indent=2))
    return r


def new_state(tenant, demo_profile=False, at=None):
    at = at or now()
    s = dict(contract_version=VERSION, tenant_id=tenant, session_id=uid('session'), subject_id=uid('subject'),
             state_revision=0, locale='zh-CN', profile={'usual_sizes':{}}, context={}, constraints=[],
             rejected_sku_ids=[], rejected_attribute_tokens=[], current_look_version_id=None,
             look_version_ids=[], pending_clarification=None, created_at=at, updated_at=at,
             expires_at=(instant(at)+timedelta(hours=24)).isoformat())
    if demo_profile:
        for slot, value in zip(SLOTS, ['M','M','38']):
            v = size(slot,value); s['profile']['usual_sizes'][slot] = v
            s['constraints'].append(constraint('size_exact',v,slot,'session','profile',at,source='user_profile'))
    return s


def constraint(kind, value, slot, scope, turn, at, strength=None, source='explicit_user'):
    c = dict(constraint_id=uid('c'), kind=kind, value=value, strength=strength or ('soft' if kind in ['scene','prefer_attribute'] else 'hard'),
             source=source, scope=scope, status='active', operator={'budget_max':'lte','size_exact':'eq','scene':'contains','keep_sku':'eq','forbid_sku':'eq','forbid_attribute':'not_contains','prefer_attribute':'contains'}[kind],
             priority=300 if kind in ['scene','prefer_attribute'] else 900, created_turn_id=turn, created_at=at)
    if slot: c['target_slot'] = slot
    if scope == 'next_recommendation': c['uses_remaining'] = 1
    return c


def validate_intent(raw, r):
    require(type(raw) is dict)
    defaults = dict(operation='initial_recommendation', replace_slots=[], release_slots=[], keep_directives=[], carry_forward_unmentioned=False,
                    preference_deltas=[], updates={}, rejections=[], target_look_version_id=None, ambiguous=False, scope_reason=None, accepted=False, relaxation_response=None, confirmation_response=None,
                    query_slots=[], query_target='products', query_attributes=[], inquiry=None, required_change_slots=[], size_correction_slots=[],quantity=1,cart_size=None,scope_reference=None,required_attributes=[])
    require(set(raw) <= set(defaults), 'ENUM_INVALID')
    i = deepcopy(defaults); i.update(deepcopy(raw))
    require(i['operation'] in ['initial_recommendation','modify_current','view_history','restore_history','add_bundle_to_cart','add_item_to_cart','scope_redirect','browse_catalog','consult','cancel_pending'], 'ENUM_INVALID')
    require(i['scope_reference'] in [None,'recent_topic','previous_request'] and (i['scope_reference'] is None or i['operation']=='modify_current'),'ENUM_INVALID')
    require(type(i['required_attributes']) is list and len(i['required_attributes'])<=20,'ENUM_INVALID')
    for attribute in i['required_attributes']:
        require(type(attribute) is dict and set(attribute)=={'slot','attribute_token'} and attribute['slot'] in SLOTS and type(attribute['attribute_token']) is str and attribute['attribute_token'] in r.vocab['tokens'] and not attribute['attribute_token'].startswith('sku:'),'ENUM_INVALID')
    require(len({(attribute['slot'],attribute['attribute_token']) for attribute in i['required_attributes']})==len(i['required_attributes']),'ENUM_INVALID')
    if i['operation'] not in ['initial_recommendation','modify_current','restore_history']:i['required_attributes']=[]
    if i['operation'] in ['consult','add_item_to_cart']:
        from .consultation import validate_inquiry
        i['inquiry']=validate_inquiry(i['inquiry'],r)
    else:require(i['inquiry'] is None,'ENUM_INVALID')
    require(type(i['quantity']) is int and 1<=i['quantity']<=10,'TYPE_INVALID')
    if i['operation']=='add_item_to_cart':
        require(i['inquiry']['topic']=='purchase' and not i['inquiry']['whole_look'] and i['inquiry']['reference']!='app','ENUM_INVALID')
        if i['cart_size'] is not None:
            q=i['inquiry'];slot=q.get('slot') or (r.skus[q['sku_id']]['slot'] if q.get('sku_id') else r.products[q['product_id']]['slot'] if q.get('product_id') else None)
            if slot:validate_size(slot,i['cart_size'])
            else:
                require(type(i['cart_size']) is dict,'SIZE_SYSTEM_MISMATCH')
                validate_size('shoes' if i['cart_size'].get('system')=='cn_shoe' else 'top',i['cart_size'])
    else:require(i['cart_size'] is None and i['quantity']==1,'ENUM_INVALID')
    require(i['query_target'] in ['products','looks'], 'ENUM_INVALID')
    require(type(i['query_attributes']) is list and len(i['query_attributes']) <= 20 and all(type(t) is str and t in r.vocab['tokens'] and not t.startswith('sku:') for t in i['query_attributes']), 'ENUM_INVALID')
    require(len(i['query_attributes']) == len(set(i['query_attributes'])), 'ENUM_INVALID')
    for field in ['replace_slots','release_slots','query_slots','required_change_slots','size_correction_slots']:
        require(type(i[field]) is list and all(s in SLOTS for s in i[field]) and len(i[field]) == len(set(i[field])), 'ENUM_INVALID')
        i[field] = [s for s in SLOTS if s in i[field]]
    for field in ['carry_forward_unmentioned','ambiguous','accepted']: require(type(i[field]) is bool)
    require(i['relaxation_response'] in [None,'accept','decline'], 'ENUM_INVALID')
    require(i['confirmation_response'] in [None,'confirm','correct'], 'ENUM_INVALID')
    require(i['target_look_version_id'] is None or (type(i['target_look_version_id']) is str and 0 < len(i['target_look_version_id']) < 150))
    reasons = ['USER_PHOTO_TRY_ON','FIT_GUARANTEE','OUT_OF_SCOPE_DOMAIN','OUT_OF_SCOPE_AUDIENCE_OR_CATEGORY']
    require(i['scope_reason'] is None or i['scope_reason'] in reasons, 'ENUM_INVALID')
    if i['operation'] == 'scope_redirect': require(i['scope_reason'] in reasons, 'ENUM_INVALID')
    for f in ['keep_directives','preference_deltas','rejections']: require(type(i[f]) is list and len(i[f]) <= 30)
    for k in i['keep_directives']:
        require(type(k) is dict and set(k) == {'slot','scope'} and k['slot'] in SLOTS and k['scope'] in ['session','next_recommendation'], 'ENUM_INVALID')
    require(len({k['slot'] for k in i['keep_directives']}) == len(i['keep_directives']))
    for p in i['preference_deltas']:
        require(type(p) is dict and set(p) <= {'attribute_token','direction','slot'} and p.get('direction') in ['increase','decrease','add','remove'], 'ENUM_INVALID')
        require(p.get('attribute_token') in r.vocab['tokens'], 'ENUM_INVALID')
        require('slot' not in p or p['slot'] in SLOTS, 'ENUM_INVALID')
    for x in i['rejections']:
        require(type(x) is dict and set(x) <= {'kind','slot','value','action'} and x.get('kind') in ['forbid_sku','forbid_attribute'] and x.get('action') in ['add','remove'], 'ENUM_INVALID')
        require(x.get('slot') in SLOTS or (x['kind'] == 'forbid_attribute' and 'slot' not in x), 'ENUM_INVALID')
        require(x.get('value') in (r.skus if x['kind'] == 'forbid_sku' else r.vocab['tokens']), 'REFERENCE_NOT_FOUND')
        if x['kind'] == 'forbid_sku': require(r.skus[x['value']]['slot'] == x['slot'], 'SKU_SLOT_MISMATCH')
    u = i['updates']; require(type(u) is dict and set(u) <= {'budget_max_fen','scene','scene_hard','usual_sizes','height_cm','weight_kg'})
    if 'budget_max_fen' in u: require(type(u['budget_max_fen']) is int and u['budget_max_fen'] >= 0, 'MONEY_INVALID')
    if 'scene' in u: require(u['scene'] in r.vocab['tokens'] and u['scene'].startswith('scene:'), 'ENUM_INVALID')
    if 'scene_hard' in u: require(type(u['scene_hard']) is bool)
    if 'usual_sizes' in u:
        require(type(u['usual_sizes']) is dict and set(u['usual_sizes']) <= set(SLOTS))
        for slot,v in u['usual_sizes'].items(): validate_size(slot,v)
    for f,lo,hi in [('height_cm',50,250),('weight_kg',10,300)]:
        if f in u: require(type(u[f]) in [int,float] and lo <= u[f] <= hi)
    return i


def solve(r, state, intent, current, target=None):
    """Return eligible looks and per-candidate failures for an auditable no-match."""
    looks = [l for l in r.looks.values() if l['active'] and (target is None or (l['look_id'] == target['look_id'] and l['items'] == target['items'] and l['image_url'] == target['image_url']))]
    active = [c for c in state['constraints'] if c['status'] == 'active']
    diagnostics = []; good = []; hard_count = 0
    for l in looks:
        failures = []
        def fail(code, cid=None): failures.append((code,cid))
        for slot, sku in l['items'].items():
            s = r.skus[sku]
            if s['size'] != state['profile']['usual_sizes'].get(slot):
                cs = [c['constraint_id'] for c in active if c['kind']=='size_exact' and c.get('target_slot')==slot]
                fail('SIZE_CONFLICT', cs[0] if cs else None)
        if r.total(l) > state['context']['budget_max_fen']:
            cs = [c['constraint_id'] for c in active if c['kind']=='budget_max']
            fail('BUDGET_CONFLICT', cs[0] if cs else None)
        for c in active:
            if c['strength'] != 'hard': continue
            kind,v,slot = c['kind'],c['value'],c.get('target_slot')
            slots = [slot] if slot else SLOTS
            violated = ((kind=='keep_sku' and l['items'][slot]!=v) or
                        (kind=='forbid_sku' and v in [l['items'][x] for x in slots]) or
                        (kind=='forbid_attribute' and r.hit(l,v,slots)>0) or
                        (kind=='scene' and r.hit(l,v)==0) or
                        (kind=='budget_max' and r.total(l)>v) or
                        (kind=='size_exact' and r.skus[l['items'][slot]]['size']!=v))
            if violated: fail({'keep_sku':'KEEP_CONFLICT','forbid_sku':'FORBIDDEN_SKU_CONFLICT','forbid_attribute':'FORBIDDEN_ATTRIBUTE_CONFLICT','scene':'SCENE_CONFLICT','budget_max':'BUDGET_CONFLICT','size_exact':'SIZE_CONFLICT'}[kind],c['constraint_id'])
        for attribute in intent.get('required_attributes',[]):
            if not r.hit(l,attribute['attribute_token'],[attribute['slot']]):fail('REQUIRED_ATTRIBUTE_CONFLICT')
        if current and intent['operation']=='modify_current':
            repl = intent['replace_slots']
            if any(l['items'][slot]==current['items'][slot] for slot in intent.get('required_change_slots',[])):fail('NO_REPLACEMENT_LOOK')
            if intent['carry_forward_unmentioned']:
                if any((l['items'][s]==current['items'][s]) if s in repl else (l['items'][s]!=current['items'][s]) for s in SLOTS): fail('NO_REPLACEMENT_LOOK')
            elif l['items'] == current['items']: fail('NO_REPLACEMENT_LOOK')
            for p in intent['preference_deltas']:
                if p['direction'] not in ['increase','decrease']: continue
                slots = [p['slot']] if 'slot' in p else (repl or SLOTS)
                difference = r.hit(l,p['attribute_token'],slots)-r.hit(current,p['attribute_token'],slots)
                if (difference <= 0 if p['direction']=='increase' else difference >= 0): fail('NO_REPLACEMENT_LOOK')
        if not failures: hard_count += 1
        for sku in l['items'].values():
            s,stock = r.skus[sku],r.stock[sku]
            if s['sale_status']!='sellable' or not r.products[s['product_id']]['active'] or not stock['sellable'] or stock['available_qty'] < 1: fail('INVENTORY_CONFLICT')
        diagnostics.append((l, sorted(set(failures), key=lambda x:(x[0],x[1] or ''))))
        if not failures: good.append(l)
    def score(l):
        comparative = explicit = general = rules = 0
        for p in intent['preference_deltas']:
            h = r.hit(l,p['attribute_token'],[p['slot']] if 'slot' in p else intent['replace_slots'] or SLOTS)
            if p['direction'] in ['increase','decrease']: comparative += h * (-1 if p['direction']=='decrease' else 1)
            elif p['direction']=='add': explicit += h
        request_tokens = []
        for c in active:
            if c['kind'] in ['prefer_attribute','scene']:
                general += r.hit(l,c['value'],[c['target_slot']] if c.get('target_slot') else SLOTS)
                request_tokens.append(c['value'])
        request_tokens += [p['attribute_token'] for p in intent['preference_deltas'] if p['direction']!='remove']
        normalized = r.normalize(request_tokens)
        for rule in r.rules:
            if rule['active'] and set(rule['when_tokens'])<=normalized and not set(rule['exceptions'])&normalized:
                rules += rule['effect']['score_delta'] * r.hit(l,rule['effect']['target_token'])
        return (-comparative,-explicit,-general,-rules,l['look_id'])
    return sorted(good,key=score), diagnostics, {'initial':len(looks),'after_hard_constraints':hard_count,'after_inventory':len(good)}


RELAX = {'BUDGET_CONFLICT':('ask_user_to_raise_budget','预算不足以覆盖当前完整搭配，是否愿意提高预算上限？'),
         'SIZE_CONFLICT':('ask_user_to_change_size','当前完整搭配图暂未覆盖你提供的尺码。已记录的尺码与预算保持不变，可以先查询可售单品。'),
         'KEEP_CONFLICT':('ask_user_to_release_keep','保留条件下没有可替换的完整搭配，下次重搭是否可以不保留该商品？'),
         'FORBIDDEN_SKU_CONFLICT':('ask_user_to_allow_sku','当前排除项下没有完整搭配，是否愿意重新接受被排除的商品？'),
         'FORBIDDEN_ATTRIBUTE_CONFLICT':('ask_user_to_allow_attribute','当前排除属性下没有完整搭配，是否愿意重新接受该属性？'),
         'SCENE_CONFLICT':('ask_user_to_change_scene','没有满足指定场景的完整搭配，是否愿意调整场景要求？'),
         'REQUIRED_ATTRIBUTE_CONFLICT':('ask_user_to_retry_later','当前可售商品与搭配图没有满足这次明确属性要求的完整方案，不能替换成不符合要求的商品。'),
         'INVENTORY_CONFLICT':('ask_user_to_wait_for_stock','当前完整搭配有商品不可售，是否稍后再查看库存？'),
         'NO_REGISTERED_COMPLETE_LOOK':('ask_user_to_retry_later','当前没有已登记的完整搭配图，是否稍后再试？'),
         'NO_REPLACEMENT_LOOK':('ask_user_to_retry_later','当前没有符合这次换搭要求的新组合，是否换一种搭配要求？')}


def execute(r, state_before, versions_before, raw_intent, turn_id, request_id, at=None, pending_intent=None, dialog_context=None):
    at = at or now(); i = validate_intent(raw_intent,r)
    from .consultation import synchronize_view_focus
    dialog_context=synchronize_view_focus(r,state_before,versions_before,dialog_context)
    if i['operation'] in ['browse_catalog','consult','cancel_pending','add_item_to_cart']:
        # Browsing cannot accept a pending proposal or consume a recommendation intent.
        i.update(relaxation_response=None,confirmation_response=None,replace_slots=[],release_slots=[],keep_directives=[],accepted=i['accepted'] if i['operation']=='add_item_to_cart' else False,carry_forward_unmentioned=False,required_change_slots=[])
        if i['operation'] in ['consult','cancel_pending','add_item_to_cart']:i.update(updates={},preference_deltas=[],rejections=[],ambiguous=i['ambiguous'] if i['operation']=='add_item_to_cart' else False)
    proposal=None
    dialog=dialog_context or {}
    confirmed_sizes=deepcopy(dialog.get('confirmed_sizes'))
    confirmation=dialog.get('confirmation')
    # Preserve the meaning of an existing size-verification question, including older sessions.
    if not confirmation and not dialog.get('proposal') and (dialog.get('no_match') or {}).get('suggested_relaxation',{}).get('action')=='ask_user_to_change_size':
        confirmation={'field':'usual_sizes','values':deepcopy(state_before['profile']['usual_sizes'])}
    awaiting_sizes=bool(confirmation and confirmation.get('field')=='usual_sizes' and confirmation.get('values')==state_before['profile']['usual_sizes'] and i['operation'] in ['initial_recommendation','modify_current'])
    size_answer=i['confirmation_response'] if awaiting_sizes else None
    if awaiting_sizes and not size_answer and not dialog.get('proposal'):
        size_answer={'accept':'confirm','decline':'correct'}.get(i['relaxation_response'])
    size_confirmed=size_answer=='confirm' and not i['updates'].get('usual_sizes')
    size_correction_needed=size_answer=='correct' and not i['updates'].get('usual_sizes')
    if size_answer:
        i['relaxation_response']=None
        confirmed_sizes=deepcopy(state_before['profile']['usual_sizes']) if size_confirmed else None
    elif i['confirmation_response']:
        i['ambiguous']=True
    declined_budget=(dialog_context or {}).get('declined_budget_max_fen')
    declined=bool(i['relaxation_response']=='decline' and (dialog_context or {}).get('no_match'))
    if i['relaxation_response']=='accept':
        require(dialog_context and dialog_context.get('proposal'), 'REQUIRED_FIELD_MISSING', '请明确希望调整的预算、保留或排除条件。')
        explicit_updates=deepcopy(i['updates'])
        i.update(deepcopy(dialog_context['proposal']))
        i['updates']={**i.get('updates',{}),**explicit_updates}
    elif declined or size_answer:
        previous=dialog_context['no_match']
        if declined and 'BUDGET_CONFLICT' in previous['reason_codes']:
            declined_budget=state_before['context'].get('budget_max_fen')
        # Retry the understood request, never replay updates or consumed keeps.
        resumed=deepcopy(dialog_context.get('retry_intent',{'operation':'modify_current' if state_before['current_look_version_id'] else 'initial_recommendation'}))
        resumed['updates']=i['updates']
        for field in ['replace_slots','release_slots','keep_directives','preference_deltas','rejections','required_change_slots','size_correction_slots','required_attributes']:
            if i[field]:resumed[field]=i[field]
        if i['replace_slots']:resumed['carry_forward_unmentioned']=i['carry_forward_unmentioned']
        resumed.update(ambiguous=False,relaxation_response=None,confirmation_response=None)
        i=validate_intent(resumed,r)
    elif i['relaxation_response']=='decline':
        i['ambiguous']=True
    if pending_intent and i["operation"] in ["initial_recommendation","modify_current"] and i["updates"] and not any(i[k] for k in ["replace_slots","release_slots","keep_directives","rejections","preference_deltas","ambiguous","required_attributes"]):
        merged=deepcopy(pending_intent);merged["updates"]=i["updates"];merged["keep_directives"]=[]
        i=validate_intent(merged,r)
    from .dialogue import prepare_scope,record_dialogue,explain_no_match
    scope=prepare_scope(r,state_before,versions_before,i,dialog_context)
    i=scope['intent']
    state = deepcopy(state_before); versions = deepcopy(versions_before)
    require(instant(at)<instant(state['expires_at']), 'STATE_REVISION_CONFLICT', '会话已到期，请新建会话。')
    current = next((v for v in versions if v['look_version_id']==state['current_look_version_id']),None)
    comparison=scope['base_look'] or current
    decision_id = uid('decision'); events=[]; changed=[]; cart=[]
    transition = dict(revision_before=state['state_revision'],revision_after=state['state_revision'],activated_constraint_ids=[],consumed_constraint_ids=[],revoked_constraint_ids=[],new_current_look_version_id=state['current_look_version_id'],appended_look_version_id=None)
    interpretation = {k:deepcopy(i[k]) for k in ['operation','replace_slots','release_slots','keep_directives','carry_forward_unmentioned','preference_deltas']}
    if i['required_change_slots']:interpretation['required_change_slots']=deepcopy(i['required_change_slots'])
    if i['required_attributes']:interpretation['required_attributes']=deepcopy(i['required_attributes'])
    if i['scope_reference']:interpretation['scope_reference']=i['scope_reference']
    if comparison and current and comparison['look_version_id']!=current['look_version_id']:interpretation['comparison_base_look_version_id']=comparison['look_version_id']
    interpretation['understanding_text']=''
    result = dict(contract_version=VERSION,decision_id=decision_id,request_id=request_id,status='',resources=deepcopy(r.binding),interpretation=interpretation,applied_constraint_ids=[],created_at=at,state_transition=transition)
    def event(kind,payload,lv=None):
        events.append(dict(contract_version=VERSION,event_id=uid('event'),event_type=kind,occurred_at=at,
                           tenant_id=state['tenant_id'],session_id=state['session_id'],subject_id=state['subject_id'],turn_id=turn_id,decision_id=decision_id,
                           look_version_id=lv,is_simulated_session=True,payload=deepcopy(payload)))
    def change(c,action):
        c['status']={'activated':'active','revoked':'revoked','consumed':'consumed'}[action]
        if action=='revoked': c['revoked_by_turn_id']=turn_id
        if action=='consumed': c['consumed_by_decision_id']=decision_id
        transition[action+'_constraint_ids'].append(c['constraint_id']); changed.append((c,action))
    def add(kind,value,slot=None,scope='session',strength=None):
        existing = [c for c in state['constraints'] if c['status']=='active' and c['kind']==kind and c.get('target_slot')==slot]
        for c in existing:
            if c['value']==value and c['scope']==scope and (strength is None or c['strength']==strength): return c
        if kind in ['budget_max','size_exact','scene','keep_sku']:
            for c in existing: change(c,'revoked')
        c=constraint(kind,value,slot,scope,turn_id,at,strength);state['constraints'].append(c);change(c,'activated');return c
    categories=['operation']
    u=i['updates']
    for key,cat in [('budget_max_fen','budget'),('scene','scene'),('usual_sizes','size')]:
        if key in u: categories.append(cat)
    if i['preference_deltas'] or i['rejections']: categories.append('preference')
    event('turn_submitted',{'input_categories':sorted(set(categories))})
    op=i['operation']; target=None
    if op in ['view_history','restore_history']:
        target=next((v for v in versions if v['look_version_id']==i['target_look_version_id']),None)
        if op=='restore_history': interpretation['restore_from_look_version_id']=i['target_look_version_id']
    # Scope redirection must not apply any parsed updates.
    if op=='scope_redirect':
        supported='fixed_model_complete_look' if i['scope_reason'] in ['USER_PHOTO_TRY_ON','FIT_GUARANTEE'] else 'personalized_outfit_recommendation'
        message='当前仅提供女性通勤三件搭配与固定模特示意。模拟数据不能用于证明真实需求，不提供本人试穿、合身保证、预测或生产排程。'
        result.update(status='scope_redirect',scope_redirect=dict(reason_code=i['scope_reason'],supported_action=supported,message=message))
        interpretation['understanding_text']=message
        event('scope_redirected',{'reason_code':i['scope_reason'],'supported_action':supported},state['current_look_version_id'])
    elif op in ['view_history','restore_history'] and not target and (op=='restore_history' or i['target_look_version_id'] or not versions):
        result.update(status='action_failed',action_failure=dict(operation=op,code='HISTORY_TARGET_NOT_FOUND',message='没有找到该历史方案。'))
    elif op=='view_history':
        ids=[target['look_version_id']] if target else state['look_version_ids'][:]
        result.update(status='action_completed',action=dict(operation=op,viewed_look_version_ids=ids))
        if target: result['action']['target_look_version_id']=target['look_version_id']
        interpretation['understanding_text']='查看历史方案，当前搭配保持不变。';event('history_viewed',{'viewed_look_version_ids':ids},target['look_version_id'] if target else state['current_look_version_id'])
    elif op=='cancel_pending':
        if not dialog.get('pending_cart'):
            for c in state['constraints']:
                if c['status']=='active' and c['scope']=='next_recommendation':change(c,'revoked')
            state['pending_clarification']=None
        result.update(status='action_completed',action={'operation':op})
        interpretation['understanding_text']='好的，已停止这次未完成的请求。已有搭配和已填写的预算、尺码保持不变。'
    elif op=='add_item_to_cart':
        from .cart import add_item
        item_result=add_item(r,state,versions,i,dialog,at)
        interpretation['understanding_text']=''
        if item_result['status']=='action_completed':
            cart=item_result['sku_ids']
            result.update(status='action_completed',action=item_result['action'])
            interpretation['understanding_text']=item_result['message']
            payload={key:deepcopy(item_result['action'][key]) for key in ['sku_ids','quantity','item_count','unit_price_fen','cart_value_fen','target_look_version_id','resources']}
            payload['price_inventory_revalidated_at']=at
            event('item_add_succeeded',payload,item_result['target_look_version_id'])
        else:
            if item_result['status']=='clarification':result.update(status='clarification',clarification={'field':item_result['field'],'question':item_result['message']})
            else:result.update(status='action_failed',action_failure=dict(operation=op,code=item_result['reason_code'],message=item_result['message'],resources=deepcopy(r.binding),target_look_version_id=item_result['target_look_version_id']))
            event('item_add_failed',dict(sku_ids=item_result['sku_ids'],quantity=i['quantity'],target_look_version_id=item_result['target_look_version_id'],reason_code=item_result['reason_code'],resources=r.binding),item_result['target_look_version_id'])
    elif op=='consult':
        from .consultation import consult
        answer=consult(r,state,versions,i['inquiry'],dialog,at)
        if answer.get('question'):
            result.update(status='clarification',clarification={'field':'consultation_target','question':answer['question']})
        else:
            result.update(status='action_completed',action={'operation':op,'inquiry_result':answer['data'],'resources':deepcopy(r.binding),'revalidated_at':at})
            interpretation['understanding_text']=answer['text']
            event('product_consulted',dict(topic=i['inquiry']['topic'],sku_ids=answer['data']['resolved_sku_ids'],look_version_id=answer['data']['look_version_id'],resources=r.binding))
    elif i['ambiguous'] or set(i['replace_slots']) & {x['slot'] for x in i['keep_directives']}:
        result.update(status='clarification',clarification=dict(field='ambiguous_instruction',question=scope['question'] or '这次想更换哪些部分？'))
    elif op=='browse_catalog':
        from .catalog import query_catalog
        catalog_result,text=query_catalog(r,state,i,at)
        result.update(status='action_completed',action=dict(operation=op,catalog_result=catalog_result,resources=deepcopy(r.binding),revalidated_at=at))
        interpretation['understanding_text']=text
        event('catalog_viewed',dict(query_slots=catalog_result['filters']['slots'],query_target=i['query_target'],query_attributes=i['query_attributes'],sku_ids=[v['sku_id'] for p in catalog_result['products'] for v in p['variants']],resources=r.binding))
    elif op=='add_bundle_to_cart':
        r.fresh(at)
        code=None
        if not current or current['look_id'] not in r.looks or not r.looks[current['look_id']]['active'] or current['items']!=r.looks[current['look_id']]['items']: code='BUNDLE_LOOK_INVALID'
        else:
            l=r.looks[current['look_id']]
            if r.display: r.check_image(l)
            eligible,_,_=solve(r,state,dict(i,operation='restore_history'),None,current)
            if any(not r.stock[x]['sellable'] or r.stock[x]['available_qty']<1 or r.skus[x]['sale_status']!='sellable' or not r.products[r.skus[x]['product_id']]['active'] for x in current['items'].values()): code='BUNDLE_INVENTORY_CHANGED'
            elif r.total(l)!=current['total_price_fen']: code='BUNDLE_PRICE_CHANGED'
            elif not eligible: code='BUNDLE_LOOK_INVALID'
        interpretation['understanding_text']='按当前价格、尺码和库存重验整套加购模拟。'
        if code:
            result.update(status='action_failed',action_failure=dict(operation=op,target_look_version_id=state['current_look_version_id'],code=code,message='整套加购未完成，商品价格、库存或当前条件已变化，请重新搭配。',resources=r.binding))
            event('bundle_add_failed',dict(target_look_version_id=state['current_look_version_id'],reason_code=code,resources=r.binding),state['current_look_version_id'])
        else:
            cart=[current['items'][s] for s in SLOTS]
            result.update(status='action_completed',action=dict(operation=op,target_look_version_id=current['look_version_id'],sku_ids=cart,item_count=3,cart_value_fen=r.total(l),resources=r.binding,revalidated_at=at))
            if i['accepted']: event('recommendation_accepted',dict(look_id=l['look_id'],total_price_fen=r.total(l)),current['look_version_id'])
            event('bundle_added_to_cart',dict(look_id=l['look_id'],sku_ids=cart,item_count=3,cart_value_fen=r.total(l),resources=r.binding,price_inventory_revalidated_at=at),current['look_version_id'])
    else:
        if op=='modify_current' and not current:
            op=i['operation']=interpretation['operation']='initial_recommendation';i['replace_slots']=interpretation['replace_slots']=[]
        require(current is not None or not i['keep_directives'], 'REFERENCE_NOT_FOUND', '请先生成一套搭配，再指定保留商品。')
        for c in state['constraints']:
            if c['status']=='active' and c['kind']=='keep_sku' and c.get('target_slot') in i['release_slots']: change(c,'revoked')
        # Explicit local replacement is an unambiguous release; whole-look requests preserve session keeps.
        if i['carry_forward_unmentioned']:
            for slot in i['replace_slots']:
                for c in state['constraints']:
                    if c['status']=='active' and c['kind']=='keep_sku' and c.get('target_slot')==slot:
                        change(c,'revoked')
                        if slot not in interpretation['release_slots']: interpretation['release_slots'].append(slot)
        for key in ['height_cm','weight_kg']:
            if key in u: state['profile'][key]=u[key]
        if 'budget_max_fen' in u: state['context']['budget_max_fen']=u['budget_max_fen'];add('budget_max',u['budget_max_fen'])
        if 'scene' in u: state['context']['scene']=u['scene'];add('scene',u['scene'],strength='hard' if u.get('scene_hard') else 'soft')
        for slot,v in u.get('usual_sizes',{}).items(): state['profile']['usual_sizes'][slot]=v;add('size_exact',v,slot)
        if confirmed_sizes!=state['profile']['usual_sizes']:confirmed_sizes=None
        for x in i['rejections']:
            if x['action']=='add': add(x['kind'],x['value'],x.get('slot'))
            else:
                for c in state['constraints']:
                    if c['status']=='active' and c['kind']==x['kind'] and c['value']==x['value'] and c.get('target_slot')==x.get('slot'): change(c,'revoked')
        rejected=[x for x in i['rejections'] if x['action']=='add']
        if rejected and current:
            event('recommendation_rejected',dict(look_id=current['look_id'],reason_code='other_structured' if any(x['kind']=='forbid_sku' for x in rejected) else 'color_dislike',rejected_sku_ids=[x['value'] for x in rejected if x['kind']=='forbid_sku'],rejected_attribute_tokens=[x['value'] for x in rejected if x['kind']=='forbid_attribute']),current['look_version_id'])
        for k in interpretation['keep_directives']:
            k['sku_id']=comparison['items'][k['slot']];add('keep_sku',k['sku_id'],k['slot'],k['scope'])
        for p in i['preference_deltas']:
            if p['direction'] in ['remove','decrease']:
                for c in state['constraints']:
                    if c['status']=='active' and c['kind']=='prefer_attribute' and c['value']==p['attribute_token']: change(c,'revoked')
            else: add('prefer_attribute',p['attribute_token'],p.get('slot'))
        for kind,key in [('forbid_sku','rejected_sku_ids'),('forbid_attribute','rejected_attribute_tokens')]: state[key]=sorted({c['value'] for c in state['constraints'] if c['status']=='active' and c['kind']==kind})
        active=[c for c in state['constraints'] if c['status']=='active']
        result['applied_constraint_ids']=sorted(c['constraint_id'] for c in active)
        keeps=[c for c in active if c['kind']=='keep_sku']
        if not i['carry_forward_unmentioned'] and op=='modify_current':
            i['replace_slots']=[s for s in SLOTS if s not in {c['target_slot'] for c in keeps}]
            interpretation['replace_slots']=i['replace_slots'][:]
        ack='我会在本次'
        if keeps: ack+='保留'+ '、'.join(LABELS[c['target_slot']] for c in keeps)+'，'
        ack+= ('更换衣服' if i['replace_slots']==['top','bottom'] else '更换'+ '、'.join(LABELS[s] for s in i['replace_slots'])) if op=='modify_current' else ('重验并恢复历史搭配' if op=='restore_history' else '选择完整搭配')
        if 'budget_max_fen' in state['context']: ack+=f"，控制在{state['context']['budget_max_fen']/100:g}元以内"
        interpretation['understanding_text']=ack+'。'
        budget_declined=declined_budget is not None and declined_budget==state['context'].get('budget_max_fen')
        if declined and budget_declined:
            interpretation['understanding_text']=f"好的，继续按你之前的{declined_budget/100:g}元预算筛选。"
        if size_confirmed:
            interpretation['understanding_text']='已确认，继续按你填写的尺码和原预算筛选。'
        missing=[s for s in SLOTS if s not in state['profile']['usual_sizes']]
        field = 'scene' if 'scene' not in state['context'] else 'budget_max_fen' if 'budget_max_fen' not in state['context'] else 'usual_sizes' if len(missing)>1 else missing[0]+'_size' if missing else None
        if size_correction_needed:field=i['size_correction_slots'][0]+'_size' if len(i['size_correction_slots'])==1 else 'usual_sizes'
        if field:
            q={'scene':'主要穿在什么场景？','budget_max_fen':'整套预算上限是多少元？','usual_sizes':'你常穿的'+ '、'.join(LABELS[s]+'尺码' for s in missing)+'分别是多少？','top_size':'上衣常穿什么尺码？','bottom_size':'下装常穿什么尺码？','shoes_size':'鞋子常穿多少码？'}[field]
            if size_correction_needed:
                q='请告诉我正确的'+('鞋码' if i['size_correction_slots']==['shoes'] else '、'.join(LABELS[s]+'尺码' for s in i['size_correction_slots']))+'。' if i['size_correction_slots'] else '需要更正哪一项尺码，正确的尺码是多少？'
            c=dict(field=field,question=q)
            if field=='usual_sizes': c['missing_slots']=missing
            result.update(status='clarification',clarification=c)
        else:
            r.fresh(at)
            good,diagnostics,counts=solve(r,state,i,comparison,target)
            if good:
                l=good[0]
                if r.display: r.check_image(l)
                n=len(versions)+1; vid=f'lv-{n}'
                v=dict(contract_version=VERSION,tenant_id=state['tenant_id'],session_id=state['session_id'],look_version_id=vid,version_no=n,parent_look_version_id=state['current_look_version_id'],restored_from_look_version_id=target['look_version_id'] if target else None,decision_id=decision_id,look_id=l['look_id'],items=deepcopy(l['items']),image_url=l['image_url'],total_price_fen=r.total(l),delta_from_parent_fen=r.total(l)-(current['total_price_fen'] if current else r.total(l)),budget_remaining_fen=state['context']['budget_max_fen']-r.total(l),resources=deepcopy(r.binding),created_at=at)
                v['item_prices_fen']={sid:r.skus[sid]['price_fen'] for sid in l['items'].values()}
                versions.append(v);state['look_version_ids'].append(vid);state['current_look_version_id']=vid
                transition['appended_look_version_id']=vid
                names='、'.join(r.products[r.skus[l['items'][s]]['product_id']]['name'].removeprefix('模拟·') for s in SLOTS)
                reason=f'这套由{names}组成，三件合计 ¥{r.total(l)/100:g}，符合已确认尺码与预算。'
                from .consultation import preference_explanation
                reason+=preference_explanation(r,l,state,i)
                result.update(status='recommendation',recommendation=dict(look_version=v,reason_text=reason,validation={k:True for k in ['slots_complete','sku_sellable','size_exact','inventory_sellable','budget_ok','look_mapping_exact','source_compliant']}))
                event('recommendation_shown',dict(look_id=l['look_id'],items=l['items'],total_price_fen=r.total(l),resources=r.binding),vid)
                if current and op=='modify_current':
                    for slot in SLOTS:
                        a,b=current['items'][slot],l['items'][slot]
                        if a!=b:event('slot_replaced',dict(from_look_version_id=current['look_version_id'],to_look_version_id=vid,slot=slot,from_sku_id=a,to_sku_id=b,price_delta_fen=r.skus[b]['price_fen']-r.skus[a]['price_fen'],reason_tokens=[]),vid)
                if target:event('history_restored',dict(restored_from_look_version_id=target['look_version_id'],new_look_version_id=vid),vid)
            else:
                if not declined and not size_confirmed:interpretation['understanding_text']=''
                # Report causes from the nearest candidate(s), plus a keep conflict only if removing it yields an alternative.
                failures = min((f for _,f in diagnostics),key=lambda f:len(set(x[0] for x in f)),default=[('NO_REGISTERED_COMPLETE_LOOK',None)])
                if keeps and op=='modify_current':
                    relaxed=deepcopy(state)
                    for c in relaxed['constraints']:
                        if c['kind']=='keep_sku' and c['status']=='active':c['status']='revoked'
                    ri=dict(i,carry_forward_unmentioned=False)
                    alternatives,_,_=solve(r,relaxed,ri,comparison,target)
                    if alternatives: failures=list(failures)+[('KEEP_CONFLICT',c['constraint_id']) for c in keeps]
                reasons=sorted({x[0] for x in failures});blocking=sorted({x[1] for x in failures if x[1]})
                primary=next((code for code in RELAX if code in reasons),reasons[0]);action,message=RELAX[primary]
                cid=next((c for code,c in failures if code==primary and c),None)
                nm=dict(no_match_id=uid('nm'),decision_id=decision_id,reason_codes=reasons,blocking_constraint_ids=blocking,candidate_counts=counts,suggested_relaxation=dict(constraint_id=cid,action=action),message=message)
                # Only offer an executable, single relaxation; accepting it requires another explicit turn.
                if primary=='BUDGET_CONFLICT':
                    relaxed=deepcopy(state);relaxed['context']['budget_max_fen']=10**12
                    for c in relaxed['constraints']:
                        if c['kind']=='budget_max' and c['status']=='active':c['status']='revoked'
                    feasible,_,_=solve(r,relaxed,i,comparison,target)
                    if feasible:
                        minimum=min(r.total(x) for x in feasible)
                        proposal={'updates':{'budget_max_fen':minimum}}
                        nm['message']=f'其他条件保持时，完整搭配最低需要 ¥{minimum/100:g}，是否把预算上限提高到这个金额？'
                    elif 'SIZE_CONFLICT' in reasons:
                        nm['message']=f"现有完整搭配图暂未覆盖你提供的尺码，增加预算也没有可用的完整方案。你的 {state['context']['budget_max_fen']/100:g} 元预算与尺码保持不变，可以先查询可售单品。"
                elif primary=='KEEP_CONFLICT' and cid:
                    kept=next(c for c in state['constraints'] if c['constraint_id']==cid)
                    proposal={'operation':'modify_current','release_slots':[kept['target_slot']], 'carry_forward_unmentioned':False,'keep_directives':[]}
                elif primary in ['FORBIDDEN_SKU_CONFLICT','FORBIDDEN_ATTRIBUTE_CONFLICT'] and cid:
                    rejected_c=next(c for c in state['constraints'] if c['constraint_id']==cid)
                    rejection={'kind':rejected_c['kind'],'value':rejected_c['value'],'action':'remove'}
                    if rejected_c.get('target_slot'):rejection['slot']=rejected_c['target_slot']
                    proposal={'rejections':[rejection]}
                if budget_declined:
                    proposal=None
                    nm['suggested_relaxation']={'constraint_id':None,'action':'ask_user_to_retry_later'}
                    coverage='当前尺码及已有搭配图中' if 'SIZE_CONFLICT' in reasons or 'NO_REGISTERED_COMPLETE_LOOK' in reasons else '当前可售商品与已登记搭配中'
                    nm['message']=f'重新筛选后，{coverage}暂时没有符合这笔预算和其他条件的完整搭配。预算仍保持在{declined_budget/100:g}元以内，不会推荐超预算的商品。'
                if confirmed_sizes and 'SIZE_CONFLICT' in reasons:
                    proposal=None
                    nm['suggested_relaxation']={'constraint_id':None,'action':'ask_user_to_retry_later'}
                    labels='、'.join(('鞋码' if s=='shoes' else LABELS[s])+' '+confirmed_sizes[s]['value'] for s in SLOTS)
                    nm['message']=f"当前已登记的完整搭配图暂未覆盖{labels}，因此还不能提供符合这些尺码的完整方案。尺码和{state['context']['budget_max_fen']/100:g}元预算保持不变。"
                nm,proposal=explain_no_match(r,state,i,comparison,nm,proposal,target,at=at,declined=declined,declined_scope=dialog.get('declined_scope_offer'))
                result.update(status='no_match',no_match=nm)
                event('no_match',{k:nm[k] for k in ['no_match_id','reason_codes','blocking_constraint_ids']} | {'resources':r.binding},state['current_look_version_id'])
            for c in active:
                if c['scope']=='next_recommendation':change(c,'consumed')
            state['pending_clarification']=None
    if result['status']=='clarification':
        c=result['clarification']
        if op not in ['consult','add_item_to_cart']:state['pending_clarification']={k:c[k] for k in ['field','question']}
        event('clarification_asked',dict(field=c['field'],missing_slots=c.get('missing_slots',[])),state['current_look_version_id'])
    for c,action in changed:
        event('constraint_changed',dict(constraint_id=c['constraint_id'],action=action,kind=c['kind'],scope=c['scope']),state['current_look_version_id'])
    if state!=state_before:
        state['state_revision']+=1;state['updated_at']=at
    transition['revision_after']=state['state_revision'];transition['new_current_look_version_id']=state['current_look_version_id']
    for k in ['activated_constraint_ids','revoked_constraint_ids','consumed_constraint_ids']:transition[k]=sorted(transition[k])
    corrected=[('鞋码' if slot=='shoes' else LABELS[slot]+'尺码')+'更新为 '+value['value'] for slot,value in u.get('usual_sizes',{}).items() if state_before['profile']['usual_sizes'].get(slot) and state_before['profile']['usual_sizes'].get(slot)!=value and state['profile']['usual_sizes'].get(slot)==value]
    if corrected:
        interpretation['understanding_text']='已将'+'、'.join(corrected)+'。'+interpretation['understanding_text']
        if result['status']=='no_match' and 'SIZE_CONFLICT' in result['no_match']['reason_codes']:
            result['no_match']['message']=f"当前完整搭配图暂未覆盖更新后的尺码组合；预算继续保持 {state['context']['budget_max_fen']/100:g} 元，可以先查看可售单品。"
    response={'text':interpretation['understanding_text']}
    if result['status']=='recommendation':
        v=result['recommendation']['look_version'];l=r.looks[v['look_id']]
        response.update(text=response['text']+result['recommendation']['reason_text']+'\n'+DISCLAIMER,image_url=l['image_url'],image_sha256=l['image_sha256'],model_asset_version=l['model_asset_version'])
    elif result['status']=='clarification':response['text']=result['clarification']['question']
    elif result['status']=='no_match':response['text']+=result['no_match']['message']
    elif result['status']=='action_failed':response['text']+=result['action_failure']['message']
    elif op=='add_bundle_to_cart':response['text']+='三件商品已整套加入模拟购物车，未生成订单。'
    if result['status']=='scope_redirect':response['text']+='\n'+DISCLAIMER
    retry_intent=dict(deepcopy(i),updates={},keep_directives=[],release_slots=[],rejections=[],accepted=False,relaxation_response=None,confirmation_response=None)
    nm=result.get('no_match')
    confirmation={'field':'usual_sizes','values':deepcopy(state['profile']['usual_sizes'])} if nm and nm['suggested_relaxation']['action']=='ask_user_to_change_size' else None
    readonly_ops=['view_history','add_bundle_to_cart','add_item_to_cart','scope_redirect','browse_catalog','consult']
    next_dialog={'no_match':nm,'proposal':proposal,'retry_intent':retry_intent,'declined_budget_max_fen':declined_budget,'confirmation':confirmation,'confirmed_sizes':confirmed_sizes} if nm else (dialog_context if op in readonly_ops or size_correction_needed else None)
    if op=='browse_catalog' and result['status']=='action_completed':
        next_dialog={**deepcopy(next_dialog or {}),'last_catalog_query':{k:deepcopy(i[k]) for k in ['query_slots','query_target','query_attributes']},'last_catalog_result':deepcopy(catalog_result['products'])}
    if op=='view_history' and result['status']=='action_completed' and target:
        next_dialog={**deepcopy(next_dialog or {}),'viewed_look_version_id':target['look_version_id']}
        next_dialog=synchronize_view_focus(r,state,versions,next_dialog,target['look_version_id'],force=True)
    if op=='consult':
        next_dialog=deepcopy(next_dialog or {})
        if result['status']=='clarification':next_dialog['pending_inquiry']=deepcopy(i['inquiry'])
        else:
            next_dialog.pop('pending_inquiry',None)
            ids=answer['data']['resolved_sku_ids']
            if ids:next_dialog['last_item_focus']={'sku_ids':ids,'look_version_id':answer['data']['look_version_id'],'topic':i['inquiry']['topic'],'price_quotes_fen':{fact['sku_id']:fact['price_fen'] for fact in answer['data']['facts']}}
    if op=='cancel_pending' and dialog.get('pending_cart'):next_dialog=deepcopy(dialog_context)
    if next_dialog:next_dialog=deepcopy(next_dialog);next_dialog.pop('pending_cart',None)
    if op=='add_item_to_cart':
        next_dialog=deepcopy(next_dialog or {})
        if item_result.get('pending_cart'):next_dialog['pending_cart']=deepcopy(item_result['pending_cart'])
        if cart:
            source=next((v for v in versions if v['look_version_id']==item_result['target_look_version_id']),None)
            # A size selected just for the cart may differ from the outfit's pictured SKU.
            focus_look=source['look_version_id'] if source and cart[0] in source['items'].values() else None
            next_dialog['last_item_focus']={'sku_ids':cart,'look_version_id':focus_look,'topic':'purchase','price_quotes_fen':{cart[0]:item_result['action']['unit_price_fen']}}
    preserved_pending=pending_intent if op in readonly_ops or (op=='cancel_pending' and dialog.get('pending_cart')) else None
    next_dialog=record_dialogue(r,state_before,versions_before,i,result,state,versions,dialog_context,next_dialog)
    return dict(decision=result,response=response,state=state,history=versions,events=events,cart_added_sku_ids=cart,dialog_context=next_dialog,pending_intent=deepcopy(i) if result['status']=='clarification' and op!='add_item_to_cart' and result['clarification']['field'] not in ['ambiguous_instruction','consultation_target'] else preserved_pending)
