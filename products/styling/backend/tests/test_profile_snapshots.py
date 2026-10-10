"""Admission preparations use isolated SQLite and do not invoke any model."""
import json
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.consumer_identity import ConsumerOwner
from app.models.chat import Base, ChatSession
from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.models.profile_snapshot import ConsumerProfileSnapshot, ConsumerSessionOwner
from app.models.consumer_profile import SavedConsumerProfile
from app.models.tryon import utcnow
from app.schemas.consumer_profile import ProfileError, ProfileMutation
from app.services import consumer_profiles, profile_snapshots as snap
from tests.profile_context_fixture import device_authorization, service_mutation

SIZES={'top':{'system':'clothing_alpha','value':'M'},'bottom':{'system':'clothing_alpha','value':'M'},'shoes':{'system':'cn_shoe','value':'38'}}


@pytest.fixture
def env(tmp_path,monkeypatch):
    engine=create_engine(f'sqlite:///{tmp_path}/snapshot.db',connect_args={'check_same_thread':False})
    Base.metadata.create_all(engine)
    factory=sessionmaker(bind=engine,autoflush=False)
    monkeypatch.setattr(snap,'SessionLocal',factory)
    monkeypatch.setattr(consumer_profiles,'SessionLocal',factory)
    monkeypatch.setenv('STYLING_FIXED_ENABLED','0')
    monkeypatch.setenv('CONSUMER_APP_SCOPE','snapshot_test')
    owner=ConsumerOwner('snapshot_test','device','a')
    device_authorization(owner,factory)
    yield factory,owner
    engine.dispose()


def mutate(owner,action='save',version=0,operation='save',patch=None):
    return service_mutation(owner,{
        'profile_action_id':action,'operation':operation,'expected_profile_version':version,
        'explicit_save':True,'explicit_default_budget':True,
        'patch':patch if patch is not None else {'base_profile':{'usual_sizes':SIZES},'default_budget_fen':80000}}, consumer_profiles.SessionLocal)


def preparation(owner,rid='request-a',sid='session-a',**extras):
    body={'request_id':rid,'session_id':sid,'message':'秋天通勤搭配',**extras}
    result=snap.prepare(owner,{'operation':'chat','session_id':sid,'request_id':rid,'request_body':body},authorization=authorization(owner))
    return result,{**body,'profile_binding':result['profile_binding']}


def accept(factory,owner,body):
    proof=device_authorization(owner,factory)
    with factory() as db:
        snap._lock(db)
        result=snap.accept_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,expected_operation='chat',authorization=proof)
        db.commit()
        return result


def authorization(owner):
    return device_authorization(owner,consumer_profiles.SessionLocal)


def test_preparation_uses_saved_values_but_never_creates_business_records(env):
    factory,owner=env
    mutate(owner)
    p,body=preparation(owner)
    assert p['snapshot']['base_profile']['usual_sizes']==SIZES
    assert p['snapshot']['conditions']=={'budget_max_fen':80000}
    assert p['snapshot']['field_sources']['usual_sizes.top']=='saved_profile'
    assert p['snapshot']['profile_version']==1
    assert 'height_cm' not in json.dumps(p) and 'weight_kg' not in json.dumps(p)
    with factory() as db:
        assert db.query(DemandTurn).count()==db.query(GenerationRequest).count()==0
        assert db.query(ConsumerProfileSnapshot).count()==1
        assert db.get(ConsumerSessionOwner,body['session_id']).owner_key==owner.binding_key


def test_original_body_absent_defaults_remains_valid(env):
    factory,owner=env
    p,body=preparation(owner)
    accepted=accept(factory,owner,body)
    assert accepted['profile_version']==0
    assert snap.get_use(owner,body['session_id'],body['request_id'],body['profile_binding'])==accepted
    with factory() as db:
        with pytest.raises(ProfileError,match='原编号'):
            snap.validate_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],{**body,'budget':''},authorization=authorization(owner))


def test_update_v2_does_not_change_prepared_v1_or_original_retry(env):
    factory,owner=env
    mutate(owner)
    first,body=preparation(owner)
    mutate(owner,action='update',version=1,operation='update',patch={'default_budget_fen':50000})
    same,_=preparation(owner)
    assert same['duplicate'] and same['profile_binding']==first['profile_binding']
    assert same['snapshot']['conditions']['budget_max_fen']==80000
    assert accept(factory,owner,body)['profile_version']==1
    fresh,_=preparation(owner,rid='fresh',sid='fresh-session')
    assert fresh['snapshot']['profile_version']==2
    assert fresh['snapshot']['conditions']['budget_max_fen']==50000


def test_explicit_selection_overrides_saved_without_rewriting_defaults(env):
    _,owner=env
    mutate(owner)
    p,_=preparation(owner,request_conditions={'budget_max_fen':50000,'scene':'scene:work_commute','request_profile_overrides':{'usual_sizes':{'shoes':{'system':'cn_shoe','value':'39'}}}})
    assert p['snapshot']['conditions']['budget_max_fen']==50000
    assert p['snapshot']['base_profile']['usual_sizes']['shoes']['value']=='39'
    assert p['snapshot']['field_sources']['usual_sizes.shoes']=='explicit_selection'
    assert consumer_profiles.read_profile(owner)['base_profile']['usual_sizes']['shoes']['value']=='38'


def test_clear_invalidates_unaccepted_but_preserves_accepted(env):
    factory,owner=env
    mutate(owner)
    accepted,body=preparation(owner)
    accept(factory,owner,body)
    pending,pbody=preparation(owner,rid='pending',sid='pending-session')
    mutate(owner,action='clear',version=1,operation='clear',patch={})
    assert snap.get_use(owner,body['session_id'],body['request_id'],body['profile_binding'])['profile_version']==1
    with factory() as db:
        snap.validate_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,authorization=authorization(owner))
        with pytest.raises(ProfileError) as error:
            snap.validate_binding(db,owner,pbody['session_id'],pbody['request_id'],pbody['profile_binding'],pbody,authorization=authorization(owner))
        assert error.value.code=='PROFILE_CLEARED'
    new,_=preparation(owner,rid='new',sid='new-session')
    assert new['snapshot']['base_profile']['usual_sizes']=={}
    assert new['snapshot']['conditions']=={}


def test_single_null_clear_conservatively_invalidates_all_unaccepted(env):
    factory,owner=env
    mutate(owner)
    p,body=preparation(owner)
    mutate(owner,action='partial-clear',version=1,operation='update',patch={'base_profile':{'usual_sizes':{'top':None}}})
    with factory() as db:
        assert db.get(ConsumerProfileSnapshot,p['profile_binding']['snapshot_id']).state=='invalidated'


def test_expiry_requires_reconfirmation_but_accepted_snapshot_survives(env):
    factory,owner=env
    p,body=preparation(owner)
    with factory() as db:
        db.get(ConsumerProfileSnapshot,p['profile_binding']['snapshot_id']).expires_at=utcnow()-timedelta(seconds=1)
        db.commit()
    with factory() as db,pytest.raises(ProfileError) as error:
        snap.validate_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,authorization=authorization(owner))
    assert error.value.code=='PROFILE_SNAPSHOT_EXPIRED'


@pytest.mark.parametrize('change',[{'message':'变了'},{'budget':''},{'profile_binding':{'snapshot_id':'bad','profile_id':None,'profile_version':0,'snapshot_digest':'a'*64}}])
def test_binding_rejects_changed_body_or_binding(env,change):
    factory,owner=env
    _,body=preparation(owner)
    changed={**body,**change}
    with factory() as db,pytest.raises(ProfileError):
        snap.validate_binding(db,owner,body['session_id'],body['request_id'],changed['profile_binding'],changed,authorization=authorization(owner))


def test_two_owner_session_and_snapshot_isolation(env):
    factory,owner=env
    p,body=preparation(owner)
    other=ConsumerOwner('snapshot_test','device','b')
    with pytest.raises(ProfileError) as err:
        preparation(other,rid='other')
    assert err.value.code=='PROFILE_SCOPE_FORBIDDEN'
    with pytest.raises(ProfileError):
        snap.lookup_snapshot(other,p['profile_binding']['snapshot_id'],authorization=authorization(other))
    with factory() as db,pytest.raises(ProfileError):
        snap.validate_binding(db,other,body['session_id'],body['request_id'],body['profile_binding'],body,authorization=authorization(other))


def test_legacy_public_session_cannot_be_claimed(env):
    factory,owner=env
    with factory() as db:
        db.add(ChatSession(id='session-a'));db.commit()
    with pytest.raises(ProfileError) as err:
        preparation(owner)
    assert err.value.code=='PROFILE_SESSION_RESTART_REQUIRED'
    with factory() as db:
        assert db.query(ConsumerSessionOwner).count()==db.query(ConsumerProfileSnapshot).count()==0


def test_effective_snapshot_immutable_and_restricted(env):
    factory,owner=env
    p,body=preparation(owner)
    accept(factory,owner,body)
    payload={'base_profile':{'usual_sizes':SIZES,'height_cm':168},'conditions':{'scene':'scene:work_commute','raw_text':'private'},'field_sources':{'scene':'explicit_text','height_cm':'explicit_text'}}
    sid=p['profile_binding']['snapshot_id']
    snap.record_effective(sid,payload);snap.record_effective(sid,payload)
    summary=snap.snapshot_summary(sid)
    assert summary['field_sources']=={'scene':'explicit_text'}
    assert 'height_cm' not in json.dumps(snap.lookup_snapshot(owner,sid,authorization=authorization(owner)))
    assert 'raw_text' not in json.dumps(snap.lookup_snapshot(owner,sid,authorization=authorization(owner)))
    with pytest.raises(ProfileError) as err:
        snap.record_effective(sid,{**payload,'conditions':{'budget_max_fen':50000}})
    assert err.value.code=='PROFILE_EFFECTIVE_CONFLICT'


def test_atomic_acceptance_rollback_leaves_prepared(env):
    factory,owner=env
    p,body=preparation(owner)
    with pytest.raises(RuntimeError):
        with factory() as db:
            snap._lock(db)
            snap.accept_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,authorization=authorization(owner))
            raise RuntimeError('injected admission failure')
    with factory() as db:
        assert db.get(ConsumerProfileSnapshot,p['profile_binding']['snapshot_id']).state=='prepared'


def test_concurrent_same_preparation_is_one_row(env):
    factory,owner=env
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers=list(pool.map(lambda _:preparation(owner)[0],range(2)))
    assert answers[0]['profile_binding']==answers[1]['profile_binding']
    assert sorted(x['duplicate'] for x in answers)==[False,True]
    with factory() as db:
        assert db.query(ConsumerProfileSnapshot).count()==1


def test_other_endpoint_cannot_accept_chat_binding(env):
    factory,owner=env
    _,body=preparation(owner)
    with factory() as db,pytest.raises(ProfileError):
        snap.accept_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,expected_operation='restore',authorization=authorization(owner))
    with pytest.raises(ProfileError) as err:
        snap.prepare(owner,{'operation':'restore','session_id':'new-restore','request_id':'bad-restore',
                           'request_body':{'action_id':'bad-restore','operation':'restore_history','target_look_version_id':42,
                                           'expected_state_revision':0,'expected_conversation_revision':0}},authorization=authorization(owner))
    assert err.value.code=='PROFILE_INVALID_REQUEST' and err.value.status==422
    with factory() as db:
        assert db.query(ConsumerProfileSnapshot).count()==1


def test_preparation_cannot_outlive_frozen_profile_retention(env,monkeypatch):
    factory,owner=env
    mutate(owner)
    deadline=utcnow()+timedelta(minutes=1)
    with factory() as db:
        db.query(SavedConsumerProfile).one().expires_at=deadline;db.commit()
    p,body=preparation(owner)
    with factory() as db:
        assert db.get(ConsumerProfileSnapshot,p['profile_binding']['snapshot_id']).expires_at==deadline
    monkeypatch.setattr(snap,'utcnow',lambda:deadline+timedelta(seconds=1))
    with factory() as db,pytest.raises(ProfileError) as err:
        snap.accept_binding(db,owner,body['session_id'],body['request_id'],body['profile_binding'],body,authorization=authorization(owner))
    assert err.value.code=='PROFILE_SNAPSHOT_EXPIRED'


def test_only_explicit_scene_aliases_are_normalized(env):
    _,owner=env
    p,body=preparation(owner,scene='通勤')
    assert p['snapshot']['conditions']['scene']=='scene:work_commute'
    assert body['scene']=='通勤'
    with pytest.raises(ProfileError) as err:
        preparation(owner,rid='travel',sid='travel-session',scene='出游')
    assert err.value.code=='PROFILE_INVALID_SCENE'
