"""Explicit local-only role entry; no automatic business actions or model calls."""
import json
import os
import time
from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, ValidationError

from app.core.admin_auth import COOKIE, demo_enabled, demo_mode, demo_token, ensure_demo_local
from app.core.consumer_identity import resolve_consumer_owner
from app.services.admin_context import AdminContextError

CONTRACT = 'styling_demo_access_v1'
router = APIRouter(prefix='/api/v1/demo-access', tags=['demo-access'])


class DemoEnter(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    role: Literal['consumer', 'styling-manager']


class DemoEntryResult(DemoEnter):
    contract_version: Literal['styling_demo_access_v1']
    entry_path: Literal['/', '/admin']


class DemoRole(DemoEnter):
    entry_path: Literal['/', '/admin']


class DemoCapabilities(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    contract_version: Literal['styling_demo_access_v1']
    mode: Literal['local_demo', 'public_demo', 'authenticated']
    login_required: bool
    roles: list[DemoRole]
    shared_demo: bool


def _closed_query(request):
    if request.query_params:
        raise AdminContextError(422, 'DEMO_ACCESS_INVALID_REQUEST', '演示入口不接受额外查询参数。')


@router.get('', response_model=DemoCapabilities)
def capabilities(request: Request, response: Response):
    _closed_query(request)
    enabled = demo_enabled()
    if enabled:
        ensure_demo_local(request)
    response.headers['Cache-Control'] = 'no-store'
    mode = ('public_demo' if demo_mode() == 'public' else 'local_demo') if enabled else 'authenticated'
    return {'contract_version': CONTRACT, 'mode': mode,
            'login_required': not enabled, 'shared_demo': enabled,
            'roles': [{'role': 'consumer', 'entry_path': '/'},
                      {'role': 'styling-manager', 'entry_path': '/admin'}]}


@router.post('/enter', response_model=DemoEntryResult, openapi_extra={
    'requestBody': {'required': True, 'content': {'application/json': {'schema': DemoEnter.model_json_schema()}}}})
async def enter(request: Request, response: Response):
    _closed_query(request)
    if not demo_enabled():
        raise AdminContextError(403, 'DEMO_ACCESS_DISABLED', '临时演示访问未启用。')
    ensure_demo_local(request, entering=True)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 1024:
            raise AdminContextError(422, 'DEMO_ACCESS_INVALID_REQUEST', '演示入口只接受角色字段。')
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError()
            value[key] = item
        return value
    try:
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        body = DemoEnter.model_validate(value)
    except (ValueError, ValidationError, UnicodeError):
        raise AdminContextError(422, 'DEMO_ACCESS_INVALID_REQUEST', '演示入口只接受consumer或styling-manager角色。') from None
    if body.role == 'consumer':
        resolve_consumer_owner(request, response)
    else:
        cookie = demo_token(request)
        remaining = max(1, int(cookie.split('.')[0]) - int(time.time()))
        response.set_cookie(COOKIE, cookie, max_age=remaining, httponly=True, samesite='strict',
                            secure=os.getenv('STYLING_ADMIN_COOKIE_SECURE', '1') != '0', path='/')
    response.headers['Cache-Control'] = 'no-store'
    return {'contract_version': CONTRACT, 'role': body.role,
            'entry_path': '/' if body.role == 'consumer' else '/admin'}
