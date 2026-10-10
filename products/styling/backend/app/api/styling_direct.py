"""Separate manager actions and purpose-bound source callback."""
import asyncio
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.exc import SQLAlchemyError
from app.core.admin_auth import require_account_bound, revalidate_principal
from app.core.database import SessionLocal
from app.core.styling_direct_auth import require_verifier
from app.schemas.styling_direct import DirectSend, DirectAction, VerifyApproval, EvidenceAction
from app.services import admin_context as ac

router = APIRouter(tags=['styling-direct'])


def principal_fields(value):
    keys = ('subject', 'scope', 'source_instance_id', 'auth_method', 'approval_identity_kind', 'session_id', 'audience', 'role')
    return {key: getattr(value, key) for key in keys}


def _check_return_context(db, principal, body):
    try:
        ac.revalidate_context(db, principal, body.expected_admin_context)
    except ac.AdminContextError:
        # Retire a deployment generation durably even if the business response
        # has already committed and the current context now fails.
        try:
            db.commit()
        except SQLAlchemyError:
            db.rollback()
        raise
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise ac.AdminContextError(503, 'ADMIN_OPERATION_STORAGE_UNAVAILABLE',
            '管理操作权威记录暂不可用，请先查询原操作。', True) from None


@router.post('/api/integrations/product-management/v1/verify-approval')
async def verify(body: VerifyApproval, verifier=Depends(require_verifier)):
    from app.services.styling_verification import verify_approval
    result = await asyncio.to_thread(verify_approval, body, verifier)
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})


@router.post('/api/v1/admin/handoffs/{handoff_id}/evidence-export')
async def evidence_create(handoff_id: str, body: EvidenceAction | None = None, principal=Depends(require_account_bound)):
    from app.services.styling_evidence import export_evidence
    def execute():
        from sqlalchemy import text
        with SessionLocal() as db:
            if db.bind.dialect.name == 'sqlite':
                db.execute(text('BEGIN IMMEDIATE'))
            operation = None
            if ac.enabled():
                if body is None:
                    raise ac.AdminContextError(422, 'ADMIN_CONTEXT_REQUIRED', '请先读取当前管理上下文。')
                operation, replay = ac.begin_action(db, principal, body, 'POST',
                    '/api/v1/admin/handoffs/' + handoff_id + '/evidence-export', 'evidence_export')
                if replay is not None:
                    db.commit()
                    _check_return_context(db, principal, body)
                    return replay
                from app.services.styling_evidence import load_frozen_approval
                _, frozen, _, _ = load_frozen_approval(db, handoff_id, principal_fields(principal))
                if frozen.version != body.expected_revision:
                    from app.services.styling_delivery import StylingDeliveryError
                    raise StylingDeliveryError(409, 'DIRECT_REVISION_CONFLICT', '交接版本已变化，请核对服务端冻结版本。')
            else:
                revalidate_principal(db, principal, account_required=True)
            row = export_evidence(db, handoff_id, principal_fields(principal))
            result = {'supplement_id': row.supplement_id, 'digest': row.digest,
                      'handoff_id': row.handoff_id, 'revision': row.revision,
                      'metadata_digest': row.metadata_digest, 'rule_version': row.rule_version,
                      'status': 'registered'}
            if operation is not None:
                ac.finish_action(db, operation, result, outcome='completed',
                    result_ref={'kind': 'frozen_evidence', 'id': row.supplement_id, 'revision': row.revision})
            db.commit()
            if operation is not None:
                _check_return_context(db, principal, body)
            return result
    result = await asyncio.to_thread(execute)
    headers = ac.action_headers(body.request_id) if ac.enabled() and body is not None else {'Cache-Control': 'no-store'}
    return JSONResponse(result, headers=headers)


@router.get('/api/v1/admin/handoffs/{handoff_id}/evidence-export')
async def evidence_read(handoff_id: str, principal=Depends(require_account_bound)):
    from app.services.styling_evidence import get_registered_export
    def execute():
        with SessionLocal() as db:
            revalidate_principal(db, principal, account_required=True)
            row = get_registered_export(db, handoff_id, principal_fields(principal))
            if row is None:
                from app.core.styling_direct_auth import DirectAuthError
                raise DirectAuthError(404, 'EVIDENCE_EXPORT_NOT_FOUND', '冻结补充尚未登记。')
            return {'content_json': row.content_json, 'digest': row.digest}
    result = await asyncio.to_thread(execute)
    return Response(result['content_json'].encode('utf-8'), media_type='application/json',
                    headers={'Cache-Control': 'no-store', 'X-Content-SHA256': result['digest']})


@router.post('/api/v1/admin/handoffs/{handoff_id}/direct-send')
async def direct_send(handoff_id: str, body: DirectSend, principal=Depends(require_account_bound)):
    from app.services.styling_delivery import send
    def execute():
        with SessionLocal() as db:
            return send(db, handoff_id, request_id=body.request_id, expected_revision=body.expected_revision,
                include_supplement=body.include_supplement, principal=principal_fields(principal),
                admin_action=body if ac.enabled() else None)
    result = await asyncio.to_thread(execute)
    return JSONResponse(result, headers=ac.action_headers(body.request_id) if ac.enabled() else {'Cache-Control': 'no-store'})


@router.get('/api/v1/admin/handoffs/{handoff_id}/direct-delivery')
async def direct_status(handoff_id: str, principal=Depends(require_account_bound)):
    from app.services.styling_delivery import status
    def execute():
        with SessionLocal() as db:
            return status(db, handoff_id, principal_fields(principal))
    result = await asyncio.to_thread(execute)
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})


@router.post('/api/v1/admin/handoffs/{handoff_id}/direct-reconcile')
async def direct_reconcile(handoff_id: str, body: DirectAction, principal=Depends(require_account_bound)):
    from app.services.styling_delivery import reconcile
    def execute():
        with SessionLocal() as db:
            return reconcile(db, handoff_id, request_id=body.request_id, expected_revision=body.expected_revision,
                principal=principal_fields(principal), admin_action=body if ac.enabled() else None)
    result = await asyncio.to_thread(execute)
    return JSONResponse(result, headers=ac.action_headers(body.request_id) if ac.enabled() else {'Cache-Control': 'no-store'})


@router.post('/api/v1/admin/handoffs/{handoff_id}/direct-supplement')
async def direct_supplement(handoff_id: str, body: DirectAction, principal=Depends(require_account_bound)):
    from app.services.styling_delivery import append_supplement
    def execute():
        with SessionLocal() as db:
            return append_supplement(db, handoff_id, request_id=body.request_id, expected_revision=body.expected_revision,
                principal=principal_fields(principal), admin_action=body if ac.enabled() else None)
    result = await asyncio.to_thread(execute)
    return JSONResponse(result, headers=ac.action_headers(body.request_id) if ac.enabled() else {'Cache-Control': 'no-store'})
