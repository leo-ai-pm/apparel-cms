"""Fixed styling JSON API. Off by default; never proxies the old 8765 service."""
import asyncio

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse, Response

from app.services import fixed_styling as fixed
from app.services.fixed_execution import execute_turn
from app.core.consumer_identity import resolve_consumer_owner
from app.services import profile_snapshots
from pydantic import ValidationError

router = APIRouter(prefix='/api/v1/outfits', tags=['fixed-outfits'])


def _error(error):
    code = error.code
    status = (409 if code in {'STATE_REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'REQUEST_IN_PROGRESS'} else
              404 if code in {'SESSION_NOT_FOUND', 'NOT_FOUND', 'CART_ITEM_NOT_FOUND'} else
              429 if code in {'RATE_LIMITED', 'MODEL_BUSY', 'MODEL_CALL_BUDGET_EXHAUSTED', 'DAILY_LIMIT'} else
              503 if code.startswith(('MODEL_', 'FIXED_')) or code == 'INVENTORY_SNAPSHOT_STALE' else 422)
    return JSONResponse(status_code=status, content={'error': {'code': code, 'message': error.message}})


async def _run(callback):
    try:
        return await asyncio.to_thread(callback)
    except fixed.FixedStylingError as error:
        return _error(error)
    except ValidationError:
        return _error(fixed.FixedStylingError('INVALID_REQUEST', '请求字段无效，请检查资料绑定及本次条件。'))


@router.get('/health')
def health():
    result = fixed.health()
    return JSONResponse(status_code=200 if result.get('ready') else 503, content=result)


@router.get('/catalog')
async def catalog():
    return await _run(fixed.catalog)


@router.post('/sessions')
async def create(body: dict = Body(default={}), owner=Depends(resolve_consumer_owner)):
    if (set(body) - {'demo_profile', 'profile_contract'} or type(body.get('demo_profile', False)) is not bool
            or ('profile_contract' in body and body['profile_contract'] != 'consumer_profile_v1')
            or (body.get('demo_profile') and 'profile_contract' in body)):
        return _error(fixed.FixedStylingError('INVALID_REQUEST', '创建会话字段无效。'))
    def create_owned():
        result = fixed.create_session(body.get('demo_profile', False))
        if body.get('profile_contract') == 'consumer_profile_v1':
            profile_snapshots.register_created_session(owner, result['session_id'])
        return result
    return await _run(create_owned)


@router.get('/sessions/{session_id}')
async def get(session_id: str, owner=Depends(resolve_consumer_owner)):
    fixed.authorize_session(owner, session_id)
    return await _run(lambda: fixed.session_view(session_id))


@router.post('/sessions/{session_id}/turns')
async def turns(session_id: str, request: Request, body: dict = Body(...), owner=Depends(resolve_consumer_owner)):
    fixed.authorize_session(owner, session_id)
    return await _run(lambda: execute_turn(session_id, body, profile_owner=owner,
                                         profile_authorization=request.state.consumer_authorization))


@router.post('/sessions/{session_id}/actions')
async def actions(session_id: str, request: Request, body: dict = Body(...), owner=Depends(resolve_consumer_owner)):
    fixed.authorize_session(owner, session_id)
    return await _run(lambda: fixed.action(session_id, body, profile_owner=owner,
                                         profile_authorization=request.state.consumer_authorization))


@router.get('/assets/{look_id}')
async def asset(look_id: str):
    try:
        raw = await asyncio.to_thread(fixed.asset_bytes, look_id)
        return Response(raw, media_type='image/png', headers={'Cache-Control': 'no-store'})
    except fixed.FixedStylingError as error:
        return _error(error)


@router.get('/product-assets/{asset_id}')
async def product_asset(asset_id: str):
    from app.services import product_image_assets
    try:
        def read_registered():
            return product_image_assets.image_bytes(asset_id, fixed.get_service().r)
        raw, mime, digest = await asyncio.to_thread(read_registered)
        return Response(raw, media_type=mime, headers={'Cache-Control': 'no-store', 'X-Content-SHA256': digest})
    except product_image_assets.ProductImageAssetError as error:
        return JSONResponse(status_code=error.status, content={'error': {'code': error.code, 'message': error.message}},
                            headers={'Cache-Control': 'no-store'})
    except fixed.FixedStylingError as error:
        return _error(error)
