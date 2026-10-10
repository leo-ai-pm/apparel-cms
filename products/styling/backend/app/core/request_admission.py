"""Reserve accepted chat requests and daily quota in one short transaction."""
import hashlib
import json
import re
import uuid
from datetime import date

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.consumer_context import validate_authorization
from app.core.database import SessionLocal
from app.core.demand_versions import EXTRACTOR_VERSION
from app.models.chat import DailyUsage
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.services.signals import desensitize


def _body_safe_evidence(message):
    # Measurements may be present in restricted request/history data, never in
    # enterprise demand evidence. Keep the original body digest for idempotency.
    numbers = r"[0-9零〇一二两三四五六七八九十百千点\.]+"
    message = re.sub(r"(?:身高|体重)\s*[:：=]?\s*(?:为|是|大约|约)?\s*" + numbers +
                     r"\s*(?:厘米|公分|公斤|千克|cm|kg|米|斤)?\s*(?:" + numbers + r")?",
                     "[身体资料已隐藏]", message, flags=re.I)
    message = re.sub(r"(?:身高\s*[:：]?\s*)?" + numbers + r"\s*(?:cm|厘米|公分)",
                     "[身体资料已隐藏]", message, flags=re.I)
    message = re.sub(r"(?:体重\s*[:：]?\s*)?" + numbers + r"\s*(?:kg|公斤|千克|斤)",
                     "[身体资料已隐藏]", message, flags=re.I)
    message = re.sub(r"(?:身高|体重)\s*[:：]?\s*\d+(?:\.\d+)?", "[身体资料已隐藏]", message)
    return message


def admit_request(request_id: str, session_id: str, message: str, budget: str, scene: str,
                  request_context_digest: str = "", *, profile_owner=None,
                  profile_binding=None, request_body=None, profile_operation="chat",
                  profile_authorization=None) -> str:
    payload = [session_id, message, budget, scene]
    if request_context_digest:
        payload.append(request_context_digest)
    if profile_binding is not None:
        if profile_owner is None or type(request_body) is not dict:
            raise ValueError("profile-bound admission requires original body and owner")
        payload = {"body": request_body, "owner_key": profile_owner.binding_key}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                      separators=(",", ":")).encode()).hexdigest() if profile_binding is not None else hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode()).hexdigest()
    with SessionLocal() as db:
        # Existing sqlite deployment: serialize request uniqueness and the quota increment together.
        # Keep the transaction short; no extraction or external model calls under this lock.
        if db.bind.dialect.name == "sqlite":
            db.execute(text("BEGIN IMMEDIATE"))
        if profile_binding is not None:
            if not db.in_transaction():
                db.begin()
            validate_authorization(db, profile_owner, profile_authorization)
        old = db.get(DemandRequestAdmission, request_id)
        if old:
            return "duplicate" if old.payload_digest == digest else "conflict"
        if db.query(DemandTurn.id).filter_by(request_id=request_id).first():
            return "duplicate"
        if profile_binding is not None:
            from app.services.profile_snapshots import validate_binding
            validate_binding(db, profile_owner, session_id, request_id, profile_binding,
                             request_body, expected_operation=profile_operation,
                             authorization=profile_authorization)
        today = date.today().isoformat()
        usage = db.query(DailyUsage).filter_by(day=today).with_for_update().first()
        if usage and usage.count >= settings.daily_call_limit:
            return "quota"
        if usage is None:
            usage = DailyUsage(day=today, count=0)
            db.add(usage)
        usage.count += 1
        if profile_binding is not None:
            from app.services.profile_snapshots import accept_binding
            accept_binding(db, profile_owner, session_id, request_id, profile_binding,
                           request_body, expected_operation=profile_operation,
                           authorization=profile_authorization)
        db.add(DemandRequestAdmission(request_id=request_id, payload_digest=digest, day=today))
        # Persist accepted user evidence in the SAME commit. A crash before extraction leaves
        # a queryable interrupted turn; duplicate admission must never point to missing text.
        turn_id = uuid.uuid4().hex
        db.add(DemandTurn(id=turn_id, request_id=request_id, session_id=session_id,
                          text=desensitize(_body_safe_evidence(message)), status="extraction_failed", extractor=EXTRACTOR_VERSION,
                          error_code="EXTRACTION_INTERRUPTED", extraction_attempts=0))
        db.add(GenerationRequest(request_id=request_id, session_id=session_id, turn_id=turn_id,
                                 status="accepted"))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            old = db.get(DemandRequestAdmission, request_id)
            if old:
                return "duplicate" if old.payload_digest == digest else "conflict"
            raise
    return "accepted"
