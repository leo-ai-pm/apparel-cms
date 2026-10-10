"""Explicit direct send/lookup/append. HTTP is outside every database transaction.

The initial envelope and receipt are immutable. Actions and network attempts are
separate from legacy send rows. No model, CMS or browser credentials are used.
"""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
from functools import wraps
import math
import ipaddress
import json
import os
import re
import time
from urllib.parse import quote, urlsplit
import uuid

import httpx
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from app.core.styling_direct_auth import DirectAuthError, read_config
from app.models.styling_delivery import (
    StylingDirectAction, StylingDirectAttempt, StylingDirectDelivery,
    StylingDirectSupplement,
)
from app.models.tryon import utcnow
from app.services import admin_context as ac


class StylingDeliveryError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(code)


_MESSAGES = {
    'DIRECT_TIMEOUT': '产品管理服务响应超时，接收状态尚未确认，请先查询原身份。',
    'DIRECT_UNREACHABLE': '产品管理服务不可达，接收状态尚未确认。',
    'DIRECT_RESPONSE_INVALID': '产品管理响应不符合协议，接收状态尚未确认。',
    'DIRECT_RECEIPT_MISMATCH': '回执与原交接身份不一致，不能记为已接收。',
    'DIRECT_REMOTE_REJECTED': '产品管理服务拒绝本次交接，请保留原身份核对。',
    'DIRECT_RECEIPT_NOT_FOUND': '产品管理尚无该原身份的接收记录。',
}
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
_ACCOUNT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$')


def _storage_safe(fn):
    @wraps(fn)
    def guarded(db, *args, **kwargs):
        try:
            return fn(db, *args, **kwargs)
        except (SQLAlchemyError, json.JSONDecodeError):
            db.rollback()
            _err(503, 'DIRECT_STORAGE_UNAVAILABLE', '直连持久化记录暂不可用，不能当作空记录或成功。')
    return guarded


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _err(status, code, message):
    raise StylingDeliveryError(status, code, message)


def _principal(principal):
    from app.core.admin_auth import account_binding_for_method
    if (not isinstance(principal, dict) or principal.get('approval_identity_kind') != 'account_bound'
            or account_binding_for_method(principal.get('auth_method')) is None
            or any(not isinstance(principal.get(k), str) or not _ACCOUNT.fullmatch(principal[k])
                   for k in ('subject', 'scope', 'source_instance_id'))):
        _err(403, 'APPROVAL_IDENTITY_LEGACY', '直接交接需要服务端账户绑定的管理者身份。')
    if os.getenv('STYLING_ADMIN_ENABLED', '1').strip().lower() not in {'1', 'true', 'enabled'}:
        _err(403, 'DIRECT_SCOPE_FORBIDDEN', '当前管理账户已停用。')
    if (principal['subject'], principal['scope'], principal['source_instance_id']) != account_binding_for_method(principal['auth_method']):
        _err(403, 'DIRECT_SCOPE_FORBIDDEN', '当前管理账户或授权范围已变化。')


def _session(db, principal):
    """Real HTTP passes a session ID; technical unit fixtures have none."""
    session_id = principal.get('session_id')
    if session_id is None:
        return
    from app.models.demand import DemandAdminSession
    from app.models.styling_account import StylingAccountSession
    session = db.get(DemandAdminSession, session_id, populate_existing=True)
    account = db.get(StylingAccountSession, session_id, populate_existing=True)
    if (session is None or account is None or session.revoked_at or account.revoked_at
            or _aware(session.expires_at) <= _aware(utcnow())
            or _aware(account.expires_at) <= _aware(utcnow())
            or account.audience != 'personal_styling'
            or any(getattr(account, k) != principal[k] for k in
                   ('subject', 'scope', 'source_instance_id', 'auth_method'))):
        _err(401, 'DIRECT_SESSION_INVALID', '原管理会话已失效，需用当前有效账户重新查询。')


def _target(principal):
    _principal(principal)
    try:
        config = read_config()
    except DirectAuthError as exc:
        _err(exc.status, exc.code, exc.message)
    values = [x for x in config.get('targets', []) if isinstance(x, dict)
              and x.get('authorized_scope') == principal['scope']
              and x.get('source_instance_id') == principal['source_instance_id']]
    if len(values) != 1 or values[0].get('enabled') is not True:
        _err(503, 'DIRECT_TARGET_NOT_CONFIGURED', '没有唯一且启用的产品管理目标配置。')
    target = values[0]
    try:
        if not isinstance(target.get('target_instance_id'), str) or not _ID.fullmatch(target['target_instance_id']):
            raise ValueError()
        if not isinstance(target.get('sender_token'), str) or not 24 <= len(target['sender_token']) <= 512:
            raise ValueError()
        if re.search(r'[\s\x00-\x1f\x7f]', target['sender_token']):
            raise ValueError()
        parsed = urlsplit(target['base_url'])
        parsed.port
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/') or '\\' in target['base_url']):
            raise ValueError()
        if parsed.scheme != 'https':
            loopback = parsed.hostname == 'localhost'
            try:
                loopback = loopback or ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                pass
            if parsed.scheme != 'http' or not loopback or os.getenv('STYLING_DIRECT_ALLOW_LOOPBACK_HTTP') != '1':
                raise ValueError()
    except (ValueError, KeyError, TypeError):
        _err(503, 'DIRECT_TARGET_INVALID', '产品管理目标地址或服务认证配置不合规。')
    return {**target, 'base_url': target['base_url'].rstrip('/')}


def _aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _begin(db):
    # Callers must not wrap a direct operation in a wider business transaction.
    db.rollback()
    if db.bind.dialect.name == 'sqlite':
        db.execute(text('BEGIN IMMEDIATE'))
    else:
        db.begin()


def _bound_action(db, principal, body, handoff_id, operation):
    """Bind browser intent before business qualification or lease acquisition."""
    if not ac.enabled():
        return None, None
    if body is None:
        raise ac.AdminContextError(422, 'ADMIN_CONTEXT_REQUIRED', '请先读取当前管理上下文。')
    path = '/api/v1/admin/handoffs/' + handoff_id + '/direct-' + operation
    return ac.begin_action(db, principal, body, 'POST', path, 'direct_' + operation)


def _check_context(db, principal, body):
    if body is not None and ac.enabled():
        ac.revalidate_context(db, principal, body.expected_admin_context)
    else:
        _session(db, principal)


def _finish_bound(db, record, value, *, failed_before_network=False):
    if record is None:
        return
    late = value.get('supplement_delivery')
    received = (late and late['status'] == 'received') if record.operation_kind == 'direct_supplement' else value['status'] == 'received'
    state = 'completed' if received else ('failed' if failed_before_network else 'unconfirmed')
    ac.finish_action(db, record, value, state=state,
        outcome='received' if received else ('failed' if failed_before_network else 'unconfirmed'),
        result_ref={'kind': 'direct_delivery', 'id': value['delivery_id'], 'revision': value['revision']})


def _returned(db, principal, body, value):
    # A committed received fact stays committed if the session is revoked
    # between confirmation and response. Do not replace it with uncertainty.
    if body is not None and ac.enabled():
        try:
            _check_context(db, principal, body)
        except ac.AdminContextError:
            # Any observed deployment retirement is permanent even when a
            # post-commit response is rejected for changed authentication.
            try:
                db.commit()
            except SQLAlchemyError:
                db.rollback()
            raise
        db.commit()
    return value


def _frozen(db, handoff_id, expected_revision, principal):
    _session(db, principal)
    from app.services.styling_evidence import load_frozen_approval, StylingEvidenceError
    try:
        fact, row, payload, metadata = load_frozen_approval(db, handoff_id, principal)
    except StylingEvidenceError as exc:
        _err(exc.status, exc.code, exc.message)
    if type(expected_revision) is not int or expected_revision != row.version:
        _err(409, 'DIRECT_REVISION_CONFLICT', '交接版本已变化，请核对服务端冻结版本。')
    return fact, row


def _export(db, handoff_id, principal):
    from app.services.styling_evidence import export_evidence, StylingEvidenceError
    try:
        return export_evidence(db, handoff_id, principal)
    except StylingEvidenceError as exc:
        _err(exc.status, exc.code, exc.message)


def _supplement(export):
    raw = export.content_json.encode('utf-8')
    if len(raw) > 4 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != export.digest:
        _err(413, 'DIRECT_INPUT_TOO_LARGE', '冻结补充大小或摘要不合规。')
    return {'supplement_id': export.supplement_id, 'digest': export.digest,
            'content_base64': base64.b64encode(export.content_json.encode('utf-8')).decode('ascii')}


def _envelope(fact, row, target, export):
    if len(row.payload_json.encode('utf-8')) > 1024 * 1024:
        _err(413, 'DIRECT_INPUT_TOO_LARGE', '冻结交接包超过大小上限。')
    return {
        'transport_schema': 'pa-direct-delivery/1',
        'source_product': 'personal_styling', 'target_product': 'product_management',
        'source_instance_id': fact.source_instance_id,
        'target_instance_id': target['target_instance_id'], 'authorized_scope': fact.scope,
        'handoff_id': row.id, 'revision': row.version,
        'payload_digest': hashlib.sha256(row.payload_json.encode('utf-8')).hexdigest(),
        'payload_base64': base64.b64encode(row.payload_json.encode('utf-8')).decode('ascii'),
        'source_approval_ref': {'approval_record_id': fact.approval_record_id},
        'supplement': _supplement(export) if export else None,
    }


def _bound(delivery, fact, target, principal):
    if (delivery.scope != principal['scope'] or delivery.source_instance_id != principal['source_instance_id']
            or delivery.target_instance_id != target['target_instance_id']
            or delivery.approval_record_id != fact.approval_record_id):
        _err(409, 'DIRECT_IDENTITY_CONFLICT', '既有直连身份与当前批准或目标绑定不一致。')
    try:
        if len(delivery.envelope_json.encode('utf-8')) > 8 * 1024 * 1024:
            raise ValueError()
        envelope = json.loads(delivery.envelope_json)
        raw = base64.b64decode(envelope['payload_base64'], validate=True)
        expected = {'source_instance_id': delivery.source_instance_id,
            'target_instance_id': delivery.target_instance_id, 'authorized_scope': delivery.scope,
            'handoff_id': delivery.handoff_id, 'revision': delivery.revision,
            'payload_digest': fact.payload_digest,
            'source_approval_ref': {'approval_record_id': fact.approval_record_id}}
        if (_sha(delivery.envelope_json) != delivery.envelope_digest
                or hashlib.sha256(raw).hexdigest() != fact.payload_digest
                or any(envelope.get(k) != v for k, v in expected.items())):
            raise ValueError()
        first = envelope.get('supplement')
        if first is not None:
            content = base64.b64decode(first['content_base64'], validate=True)
            if (first['supplement_id'] != delivery.first_supplement_id
                    or first['digest'] != delivery.first_supplement_digest
                    or hashlib.sha256(content).hexdigest() != first['digest']):
                raise ValueError()
        elif delivery.first_supplement_id is not None or delivery.first_supplement_digest is not None:
            raise ValueError()
        if delivery.receipt_json != 'null':
            _receipt(json.loads(delivery.receipt_json), delivery)
    except (ValueError, KeyError, TypeError, StylingDeliveryError):
        _err(409, 'DIRECT_FROZEN_CONFLICT', '已保存的直连原体或回执不完整，不能重写原身份。')


def _view(db, delivery):
    late = db.query(StylingDirectSupplement).filter_by(delivery_id=delivery.id).first()
    remaining = ((_aware(delivery.lease_until) - _aware(utcnow())).total_seconds()
                 if delivery.lease_token and delivery.lease_until else 0)
    result = {
        'transport': 'direct', 'delivery_id': delivery.id, 'handoff_id': delivery.handoff_id,
        'revision': delivery.revision, 'status': delivery.status,
        'operation_in_progress': remaining > 0, 'retry_after_seconds': max(0, math.ceil(remaining)),
        'source_instance_id': delivery.source_instance_id, 'target_instance_id': delivery.target_instance_id,
        'authorized_scope': delivery.scope, 'payload_digest': delivery.payload_digest,
        'source_approval_ref': {'approval_record_id': delivery.approval_record_id},
        'first_supplement': ({'supplement_id': delivery.first_supplement_id,
                              'digest': delivery.first_supplement_digest}
                             if delivery.first_supplement_id else None),
        'receipt': json.loads(delivery.receipt_json),
        'current_supplement': json.loads(delivery.current_supplement_json),
        'last_error': delivery.last_error or None,
        'supplement_delivery': ({'supplement_id': late.supplement_id, 'digest': late.digest,
                                'status': late.status, 'receipt': json.loads(late.receipt_json),
                                'last_error': late.last_error or None} if late else None),
        'attempts': [{'attempt_id': a.id, 'operation': a.operation, 'status': a.status,
                      'error_code': a.error_code or None,
                      'started_at': _aware(a.started_at).isoformat(),
                      'finished_at': _aware(a.finished_at).isoformat() if a.finished_at else None}
                     for a in db.query(StylingDirectAttempt).filter_by(delivery_id=delivery.id)
                     .order_by(StylingDirectAttempt.started_at, StylingDirectAttempt.id).all()],
    }
    if ac.enabled():
        # This is the source transmission initiator, not the currently logged
        # in manager or the frozen approval actor. Never send it to a partner.
        result['transmission_actor_subject'] = delivery.actor_subject
    return result


def _finish_action(db, action, delivery):
    value = _view(db, delivery)
    action.response_json, action.finished_at = _json(value), utcnow()
    return value


def _find_action(db, request_id, principal, digest):
    action = db.query(StylingDirectAction).filter_by(scope=principal['scope'],
               actor_subject=principal['subject'], request_id=request_id).first()
    if action:
        if action.request_digest != digest:
            _err(409, 'DIRECT_REQUEST_CONFLICT', '同一请求标识已绑定其他操作或内容。')
        if action.response_json != 'null':
            return action, json.loads(action.response_json)
    return action, None


def _recover_lease(db, delivery):
    if delivery.lease_token and delivery.lease_until and _aware(delivery.lease_until) > _aware(utcnow()):
        _err(409, 'DIRECT_SEND_IN_PROGRESS', '该冻结身份已有直连操作在途，请稍后查询。')
    if delivery.lease_token:
        for attempt in db.query(StylingDirectAttempt).filter_by(delivery_id=delivery.id, status='sending').all():
            attempt.status, attempt.error_code, attempt.finished_at = 'unconfirmed', 'DIRECT_INTERRUPTED', utcnow()
        if delivery.status != 'received':
            delivery.status, delivery.last_error = 'unconfirmed', 'DIRECT_INTERRUPTED'
        for action in db.query(StylingDirectAction).filter_by(delivery_id=delivery.id, response_json='null').all():
            _finish_action(db, action, delivery)
        delivery.lease_token, delivery.lease_until = None, None


def _claim_lease(delivery):
    token = uuid.uuid4().hex
    delivery.lease_token, delivery.lease_until = token, utcnow() + timedelta(seconds=60)
    if delivery.status != 'received':
        delivery.status = 'sending'
    delivery.updated_at = utcnow()
    return token


def _action(db, delivery, principal, request_id, operation, digest):
    action = StylingDirectAction(id=uuid.uuid4().hex, delivery_id=delivery.id,
        scope=principal['scope'], actor_subject=principal['subject'], request_id=request_id,
        operation=operation, request_digest=digest)
    db.add(action)
    db.flush()
    return action


def _unique_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate')
        result[key] = value
    return result


def _http(target, method, path, *, content=None, key=None, params=None):
    headers = {'Authorization': 'Bearer ' + target['sender_token'], 'Accept': 'application/json'}
    if content is not None:
        headers['Content-Type'] = 'application/json'
    if key:
        headers['Idempotency-Key'] = key
    start = time.monotonic()
    try:
        with httpx.Client(trust_env=False, follow_redirects=False,
                timeout=httpx.Timeout(10.0, connect=3.0, pool=1.0),
                limits=httpx.Limits(max_connections=1, max_keepalive_connections=0)) as client:
            with client.stream(method, target['base_url'] + path, headers=headers,
                               content=content, params=params) as response:
                if response.status_code == 404:
                    return 404, None
                if response.status_code not in (200, 201):
                    if response.status_code == 504:
                        _err(504, 'DIRECT_TIMEOUT', _MESSAGES['DIRECT_TIMEOUT'])
                    _err(502, 'DIRECT_REMOTE_REJECTED', _MESSAGES['DIRECT_REMOTE_REJECTED'])
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 262144 or time.monotonic() - start > 15:
                        _err(502, 'DIRECT_RESPONSE_INVALID', _MESSAGES['DIRECT_RESPONSE_INVALID'])
                    chunks.append(chunk)
                try:
                    value = json.loads(b''.join(chunks).decode('utf-8'), object_pairs_hook=_unique_pairs,
                                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                except (ValueError, UnicodeError):
                    _err(502, 'DIRECT_RESPONSE_INVALID', _MESSAGES['DIRECT_RESPONSE_INVALID'])
                return response.status_code, value
    except httpx.TimeoutException:
        _err(504, 'DIRECT_TIMEOUT', _MESSAGES['DIRECT_TIMEOUT'])
    except httpx.HTTPError:
        _err(502, 'DIRECT_UNREACHABLE', _MESSAGES['DIRECT_UNREACHABLE'])


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        return False
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return dt.tzinfo is not None and dt.utcoffset() == timedelta(0) and dt <= _aware(utcnow()) + timedelta(minutes=5)
    except ValueError:
        return False


def _receipt(value, delivery):
    envelope = json.loads(delivery.envelope_json)
    expected = {k: envelope[k] for k in ('transport_schema', 'source_product', 'target_product',
        'source_instance_id', 'target_instance_id', 'authorized_scope', 'handoff_id',
        'revision', 'payload_digest', 'source_approval_ref')}
    expected.update(receipt_schema='pa-direct-receipt/1', status='received',
                    supplement_id=delivery.first_supplement_id, supplement_digest=delivery.first_supplement_digest)
    keys = set(expected) | {'direct_receive_id', 'received_at', 'verification_id'}
    if (not isinstance(value, dict) or set(value) != keys or type(value.get('revision')) is not int
            or any(value.get(k) != v for k, v in expected.items())
            or any(not isinstance(value.get(k), str) or not _ID.fullmatch(value[k])
                   for k in ('direct_receive_id', 'verification_id'))
            or not _timestamp(value.get('received_at'))):
        _err(502, 'DIRECT_RECEIPT_MISMATCH', _MESSAGES['DIRECT_RECEIPT_MISMATCH'])
    if delivery.receipt_json != 'null' and value != json.loads(delivery.receipt_json):
        _err(502, 'DIRECT_RECEIPT_MISMATCH', _MESSAGES['DIRECT_RECEIPT_MISMATCH'])
    return value


def _lookup_response(value, delivery, late):
    if not isinstance(value, dict) or set(value) != {'receipt', 'current_supplement'}:
        _err(502, 'DIRECT_RESPONSE_INVALID', _MESSAGES['DIRECT_RESPONSE_INVALID'])
    receipt = _receipt(value['receipt'], delivery)
    current = value['current_supplement']
    allowed = {(delivery.first_supplement_id, delivery.first_supplement_digest)}
    if late:
        allowed.add((late.supplement_id, late.digest))
    if current is not None:
        if (not isinstance(current, dict) or set(current) != {'supplement_id', 'digest'}
                or (current.get('supplement_id'), current.get('digest')) not in allowed):
            _err(502, 'DIRECT_RECEIPT_MISMATCH', _MESSAGES['DIRECT_RECEIPT_MISMATCH'])
    if delivery.first_supplement_id and current is None:
        _err(502, 'DIRECT_RECEIPT_MISMATCH', _MESSAGES['DIRECT_RECEIPT_MISMATCH'])
    return receipt, current


def _post_response(value, delivery):
    if not isinstance(value, dict) or set(value) != {'receipt', 'duplicate'} or type(value['duplicate']) is not bool:
        _err(502, 'DIRECT_RESPONSE_INVALID', _MESSAGES['DIRECT_RESPONSE_INVALID'])
    receipt = _receipt(value['receipt'], delivery)
    return receipt, ({'supplement_id': delivery.first_supplement_id,
                      'digest': delivery.first_supplement_digest} if delivery.first_supplement_id else None)


def _late_response(value, delivery, late):
    if (not isinstance(value, dict) or set(value) != {'supplement_receipt', 'duplicate'}
            or type(value['duplicate']) is not bool):
        _err(502, 'DIRECT_RESPONSE_INVALID', _MESSAGES['DIRECT_RESPONSE_INVALID'])
    receipt = value['supplement_receipt']
    expected = {'receipt_schema': 'pa-direct-supplement-receipt/1',
        'direct_receive_id': json.loads(delivery.receipt_json)['direct_receive_id'],
        'supplement_id': late.supplement_id, 'digest': late.digest, 'status': 'received'}
    if (not isinstance(receipt, dict) or set(receipt) != set(expected) | {'received_at', 'verification_id'}
            or any(receipt.get(k) != v for k, v in expected.items())
            or not isinstance(receipt.get('verification_id'), str) or not _ID.fullmatch(receipt['verification_id'])
            or not _timestamp(receipt.get('received_at'))
            or late.receipt_json != 'null' and receipt != json.loads(late.receipt_json)):
        _err(502, 'DIRECT_RECEIPT_MISMATCH', _MESSAGES['DIRECT_RECEIPT_MISMATCH'])
    return receipt


def _perform(db, delivery_id, action_id, token, principal, target, operation, admin_action=None):
    # Commit the attempt before IO: the receiver may call back into this database.
    _begin(db)
    delivery = db.get(StylingDirectDelivery, delivery_id)
    if delivery.lease_token != token:
        db.rollback()
        _err(409, 'DIRECT_SEND_IN_PROGRESS', '该直连操作的在途租约已变化，请查询。')
    try:
        _check_context(db, principal, admin_action)
    except (StylingDeliveryError, ac.AdminContextError) as exc:
        if delivery.status != 'received':
            delivery.status, delivery.last_error = 'unconfirmed', exc.code
        db.commit()
        return False, exc.code
    attempt = StylingDirectAttempt(id=uuid.uuid4().hex, delivery_id=delivery_id,
                                   action_id=action_id, operation=operation)
    db.add(attempt)
    db.flush()
    attempt_id = attempt.id
    late = db.query(StylingDirectSupplement).filter_by(delivery_id=delivery_id).first()
    envelope_bytes = delivery.envelope_json.encode('utf-8')
    identity = {'handoff_id': delivery.handoff_id, 'revision': delivery.revision}
    if operation == 'supplement':
        content = late.request_json.encode('utf-8')
        receive_id = json.loads(delivery.receipt_json)['direct_receive_id']
        path = '/api/integrations/styling/v1/handoffs/' + quote(receive_id, safe='') + '/supplements'
        key = receive_id + ':' + late.supplement_id
    else:
        content, path, key = envelope_bytes, '/api/integrations/styling/v1/handoffs', delivery.handoff_id + ':' + str(delivery.revision)
    # Freeze only non-secret state in Python; expire/commit releases the SQL lock.
    db.commit()
    code, receipt, current, missing, dispatched = '', None, None, False, False
    try:
        latest = _target(principal)
        if latest['target_instance_id'] != target['target_instance_id']:
            _err(409, 'DIRECT_IDENTITY_CONFLICT', '目标实例已变化。')
        if admin_action is not None and ac.enabled():
            # Target configuration may be slow or may permit another request
            # to revoke the session. Re-read authority at the final dispatch
            # boundary; release its transaction before any target request.
            try:
                _check_context(db, principal, admin_action)
            except ac.AdminContextError:
                db.commit()
                raise
            db.commit()
        dispatched = True
        if operation == 'lookup':
            status_code, value = _http(latest, 'GET', '/api/integrations/styling/v1/handoffs/lookup', params=identity)
            if status_code == 404:
                missing, code = True, 'DIRECT_RECEIPT_NOT_FOUND'
            else:
                # No SQL access here: frozen ORM values have been loaded above.
                receipt, current = _lookup_response(value, delivery, late)
        elif operation == 'send':
            status_code, value = _http(latest, 'POST', path, content=content, key=key)
            if status_code == 404:
                _err(502, 'DIRECT_REMOTE_REJECTED', _MESSAGES['DIRECT_REMOTE_REJECTED'])
            receipt, current = _post_response(value, delivery)
        else:
            status_code, value = _http(latest, 'POST', path, content=content, key=key)
            if status_code == 404:
                _err(502, 'DIRECT_REMOTE_REJECTED', _MESSAGES['DIRECT_REMOTE_REJECTED'])
            receipt = _late_response(value, delivery, late)
        # A disabled sender/manager does not obtain a new confirmed result.
        latest = _target(principal)
        if latest['target_instance_id'] != target['target_instance_id']:
            _err(409, 'DIRECT_IDENTITY_CONFLICT', '目标实例已变化。')
    except (StylingDeliveryError, ac.AdminContextError) as exc:
        code = exc.code
    _begin(db)
    delivery = db.get(StylingDirectDelivery, delivery_id)
    attempt = db.get(StylingDirectAttempt, attempt_id)
    late = db.query(StylingDirectSupplement).filter_by(delivery_id=delivery_id).first()
    try:
        _check_context(db, principal, admin_action)
    except (StylingDeliveryError, ac.AdminContextError) as exc:
        code = exc.code
    if receipt is not None and not code:
        # An old valid response may confirm this same immutable object, but an
        # old failure cannot overwrite another worker's already stored receipt.
        if operation == 'supplement':
            if late.receipt_json != 'null' and json.loads(late.receipt_json) != receipt:
                code = 'DIRECT_RECEIPT_MISMATCH'
            else:
                late.status, late.receipt_json, late.last_error = 'received', _json(receipt), ''
                late.updated_at = utcnow()
                delivery.current_supplement_json = _json({'supplement_id': late.supplement_id, 'digest': late.digest})
        else:
            if delivery.receipt_json != 'null' and json.loads(delivery.receipt_json) != receipt:
                code = 'DIRECT_RECEIPT_MISMATCH'
            else:
                delivery.status, delivery.receipt_json, delivery.last_error = 'received', _json(receipt), ''
                delivery.current_supplement_json = _json(current)
    if code:
        if operation == 'supplement' and late and late.status != 'received':
            late.status, late.last_error, late.updated_at = 'unconfirmed', code, utcnow()
        if delivery.status != 'received':
            delivery.status, delivery.last_error = 'unconfirmed', code
    failed_before_dispatch = admin_action is not None and ac.enabled() and code and not dispatched
    attempt.status, attempt.error_code, attempt.finished_at = (
        'not_sent' if failed_before_dispatch else ('received' if not code else 'unconfirmed')), code, utcnow()
    delivery.updated_at = utcnow()
    db.commit()
    return missing, code


def _complete(db, delivery_id, action_id, token, principal, admin_action=None, bound_record=None):
    _begin(db)
    delivery = db.get(StylingDirectDelivery, delivery_id)
    if delivery.lease_token == token:
        delivery.lease_token, delivery.lease_until = None, None
    action = db.get(StylingDirectAction, action_id)
    if action.operation == 'supplement':
        late = db.query(StylingDirectSupplement).filter_by(delivery_id=delivery_id).first()
        if late and late.status == 'sending':
            attempt = db.query(StylingDirectAttempt).filter_by(action_id=action_id).order_by(StylingDirectAttempt.started_at.desc()).first()
            late.status, late.last_error = 'unconfirmed', (attempt.error_code if attempt else 'DIRECT_INTERRUPTED')
            late.updated_at = utcnow()
    result = _finish_action(db, action, delivery)
    failed_before_network = False
    if bound_record is not None:
        attempted = db.query(StylingDirectAttempt).filter_by(action_id=action_id).first()
        if attempted is None or attempted.status == 'not_sent':
            try:
                _check_context(db, principal, admin_action)
            except ac.AdminContextError:
                failed_before_network = True
    _finish_bound(db, bound_record, result, failed_before_network=failed_before_network)
    db.commit()
    if admin_action is not None and ac.enabled():
        _returned(db, principal, admin_action, result)
    _target(principal)
    if admin_action is None or not ac.enabled():
        _session(db, principal)
    return result


@_storage_safe
def send(db, handoff_id, request_id, expected_revision, include_supplement, principal, admin_action=None):
    target = None if ac.enabled() else _target(principal)
    if type(include_supplement) is not bool:
        _err(422, 'DIRECT_INVALID_REQUEST', '首次补充选择必须是布尔值。')
    digest = _sha(_json({'operation': 'send', 'handoff_id': handoff_id,
                         'expected_revision': expected_revision, 'include_supplement': include_supplement}))
    _begin(db)
    try:
        bound_record, replay = _bound_action(db, principal, admin_action, handoff_id, 'send')
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        target = target or _target(principal)
        fact, row = _frozen(db, handoff_id, expected_revision, principal)
        delivery = db.query(StylingDirectDelivery).filter_by(handoff_id=handoff_id, revision=row.version).first()
        existing = delivery is not None
        if delivery:
            _bound(delivery, fact, target, principal)
            if bool(delivery.first_supplement_id) != include_supplement:
                _err(409, 'DIRECT_IDENTITY_CONFLICT', '首次补充选择已冻结，晚补必须使用独立追加接口。')
        action, replay = _find_action(db, request_id, principal, digest)
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        if delivery and delivery.status != 'received':
            _recover_lease(db, delivery)
            if action and action.response_json != 'null':
                db.commit()
                return _returned(db, principal, admin_action, json.loads(action.response_json))
        if action:
            _err(409, 'DIRECT_SEND_IN_PROGRESS', '该请求已在途，请查询原身份。')
        if not delivery:
            from app.api.admin import _eligibility
            if _eligibility(db, row):
                _err(409, 'DIRECT_SEND_INELIGIBLE', '原冻结目标的当前发送资格不满足，请核对。')
            export = _export(db, handoff_id, principal) if include_supplement else None
            envelope_json = _json(_envelope(fact, row, target, export))
            if len(envelope_json.encode('utf-8')) > 8 * 1024 * 1024:
                _err(413, 'DIRECT_INPUT_TOO_LARGE', '直连信封超过大小上限。')
            delivery = StylingDirectDelivery(id='SDLV-' + uuid.uuid4().hex,
                handoff_id=handoff_id, revision=row.version, scope=principal['scope'],
                source_instance_id=principal['source_instance_id'], target_instance_id=target['target_instance_id'],
                approval_record_id=fact.approval_record_id, actor_subject=principal['subject'],
                envelope_json=envelope_json, envelope_digest=_sha(envelope_json),
                payload_digest=hashlib.sha256(row.payload_json.encode('utf-8')).hexdigest(),
                first_supplement_id=export.supplement_id if export else None,
                first_supplement_digest=export.digest if export else None,
                receipt_json='null', current_supplement_json='null')
            db.add(delivery)
            db.flush()
        action = _action(db, delivery, principal, request_id, 'send', digest)
        if delivery.status == 'received':
            result = _finish_action(db, action, delivery)
            _finish_bound(db, bound_record, result)
            db.commit()
            return _returned(db, principal, admin_action, result)
        if ac.enabled() and existing:
            # A prior uncertain network attempt cannot grant another send from
            # a lookup 404. Only explicit reconcile may query the target.
            uncertain = db.query(StylingDirectAttempt).filter_by(delivery_id=delivery.id).filter(
                StylingDirectAttempt.status != 'not_sent').first()
            if uncertain is not None:
                result = _finish_action(db, action, delivery)
                _finish_bound(db, bound_record, result)
                db.commit()
                return _returned(db, principal, admin_action, result)
            # A source-only preflight failure has never reached the target.
            # A new explicit action may execute after normal qualification.
            existing = False
        token = _claim_lease(delivery)
        delivery_id, action_id = delivery.id, action.id
        db.commit()
    except Exception:
        db.rollback()
        raise
    # Explicit retry is lookup-first. The 404 result alone is never success.
    if existing:
        missing, code = _perform(db, delivery_id, action_id, token, principal, target, 'lookup', admin_action)
        if not missing:
            return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)
    # A retry that found no record still revalidates the existing source gate.
    _begin(db)
    try:
        _check_context(db, principal, admin_action)
        _, row = _frozen(db, handoff_id, expected_revision, principal)
        from app.api.admin import _eligibility
        if _eligibility(db, row):
            delivery = db.get(StylingDirectDelivery, delivery_id)
            delivery.status, delivery.last_error = 'unconfirmed', 'DIRECT_SEND_INELIGIBLE'
            db.commit()
            return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)
        db.commit()
    except ac.AdminContextError as exc:
        delivery = db.get(StylingDirectDelivery, delivery_id)
        if delivery.status != 'received':
            delivery.status, delivery.last_error = 'unconfirmed', exc.code
        db.commit()
        return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)
    except Exception:
        db.rollback()
        raise
    _perform(db, delivery_id, action_id, token, principal, target, 'send', admin_action)
    return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)


@_storage_safe
def reconcile(db, handoff_id, request_id, expected_revision, principal, admin_action=None):
    target = None if ac.enabled() else _target(principal)
    digest = _sha(_json({'operation': 'reconcile', 'handoff_id': handoff_id, 'expected_revision': expected_revision}))
    _begin(db)
    try:
        bound_record, replay = _bound_action(db, principal, admin_action, handoff_id, 'reconcile')
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        target = target or _target(principal)
        fact, row = _frozen(db, handoff_id, expected_revision, principal)
        delivery = db.query(StylingDirectDelivery).filter_by(handoff_id=handoff_id, revision=row.version).first()
        if not delivery:
            _err(404, 'DIRECT_DELIVERY_NOT_FOUND', '该版本尚无直连发送记录。')
        _bound(delivery, fact, target, principal)
        action, replay = _find_action(db, request_id, principal, digest)
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        if delivery.status != 'received':
            _recover_lease(db, delivery)
            if action and action.response_json != 'null':
                db.commit()
                return _returned(db, principal, admin_action, json.loads(action.response_json))
        if action:
            _err(409, 'DIRECT_SEND_IN_PROGRESS', '该请求已在途。')
        action = _action(db, delivery, principal, request_id, 'reconcile', digest)
        if delivery.status == 'received':
            result = _finish_action(db, action, delivery)
            _finish_bound(db, bound_record, result)
            db.commit()
            return _returned(db, principal, admin_action, result)
        token = _claim_lease(delivery)
        delivery_id, action_id = delivery.id, action.id
        db.commit()
    except Exception:
        db.rollback()
        raise
    _perform(db, delivery_id, action_id, token, principal, target, 'lookup', admin_action)
    return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)


@_storage_safe
def status(db, handoff_id, principal):
    target = _target(principal)
    _session(db, principal)
    from app.services.styling_evidence import load_frozen_approval, StylingEvidenceError
    try:
        fact, row, _, _ = load_frozen_approval(db, handoff_id, principal)
    except StylingEvidenceError as exc:
        _err(exc.status, exc.code, exc.message)
    delivery = db.query(StylingDirectDelivery).filter_by(handoff_id=handoff_id, revision=row.version).first()
    if not delivery:
        value = {'transport': 'direct', 'handoff_id': handoff_id, 'revision': row.version,
                'status': 'not_started', 'receipt': None, 'current_supplement': None,
                'supplement_delivery': None, 'attempts': []}
        if ac.enabled():
            value['transmission_actor_subject'] = None
        return value
    _bound(delivery, fact, target, principal)
    return _view(db, delivery)


@_storage_safe
def append_supplement(db, handoff_id, request_id, expected_revision, principal, admin_action=None):
    target = None if ac.enabled() else _target(principal)
    digest = _sha(_json({'operation': 'supplement', 'handoff_id': handoff_id, 'expected_revision': expected_revision}))
    _begin(db)
    try:
        bound_record, replay = _bound_action(db, principal, admin_action, handoff_id, 'supplement')
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        target = target or _target(principal)
        fact, row = _frozen(db, handoff_id, expected_revision, principal)
        delivery = db.query(StylingDirectDelivery).filter_by(handoff_id=handoff_id, revision=row.version).first()
        if not delivery or delivery.status != 'received':
            _err(409, 'DIRECT_RECEIPT_REQUIRED', '须先核实原身份的直接接收回执，再追加补充。')
        _bound(delivery, fact, target, principal)
        action, replay = _find_action(db, request_id, principal, digest)
        if replay is not None:
            db.commit()
            return _returned(db, principal, admin_action, replay)
        _recover_lease(db, delivery)
        if action and action.response_json != 'null':
            db.commit()
            return _returned(db, principal, admin_action, json.loads(action.response_json))
        if action:
            _err(409, 'DIRECT_SEND_IN_PROGRESS', '该补充请求已在途。')
        export = _export(db, handoff_id, principal)
        if delivery.first_supplement_id:
            _err(409, 'DIRECT_SUPPLEMENT_ALREADY_PRESENT', '首次信封已有补充，不能再次追加。')
        request_json = _json({'handoff_id': delivery.handoff_id, 'revision': delivery.revision,
            'payload_digest': delivery.payload_digest, 'source_approval_ref': {'approval_record_id': delivery.approval_record_id},
            'supplement': _supplement(export)})
        late = db.query(StylingDirectSupplement).filter_by(delivery_id=delivery.id).first()
        existing = late is not None
        if late and (late.request_json != request_json or late.supplement_id != export.supplement_id or late.digest != export.digest):
            _err(409, 'DIRECT_SUPPLEMENT_CONFLICT', '晚补的原内容已冻结，不得覆盖。')
        if not late:
            late = StylingDirectSupplement(id='SDSUP-' + uuid.uuid4().hex, delivery_id=delivery.id,
                supplement_id=export.supplement_id, digest=export.digest, request_json=request_json,
                request_digest=_sha(request_json), receipt_json='null')
            db.add(late)
            db.flush()
        action = _action(db, delivery, principal, request_id, 'supplement', digest)
        if late.status == 'received':
            result = _finish_action(db, action, delivery)
            _finish_bound(db, bound_record, result)
            db.commit()
            return _returned(db, principal, admin_action, result)
        token = _claim_lease(delivery)
        late.status, late.updated_at = 'sending', utcnow()
        delivery_id, action_id = delivery.id, action.id
        db.commit()
    except Exception:
        db.rollback()
        raise
    if existing:
        # First query the initial identity. A matching current supplement still
        # needs its stable receipt, obtained by the same append identity/body.
        missing, code = _perform(db, delivery_id, action_id, token, principal, target, 'lookup', admin_action)
        if missing or code:
            return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)
    _perform(db, delivery_id, action_id, token, principal, target, 'supplement', admin_action)
    return _complete(db, delivery_id, action_id, token, principal, admin_action, bound_record)
