"""Authorized private photo routes. Uploads are bounded before any disk spooling."""
import json
import os
import re
from email import policy
from email.parser import BytesParser

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.core.consumer_identity import resolve_consumer_owner
from app.models.tryon import utcnow
from app.schemas.personal_preview import PreviewConfirmation, PreviewDelete, PreviewTaskInput
from app.services.personal_preview import PreviewError, get_store
from app.services.personal_preview_media import MediaError, normalize_photo

CONTRACT = 'personal_outfit_preview_v1'
PHOTO_LIMIT = 5 * 1024 * 1024
ENVELOPE_LIMIT = PHOTO_LIMIT + 64 * 1024
METADATA_LIMIT = 8 * 1024


async def preview_error_handler(_request, exc):
    return JSONResponse(status_code=exc.status,
                        content={'error': {'code': exc.code, 'message': exc.message}},
                        headers={'Cache-Control': 'no-store'})


def _bad(code='PREVIEW_INVALID_REQUEST', message='照片请求字段无效，请重新核对。', status=422):
    return PreviewError(code, message, status)


def _closed_query(request: Request):
    # Owner identity comes only from the authorized Cookie. Reject extra or
    # repeated query fields on every route instead of silently ignoring them.
    allowed = {'session_id', 'look_version_id'} if request.url.path == '/api/v1/personal-preview/availability' else (
        {'limit', 'cursor'} if request.url.path == '/api/v1/personal-preview/tasks' and request.method == 'GET' else set())
    seen = set()
    for key, _value in request.query_params.multi_items():
        if key not in allowed or key in seen:
            raise _bad()
        seen.add(key)


router = APIRouter(prefix='/api/v1/personal-preview', tags=['personal-preview'],
                   dependencies=[Depends(_closed_query)])


def _daily_limit():
    try:
        limit = int(os.environ.get('STYLING_PERSONAL_PREVIEW_DAILY_LIMIT', '10'))
    except ValueError:
        raise _bad('PREVIEW_STORAGE_UNAVAILABLE', '任务限额配置无效。', 503) from None
    if not 1 <= limit <= 100:
        raise _bad('PREVIEW_STORAGE_UNAVAILABLE', '任务限额配置无效。', 503)
    return limit


def _validate(model, body):
    try:
        return model.model_validate(body).model_dump(mode='json')
    except ValidationError:
        raise _bad() from None


def _unique_pairs(items):
    obj = {}
    for key, value in items:
        if key in obj:
            raise ValueError('duplicate JSON key')
        obj[key] = value
    return obj


async def _multipart(request):
    content_type = request.headers.get('content-type', '')
    if len(content_type) > 256 or '\r' in content_type or '\n' in content_type:
        raise _bad()
    prefix = BytesParser(policy=policy.default).parsebytes(
        ('Content-Type: ' + content_type + '\r\n\r\n').encode('ascii', errors='ignore'))
    boundary = prefix.get_boundary()
    if (prefix.get_content_type() != 'multipart/form-data' or not boundary
            or not re.fullmatch(r"[A-Za-z0-9'()+_,./:=? -]{1,70}", boundary)):
        raise _bad()
    declared_length = request.headers.get('content-length')
    if declared_length is not None:
        if not re.fullmatch(r'[0-9]{1,10}', declared_length):
            raise _bad()
        if int(declared_length) > ENVELOPE_LIMIT:
            raise _bad('PREVIEW_UPLOAD_TOO_LARGE', '照片超过5MiB或请求开销超限。', 413)
    # Starlette's automatic form parser can spool raw photos before validation.
    # Consume directly with a hard envelope cap, keeping the raw photo in memory.
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > ENVELOPE_LIMIT:
            raise _bad('PREVIEW_UPLOAD_TOO_LARGE', '照片超过5MiB或请求开销超限。', 413)
        raw.extend(chunk)
    try:
        message = BytesParser(policy=policy.default).parsebytes(
            ('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii') + bytes(raw))
        parts = list(message.iter_parts())
        if message.defects or len(parts) != 2:
            raise ValueError('invalid envelope')
        for part, name in zip(parts, ('metadata', 'photo')):
            if (part.defects or part.is_multipart()
                    or part.get_content_disposition() != 'form-data'
                    or part.get_param('name', header='content-disposition') != name
                    or part.get('Content-Transfer-Encoding') not in (None, 'binary')):
                raise ValueError('invalid part')
            if len(part.get_all('Content-Disposition', [])) != 1:
                raise ValueError('duplicate disposition')
        metadata_bytes = parts[0].get_payload(decode=True)
        photo = parts[1].get_payload(decode=True)
        if (parts[0].get_content_type() != 'application/json' or metadata_bytes is None
                or len(metadata_bytes) > METADATA_LIMIT or photo is None):
            raise ValueError('invalid metadata')
        metadata = json.loads(metadata_bytes.decode('utf-8'), object_pairs_hook=_unique_pairs,
                              parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('non-finite')))
    except (ValueError, UnicodeError, TypeError):
        raise _bad() from None
    if len(photo) > PHOTO_LIMIT:
        raise _bad('PREVIEW_UPLOAD_TOO_LARGE', '照片超过5MiB。', 413)
    return _validate(PreviewTaskInput, metadata), photo


@router.get('/capabilities')
def capabilities(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    enabled = os.environ.get('STYLING_PERSONAL_PREVIEW_ENABLED', '0') == '1'
    isolated = os.environ.get('STYLING_PERSONAL_PREVIEW_ISOLATED', '0') == '1'
    mode = os.environ.get('STYLING_PERSONAL_PREVIEW_PROVIDER', 'disabled')
    mock = enabled and isolated and mode == 'mock'
    from app.services.personal_preview_runninghub import configuration_ready, MODEL
    real = enabled and mode == 'runninghub' and configuration_ready()
    return {'contract_version': CONTRACT, 'enabled': enabled, 'available': mock or real,
            'provider_mode': 'runninghub' if real else ('mock' if mock else 'disabled'), 'is_mock': mock,
            'real_provider_enabled': real, 'provider_model': MODEL if real else None,
            'limits': {'photo_max_bytes': PHOTO_LIMIT, 'metadata_max_bytes': METADATA_LIMIT,
                       'max_pixels': 20_000_000, 'max_side': 8192, 'formats': ['jpeg', 'png', 'webp'],
                       'active_per_owner': 1, 'daily_tasks': _daily_limit(),
                       **({'total_real_tasks': 1} if real else {})},
            'retention': {'confirmation_seconds': 600, 'input_hard_seconds': 86400,
                          'result_seconds': 30 * 86400, 'metadata_seconds': 90 * 86400,
                          'request_tombstones': 'retained', 'provider_retention': 'unknown'},
            'reasons': [] if mock or real else ['PREVIEW_DISABLED' if not enabled else 'PREVIEW_PROVIDER_UNAVAILABLE']}


@router.get('/availability')
def availability(request: Request, response: Response, session_id: str = Query(min_length=1, max_length=64),
                 look_version_id: str = Query(min_length=1, max_length=64),
                 owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().availability(owner, request.state.consumer_authorization, session_id, look_version_id)


@router.post('/confirmations', status_code=201)
def confirm(request: Request, response: Response, body: dict = Body(...), owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().confirm(owner, request.state.consumer_authorization, _validate(PreviewConfirmation, body))


@router.post('/tasks')
async def submit(request: Request, owner=Depends(resolve_consumer_owner)):
    store = get_store()
    first_upload_at = utcnow()
    metadata, raw_photo = await _multipart(request)
    try:
        photo = normalize_photo(raw_photo)
    except MediaError as exc:
        raise _bad(exc.code, '照片格式、大小或完整解码未通过，请重新选择。', exc.status) from None
    result = store.submit(owner, request.state.consumer_authorization, metadata, photo,
                          first_upload_at=first_upload_at)
    return JSONResponse(status_code=200 if result['duplicate'] else 202, content=result,
                        headers={'Cache-Control': 'no-store'})


@router.get('/requests/{request_id}')
def lookup_request(request_id: str, request: Request, response: Response, owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().lookup_request(owner, request.state.consumer_authorization, request_id)


@router.get('/tasks')
def tasks(request: Request, response: Response, limit: int = Query(default=20, ge=1, le=50),
          cursor: str | None = Query(default=None, max_length=256), owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().list(owner, request.state.consumer_authorization, limit=limit, cursor=cursor)


@router.get('/tasks/{task_id}')
def task(task_id: str, request: Request, response: Response, owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().get(owner, request.state.consumer_authorization, task_id)


@router.get('/tasks/{task_id}/result')
def result(task_id: str, request: Request, owner=Depends(resolve_consumer_owner)):
    data, mime = get_store().result(owner, request.state.consumer_authorization, task_id)
    return Response(content=data, media_type=mime,
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                             'Content-Disposition': 'inline; filename="personal-preview.jpg"'})


@router.get('/tasks/{task_id}/model-image')
def model_image(task_id: str, request: Request, owner=Depends(resolve_consumer_owner)):
    import hashlib
    data, mime = get_store().model_image(owner, request.state.consumer_authorization, task_id)
    return Response(content=data, media_type=mime,
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                             'X-Content-SHA256': hashlib.sha256(data).hexdigest()})


@router.post('/tasks/{task_id}/delete')
def delete(task_id: str, request: Request, response: Response, body: dict = Body(...),
           owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().delete(owner, request.state.consumer_authorization, task_id, _validate(PreviewDelete, body))


@router.get('/tasks/{task_id}/deletion')
def deletion(task_id: str, request: Request, response: Response, owner=Depends(resolve_consumer_owner)):
    response.headers['Cache-Control'] = 'no-store'
    return get_store().deletion(owner, request.state.consumer_authorization, task_id)
