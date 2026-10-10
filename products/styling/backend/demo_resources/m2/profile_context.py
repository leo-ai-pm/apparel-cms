"""Server-frozen request context; never loads mutable consumer defaults."""
from copy import deepcopy

from .core import constraint, require

FIELDS = ('usual_sizes.top', 'usual_sizes.bottom', 'usual_sizes.shoes',
          'height_cm', 'weight_kg', 'scene', 'budget_max_fen')


def value(state, field):
    if field.startswith('usual_sizes.'):
        return state['profile'].get('usual_sizes', {}).get(field.split('.')[1])
    return state['profile'].get(field) if field in ('height_cm', 'weight_kg') else state['context'].get(field)


def _put(state, field, selected):
    if field.startswith('usual_sizes.'):
        target, key = state['profile'].setdefault('usual_sizes', {}), field.split('.')[1]
    else:
        target, key = (state['profile'] if field in ('height_cm', 'weight_kg') else state['context']), field
    if selected is None:
        target.pop(key, None)
    else:
        target[key] = deepcopy(selected)


def apply_frozen(state, use, turn_id, at):
    require(type(use) is dict and type(use.get('field_sources')) is dict, 'PROFILE_SNAPSHOT_INVALID')
    state = deepcopy(state)
    sources = {}
    base, conditions = use.get('base_profile', {}), use.get('conditions', {})
    for field in FIELDS:
        old = value(state, field)
        selected = (base.get('usual_sizes', {}).get(field.split('.')[1]) if field.startswith('usual_sizes.')
                    else base.get(field) if field in ('height_cm', 'weight_kg') else conditions.get(field))
        source = use['field_sources'].get(field)
        if selected is not None:
            require(source in ('saved_profile', 'explicit_selection', 'current_request', 'explicit_text'),
                    'PROFILE_SNAPSHOT_INVALID')
        # Preparation has already merged then-current explicit values and saved
        # defaults. A later live session must not change this frozen input.
        _put(state, field, selected)
        if selected is None:
            sources.pop(field, None)
        else:
            sources[field] = source
        kind = 'size_exact' if field.startswith('usual_sizes.') else {'scene': 'scene', 'budget_max_fen': 'budget_max'}.get(field)
        if kind and selected != old:
            slot = field.split('.')[1] if field.startswith('usual_sizes.') else None
            for item in state['constraints']:
                if item['status'] == 'active' and item['kind'] == kind and item.get('target_slot') == slot:
                    item.update(status='revoked', revoked_by_turn_id=turn_id)
            if selected is not None:
                state['constraints'].append(constraint(kind, deepcopy(selected), slot, 'session', turn_id, at,
                                                      source='user_profile' if source == 'saved_profile' else 'explicit_user'))
    state['profile_field_sources'] = sources
    state['profile_mode'] = True
    return state


def finish(result, intent, use, previous_state, previous_history_count, at):
    state = result['state']
    sources = state['profile_field_sources']
    updates = intent.get('updates', {})
    for field in FIELDS:
        selected = updates.get('usual_sizes', {}).get(field.split('.')[1]) if field.startswith('usual_sizes.') else updates.get(field)
        if selected is not None and value(state, field) == selected and intent.get('operation') != 'scope_redirect':
            sources[field] = 'explicit_text'
    if state != previous_state and state['state_revision'] == previous_state['state_revision']:
        state['state_revision'] += 1
        state['updated_at'] = at
        result['decision']['state_transition']['revision_after'] = state['state_revision']
    used_sources = {key: source for key, source in sources.items() if key not in ('height_cm', 'weight_kg')}
    summary = {key: deepcopy(use.get(key)) for key in ('snapshot_id', 'profile_id', 'profile_version', 'snapshot_digest')}
    summary.update(profile_contract='consumer_profile_v1', recorded=True)
    summary['field_sources'] = used_sources
    for version in result['history'][previous_history_count:]:
        version['profile_snapshot'] = deepcopy(summary)
    result['profile_effective'] = {
        'base_profile': {'usual_sizes': deepcopy(state['profile']['usual_sizes'])},
        'conditions': {key: state['context'].get(key) for key in ('scene', 'budget_max_fen')},
        'field_sources': deepcopy(used_sources),
    }
    return result
