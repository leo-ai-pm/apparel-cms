"""Bounded dialogue references and grounded local no-match explanations.

This module consumes validated model intent and server-owned state. It never parses
natural-language keywords and never treats a remembered topic as a permanent keep.
"""
from copy import deepcopy
from itertools import combinations
from .core import SLOTS, LABELS, solve, json_hash


def prepare_scope(r,state,history,intent,dialog):
    """Resolve a model-requested reference against server evidence, without writes."""
    i=deepcopy(intent);context=dialog or {};ref=i.get('scope_reference')
    output={'intent':i,'base_look':None,'question':None}
    if i['operation']!='modify_current' or ref is None:return output
    current=next((v for v in history if v['look_version_id']==state['current_look_version_id']),None)
    def clarify(question):
        i['ambiguous']=True;output['question']=question
        return output
    if not current:return clarify('还没有可调整的搭配。你想先看哪类商品，还是让我搭一整套？')
    if ref=='recent_topic':
        topic=context.get('dialogue_topic') or {}
        # last_catalog_query is a compatible server-owned fallback for existing sessions.
        if not topic and 'dialogue_topic' not in context:
            query=context.get('last_catalog_query') or {}
            slots=query.get('query_slots',[])
            if query.get('query_target','products')=='products' and len(slots)==1:topic={'slot':slots[0]}
        slot=topic.get('slot')
        if slot not in SLOTS:return clarify('你想让我挑选上衣、下装还是鞋子？如果想重搭整套，也可以直接说。')
        i.update(replace_slots=[slot],required_change_slots=[slot],carry_forward_unmentioned=True)
        if not i.get('required_attributes') and topic.get('required_attributes'):i['required_attributes']=deepcopy(topic['required_attributes'])
        i['release_slots']=list(dict.fromkeys([*i['release_slots'],slot]))
        i['keep_directives']=[k for k in i['keep_directives'] if k['slot']!=slot]
        output['base_look']=current
        return output
    previous=context.get('last_modification') or {}
    base=next((v for v in history if v['look_version_id']==previous.get('base_look_version_id')),None)
    if not previous and (context.get('dialogue_topic') or {}).get('base_look_version_id')==current['look_version_id'] and i['replace_slots']:
        # Prior attempts produced no replacement: the verified current outfit is still the baseline.
        i.update(carry_forward_unmentioned=True,required_change_slots=list(dict.fromkeys([*i['required_change_slots'],*i['replace_slots']])))
        output['base_look']=current
        return output
    if previous.get('result_look_version_id')!=current['look_version_id'] or not base:
        return clarify('你是要保留当前搭配的其他单品，还是以之前某一套为基础？请说清是哪一套，我再只换你指定的部分。')
    slots=i['replace_slots']
    if not slots:return clarify(f"你指的是以第 {base['version_no']} 套为基础，具体只换哪一部分？")
    i.update(carry_forward_unmentioned=True,required_change_slots=list(dict.fromkeys([*i['required_change_slots'],*slots])))
    output['base_look']=base
    return output


def record_dialogue(r,state_before,history_before,intent,result,state,history,dialog_before,next_dialog):
    """Store only the latest structured topic and one verifiable modification link."""
    before=dialog_before or {};context=deepcopy(next_dialog or {})
    op=intent['operation'];status=result['status']
    for key in ['dialogue_topic','last_modification','declined_scope_offer']:
        if key not in context and key in before:context[key]=deepcopy(before[key])
    if op=='cancel_pending':
        context.pop('dialogue_topic',None);context.pop('declined_scope_offer',None)
        context.pop('last_catalog_query',None);context.pop('last_catalog_result',None)
        return context or None
    if op=='browse_catalog' and status=='action_completed':
        slots=intent['query_slots']
        if intent['query_target']=='products' and len(slots)==1:
            context['dialogue_topic']={'slot':slots[0],'kind':'catalog','base_look_version_id':state['current_look_version_id'],'required_attributes':[{'slot':slots[0],'attribute_token':token} for token in intent['query_attributes']]}
            offer=context.get('no_match') or {}
            prior_slots=(offer.get('scope_diagnostics') or {}).get('replace_slots',[])
            if offer.get('suggested_relaxation',{}).get('action')=='ask_user_to_expand_scope' and prior_slots and slots[0] not in prior_slots:
                # A different category becomes the active topic; its selection cannot answer
                # the prior category's expansion offer. Budget and size confirmations survive.
                for key in ['no_match','proposal','retry_intent']:context.pop(key,None)
        else:context.pop('dialogue_topic',None)
    elif op=='consult' and status=='action_completed':
        ids=result['action']['inquiry_result']['resolved_sku_ids']
        slots={r.skus[sid]['slot'] for sid in ids}
        if len(slots)==1:context['dialogue_topic']={'slot':next(iter(slots)),'kind':'consult','base_look_version_id':state['current_look_version_id']}
        elif ids:
            context.pop('dialogue_topic',None);context.pop('last_catalog_query',None)
    elif op in ['initial_recommendation','modify_current','restore_history'] and status in ['recommendation','no_match']:
        slots=intent['replace_slots']
        if op=='modify_current' and len(slots)==1:
            context['dialogue_topic']={'slot':slots[0],'kind':'modification','base_look_version_id':state['current_look_version_id'],'required_attributes':deepcopy(intent.get('required_attributes',[]))}
        else:
            context.pop('dialogue_topic',None)
            context.pop('last_catalog_query',None);context.pop('last_catalog_result',None)
        if status=='recommendation':
            if op=='modify_current':
                base=state_before['current_look_version_id']
                if intent.get('scope_reference')=='previous_request':base=(before.get('last_modification') or {}).get('base_look_version_id',base)
                context['last_modification']={'base_look_version_id':base,'result_look_version_id':state['current_look_version_id'],'replace_slots':slots[:]}
            else:context.pop('last_modification',None)
    scope=(result.get('no_match') or {}).get('scope_diagnostics') or {}
    if scope.get('expansion_declined'):
        context['declined_scope_offer']={'signature':scope['request_signature'],'replace_slots':scope['replace_slots'][:],'base_look_version_id':scope['base_look_version_id']}
    elif scope.get('request_signature') and (context.get('declined_scope_offer') or {}).get('signature')!=scope['request_signature']:
        context.pop('declined_scope_offer',None)
    if status=='recommendation':context.pop('declined_scope_offer',None)
    return context or None


def scope_signature(r,state,intent,current):
    """A refusal expires when substantive conditions change, not on repeated wording."""
    constraints=[{k:c[k] for k in ['kind','value','target_slot','strength'] if k in c}
                 for c in state['constraints'] if c['status']=='active' and not (c['kind']=='keep_sku' and c['scope']=='next_recommendation')]
    constraints.sort(key=json_hash)
    inventory=[(sid,sku['price_fen'],sku['sale_status'],r.products[sku['product_id']]['active'],r.stock[sid]['available_qty'],r.stock[sid]['sellable'])
               for sid,sku in sorted(r.skus.items()) if sku['size']==state['profile']['usual_sizes'].get(sku['slot'])]
    return json_hash({'base_items':current['items'],'replace_slots':intent['replace_slots'],'budget':state['context']['budget_max_fen'],
                      'sizes':state['profile']['usual_sizes'],'constraints':constraints,'inventory':inventory,'required_attributes':intent.get('required_attributes',[])})


def explain_no_match(r,state,intent,current,no_match,proposal,target=None,at=None,declined=False,declined_scope=None):
    """Explain local failures and offer only alternatives that the solver verifies."""
    nm=deepcopy(no_match)
    if not current or intent['operation']!='modify_current' or not intent['carry_forward_unmentioned'] or not intent['replace_slots'] or len(intent['replace_slots'])==3:
        return nm,proposal
    slots=intent['replace_slots'];kept=[s for s in SLOTS if s not in slots]
    signature=scope_signature(r,state,intent,current)
    expansion_declined=declined or (declined_scope or {}).get('signature')==signature
    names=lambda values:'、'.join(LABELS[s] for s in values)
    budget=state['context']['budget_max_fen']
    prefix=(f"按你的更正，以第 {current['version_no']} 套为基础，" if current['look_version_id']!=state['current_look_version_id'] else '')+f"本次只换{names(slots)}，保留{names(kept)}，整套预算保持 {budget/100:g} 元。"
    from .consultation import TOKEN_LABELS
    attribute_labels={**TOKEN_LABELS,'color:light':'浅色','color:dark':'深色','color:black':'黑色','color:white':'白色','color:red':'红色'}
    requirements=intent.get('required_attributes',[])
    if requirements:
        rendered=[LABELS[a['slot']]+'须满足'+attribute_labels.get(a['attribute_token'],a['attribute_token'])+'要求' for a in requirements]
        prefix+='；'.join(rendered)+'。'
        if all(r.hit(current,a['attribute_token'],[a['slot']]) for a in requirements):prefix+='当前单品已满足这些属性，本次需要另一款同样符合要求的商品。'
    _,diagnostics,_=solve(r,state,intent,current,target)
    structurally_matching=[]
    for look,failures in diagnostics:
        if all(look['items'][s]!=current['items'][s] if s in slots else look['items'][s]==current['items'][s] for s in SLOTS):
            structurally_matching.append((look,failures))
    matching_sizes=[(l,f) for l,f in structurally_matching if all(r.skus[l['items'][s]]['size']==state['profile']['usual_sizes'].get(s) for s in SLOTS)]
    if not matching_sizes:
        detail='已有完整搭配图还没有覆盖这种局部替换与尺码组合，不能把可售单品当成已有对应的上身图。'
        cause='LOCAL_IMAGE_COVERAGE'
    else:
        failure_sets=[{code for code,_ in failures} for _,failures in matching_sizes]
        if all('INVENTORY_CONFLICT' in failures for failures in failure_sets):
            detail='对应搭配图里的替换商品当前有缺货或下架，暂时不能提供可售的完整方案。';cause='INVENTORY_CONFLICT'
        elif all('BUDGET_CONFLICT' in failures for failures in failure_sets):
            detail='已有对应的局部替换搭配图，但这些组合都超过整套预算。';cause='BUDGET_CONFLICT'
        elif all('REQUIRED_ATTRIBUTE_CONFLICT' in failures for failures in failure_sets):
            detail='现有局部替换图里的其他商品都没有满足上述明确属性，不能换成不符合要求的商品。';cause='REQUIRED_ATTRIBUTE_CONFLICT'
        elif any('KEEP_CONFLICT' in failures for failures in failure_sets):
            detail='已登记的替换组合与当前明确保留条件冲突，需要先得到你的同意才能改变保留范围。';cause='KEEP_CONFLICT'
        else:
            detail='已有相关搭配图，但没有同时满足这次属性要求、排除条件和保留范围的方案。';cause='LOCAL_CONSTRAINT_CONFLICT'
    nm['scope_diagnostics']={'replace_slots':slots[:],'kept_slots':kept,'base_look_version_id':current['look_version_id'],
                             'registered_local_look_count':len(structurally_matching),'matching_size_local_look_count':len(matching_sizes),'cause':cause,
                             'request_signature':signature,'expansion_declined':expansion_declined}
    nm['message']=prefix+detail+'当前方案没有改变。'
    # Preserve an already verified budget offer; no second relaxation is mixed into it.
    if proposal and proposal.get('updates',{}).get('budget_max_fen') is not None:
        nm['message']+=' '+no_match['message']
        return nm,proposal
    # A larger scope is an offer, never an implicit state mutation. Try the smallest addition.
    extra_counts=range(1,len(kept)+1) if not expansion_declined else []
    for extra_count in extra_counts:
        for extras in combinations(kept,extra_count):
            allowed=[s for s in SLOTS if s in slots or s in extras]
            probe=deepcopy(state)
            for constraint in probe['constraints']:
                if constraint['status']=='active' and constraint['kind']=='keep_sku' and constraint.get('target_slot') in allowed:constraint['status']='revoked'
            candidate=deepcopy(intent)
            if candidate.get('scope_reference')=='recent_topic':candidate['scope_reference']=None
            candidate.update(replace_slots=allowed,carry_forward_unmentioned=True,keep_directives=[],
                             release_slots=list(dict.fromkeys([*intent['release_slots'],*allowed])),updates={},
                             relaxation_response=None,confirmation_response=None,accepted=False)
            feasible,_,_=solve(r,probe,candidate,current,target)
            if not feasible:continue
            look=feasible[0]
            nm['scope_diagnostics']['verified_alternative']={'look_id':look['look_id'],'replace_slots':allowed,'total_price_fen':r.total(look)}
            remaining=[s for s in SLOTS if s not in allowed]
            nm['message']+=f"如果你愿意同时更换{names(extras)}"+('、继续保留'+names(remaining) if remaining else '')+f"，已有总价 ¥{r.total(look)/100:g} 的完整搭配图可选。是否允许同时更换{names(extras)}？"
            nm['suggested_relaxation']={'constraint_id':None,'action':'ask_user_to_expand_scope'}
            return nm,candidate
    # A factual read-only option remains useful even if no expanded look is feasible.
    from .catalog import query_catalog
    query=deepcopy(intent);query.update(query_slots=slots[:],query_target='products',query_attributes=[a['attribute_token'] for a in requirements if len(slots)==1 and a['slot']==slots[0]],updates={})
    data,_=query_catalog(r,state,query,at or r.inventory['captured_at'])
    count=data['total_product_count']
    nm['scope_diagnostics']['sellable_product_count']=count
    nm['message']+=(f"可以先查看符合{'本次属性、' if query['query_attributes'] else '当前'}尺码和价格条件的 {count} 款{names(slots)}，再决定是否单件加购；这不会改变其他单品。" if count else f'当前条件下也没有可售的{names(slots)}，可以保留现方案，稍后再查库存。')
    nm['suggested_relaxation']={'constraint_id':None,'action':'ask_user_to_retry_later'}
    return nm,None
