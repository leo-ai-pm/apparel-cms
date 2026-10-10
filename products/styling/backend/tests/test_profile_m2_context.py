"""Frozen profile use in the existing solver; offline parser, new SQLite only."""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import sys

import pytest

ROOT = Path('/Users/Admin/Documents/01项目/个人项目/永嘉农商杯')
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from m2.core import demo_resources, validate_intent
from m2.service import Service


class OfflineParser:
    configured = True
    name = 'profile-offline-controlled'

    def __init__(self):
        self.intent = {'operation': 'initial_recommendation', 'updates': {'scene': 'scene:work_commute'}}
        self.states = []
        self.fail = False

    @contextmanager
    def call_accounting(self, callback):
        yield  # This parser has no HTTP transport.

    def parse(self, text, state, history, resources, dialog=None):
        self.states.append(deepcopy(state))
        if self.fail:
            raise RuntimeError('controlled offline failure')
        return validate_intent(self.intent, resources), {'mode': 'offline_controlled', 'cost': 0}


@pytest.fixture
def solver(tmp_path):
    parser = OfflineParser()
    service = Service(demo_resources('2026-10-10T00:00:00+00:00', save=False), parser,
                      clock=lambda: '2026-10-10T00:01:00+00:00', db_path=tmp_path / 'fixed.sqlite3')
    sid = service.create()['state']['session_id']
    yield service, parser, sid
    service.close()


def use(version=1, budget=80000, shoe='38', status='saved'):
    sizes = {'top': {'system': 'clothing_alpha', 'value': 'M'},
             'bottom': {'system': 'clothing_alpha', 'value': 'M'},
             'shoes': {'system': 'cn_shoe', 'value': shoe}}
    return {'snapshot_id': f'snapshot-{version}', 'profile_id': 'profile-test', 'profile_version': version,
            'snapshot_digest': str(version) * 64, 'base_profile': {'usual_sizes': sizes},
            'conditions': {'scene': None, 'budget_max_fen': budget}, 'explicit_overrides': {},
            'field_sources': {**{f'usual_sizes.{k}': 'saved_profile' for k in sizes},
                              'budget_max_fen': 'saved_profile'}, 'profile_status': status}


def body(service, sid, rid):
    row = service.view(sid)
    return {'contract_version': '0.1.0', 'request_id': rid, 'idempotency_key': rid, 'turn_id': rid,
            'expected_state_revision': row['state']['state_revision'],
            'expected_conversation_revision': row['conversation_revision'], 'user_utterance': '离线场景输入'}


def test_saved_sizes_and_budget_fill_scene_only_and_version_is_bodyless(solver):
    service, parser, sid = solver
    result = service.turn(sid, body(service, sid, 'one'), profile_use=use())
    assert parser.states[0]['profile']['usual_sizes']['shoes']['value'] == '38'
    assert result['decision']['status'] == 'recommendation'
    snapshot = result['history'][0]['profile_snapshot']
    assert snapshot['snapshot_id'] == 'snapshot-1' and snapshot['profile_version'] == 1
    assert snapshot['field_sources']['scene'] == 'explicit_text'
    assert 'base_profile' not in snapshot and 'height_cm' not in snapshot and 'weight_kg' not in snapshot


def test_natural_text_budget_beats_frozen_selection_and_never_changes_saved_use(solver):
    service, parser, sid = solver
    frozen = use()
    frozen['field_sources']['budget_max_fen'] = 'explicit_selection'
    parser.intent['updates']['budget_max_fen'] = 50000
    result = service.turn(sid, body(service, sid, 'low'), profile_use=frozen)
    assert result['decision']['status'] == 'no_match' and result['history'] == []
    assert result['state']['context']['budget_max_fen'] == 50000
    assert result['state']['profile_field_sources']['budget_max_fen'] == 'explicit_text'
    assert frozen['conditions']['budget_max_fen'] == 80000


def test_profile_preinjection_does_not_commit_when_model_fails(solver):
    service, parser, sid = solver
    original = service.view(sid)
    parser.fail = True
    with pytest.raises(RuntimeError, match='controlled offline failure'):
        service.turn(sid, body(service, sid, 'fail'), profile_use=use())
    assert service.view(sid) == original


def test_new_default_replaces_prior_saved_then_clear_does_not_revive_autofill(solver):
    service, parser, sid = solver
    first = service.turn(sid, body(service, sid, 'first'), profile_use=use())
    frozen_history = deepcopy(first['history'])
    second = service.turn(sid, body(service, sid, 'second'), profile_use=use(2, shoe='39'))
    assert second['decision']['status'] == 'no_match'
    assert second['state']['profile']['usual_sizes']['shoes']['value'] == '39'
    assert second['history'] == frozen_history
    cleared = use(3, status='cleared')
    cleared.update(base_profile={}, conditions={'scene': None, 'budget_max_fen': None}, field_sources={})
    third = service.turn(sid, body(service, sid, 'clear'), profile_use=cleared)
    assert third['decision']['status'] == 'clarification'
    assert third['state']['profile']['usual_sizes'] == {}
    assert 'budget_max_fen' not in third['state']['context']
    assert third['history'] == frozen_history


def test_same_m2_id_cannot_replay_another_frozen_binding(solver):
    service, parser, sid = solver
    request = body(service, sid, 'stable')
    original = service.turn(sid, request, profile_use=use())
    assert service.turn(sid, request, profile_use=use()) == original
    assert len(parser.states) == 1
    with pytest.raises(Exception) as error:
        service.turn(sid, request, profile_use=use(2))
    assert error.value.code == 'IDEMPOTENCY_CONFLICT'


def test_prepared_context_does_not_inherit_later_explicit_state(solver):
    service, parser, sid = solver
    frozen = use()
    parser.intent['updates'].update(budget_max_fen=50000, usual_sizes={
        'top': {'system': 'clothing_alpha', 'value': 'S'},
        'bottom': {'system': 'clothing_alpha', 'value': 'S'}})
    service.turn(sid, body(service, sid, 'later-explicit'), profile_use=use(2))
    parser.intent['updates'] = {'scene': 'scene:work_commute'}
    result = service.turn(sid, body(service, sid, 'prepared-earlier'), profile_use=frozen)
    assert result['state']['context']['budget_max_fen'] == 80000
    assert result['state']['profile']['usual_sizes']['top']['value'] == 'M'
    assert result['decision']['status'] == 'recommendation'
    unknown = use(3)
    unknown.update(base_profile={}, conditions={'scene': None, 'budget_max_fen': None}, field_sources={})
    service.turn(sid, body(service, sid, 'prepared-unknown'), profile_use=unknown)
    assert parser.states[-1]['profile']['usual_sizes'] == {}
    assert 'budget_max_fen' not in parser.states[-1]['context']
