"""Frozen profile preparations shared with the admission transaction; no model IO."""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta
from sqlalchemy import select, update, text
from sqlalchemy.exc import SQLAlchemyError
from app.models.chat import ChatSession
from app.core.consumer_context import validate_authorization
from app.core.database import SessionLocal
from app.models.profile_snapshot import ConsumerProfileSnapshot, ConsumerSessionOwner
from app.models.tryon import utcnow
from app.schemas.profile_snapshot import ProfileBinding, ProfilePrepareRequest, RequestConditions
from app.schemas.consumer_profile import ProfileError
from app.services.consumer_profiles import read_profile


def _error(code, message, status=409):
    raise ProfileError(code, message, status)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def body_digest(body):
    # Raw validated JSON, not a model dump which could invent absent/default fields.
    return hashlib.sha256(_json({k:v for k,v in body.items() if k != 'profile_binding'}).encode()).hexdigest()


def _lock(db):
    if db.bind.dialect.name == 'sqlite':
        db.execute(text('BEGIN IMMEDIATE'))


def _authorize(db, owner, authorization):
    # Trusted adapters also revalidate inside an actual transaction; an owner
    # reference alone never authenticates a public preparation/read/replay.
    if not db.in_transaction():
        if db.bind.dialect.name == 'sqlite':
            # sqlite3 legacy transaction mode does not BEGIN for SELECT.
            # Pin authorization and the following private reads to one view.
            db.execute(text('BEGIN'))
        else:
            db.begin()
    validate_authorization(db, owner, authorization)


def _binding(row):
    return {'snapshot_id':row.snapshot_id,'profile_id':row.profile_id,
            'profile_version':row.profile_version,'snapshot_digest':row.snapshot_digest}


def _snapshot(row):
    return {**json.loads(row.snapshot_json), 'state':row.state,
            'created_at':row.created_at.isoformat()+'Z', 'expires_at':row.expires_at.isoformat()+'Z',
            'effective_profile_snapshot':json.loads(row.effective_json) if row.effective_json else None}


def authorize_session(owner, session_id, *, db=None):
    if db is None:
        with SessionLocal() as local:
            return authorize_session(owner,session_id,db=local)
    owned=db.get(ConsumerSessionOwner,session_id)
    if owned is not None and owned.owner_key != owner.binding_key:
        _error('PROFILE_SCOPE_FORBIDDEN','该会话不属于当前资料空间。',404)


def register_created_session(owner, session_id):
    """Only a freshly created server session may use this internal helper."""
    with SessionLocal() as db:
        _lock(db)
        authorize_session(owner,session_id,db=db)
        if db.get(ConsumerSessionOwner,session_id) is None:
            db.add(ConsumerSessionOwner(session_id=session_id,owner_key=owner.binding_key))
        db.commit()


def _current(session_id, status):
    # Read live state only; never restore defaults from a historical LookVersion.
    from app.services import fixed_styling as fixed
    if not fixed.enabled():
        return {},{},{}
    try:
        view=fixed.session_view(session_id)
    except fixed.FixedStylingError as exc:
        if exc.code == 'SESSION_NOT_FOUND':
            return {},{},{}
        _error('PROFILE_PREPARE_UNAVAILABLE','当前会话条件暂时不可读取，请稍后重试。',503)
    state=view.get('state',{});sources=view.get('profile_field_sources',state.get('profile_field_sources',{}))
    profile=state.get('profile',{});context=state.get('context',{})
    sizes=profile.get('usual_sizes',{})
    retained={};conditions={};picked={}
    def explicit(field):
        return sources.get(field) in ('explicit_text','explicit_selection','current_request') or (not sources and status not in ('cleared','expired'))
    for slot in ('top','bottom','shoes'):
        path='usual_sizes.'+slot
        if sizes.get(slot) is not None and explicit(path):
            retained[slot]=sizes[slot];picked[path]='current_request'
    for field in ('scene','budget_max_fen'):
        if context.get(field) is not None and explicit(field):
            conditions[field]=context[field];picked[field]='current_request'
    return {'usual_sizes':retained},conditions,picked


def _canonical_scene(value):
    # Explicit aliases only; unrelated scenarios never become commute by guess.
    aliases={'通勤':'scene:work_commute','日常通勤':'scene:work_commute','style:commute':'scene:work_commute'}
    canonical=aliases.get(value,value)
    from app.services import fixed_styling as fixed
    allowed={'scene:work_commute'}
    if fixed.enabled():
        _,core=fixed._m2()
        vocabulary=core.demo_resources(save=False).vocab
        allowed={token for token in vocabulary['tokens'] if token.startswith('scene:')}
    if canonical not in allowed:
        _error('PROFILE_INVALID_SCENE','该场景选择尚未进入当前资源词表，请保留自然语言表达。',422)
    return canonical


def _validated_body(req):
    body=req.request_body
    if 'profile_binding' in body:
        _error('PROFILE_INVALID_REQUEST','准备输入不应带旧绑定；重试应直接发送已保存原体。',422)
    identity_key='action_id' if req.operation=='restore' else 'request_id'
    if body.get(identity_key) != req.request_id or (req.operation=='chat' and body.get('session_id') != req.session_id):
        _error('PROFILE_REQUEST_ID_MISMATCH','准备身份与当次请求不一致。',422)
    if req.operation=='chat':
        from app.schemas.chat import ChatRequest
        if set(body)-set(ChatRequest.model_fields):
            _error('PROFILE_INVALID_REQUEST','聊天准备含未约定字段。',422)
        ChatRequest.model_validate(body)
    elif req.operation=='restore':
        if body.get('operation') != 'restore_history':
            _error('PROFILE_INVALID_REQUEST','恢复准备仅适用于明确恢复历史。',422)
        allowed={'action_id','operation','target_look_version_id','expected_state_revision','expected_conversation_revision','request_conditions'}
        target=body.get('target_look_version_id')
        if set(body)-allowed or not isinstance(target,str) or not 0<len(target)<150:
            _error('PROFILE_INVALID_REQUEST','恢复准备字段无效。',422)
        for field in ('expected_state_revision','expected_conversation_revision'):
            if type(body.get(field)) is not int or body[field]<0:
                _error('PROFILE_INVALID_REQUEST','恢复版本字段无效。',422)
    else:
        allowed={'contract_version','request_id','idempotency_key','turn_id','expected_state_revision','expected_conversation_revision','user_utterance','view_context','request_conditions'}
        if set(body)-allowed or body.get('contract_version')!='0.1.0' or not isinstance(body.get('user_utterance'),str) or not body['user_utterance'].strip():
            _error('PROFILE_INVALID_REQUEST','自然语言准备字段无效。',422)
        if len(body['user_utterance'])>3000 or body.get('idempotency_key') != req.request_id:
            _error('PROFILE_INVALID_REQUEST','自然语言请求身份或长度无效。',422)
        if not isinstance(body.get('turn_id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',body['turn_id']):
            _error('PROFILE_INVALID_REQUEST','轮次身份无效。',422)
        for field in ('expected_state_revision','expected_conversation_revision'):
            if type(body.get(field)) is not int or body[field]<0:
                _error('PROFILE_INVALID_REQUEST','请求版本字段无效。',422)
        if 'view_context' in body and (not isinstance(body['view_context'],dict) or set(body['view_context'])-{'look_version_id','selected_item_ids'}):
            _error('PROFILE_INVALID_REQUEST','页面上下文字段无效。',422)
        if 'view_context' in body:
            view=body['view_context'];look=view.get('look_version_id')
            if 'look_version_id' not in view or (look is not None and (not isinstance(look,str) or not 0<len(look)<=128)):
                _error('PROFILE_INVALID_REQUEST','页面版本字段无效。',422)
            if 'selected_item_ids' in view and (not isinstance(view['selected_item_ids'],list) or not all(isinstance(v,str) for v in view['selected_item_ids'])):
                _error('PROFILE_INVALID_REQUEST','页面单品字段无效。',422)
    conditions=RequestConditions.model_validate(body.get('request_conditions') or {})
    explicit=conditions.model_dump(exclude_unset=True)
    if explicit.get('scene') is not None:explicit['scene']=_canonical_scene(explicit['scene'])
    return explicit


def prepare(owner, body, *, authorization):
    req=ProfilePrepareRequest.model_validate(body)
    explicit=_validated_body(req);fingerprint=body_digest(req.request_body)
    with SessionLocal() as db:
        _lock(db);_authorize(db,owner,authorization);authorize_session(owner,req.session_id,db=db)
        old=db.scalar(select(ConsumerProfileSnapshot).where(ConsumerProfileSnapshot.owner_key==owner.binding_key, ConsumerProfileSnapshot.request_id==req.request_id))
        if old:
            if old.body_digest!=fingerprint or old.session_id!=req.session_id or old.operation!=req.operation:
                _error('PROFILE_REQUEST_CONFLICT','该请求编号已用于其他输入，请重新确认。')
            _qualification(old)
            return {'profile_binding':_binding(old),'snapshot':_snapshot(old),'duplicate':True}
        if db.get(ConsumerSessionOwner,req.session_id) is None:
            # A public legacy ID is not proof of ownership. Never claim an old
            # demo conversation or move its history into an anonymous profile.
            legacy=db.get(ChatSession,req.session_id) is not None
            from app.services import fixed_styling as fixed
            if fixed.enabled():
                try:
                    fixed.session_view(req.session_id)
                    legacy=True
                except fixed.FixedStylingError as exc:
                    if exc.code!='SESSION_NOT_FOUND':
                        _error('PROFILE_PREPARE_UNAVAILABLE','会话资格暂时不可检查。',503)
            if legacy:
                _error('PROFILE_SESSION_RESTART_REQUIRED','旧演示会话没有资料归属，请明确开始一个新会话。')
        saved=read_profile(owner,db=db)
        base=saved.get('base_profile') or {};status=saved.get('status','empty')
        # Height/weight are saved in the profile but not inputs to this MVP's fit
        # solver. Avoid repeating unused body measurements in every snapshot.
        sizes={slot:value for slot,value in (base.get('usual_sizes') or {}).items() if value is not None}
        effective={'usual_sizes':sizes};conditions={};sources={'usual_sizes.'+slot:'saved_profile' for slot in sizes}
        if saved.get('default_budget_fen') is not None:
            conditions['budget_max_fen']=saved['default_budget_fen'];sources['budget_max_fen']='saved_profile'
        current,current_conditions,current_sources=_current(req.session_id,status)
        effective['usual_sizes'].update(current.get('usual_sizes',{}));conditions.update(current_conditions);sources.update(current_sources)
        overrides=explicit.get('request_profile_overrides') or {}
        for slot,value in (overrides.get('usual_sizes') or {}).items():
            effective['usual_sizes'][slot]=value;sources['usual_sizes.'+slot]='explicit_selection'
        for field in ('scene','budget_max_fen'):
            if field in explicit:
                if explicit[field] is None:conditions.pop(field,None);sources.pop(field,None)
                else:conditions[field]=explicit[field];sources[field]='explicit_selection'
        if req.operation=='chat':
            if req.request_body.get('scene'):
                conditions['scene']=_canonical_scene(req.request_body['scene']);sources['scene']='explicit_selection'
            budget=req.request_body.get('budget','')
            if budget:
                if not re.fullmatch(r'[0-9]+(?:\.[0-9]{1,2})?',budget):
                    _error('PROFILE_INVALID_REQUEST','预算请使用明确人民币金额。',422)
                from decimal import Decimal
                amount=int(Decimal(budget)*100)
                if not 0<amount<=100000000:_error('PROFILE_INVALID_REQUEST','预算超出有效范围。',422)
                conditions['budget_max_fen']=amount;sources['budget_max_fen']='explicit_selection'
        now=utcnow()
        try:
            ttl=int(os.getenv('STYLING_PROFILE_PREPARE_TTL_SECONDS','86400'))
        except ValueError:
            _error('PROFILE_STORAGE_UNAVAILABLE','资料准备期限配置无效。',503)
        if not 60<=ttl<=604800:_error('PROFILE_STORAGE_UNAVAILABLE','资料准备期限配置无效。',503)
        sid='ps-'+uuid.uuid4().hex
        payload={'profile_contract':'consumer_profile_v1','snapshot_id':sid,'bound_request_id':req.request_id,
                 'profile_id':saved.get('profile_id'),'profile_version':saved.get('profile_version',0),
                 'base_profile':effective,'conditions':conditions,'field_sources':sources,
                 'explicit_overrides':{'usual_sizes':overrides.get('usual_sizes',{})},'profile_status':status}
        digest=hashlib.sha256(_json({'owner':owner.binding,'body_digest':fingerprint,'snapshot':payload}).encode()).hexdigest()
        payload['snapshot_digest']=digest
        expires_at=now+timedelta(seconds=ttl)
        if saved.get('expires_at'):
            profile_expiry=datetime.fromisoformat(saved['expires_at'].replace('Z','+00:00')).replace(tzinfo=None)
            expires_at=min(expires_at,profile_expiry)
        row=ConsumerProfileSnapshot(snapshot_id=sid,owner_key=owner.binding_key,session_id=req.session_id,request_id=req.request_id,
             operation=req.operation,profile_id=saved.get('profile_id'),profile_version=saved.get('profile_version',0),
             body_digest=fingerprint,snapshot_digest=digest,snapshot_json=_json(payload),expires_at=expires_at)
        db.add(row)
        if db.get(ConsumerSessionOwner,req.session_id) is None:db.add(ConsumerSessionOwner(session_id=req.session_id,owner_key=owner.binding_key))
        db.commit()
        return {'profile_binding':_binding(row),'snapshot':_snapshot(row),'duplicate':False}


def _qualification(row):
    if row.state=='accepted':return
    if row.state=='invalidated':_error(row.invalidation_reason or 'PROFILE_SNAPSHOT_INVALIDATED','原资料准备已清除，请重新确认本次条件。')
    if row.expires_at <= utcnow():_error('PROFILE_SNAPSHOT_EXPIRED','原资料准备已过期，请重新确认本次条件。')


def validate_binding(db,owner,session_id,request_id,binding,request_body,accept=False,expected_operation=None,*,authorization):
    _authorize(db,owner,authorization)
    binding=ProfileBinding.model_validate(binding).model_dump()
    row=db.get(ConsumerProfileSnapshot,binding['snapshot_id'])
    if row is None or row.owner_key!=owner.binding_key:
        _error('PROFILE_SNAPSHOT_NOT_FOUND','资料准备不存在或不属于当前空间。',404)
    if (row.session_id!=session_id or row.request_id!=request_id or binding!=_binding(row)
            or row.body_digest!=body_digest(request_body)
            or (expected_operation is not None and row.operation!=expected_operation)):
        _error('PROFILE_REQUEST_CONFLICT','原编号、绑定与本次内容不一致，请重新确认。')
    authorize_session(owner,session_id,db=db);_qualification(row)
    if accept and row.state!='accepted':row.state='accepted';row.accepted_at=utcnow()
    return json.loads(row.snapshot_json)


def accept_binding(db,owner,session_id,request_id,binding,request_body,expected_operation=None,*,authorization):
    return validate_binding(db,owner,session_id,request_id,binding,request_body,accept=True,
                            expected_operation=expected_operation,authorization=authorization)


def replay(owner,session_id,request_id,binding,request_body,*,authorization):
    with SessionLocal() as db:
        validate_binding(db,owner,session_id,request_id,binding,request_body,authorization=authorization)
        row=db.get(ConsumerProfileSnapshot,binding['snapshot_id'])
        if row.state!='accepted' or row.operation=='restore':return None
        from app.services import generation
        return generation.lookup(request_id,session_id)


def get_use(owner,session_id,request_id,binding):
    # Internal execution only: acceptance already fixed the authorized owner and
    # inputs. Clear/revocation later cannot replace those inputs or cancel work.
    binding=ProfileBinding.model_validate(binding).model_dump()
    with SessionLocal() as db:
        row=db.get(ConsumerProfileSnapshot,binding['snapshot_id'])
        if row is None or row.owner_key!=owner.binding_key or row.session_id!=session_id or row.request_id!=request_id:
            _error('PROFILE_SNAPSHOT_NOT_FOUND','资料准备不存在。',404)
        if binding!=_binding(row) or row.state!='accepted':
            _error('PROFILE_REQUEST_CONFLICT','当次绑定尚未受理或内容已改变。')
        authorize_session(owner,session_id,db=db)
        return json.loads(row.snapshot_json)


def invalidate_prepared(db,owner,reason='PROFILE_CLEARED'):
    db.execute(update(ConsumerProfileSnapshot).where(ConsumerProfileSnapshot.owner_key==owner.binding_key,ConsumerProfileSnapshot.state=='prepared').values(state='invalidated',invalidation_reason=reason))


def authorize_request(owner,session_id,request_id,*,authorization):
    with SessionLocal() as db:
        _authorize(db,owner,authorization)
        authorize_session(owner,session_id,db=db)
        rows=db.scalars(select(ConsumerProfileSnapshot).where(ConsumerProfileSnapshot.request_id==request_id,ConsumerProfileSnapshot.session_id==session_id)).all()
        if rows and not any(r.owner_key==owner.binding_key for r in rows):_error('PROFILE_SCOPE_FORBIDDEN','请求不属于当前资料空间。',404)


def record_effective(snapshot_id,effective_payload):
    # Never propagate unused body measurements or raw dialogue into generic data.
    sizes=effective_payload.get('base_profile',{}).get('usual_sizes',{})
    conditions=effective_payload.get('conditions',{})
    allowed={'usual_sizes.top','usual_sizes.bottom','usual_sizes.shoes','scene','budget_max_fen'}
    sources=effective_payload.get('field_sources',{})
    effective={'base_profile':{'usual_sizes':{k:v for k,v in sizes.items() if k in ('top','bottom','shoes')}},
               'conditions':{k:v for k,v in conditions.items() if k in ('scene','budget_max_fen')},
               'field_sources':{k:v for k,v in sources.items() if k in allowed and v in ('explicit_text','explicit_selection','current_request','saved_profile')}}
    encoded=_json(effective)
    with SessionLocal() as db:
        _lock(db);row=db.get(ConsumerProfileSnapshot,snapshot_id)
        if row is None or row.state!='accepted':_error('PROFILE_SNAPSHOT_NOT_ACCEPTED','当次资料尚未正式绑定。')
        if row.effective_json and row.effective_json!=encoded:_error('PROFILE_EFFECTIVE_CONFLICT','当次有效资料不能改写。')
        row.effective_json=encoded;db.commit()


def snapshot_summary(snapshot_id):
    with SessionLocal() as db:
        row=db.get(ConsumerProfileSnapshot,snapshot_id)
        if row is None:return None
        p=json.loads(row.effective_json or row.snapshot_json)
        return {'profile_contract':'consumer_profile_v1',**_binding(row),'recorded':True,'field_sources':p['field_sources']}


def lookup_snapshot(owner,snapshot_id,*,authorization):
    try:
        with SessionLocal() as db:
            _authorize(db,owner,authorization)
            row=db.get(ConsumerProfileSnapshot,snapshot_id)
            if row is None or row.owner_key!=owner.binding_key:_error('PROFILE_SNAPSHOT_NOT_FOUND','资料准备不存在。',404)
            return {'profile_binding':_binding(row),'snapshot':_snapshot(row)}
    except SQLAlchemyError:
        _error('PROFILE_STORAGE_UNAVAILABLE','资料准备存储暂不可用，请保留原编号。',503)
