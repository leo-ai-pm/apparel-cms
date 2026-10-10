"""Single-product simulated cart validation; never mutates outfit or inventory."""
from copy import deepcopy

from .core import SLOTS, LABELS, validate_size


def _resolve(r,state,history,q,dialog):
    ref=q['reference'];slot=q.get('slot');look=None;ids=[];quotes={};question=None
    if ref in ['current','visible','history']:
        target=state['current_look_version_id']
        if ref=='visible':target=(dialog['view_context'].get('look_version_id') or target) if 'view_context' in dialog else (dialog.get('viewed_look_version_id') or target)
        if ref=='history':target=q.get('look_version_id')
        look=next((v for v in history if v['look_version_id']==target),None)
        if look:
            ids=[look['items'][s] for s in ([slot] if slot else SLOTS)]
            prices=look.get('item_prices_fen')
            quotes=None if prices is None else {sid:prices[sid] for sid in ids if sid in prices}
    elif ref=='last_mentioned':
        focus=dialog.get('last_item_focus') or {}
        look=next((v for v in history if v['look_version_id']==focus.get('look_version_id')),None)
        ids=[look['items'][slot]] if look and slot else [sid for sid in focus.get('sku_ids',[]) if sid in r.skus and (not slot or r.skus[sid]['slot']==slot)]
        prices=focus.get('price_quotes_fen') or (look.get('item_prices_fen') if look else {})
        quotes=None if prices is None else {sid:prices[sid] for sid in ids if sid in prices}
    elif ref=='catalog':
        products=dialog.get('last_catalog_result') or []
        if q.get('catalog_position'):
            position=q['catalog_position']
            if position>len(products):question=f'刚才列表只有 {len(products)} 款商品，没有第 {position} 款。你想加购哪一款？'
            else:
                variants=products[position-1]['variants'];ids=[v['sku_id'] for v in variants if v['sku_id'] in r.skus]
                quotes={v['sku_id']:v['price_fen'] for v in variants}
        elif q.get('sku_id'):ids=[q['sku_id']]
        elif q.get('product_id'):ids=[sid for sid,s in r.skus.items() if s['product_id']==q['product_id']]
        if not quotes:quotes={v['sku_id']:v['price_fen'] for p in products for v in p['variants'] if v['sku_id'] in ids}
        if not quotes:quotes={sid:price for sid,price in (dialog.get('last_item_focus') or {}).get('price_quotes_fen',{}).items() if sid in ids}
    for field in ['sku_id','product_id','slot']:
        if field in q:ids=[sid for sid in ids if (sid if field=='sku_id' else r.skus[sid][field])==q[field]]
    if quotes is not None:quotes={sid:price for sid,price in quotes.items() if sid in ids}
    return ids,look,quotes,question


def add_item(r,state,history,intent,dialog,at):
    """Return a validated action, a local clarification, or an explicit failure."""
    r.fresh(at)
    q=intent['inquiry'];quantity=intent['quantity'];cart_size=intent.get('cart_size')
    previous=dialog.get('pending_cart') or {}
    continuing=bool(previous and q==previous.get('inquiry'))
    ids,look,quotes,question=_resolve(r,state,history,q,dialog)
    target=look['look_version_id'] if look else None
    if continuing:
        target=previous.get('target_look_version_id',target)
        quotes=deepcopy(previous.get('reference_prices_fen',quotes))
    pending={'inquiry':deepcopy(q),'quantity':quantity,'target_look_version_id':target,'reference_prices_fen':deepcopy(quotes)}
    if cart_size:pending['cart_size']=deepcopy(cart_size)
    def clarify(field,message,code):
        pending.update(field=field,question=message)
        return {'status':'clarification','field':field,'message':message,'reason_code':code,'pending_cart':pending,
                'sku_ids':ids if len(ids)==1 else [],'quantity':quantity,'target_look_version_id':target}
    if question:return clarify('cart_target',question,'ITEM_TARGET_AMBIGUOUS')
    if intent['ambiguous'] or not ids or len({r.skus[sid]['product_id'] for sid in ids})!=1:
        return clarify('cart_target','你想加购哪一件商品？请说明上衣、下装、鞋子，或商品名称。','ITEM_TARGET_AMBIGUOUS')
    product_id=r.skus[ids[0]]['product_id'];slot=r.skus[ids[0]]['slot']
    # Pin the product before asking a size, so a later view/list change cannot redirect it.
    canonical={'topic':'purchase','reference':'catalog','whole_look':False,'product_id':product_id,'slot':slot}
    if cart_size:
        validate_size(slot,cart_size)
        ids=[sid for sid,s in r.skus.items() if s['product_id']==product_id and s['size']==cart_size]
    elif len(ids)>1:
        usual=state['profile']['usual_sizes'].get(slot)
        if usual:ids=[sid for sid in ids if r.skus[sid]['size']==usual]
    pending['inquiry']=canonical
    if len(ids)!=1:
        sizes=sorted({s['size']['value'] for s in r.skus.values() if s['product_id']==product_id},key=lambda value:['S','M','L','XL','35','36','37','38','39','40'].index(value))
        return clarify('cart_size',f"这件{LABELS[slot]}需要哪个尺码？商品登记尺码为 {' / '.join(sizes)}；只用于这次单件加购。",'ITEM_SIZE_REQUIRED')
    sid=ids[0];sku=r.skus[sid];stock=r.stock[sid];product=r.products[product_id]
    canonical['sku_id']=sid
    pending.update(sku_id=sid,cart_size=deepcopy(sku['size']))
    if not product['active'] or sku['sale_status']!='sellable' or not stock['sellable'] or stock['available_qty']<quantity:
        return dict(status='action_failed',reason_code='ITEM_INVENTORY_CHANGED',message='这件商品当前已下架、售罄或可售数量不足，单件加购未完成。',sku_ids=[sid],quantity=quantity,target_look_version_id=target)
    price=sku['price_fen'];quoted=quotes.get(sid) if quotes is not None else None
    if quoted is None and quotes and len(set(quotes.values()))==1:quoted=next(iter(quotes.values()))
    needs_quote=quotes is None or (quoted is not None and quoted!=price) or (continuing and previous.get('field')=='cart_price_confirmation')
    confirmed=(continuing and previous.get('field')=='cart_price_confirmation' and intent['accepted'] and previous.get('sku_id')==sid and previous.get('quantity')==quantity and previous.get('unit_price_fen')==price)
    if needs_quote and not confirmed:
        pending['unit_price_fen']=price
        old=f'从 ¥{quoted/100:g} 调整为 ' if quoted is not None and quoted!=price else '为 '
        unit='双' if slot=='shoes' else '件'
        return clarify('cart_price_confirmation',f"{product['name'].removeprefix('模拟·')}当前单价{old}¥{price/100:g}，{quantity} {unit}合计 ¥{price*quantity/100:g}。是否按这个价格加入模拟购物车？",'ITEM_PRICE_CHANGED')
    action=dict(operation='add_item_to_cart',sku_ids=[sid],quantity=quantity,item_count=quantity,unit_price_fen=price,
                cart_value_fen=price*quantity,target_look_version_id=target,resources=deepcopy(r.binding),revalidated_at=at)
    unit='双' if slot=='shoes' else '件'
    message=f"已将{product['name'].removeprefix('模拟·')}（{sku['size']['value']} 码）{quantity} {unit}加入模拟购物车，单价 ¥{price/100:g}，合计 ¥{price*quantity/100:g}；未生成订单。"
    return dict(status='action_completed',action=action,message=message,sku_ids=[sid],quantity=quantity,target_look_version_id=target)
