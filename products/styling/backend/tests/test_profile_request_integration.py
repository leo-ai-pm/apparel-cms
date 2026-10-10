"""Profile preparation/admission/generation seams; isolated DB and offline parser."""
from copy import deepcopy
from contextlib import contextmanager
from pathlib import Path
import uuid

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import chat, consumer_events, outfits
from app.api.consumer_profiles import profile_error_handler
from app.core import request_admission, consumer_identity
from app.core.config import settings
from app.core.cost_guard import CostGuard
from app.core.consumer_identity import ConsumerOwner, resolve_consumer_owner
from app.models.chat import Base, DailyUsage
from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.models.profile_snapshot import ConsumerProfileSnapshot
from app.schemas.consumer_profile import ProfileError, ProfileMutation
from app.services import agent, demand, generation, fixed_execution, fixed_styling as fixed
from app.services import consumer_profiles, profile_snapshots
from tests.conftest import collect_sse
from tests.profile_context_fixture import device_authorization, service_mutation


class Parser:
    configured = True
    name = 'offline-profile-integration'
    mode = 'offline_controlled'

    def __init__(self):
        self.calls = 0
        self.updates = {'scene': 'scene:work_commute'}

    @contextmanager
    def call_accounting(self, callback):
        yield

    def parse(self, text, state, history, resources, dialog=None):
        from m2.core import validate_intent
        self.calls += 1
        return validate_intent({'operation': 'initial_recommendation', 'updates': self.updates}, resources), {'mode': self.mode, 'cost': 0}


@pytest.fixture
def integrated(tmp_path, monkeypatch):
    engine = create_engine(f'sqlite:///{tmp_path}/business.db', connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    for module in (chat, request_admission, consumer_identity, consumer_profiles, profile_snapshots,
                   agent, demand, generation, consumer_events):
        monkeypatch.setattr(module, 'SessionLocal', local)
    monkeypatch.setenv('STYLING_FIXED_ENABLED', '1')
    monkeypatch.setenv('CONSUMER_APP_SCOPE', 'profile_integration_test')
    monkeypatch.setenv('STYLING_FIXED_ROOT', '/Users/Admin/Documents/01项目/个人项目/永嘉农商杯')
    monkeypatch.setenv('STYLING_FIXED_DB', str(tmp_path / 'fixed.sqlite3'))
    monkeypatch.setenv('STYLING_FIXED_MODEL_CALL_LIMIT', '12')
    monkeypatch.setattr(settings, 'max_concurrency', 1)
    monkeypatch.setattr(settings, 'daily_call_limit', 100)
    guard = CostGuard()
    monkeypatch.setattr(chat, 'cost_guard', guard)
    monkeypatch.setattr(fixed_execution, 'cost_guard', guard)
    parser = Parser()
    monkeypatch.setattr(fixed, '_make_model', lambda: parser)
    fixed.close_service()
    owner = ConsumerOwner('profile_integration_test', 'device', 'owner-a')
    current_owner = [owner]
    app = FastAPI()
    app.add_exception_handler(ProfileError, profile_error_handler)
    app.include_router(chat.router)
    app.include_router(outfits.router)
    app.include_router(consumer_events.router)
    def trusted_test_owner(request: Request):
        current = current_owner[0]
        request.state.consumer_authorization = device_authorization(current, local)
        return current
    app.dependency_overrides[resolve_consumer_owner] = trusted_test_owner
    client = TestClient(app)
    yield dict(db=local, owner=owner, current_owner=current_owner, client=client, guard=guard, parser=parser)
    fixed.close_service()
    engine.dispose()


def mutate(ctx, body):
    return service_mutation(ctx['owner'], body, ctx['db'])


def save(ctx, version=0, budget=80000, shoe='38'):
    return mutate(ctx, {
        'profile_action_id': uuid.uuid4().hex, 'operation': 'save' if version == 0 else 'update',
        'expected_profile_version': version, 'explicit_save': True, 'explicit_default_budget': True,
        'patch': {'base_profile': {'usual_sizes': {'top': {'system': 'clothing_alpha', 'value': 'M'},
                   'bottom': {'system': 'clothing_alpha', 'value': 'M'}, 'shoes': {'system': 'cn_shoe', 'value': shoe}}},
                  'default_budget_fen': budget}})


def prepared(ctx, message='秋天通勤', conditions=None):
    raw = {'request_id': uuid.uuid4().hex, 'session_id': uuid.uuid4().hex, 'message': message}
    if conditions is not None:
        raw['request_conditions'] = conditions
    prep = profile_snapshots.prepare(ctx['owner'], {'operation': 'chat', 'session_id': raw['session_id'],
                                                   'request_id': raw['request_id'], 'request_body': raw},
                                     authorization=device_authorization(ctx['owner'],ctx['db']))
    return {**raw, 'profile_binding': prep['profile_binding']}


def terminal(ctx, body):
    response = ctx['client'].post('/api/v1/chat', json=body)
    assert response.status_code == 200
    return collect_sse(response)


def test_profile_429_freezes_v1_then_replay_precedes_clear_and_busy(integrated):
    ctx = integrated
    save(ctx)
    body = prepared(ctx)
    assert ctx['guard'].acquire_slot()
    try:
        response = ctx['client'].post('/api/v1/chat', json=body)
        assert response.status_code == 429
        with ctx['db']() as db:
            assert db.get(ConsumerProfileSnapshot, body['profile_binding']['snapshot_id']).state == 'prepared'
            assert db.query(DemandTurn).count() == db.query(GenerationRequest).count() == 0
    finally:
        ctx['guard'].release_slot()
    save(ctx, version=1, budget=50000, shoe='39')
    done = [d for e, d in terminal(ctx, body) if e == 'done'][0]
    assert done['outcome'] == 'complete_outfit'
    assert done['outfit']['items']['shoes']['size']['value'] == '38'
    assert done['outfit']['profile_snapshot']['profile_version'] == 1
    mutate(ctx, {
        'profile_action_id': uuid.uuid4().hex, 'operation': 'clear', 'expected_profile_version': 2})
    assert ctx['guard'].acquire_slot()
    try:
        replayed = [d for e, d in terminal(ctx, body) if e == 'done'][0]
        assert replayed == done
        assert ctx['client'].post('/api/v1/chat', json={**body, 'message': '另一条要求'}).status_code == 409
    finally:
        ctx['guard'].release_slot()
    assert ctx['parser'].calls == 1
    with ctx['db']() as db:
        assert db.query(DemandTurn).count() == db.query(GenerationRequest).count() == 1
        assert db.query(DailyUsage).one().count == 1


def test_bound_session_and_generation_are_not_readable_by_other_owner(integrated):
    ctx = integrated
    save(ctx)
    body = prepared(ctx)
    done = [d for e, d in terminal(ctx, body) if e == 'done'][0]
    ctx['current_owner'][0] = ConsumerOwner('profile_integration_test', 'device', 'owner-b')
    for path in [f"/api/v1/outfits/sessions/{body['session_id']}", f"/api/v1/sessions/{body['session_id']}/messages",
                 f"/api/v1/outfits/sessions/{done['fixed_session_id']}",
                 f"/api/v1/generation-requests/{body['request_id']}?session_id={body['session_id']}"]:
        denied = ctx['client'].get(path)
        assert denied.status_code == 404 and 'profile_snapshot' not in denied.text
    assert ctx['client'].post('/api/v1/chat', json=body).status_code == 404
    assert ctx['parser'].calls == 1 and done['outfit']['look_version_id'] == 'lv-1'


@pytest.mark.parametrize('message,private', [
    ('身高165cm，体重52kg，预算800，秋天通勤', ('165', '52')),
    ('身高一米七，体重六十公斤，预算800，秋天通勤', ('一米七', '六十公斤')),
    ('身高1.70米，体重60kg，预算800，秋天通勤', ('1.70', '60kg')),
], ids=['ascii_units', 'chinese_units', 'meters'])
def test_structured_low_budget_and_body_measurements_do_not_become_partner_evidence(integrated, message, private):
    ctx = integrated
    save(ctx)
    body = prepared(ctx, message, {'budget_max_fen': 50000})
    done = [d for e, d in terminal(ctx, body) if e == 'done'][0]
    assert done['outcome'] == 'no_match' and done['outfit'] is None
    assert ctx['parser'].calls == 1
    with ctx['db']() as db:
        turn = db.query(DemandTurn).one()
        assert all(value not in turn.text for value in private) and '预算800' in turn.text
        snap = db.get(ConsumerProfileSnapshot, body['profile_binding']['snapshot_id'])
        assert snap.state == 'accepted' and '50000' in snap.effective_json
        assert 'height_cm' not in snap.effective_json and 'weight_kg' not in snap.effective_json
    assert consumer_profiles.read_profile(ctx['owner'])['default_budget_fen'] == 80000


def test_opt_in_fixed_session_requires_binding_and_json_turn_replays(integrated):
    ctx = integrated
    save(ctx)
    created = ctx['client'].post('/api/v1/outfits/sessions', json={'profile_contract': 'consumer_profile_v1'})
    assert created.status_code == 200
    view = created.json()
    sid = view['session_id']
    raw = {'contract_version': '0.1.0', 'request_id': 'json-one', 'idempotency_key': 'json-one',
           'turn_id': 'json-one', 'expected_state_revision': view['state']['state_revision'],
           'expected_conversation_revision': view['conversation_revision'], 'user_utterance': '秋天通勤'}
    before = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/turns', json=raw)
    assert before.status_code == 422 and before.json()['error']['code'] == 'PROFILE_BINDING_REQUIRED'
    prep = profile_snapshots.prepare(ctx['owner'], {'operation': 'turn', 'session_id': sid,
                                                   'request_id': 'json-one', 'request_body': raw},
                                     authorization=device_authorization(ctx['owner'],ctx['db']))
    original = {**raw, 'profile_binding': prep['profile_binding']}
    first = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/turns', json=original)
    assert first.status_code == 200 and first.json()['outcome'] == 'complete_outfit'
    save(ctx, version=1, shoe='39', budget=50000)
    assert ctx['guard'].acquire_slot()
    try:
        replay = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/turns', json=original)
        assert replay.status_code == 200 and replay.json() == first.json()
    finally:
        ctx['guard'].release_slot()
    assert ctx['parser'].calls == 1


def test_restore_uses_new_defaults_then_explicit_override_without_rewriting_history(integrated):
    ctx = integrated
    save(ctx)
    original = prepared(ctx)
    done = [d for e, d in terminal(ctx, original) if e == 'done'][0]
    sid = original['session_id']
    history = deepcopy(fixed.session_view(sid)['history'])
    save(ctx, version=1, shoe='39', budget=50000)

    def restore(action_id, conditions=None):
        view = fixed.session_view(sid)
        raw = {'action_id': action_id, 'operation': 'restore_history',
               'target_look_version_id': history[0]['look_version_id'],
               'expected_state_revision': view['state']['state_revision'],
               'expected_conversation_revision': view['conversation_revision']}
        if conditions is not None:
            raw['request_conditions'] = conditions
        prep = profile_snapshots.prepare(ctx['owner'], {'operation': 'restore', 'session_id': sid,
                                                       'request_id': action_id, 'request_body': raw},
                                         authorization=device_authorization(ctx['owner'],ctx['db']))
        body = {**raw, 'profile_binding': prep['profile_binding']}
        response = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/actions', json=body)
        assert response.status_code == 200
        return body, response.json()

    _, failed = restore('new-defaults')
    assert failed['outcome'] == 'no_match' and failed['history'] == history
    body, success = restore('explicit-restore', {'budget_max_fen': 80000,
                          'request_profile_overrides': {'usual_sizes': {'shoes': {'system': 'cn_shoe', 'value': '38'}}}})
    assert success['outcome'] == 'complete_outfit' and len(success['history']) == 2
    assert success['history'][0] == history[0]
    assert success['outfit']['profile_snapshot']['profile_version'] == 2
    assert success['outfit']['profile_snapshot']['field_sources']['usual_sizes.shoes'] == 'explicit_selection'
    mutate(ctx, {
        'profile_action_id': 'clear-after-restore', 'operation': 'clear', 'expected_profile_version': 2, 'patch': {}})
    again = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/actions', json=body)
    assert again.status_code == 200 and again.json() == success
    with ctx['db']() as db:
        assert db.query(DemandTurn).count() == db.query(GenerationRequest).count() == 1
        assert db.query(DailyUsage).one().count == 1
    assert ctx['parser'].calls == 1


def test_clear_prepared_rejects_original_without_admission_or_model(integrated):
    ctx = integrated
    save(ctx)
    body = prepared(ctx)
    mutate(ctx, {
        'profile_action_id': 'clear-before', 'operation': 'clear', 'expected_profile_version': 1, 'patch': {}})
    response = ctx['client'].post('/api/v1/chat', json=body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'PROFILE_CLEARED'
    with ctx['db']() as db:
        assert db.query(DemandTurn).count() == db.query(GenerationRequest).count() == 0
        assert db.query(DailyUsage).count() == 0
    assert ctx['parser'].calls == 0


def test_prepared_chat_ignores_another_later_explicit_turn(integrated):
    ctx = integrated
    save(ctx)
    original = prepared(ctx)
    later = {'request_id': 'later-explicit', 'session_id': original['session_id'], 'message': '秋天通勤',
             'request_conditions': {'budget_max_fen': 50000, 'request_profile_overrides': {
                 'usual_sizes': {'top': {'system': 'clothing_alpha', 'value': 'S'},
                                 'bottom': {'system': 'clothing_alpha', 'value': 'S'}}}}}
    prep = profile_snapshots.prepare(ctx['owner'], {'operation': 'chat', 'session_id': later['session_id'],
                                                   'request_id': later['request_id'], 'request_body': later},
                                     authorization=device_authorization(ctx['owner'],ctx['db']))
    later['profile_binding'] = prep['profile_binding']
    assert [d for e, d in terminal(ctx, later) if e == 'done'][0]['outcome'] == 'no_match'
    result = [d for e, d in terminal(ctx, original) if e == 'done'][0]
    assert result['outcome'] == 'complete_outfit'
    assert result['outfit']['items']['top']['size']['value'] == 'M'
    assert result['outfit']['profile_snapshot']['snapshot_id'] == original['profile_binding']['snapshot_id']
    assert fixed.session_view(original['session_id'])['state']['context']['budget_max_fen'] == 80000
    assert ctx['parser'].calls == 2


@pytest.mark.parametrize('bad', [
    {'profile_binding': {'snapshot_id': 'bad', 'profile_id': None, 'profile_version': True, 'snapshot_digest': 'a' * 64}},
    {'profile_binding': {'snapshot_id': 'bad', 'profile_id': None, 'profile_version': 1, 'snapshot_digest': 'a' * 64},
     'request_conditions': {'budget_max_fen': -1}},
    {'profile_binding': {'snapshot_id': 'bad', 'profile_id': None, 'profile_version': 1, 'snapshot_digest': 'a' * 64},
     'request_conditions': {'request_profile_overrides': {'weight_kg': 'private-invalid-body-value'}}},
])
def test_json_route_bad_profile_types_are_sanitized_before_admission(integrated, bad):
    ctx = integrated
    view = ctx['client'].post('/api/v1/outfits/sessions', json={'profile_contract': 'consumer_profile_v1'}).json()
    sid = view['session_id']
    raw = {'contract_version': '0.1.0', 'request_id': 'invalid-one', 'idempotency_key': 'invalid-one',
           'turn_id': 'invalid-one', 'expected_state_revision': view['state']['state_revision'],
           'expected_conversation_revision': view['conversation_revision'], 'user_utterance': '秋天通勤', **bad}
    response = ctx['client'].post(f'/api/v1/outfits/sessions/{sid}/turns', json=raw)
    assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_REQUEST'
    assert 'private-invalid-body-value' not in response.text
    with ctx['db']() as db:
        assert db.query(DemandTurn).count() == db.query(GenerationRequest).count() == db.query(DailyUsage).count() == 0
    assert ctx['parser'].calls == 0
