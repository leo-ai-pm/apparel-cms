"""Transactional sessions with optional persistence and bounded conversation context."""
from copy import deepcopy
from contextlib import nullcontext
import threading
import time

from .core import require, new_state, execute, now, instant, json_hash, validate_intent, VERSION, Resources
from .model import CompatibleModel
from .runtime import RequestLimits, redact_text
from .storage import SQLiteStore


class Service:
    def __init__(self,resources,model=None,clock=now,*,db_path=None,remember_messages=False,refresh_factory=None,limits=None):
        self.r=resources;self.model=model or CompatibleModel();self.clock=clock
        self.lock=threading.RLock();self.store=SQLiteStore(db_path) if db_path else None
        self.sessions=self.store.load(self.clock()) if self.store else {}
        self.remember_messages=remember_messages;self.refresh_factory=refresh_factory
        self.limits=limits or RequestLimits()
        self.limits.store=self.store
        if self.store:
            saved=self.store.value('runtime_resources')
            stable_binding=lambda binding:{key:value for key,value in binding.items() if key!='inventory_snapshot_id'}
            if saved and stable_binding(saved['resource_binding'])==stable_binding(resources.binding):
                self.r=resources.clone(saved)
            else:self.store.set_value('runtime_resources',self.r.data)

    def close(self):
        with self.lock:
            if self.store:self.store.close()

    def purge(self):
        at=instant(self.clock())
        for sid in list(self.sessions):
            if instant(self.sessions[sid]['state']['expires_at'])<=at:
                if self.store:self.store.delete(sid)
                del self.sessions[sid]

    def resources(self):
        with self.lock:
            at=self.clock()
            if self.refresh_factory and (instant(self.r.inventory['valid_until'])-instant(at)).total_seconds()<300:
                refreshed=self.refresh_factory(at)
                require(refreshed.data['tenant_id']==self.r.data['tenant_id'],'TENANT_REFERENCE_MISMATCH')
                # Reissue time/version only: do not silently replenish sold-out SKUs from a seed.
                fixture=deepcopy(self.r.data)
                inventory=deepcopy(refreshed.inventory)
                inventory['items']=deepcopy(list(self.r.stock.values()))
                inventory['catalog_version']=fixture['catalog']['catalog_version']
                fixture['inventory_snapshot']=inventory
                fixture['resource_binding']['inventory_snapshot_id']=inventory['inventory_snapshot_id']
                self.r=self.r.clone(fixture)
                if self.store:
                    self.store.set_value('runtime_resources',self.r.data)
                    snapshots=self.store.value('inventory_snapshots',[])
                    snapshots=[entry for entry in snapshots if (instant(at)-instant(entry['snapshot']['captured_at'])).total_seconds()<86400]
                    snapshots.append({'snapshot':self.r.inventory,'resources':self.r.binding,'validated_at':at})
                    self.store.set_value('inventory_snapshots',snapshots)
            self.r.fresh(at)
            return self.r

    def _row(self,sid,owner_id=None):
        self.purge()
        if self.store:
            stored=self.store.get(sid)
            if stored:self.sessions[sid]=stored
            else:self.sessions.pop(sid,None)
        require(sid in self.sessions,'SESSION_NOT_FOUND','会话不存在或已到期，请新建会话。')
        row=self.sessions[sid]
        require(row.get('owner_id')==owner_id,'SESSION_NOT_FOUND','会话不存在或已到期，请新建会话。')
        return row

    def create(self,demo=False,owner_id=None):
        with self.lock:
            self.purge();require(len(self.sessions)<100,'CAPACITY_EXCEEDED','演示会话已满，请结束旧会话。')
            state=new_state(self.r.data['tenant_id'],demo,self.clock())
            row={'state':state,'history':[],'events':[],'cache':{},'cart':[],'pending_intent':None,'dialog_context':None,
                 'conversation_revision':0,'messages':[],'owner_id':owner_id}
            if self.store:self.store.save(row)
            self.sessions[state['session_id']]=row
            return self.view(state['session_id'],owner_id)

    def view(self,sid,owner_id=None):
        with self.lock:
            row=self._row(sid,owner_id)
            return deepcopy({k:row[k] for k in ['state','history','events','cart','messages','conversation_revision']})

    def delete(self,sid,owner_id=None):
        with self.lock:
            if sid not in self.sessions and not self.store:return
            self._row(sid,owner_id)
            if self.store:self.store.delete(sid)
            self.sessions.pop(sid,None)

    def turn(self,sid,body,owner_id=None,*,profile_use=None):
        started=time.monotonic()
        require(type(body) is dict)
        require(set(body)<= {'contract_version','request_id','idempotency_key','turn_id','expected_state_revision','expected_conversation_revision','user_utterance','action','view_context'},'TYPE_INVALID')
        require(body.get('contract_version')==VERSION,'CONTRACT_VERSION_UNSUPPORTED')
        for key in ['request_id','idempotency_key','turn_id']:require(type(body.get(key)) is str and 0<len(body[key])<=128)
        require(type(body.get('expected_state_revision')) is int)
        if 'expected_conversation_revision' in body:require(type(body['expected_conversation_revision']) is int and body['expected_conversation_revision']>=0)
        require(('action' in body) != ('user_utterance' in body))
        if 'user_utterance' in body:require(type(body['user_utterance']) is str and 0<len(body['user_utterance'].strip())<=3000)
        if 'view_context' in body:
            view=body['view_context']
            require(type(view) is dict and set(view)=={'look_version_id'})
            require(view['look_version_id'] is None or (type(view['look_version_id']) is str and 0<len(view['look_version_id'])<=128))
        digest=json_hash(body if profile_use is None else {'body':body,'profile_use':profile_use});key=body['idempotency_key']
        with self.lock:
            row=self._row(sid,owner_id)
            if key in row['cache']:
                cached=row['cache'][key];require(cached[0]==digest,'IDEMPOTENCY_CONFLICT');return deepcopy(cached[1])
            require(row['state']['state_revision']==body['expected_state_revision'],'STATE_REVISION_CONFLICT','另一条请求已更新方案，请刷新后重试。')
            require(body.get('expected_conversation_revision',row['conversation_revision'])==row['conversation_revision'],'STATE_REVISION_CONFLICT','另一条请求已更新对话，请刷新后重试。')
            require(len(row['cache'])<200,'CAPACITY_EXCEEDED','当前会话已达到 200 轮上限，请新建会话；已有聊天仍可查看。')
            if 'view_context' in body:
                target=body['view_context']['look_version_id']
                require(target is None or any(v['look_version_id']==target for v in row['history']),'REFERENCE_NOT_FOUND','查看的搭配不属于当前会话。')
            self.limits.check(owner_id or sid,instant(self.clock()).timestamp(),'user_utterance' in body and not hasattr(self.model,'call_accounting'))
            snapshot=deepcopy(row);resources=self.resources()
        original_snapshot=deepcopy(snapshot)
        if profile_use is not None:
            from .profile_context import apply_frozen
            snapshot['state']=apply_frozen(snapshot['state'],profile_use,body['turn_id'],self.clock())
        dialog=deepcopy(snapshot.get('dialog_context') or {})
        if self.remember_messages:
            recent=deepcopy(snapshot['messages'][-20:])
            while len(recent)>2 and sum(len(message['content']) for message in recent)>16000:
                del recent[:2]
            dialog['recent_messages']=recent
        if 'view_context' in body:dialog['view_context']=deepcopy(body['view_context'])
        if 'action' in body:
            action=body['action'];require(type(action) is dict)
            allowed={'operation','inquiry','quantity','cart_size','accepted'} if action.get('operation')=='add_item_to_cart' else {'operation','target_look_version_id'}
            require(set(action)<=allowed)
            require(action.get('operation') in ['view_history','restore_history','add_bundle_to_cart','add_item_to_cart'],'ENUM_INVALID')
            intent=validate_intent(action,resources);meta={'mode':'deterministic_action','model':None,'input_tokens':0,'output_tokens':0,'tool_calls':0,'retries':0,'cost':0}
        else:
            self.limits.acquire()
            accounting=self.model.call_accounting(lambda:self.limits.count_model_call(instant(self.clock()).timestamp())) if hasattr(self.model,'call_accounting') else nullcontext()
            try:
                with accounting:intent,meta=self.model.parse(body['user_utterance'],snapshot['state'],snapshot['history'],resources,dialog or None)
            finally:self.limits.release()
        result=execute(resources,snapshot['state'],snapshot['history'],intent,body['turn_id'],body['request_id'],self.clock(),snapshot.get('pending_intent'),dialog or None)
        if profile_use is not None:
            from .profile_context import finish
            result=finish(result,intent,profile_use,original_snapshot['state'],len(snapshot['history']),self.clock())
        with self.lock:
            row=self._row(sid,owner_id)
            if key in row['cache']:
                require(row['cache'][key][0]==digest,'IDEMPOTENCY_CONFLICT');return deepcopy(row['cache'][key][1])
            require(row['conversation_revision']==original_snapshot['conversation_revision'] and row['state']==original_snapshot['state'],'STATE_REVISION_CONFLICT','对话已变化，请刷新后重试。')
            resources.fresh(self.clock())
            committed=deepcopy(row)
            committed['pending_intent']=result.pop('pending_intent',None)
            committed['dialog_context']=result.pop('dialog_context',None)
            if committed['dialog_context']:
                committed['dialog_context'].pop('recent_messages',None)
                # Viewing focus is supplied by each request; never persist a stale screen focus.
                committed['dialog_context'].pop('view_context',None)
            committed['state']=result['state'];committed['history']=result['history'];committed['events'].extend(result['events'])
            if result['cart_added_sku_ids']:committed['cart'].append(deepcopy(result['decision']['action']))
            if self.remember_messages:
                user_text=body.get('user_utterance') or {'view_history':'查看搭配历史','restore_history':'恢复历史搭配','add_bundle_to_cart':'整套模拟加购','add_item_to_cart':'单件模拟加购'}[body['action']['operation']]
                committed['messages'].extend([{'role':'user','content':redact_text(user_text)},
                                               {'role':'assistant','content':redact_text(result['response']['text'])}])
            committed['conversation_revision']+=1
            result['conversation_revision']=committed['conversation_revision']
            result['cart']=deepcopy(committed['cart'])
            result['metrics']=dict(meta,total_duration_ms=round((time.monotonic()-started)*1000))
            committed['cache'][key]=(digest,deepcopy(result))
            if self.store:self.store.save(committed,expected=snapshot['conversation_revision'])
            self.sessions[sid]=committed
            return deepcopy(result)
