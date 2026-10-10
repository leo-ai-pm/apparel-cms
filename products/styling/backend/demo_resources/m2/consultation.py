"""Grounded answers about referenced products, without changing outfit state."""
from copy import deepcopy
from .core import require,SLOTS,LABELS,DISCLAIMER

TOPICS=['price','details','material','purchase','reason','availability','fit','capabilities','acknowledgement']
REFERENCES=['current','visible','history','catalog','last_mentioned','app']
FEATURES=['real_payment','personal_try_on','fit_guarantee']
TOKEN_LABELS={'style:casual':'休闲','style:refined':'精致','style:urban_chic':'都市通勤','scene:work_commute':'日常通勤','silhouette:wide_leg':'阔腿','silhouette:oversized':'宽松廓形','pattern:stripe':'条纹','design:asymmetric':'不对称剪裁','heel:low':'低跟','heel:flat':'平底','color:ivory':'象牙白','color:burgundy':'酒红色','color:blue':'蓝色','color:ecru':'本白'}


def synchronize_view_focus(r,state,history,dialog,target_id=None,force=False):
    """A newly viewed outfit supersedes stale outfit-bound focus, never user constraints."""
    context=deepcopy(dialog or {})
    if not force:
        if 'view_context' in context:target_id=context['view_context'].get('look_version_id') or state['current_look_version_id']
        else:target_id=context.get('viewed_look_version_id') or state['current_look_version_id']
    look=next((version for version in history if version['look_version_id']==target_id),None)
    if not look:return context
    focus=context.get('last_item_focus') or {}
    bound=focus.get('look_version_id')
    changed='visible_focus_version_id' in context and context['visible_focus_version_id']!=target_id
    if force or (bound is not None and bound!=target_id) or (changed and 'view_context' in context):
        slots={r.skus[sku_id]['slot'] for sku_id in focus.get('sku_ids',[]) if sku_id in r.skus}
        context['last_item_focus']={'sku_ids':[look['items'][slot] for slot in SLOTS if not slots or slot in slots],
                                    'look_version_id':target_id,'topic':focus.get('topic')}
    context['visible_focus_version_id']=target_id
    return context


def validate_inquiry(raw,r):
    require(type(raw) is dict and set(raw)<={'topic','reference','slot','look_version_id','sku_id','product_id','whole_look','catalog_position','product_name'},'ENUM_INVALID')
    q=dict(raw);q.setdefault('reference','current')
    q.setdefault('whole_look',False)
    require(type(q['whole_look']) is bool,'ENUM_INVALID')
    require(not q['whole_look'] or not any(key in q for key in ['slot','sku_id','product_id','catalog_position','product_name']),'ENUM_INVALID')
    if 'catalog_position' in q:
        require(type(q['catalog_position']) is int and 1<=q['catalog_position']<=1000 and q['reference']=='catalog','ENUM_INVALID')
        require(not any(key in q for key in ['sku_id','product_id']),'ENUM_INVALID')
    if 'product_name' in q:
        require(type(q['product_name']) is str and 0<len(q['product_name'])<=300,'ENUM_INVALID')
        name=q['product_name'].removeprefix('模拟·')
        matches=[p for p in r.products.values() if p['name'].removeprefix('模拟·')==name]
        require(len(matches)==1,'REFERENCE_NOT_FOUND','这个完整商品名没有唯一对应商品，请重新确认名称。')
        product=matches[0]
        require(not q.get('product_id') or q['product_id']==product['product_id'],'PRODUCT_REFERENCE_CONFLICT','商品名称与编号不一致，尚未执行，请重新确认商品。')
        require(not q.get('sku_id') or (q['sku_id'] in r.skus and r.skus[q['sku_id']]['product_id']==product['product_id']),'PRODUCT_REFERENCE_CONFLICT','商品名称与尺码商品不一致，尚未执行，请重新确认商品。')
        require(not q.get('slot') or q['slot']==product['slot'],'SKU_SLOT_MISMATCH')
        q['product_name']=name;q['product_id']=product['product_id'];q['slot']=product['slot']
    require(q.get('topic') in TOPICS and q['reference'] in REFERENCES,'ENUM_INVALID')
    require('slot' not in q or q['slot'] in SLOTS,'ENUM_INVALID')
    for key,index in [('sku_id',r.skus),('product_id',r.products)]:
        if key in q:require(type(q[key]) is str and q[key] in index,'REFERENCE_NOT_FOUND')
    if 'look_version_id' in q:require(type(q['look_version_id']) is str and 0<len(q['look_version_id'])<150,'REFERENCE_NOT_FOUND')
    if q.get('sku_id') and q.get('slot'):require(r.skus[q['sku_id']]['slot']==q['slot'],'SKU_SLOT_MISMATCH')
    if q.get('sku_id') and q.get('product_id'):require(r.skus[q['sku_id']]['product_id']==q['product_id'],'REFERENCE_NOT_FOUND')
    return q


def consult(r,state,history,q,dialog,at):
    topic=q['topic'];ref=q['reference'];slot=q.get('slot');look=None;ids=[]
    base=dict(topic=topic,resolved_sku_ids=[],look_version_id=None,facts=[],unsupported_features=FEATURES[:])
    if topic=='capabilities':
        return dict(data=base,text='我可以按预算、常穿尺码和场景推荐完整搭配，也可以查询商品、解释价格、保留或替换单品、查看和恢复历史。可以单件或整套模拟加购，暂不支持真实支付；图片是固定模特示意。')
    if topic=='acknowledgement':
        return dict(data=base,text='好的。有想了解的商品或需要调整的搭配，继续告诉我就可以。' if history else '你好，可以直接告诉我你的预算和穿着需求，也可以先问问有哪些商品。')
    if ref in ['current','visible','history']:
        target=state['current_look_version_id']
        if ref=='visible':
            if 'view_context' in dialog:target=dialog['view_context'].get('look_version_id') or target
            else:target=dialog.get('viewed_look_version_id') or target
        if ref=='history':target=q.get('look_version_id')
        look=next((v for v in history if v['look_version_id']==target),None)
        if not look:return {'question':'你想了解哪一件商品？可以说商品名，或先查看一套搭配。'}
        ids=[look['items'][s] for s in ([slot] if slot else SLOTS)]
    elif ref=='last_mentioned':
        focus=dialog.get('last_item_focus') or {}
        look=next((v for v in history if v['look_version_id']==focus.get('look_version_id')),None)
        ids=[look['items'][slot]] if look and slot else [sid for sid in focus.get('sku_ids',[]) if sid in r.skus and (not slot or r.skus[sid]['slot']==slot)]
        if look and q['whole_look']:ids=[look['items'][s] for s in SLOTS]
    elif ref=='catalog':
        if q.get('catalog_position'):
            products=dialog.get('last_catalog_result') or [];position=q['catalog_position']
            if position>len(products):return {'question':f'刚才列表只有 {len(products)} 款商品，没有第 {position} 款。你想了解哪一款？'}
            ids=[variant['sku_id'] for variant in products[position-1]['variants'] if variant['sku_id'] in r.skus and (not slot or r.skus[variant['sku_id']]['slot']==slot)]
        elif q.get('sku_id'):ids=[q['sku_id']]
        elif q.get('product_id'):
            variants=[s for s in r.skus.values() if s['product_id']==q['product_id'] and (not slot or s['slot']==slot)]
            ids=[s['sku_id'] for s in variants if not state['profile']['usual_sizes'].get(s['slot']) or s['size']==state['profile']['usual_sizes'][s['slot']]]
    for field in ['sku_id','product_id']:
        if field in q:ids=[sid for sid in ids if (sid if field=='sku_id' else r.skus[sid]['product_id'])==q[field]]
    if not ids:return {'question':'你想了解哪一件？可以说商品名，或者说明上衣、下装还是鞋子。'}
    if not q['whole_look'] and len({r.skus[sid]['product_id'] for sid in ids})>1:
        return {'question':'你指的是上衣、下装还是鞋子？如果想了解整套，也可以直接说。'}
    r.fresh(at)
    facts=[]
    for sid in ids:
        sku=r.skus[sid];p=r.products[sku['product_id']];stock=r.stock[sid]
        facts.append(dict(sku_id=sid,product_id=p['product_id'],name=p['name'].removeprefix('模拟·'),slot=sku['slot'],size=deepcopy(sku['size']),price_fen=sku['price_fen'],available_qty=stock['available_qty'],sellable=bool(p['active'] and sku['sale_status']=='sellable' and stock['sellable'] and stock['available_qty']>0),attribute_tokens=sorted(r.tokens(sid)),material=p.get('material')))
    base.update(resolved_sku_ids=ids,look_version_id=look['look_version_id'] if look else None,facts=facts)
    grouped={}
    for fact in facts:
        signature=(fact['product_id'],fact['name'],fact['price_fen'],fact['sellable'],str(fact['material']),tuple(fact['attribute_tokens']))
        if signature not in grouped:grouped[signature]=dict(fact,size_values=[])
        if fact['size']['value'] not in grouped[signature]['size_values']:grouped[signature]['size_values'].append(fact['size']['value'])
    display_facts=list(grouped.values())
    money=lambda fen:f'¥{fen/100:g}'
    def line(f,availability=False):
        unit='双' if f['slot']=='shoes' else '件'
        sizes=' / '.join(f.get('size_values',[f['size']['value']]))
        value=f"{f['name']}，{sizes} 码，{money(f['price_fen'])} / {unit}"
        return value+('，当前模拟库存可售。' if f['sellable'] else '，当前无可售库存。') if availability else value+'。'
    if topic in ['price','details','availability']:
        text='\n'.join(line(f,topic!='price') for f in display_facts)
        if len(facts)==3 and look and not slot:text+='\n这套当前商品总价为 '+money(sum(f['price_fen'] for f in facts))+'。'
        if topic=='details':
            attrs=sorted({TOKEN_LABELS[t] for f in facts for t in f['attribute_tokens'] if t in TOKEN_LABELS})
            if attrs:text+='\n已登记特点：'+'、'.join(attrs)+'。'
    elif topic=='material':
        materials={f['product_id']:f for f in facts}
        text='\n'.join(f"{f['name']}："+(str(f['material'])+'。' if f['material'] else '商品资料暂未提供具体材质成分，不能仅凭图片判断。') for f in materials.values())
    elif topic=='purchase':
        text='\n'.join(line(f,True) for f in display_facts)+'\n可以单件或整套加入模拟购物车。你明确说“加入购物车”后才会添加，不会生成真实订单或支付。'
    elif topic=='fit':
        text='\n'.join(f"{f['name']}当前登记尺码为 {' / '.join(f['size_values'])}。" for f in display_facts)+'\n没有提供品牌实测尺码表，不能据此保证合身。'+DISCLAIMER+'。'
    else:
        attrs=sorted({TOKEN_LABELS[t] for f in facts for t in f['attribute_tokens'] if t in TOKEN_LABELS})
        text='这'+('套搭配' if len(facts)>1 else '件商品')+'的选择依据是已登记的'+('、'.join(attrs) if attrs else '商品属性')+'。'
        if look and state['context'].get('budget_max_fen') is not None:
            total=sum(r.skus[s]['price_fen'] for s in look['items'].values());budget=state['context']['budget_max_fen']
            text+=f'该方案当前三件合计 {money(total)}，'+('在' if total<=budget else '超过')+f'你的 {money(budget)} 预算'+('内。' if total<=budget else '，需要重新筛选。')
        text+='这是基于模拟商品标签的搭配说明，不代表实际脚感或合身保证。'
    return dict(data=base,text=text)


def preference_explanation(r,look,state,intent):
    """Describe fulfilled or absent style evidence, never infer material or fit."""
    labels={**TOKEN_LABELS,'dress_code:formal':'正式风格','prefer:refined':'精致风格','prefer:casual':'休闲风格',
            'style:formal':'正式风格','style:premium':'高级风格','style:feminine':'温柔风格',
            'prefer:light':'浅色','color:light':'浅色','prefer:comfortable':'舒适偏好','style:comfortable':'舒适偏好',
            'comfort:comfortable':'舒适偏好','style:refined':'精致风格','style:casual':'休闲风格'}
    requests=[]
    for constraint in state['constraints']:
        if constraint['status']=='active' and constraint['kind']=='prefer_attribute':
            requests.append((constraint['value'],[constraint['target_slot']] if constraint.get('target_slot') else SLOTS,'add'))
    requests.extend((p['attribute_token'],[p['slot']] if p.get('slot') else intent['replace_slots'] or SLOTS,p['direction']) for p in intent['preference_deltas'] if p['direction']!='remove')
    messages=[];seen=set()
    scene=state['context'].get('scene')
    if scene in ['scene:work_commute','scene:office']:
        if r.hit(look,scene):
            actual={token for sid in look['items'].values() for token in r.tokens(sid)}
            features=[TOKEN_LABELS[token] for token in ['design:asymmetric','silhouette:wide_leg','silhouette:oversized','pattern:stripe','heel:low','heel:flat'] if token in actual]
            messages.append('这套有日常通勤场景资料，'+('款式特点包括'+'、'.join(features)+'，可作为上班穿搭参考。' if features else '可作为上班穿搭参考。'))
        else:messages.append('现有商品资料未明确覆盖你要求的通勤场景，这项场景偏好尚未满足。')
    for token,slots,direction in requests:
        if token not in labels or token in seen:continue
        seen.add(token);label=labels[token];matches=r.hit(look,token,slots)
        if direction=='decrease':
            messages.append(f'本次按减少{label}的偏好排序，当前有 {matches} 件单品带有该标签。')
        elif not matches:
            messages.append(f'本次预算和其他硬条件下选出的这套未体现你希望的{label}，这项风格偏好未满足。')
        elif 'comfortable' in token:
            shoe_tokens=r.tokens(look['items']['shoes']) if 'shoes' in slots else set()
            structures=[TOKEN_LABELS[t] for t in ['heel:low','heel:flat'] if t in shoe_tokens]
            evidence=('鞋子已登记的'+'、'.join(structures)+'结构及舒适相关标签') if structures else '已登记的舒适相关标签'
            messages.append('本次依据'+evidence+'响应舒适偏好，但不能保证实际脚感或合身。')
        else:
            slots_with_attribute=[LABELS[slot] for slot in slots if r.hit(look,token,[slot])]
            messages.append('、'.join(slots_with_attribute)+f'有已登记的{label}属性，用于响应你的偏好。')
    return ''.join(messages)
