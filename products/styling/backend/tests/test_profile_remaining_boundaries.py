"""Remaining CPF boundaries: partial NL, body-only, and clear during a running turn."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import uuid

from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.schemas.consumer_profile import ProfileMutation
from app.services import consumer_profiles, fixed_styling
from tests.test_profile_request_integration import integrated, prepared, save, terminal, mutate
from tests.conftest import collect_sse


def test_partial_saved_sizes_can_be_completed_by_natural_language(integrated):
    ctx=integrated
    mutate(ctx, {
        'profile_action_id':uuid.uuid4().hex,'operation':'save','expected_profile_version':0,
        'explicit_save':True,'explicit_default_budget':True,
        'patch':{'base_profile':{'usual_sizes':{'top':{'system':'clothing_alpha','value':'M'},'bottom':{'system':'clothing_alpha','value':'M'}}},'default_budget_fen':80000}})
    ctx['parser'].updates={'scene':'scene:work_commute','usual_sizes':{'shoes':{'system':'cn_shoe','value':'38'}}}
    done=next(d for e,d in terminal(ctx,prepared(ctx,'秋天通勤，鞋38')) if e=='done')
    assert done['outcome']=='complete_outfit'
    assert done['profile_context']['missing_fields']==[]
    assert done['profile_context']['clarification'] is None
    assert done['profile_context']['field_sources']['usual_sizes.shoes']=='explicit_text'
    sources=done['outfit']['profile_snapshot']['field_sources']
    assert sources['usual_sizes.top']=='saved_profile' and sources['usual_sizes.shoes']=='explicit_text'
    assert consumer_profiles.read_profile(ctx['owner'])['base_profile']['usual_sizes']['shoes'] is None


def test_saved_body_measurements_never_infer_sizes(integrated):
    ctx=integrated
    mutate(ctx, {
        'profile_action_id':uuid.uuid4().hex,'operation':'save','expected_profile_version':0,
        'explicit_save':True,'explicit_default_budget':True,
        'patch':{'base_profile':{'height_cm':168.5,'weight_kg':58.5},'default_budget_fen':80000}})
    body=prepared(ctx,'秋天通勤')
    done=next(d for e,d in terminal(ctx,body) if e=='done')
    assert done['outcome']=='clarification' and done['outfit'] is None
    assert done['profile_context']['missing_fields']==['usual_sizes.top','usual_sizes.bottom','usual_sizes.shoes']
    assert done['profile_context']['clarification']['field']=='usual_sizes'
    assert done['profile_context']['clarification']['next_field']=='usual_sizes.top'
    assert not {'height_cm','weight_kg'} & set(done['profile_context']['field_sources'])
    record=ctx['client'].get(f"/api/v1/generation-requests/{body['request_id']}",params={'session_id':body['session_id']})
    assert record.json()['result']['profile_context']==done['profile_context']
    view=fixed_styling.session_view(body['session_id'])
    assert view['state']['profile']['usual_sizes']=={}
    assert view['history']==[]


def test_partial_saved_sizes_report_actual_missing_shoes_without_question_parsing(integrated):
    ctx=integrated
    mutate(ctx, {
        'profile_action_id':uuid.uuid4().hex,'operation':'save','expected_profile_version':0,
        'explicit_save':True,'explicit_default_budget':True,
        'patch':{'base_profile':{'usual_sizes':{'top':{'system':'clothing_alpha','value':'M'},'bottom':{'system':'clothing_alpha','value':'M'}}},'default_budget_fen':80000}})
    done=next(d for e,d in terminal(ctx,prepared(ctx,'秋天通勤')) if e=='done')
    context=done['profile_context']
    assert context['missing_fields']==['usual_sizes.shoes']
    assert context['clarification']=={'field':'shoes_size','next_field':'usual_sizes.shoes','question':'鞋子常穿多少码？'}


def test_unbound_legacy_result_does_not_gain_profile_context(integrated):
    ctx=integrated
    body={'session_id':uuid.uuid4().hex,'request_id':uuid.uuid4().hex,'message':'秋天通勤'}
    done=next(d for e,d in terminal(ctx,body) if e=='done')
    assert 'profile_context' not in done


def test_clear_while_model_is_running_keeps_accepted_v1(integrated,monkeypatch):
    ctx=integrated;save(ctx)
    body=prepared(ctx)
    started=Event();release=Event()
    original=ctx['parser'].parse
    def blocking(*args,**kwargs):
        started.set()
        assert release.wait(5),'controlled parser never released'
        return original(*args,**kwargs)
    monkeypatch.setattr(ctx['parser'],'parse',blocking)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(ctx['client'].post,'/api/v1/chat',json=body)
        try:
            assert started.wait(5),'formal turn did not reach controlled execution'
            with ctx['db']() as db:
                assert db.get(GenerationRequest,body['request_id']).status=='running'
            mutate(ctx, {
                'profile_action_id':uuid.uuid4().hex,'operation':'clear','expected_profile_version':1,'patch':{}})
            assert consumer_profiles.read_profile(ctx['owner'])['status']=='cleared'
        finally:
            release.set()
        response=future.result(timeout=5)
    done=next(d for e,d in collect_sse(response) if e=='done')
    assert done['outcome']=='complete_outfit'
    assert done['outfit']['profile_snapshot']['profile_version']==1
    assert done['outfit']['items']['shoes']['size']['value']=='38'
    assert ctx['parser'].calls==1
    with ctx['db']() as db:
        assert db.query(DemandTurn).count()==db.query(GenerationRequest).count()==1
