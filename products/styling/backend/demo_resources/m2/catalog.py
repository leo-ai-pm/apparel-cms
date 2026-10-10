"""Read-only inventory queries; image coverage and outfit eligibility are separate facts."""
from copy import deepcopy
from .core import SLOTS, LABELS, solve


def query_catalog(r, state, intent, at):
    r.fresh(at)
    slots=intent['query_slots'] or SLOTS[:]
    attrs=intent['query_attributes']
    updates=intent['updates']
    sizes={**deepcopy(state['profile']['usual_sizes']),**deepcopy(updates.get('usual_sizes',{}))}
    bundle_budget=state['context'].get('budget_max_fen')
    explicit_budget=updates.get('budget_max_fen')
    if intent['query_target']=='looks' and explicit_budget is not None:
        bundle_budget=explicit_budget
    ceiling=explicit_budget if explicit_budget is not None else bundle_budget
    basis=('query_item_ceiling' if intent['query_target']=='products' else 'query_bundle_ceiling') if explicit_budget is not None else ('bundle_ceiling' if bundle_budget is not None else 'not_provided')
    forbidden=[c for c in state['constraints'] if c['status']=='active' and c['strength']=='hard' and c['kind'] in ['forbid_sku','forbid_attribute']]

    def matches(sku):
        slot=sku['slot'];sid=sku['sku_id'];stock=r.stock[sid]
        if slot not in slots or not r.products[sku['product_id']]['active'] or sku['sale_status']!='sellable' or not stock['sellable'] or stock['available_qty']<1:
            return False
        if slot in sizes and sku['size']!=sizes[slot]:return False
        if ceiling is not None and sku['price_fen']>ceiling:return False
        one={'items':{slot:sid}}
        for c in forbidden:
            if c.get('target_slot') not in [None,slot]:continue
            if (c['kind']=='forbid_sku' and c['value']==sid) or (c['kind']=='forbid_attribute' and r.hit(one,c['value'],[slot])):return False
        return all(r.hit(one,t,[slot]) for t in attrs)

    grouped={}
    for sku in r.skus.values():
        if not matches(sku):continue
        pid=sku['product_id']
        product=grouped.setdefault(pid,dict(product_id=pid,name=r.products[pid]['name'],slot=sku['slot'],variants=[]))
        product['variants'].append(dict(sku_id=sku['sku_id'],size=deepcopy(sku['size']),price_fen=sku['price_fen'],available_qty=r.stock[sku['sku_id']]['available_qty']))
    size_order=['S','M','L','XL','35','36','37','38','39','40']
    for p in grouped.values():p['variants'].sort(key=lambda v:(size_order.index(v['size']['value']),v['sku_id']))
    products=sorted(grouped.values(),key=lambda p:(SLOTS.index(p['slot']),min(v['price_fen'] for v in p['variants']),p['product_id']))

    groups={};matching=0
    complete_sizes=all(slot in sizes for slot in SLOTS)
    for look in sorted(r.looks.values(),key=lambda l:l['look_id']):
        if not look['active']:continue
        if r.display:r.check_image(look)
        look_sizes={slot:deepcopy(r.skus[look['items'][slot]]['size']) for slot in SLOTS}
        key=tuple(look_sizes[slot]['value'] for slot in SLOTS)
        price=r.total(look)
        group=groups.setdefault(key,dict(usual_sizes=look_sizes,look_ids=[],min_total_price_fen=price,max_total_price_fen=price))
        group['look_ids'].append(look['look_id'])
        group['min_total_price_fen']=min(group['min_total_price_fen'],price)
        group['max_total_price_fen']=max(group['max_total_price_fen'],price)
        if complete_sizes and look_sizes==sizes:matching+=1

    # Query overrides exist only in this copy. Item ceilings never replace a bundle budget.
    probe=deepcopy(state);probe['profile']['usual_sizes']=sizes
    probe['context'].update({k:v for k,v in updates.items() if k=='scene'})
    if bundle_budget is not None:probe['context']['budget_max_fen']=bundle_budget
    for c in probe['constraints']:
        if c['kind']=='size_exact' and c.get('target_slot') in updates.get('usual_sizes',{}):c['value']=sizes[c['target_slot']]
        elif c['kind']=='budget_max' and intent['query_target']=='looks' and explicit_budget is not None:c['value']=bundle_budget
        elif c['kind']=='scene' and 'scene' in updates:c['value']=updates['scene']
    eligible=None
    if complete_sizes and bundle_budget is not None and probe['context'].get('scene'):
        looks,_,_=solve(r,probe,dict(intent,operation='initial_recommendation',preference_deltas=[]),None)
        eligible=[l['look_id'] for l in looks if all(matches(r.skus[l['items'][slot]]) for slot in slots)]
    summaries=[]
    for look in sorted(r.looks.values(),key=lambda l:l['look_id']):
        if look['active'] and (eligible is None or look['look_id'] in eligible):
            summaries.append(dict(look_id=look['look_id'],names=[r.products[r.skus[look['items'][slot]]['product_id']]['name'].removeprefix('模拟·') for slot in SLOTS],total_price_fen=r.total(look),sizes={slot:r.skus[look['items'][slot]]['size']['value'] for slot in SLOTS}))
    data=dict(target=intent['query_target'],filters=dict(slots=slots,usual_sizes=sizes,budget_max_fen=ceiling,bundle_budget_max_fen=bundle_budget,budget_basis=basis,attribute_tokens=attrs),
              products=products[:12],total_product_count=len(products),truncated=len(products)>12,
              look_summaries=summaries[:12],
              coverage=dict(registered_groups=list(groups.values()),matching_size_look_count=matching if complete_sizes else None,eligible_look_ids=eligible))
    return data,describe(data)


def describe(data):
    money=lambda fen:f'¥{fen/100:g}'
    filters=data['filters'];coverage=data['coverage'];lines=[]
    if data['target']=='products':
        if data['products']:
            lines.append(f"按本次查询条件，目前有 {data['total_product_count']} 款可售模拟商品：")
            for p in data['products']:
                variants=p['variants'];prices=[v['price_fen'] for v in variants]
                price=money(min(prices)) if min(prices)==max(prices) else f'{money(min(prices))}–{money(max(prices))}'
                sizes=' / '.join(v['size']['value'] for v in variants)
                unit='双' if p['slot']=='shoes' else '件'
                lines.append(f"• {LABELS[p['slot']]}：{p['name'].removeprefix('模拟·')}，{sizes} 码，{price} / {unit}")
            if data['truncated']:lines.append('以上先列出前 12 款，可继续按品类或属性缩小范围。')
            lines.append('以上为单件价格，不能直接视为一套搭配。')
        else:lines.append('按本次品类、尺码、价格和排除条件，暂无可售模拟单品。')
        if filters['budget_basis']=='query_item_ceiling':lines.append(f"本次单件查询上限为 {money(filters['budget_max_fen'])}。")
    if data['target']=='products':
        if not data['products'] and coverage['eligible_look_ids']:
            lines.append('仍有符合整套条件的方案，可以继续让我搭配。')
        return '\n'.join(lines)
    eligible=coverage['eligible_look_ids']
    if eligible is not None:
        lines.append(f"按当前尺码、预算和其他条件，可选 {len(eligible)} 套完整搭配：")
    else:
        lines.append('以下为已登记的搭配图；还需结合你的尺码、整套预算和穿着场景筛选：')
    for look in data.get('look_summaries',[]):
        sizes='/'.join(look['sizes'][slot] for slot in SLOTS)
        lines.append('• '+' + '.join(look['names'])+f"，{money(look['total_price_fen'])}（{sizes}）。")
    if eligible==[]:lines.append('当前条件下暂无可用完整方案；可以保持预算，先了解符合条件的单品。')
    if filters['bundle_budget_max_fen'] is not None:
        lines.append(f"整套预算保持 {money(filters['bundle_budget_max_fen'])}。")
    return '\n'.join(lines)
