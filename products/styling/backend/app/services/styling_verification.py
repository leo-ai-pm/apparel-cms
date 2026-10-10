"""A callback proves stored account approvals, never a caller's claimed hash."""
from datetime import timedelta, timezone
import hashlib
import json
import uuid

from sqlalchemy import text
from app.core.database import SessionLocal
from app.core.styling_direct_auth import DirectAuthError
from app.models.styling_verification import StylingApprovalVerification
from app.models.tryon import utcnow


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def verify_approval(req, verifier):
    from app.models.styling_direct import StylingApprovalFact, StylingEvidenceExport
    from app.services.styling_evidence import load_frozen_approval
    body = req.model_dump(mode='json')
    for key in ('authorized_scope', 'source_instance_id', 'target_instance_id'):
        if body[key] != verifier[key]:
            raise DirectAuthError(403, 'DIRECT_SCOPE_FORBIDDEN', '服务主体与请求范围不匹配。')
    digest = hashlib.sha256(_encoded(body).encode()).hexdigest()
    with SessionLocal() as db:
        if db.bind.dialect.name == 'sqlite':
            db.execute(text('BEGIN IMMEDIATE'))
        expected = {'scope': verifier['authorized_scope'], 'source_instance_id': verifier['source_instance_id'],
                    'approval_identity_kind': 'account_bound'}
        fact, handoff, payload, metadata = load_frozen_approval(db, req.handoff_id, expected)
        if (fact.approval_record_id != req.source_approval_ref.approval_record_id
                or fact.revision != req.revision or fact.payload_digest != req.payload_digest):
            raise DirectAuthError(422, 'APPROVAL_BINDING_MISMATCH', '批准引用与冻结交接事实不匹配。')
        if req.supplement_id is not None:
            supplement = db.get(StylingEvidenceExport, req.supplement_id)
            if (supplement is None or supplement.handoff_id != req.handoff_id
                    or supplement.revision != req.revision or supplement.approval_record_id != fact.approval_record_id
                    or supplement.digest != req.supplement_digest or supplement.metadata_digest != fact.metadata_digest
                    or hashlib.sha256(supplement.content_json.encode()).hexdigest() != req.supplement_digest):
                raise DirectAuthError(422, 'SUPPLEMENT_BINDING_MISMATCH', '冻结补充绑定不匹配。')
        if req.verification_purpose == 'initial_delivery':
            from app.api.admin import _eligibility
            if _eligibility(db, handoff):
                raise DirectAuthError(422, 'APPROVAL_OPERATION_INELIGIBLE', '该冻结包当前不具备首次发送资格。')
        previous = db.query(StylingApprovalVerification).filter_by(verifier_subject=verifier['subject'], nonce=req.nonce).first()
        at = utcnow()
        if previous:
            if previous.request_digest != digest:
                raise DirectAuthError(409, 'VERIFICATION_NONCE_CONFLICT', '核验随机标识已绑定其他请求。')
            if previous.expires_at <= at:
                raise DirectAuthError(422, 'VERIFICATION_NONCE_EXPIRED', '核验随机标识已过期。')
            return json.loads(previous.response_json)
        response = {**body, 'metadata_digest': fact.metadata_digest,
                    'approved_by': fact.subject, 'approval_identity_kind': 'account_bound',
                    'approved_at': fact.approved_at, 'verification_id': 'STV-' + uuid.uuid4().hex,
                    'verified_at': at.replace(tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z'),
                    'approval_state': 'approved', 'operation_eligible': True, 'data_origin': fact.data_origin}
        db.add(StylingApprovalVerification(verification_id=response['verification_id'],
                verifier_subject=verifier['subject'], nonce=req.nonce, request_digest=digest,
                response_json=_encoded(response), verified_at=at, expires_at=at + timedelta(seconds=300)))
        db.commit()
        return response
