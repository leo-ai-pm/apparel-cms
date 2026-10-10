"""Consumer observations and same-session generation status; neither invokes a model."""
import hashlib
import json
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from app.core.consumer_identity import resolve_consumer_owner
from sqlalchemy import text

from app.core.database import SessionLocal
from app.models.consumer_event import ConsumerEvent, ConsumerEventReceipt
from app.schemas.consumer_event import ConsumerEventRequest
from app.services import generation

router = APIRouter(prefix="/api/v1", tags=["consumer-events"])


@router.get("/generation-requests/{request_id}")
def get_generation(request_id: str, request: Request, response: Response,
                   session_id: str = Query(min_length=1, max_length=64),
                   owner=Depends(resolve_consumer_owner)):
    from app.services import profile_snapshots
    response.headers["Cache-Control"] = "no-store"
    profile_snapshots.authorize_request(owner, session_id, request_id,
                                       authorization=request.state.consumer_authorization)
    return generation.lookup(request_id, session_id)


def _reply(event_id, duplicate):
    return {"event_id": event_id, "duplicate": duplicate, "source": "client",
            "data_origin": "runtime_demo", "is_simulated": True}


@router.post("/consumer-events")
def record_event(req: ConsumerEventRequest):
    body = req.model_dump(mode="json", exclude_none=True)
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    semantic = None
    if req.event_name == "product_impression":
        semantic = hashlib.sha256(json.dumps([req.session_id, req.page_view_id, req.product_id,
                                             req.source_slot], separators=(",", ":")).encode()).hexdigest()

    # Check transport retries BEFORE re-reading mutable external availability. A recorded
    # observation remains idempotent even if the fixed asset later becomes unavailable.
    with SessionLocal() as db:
        if db.bind.dialect.name == "sqlite":
            db.execute(text("BEGIN IMMEDIATE"))
        receipt = db.get(ConsumerEventReceipt, req.event_id)
        if receipt:
            if receipt.payload_digest != digest:
                raise HTTPException(409, "事件编号已用于不同内容")
            return _reply(receipt.canonical_event_id, True)
        if req.event_name == "outfit_displayed":
            version = generation.persisted_version(req.session_id, req.look_version_id)
            if set(req.sku_ids) != set(generation.version_sku_ids(version)):
                raise HTTPException(409, "展示SKU与当前版本不一致")
        existing = db.query(ConsumerEvent).filter_by(semantic_key=semantic).first() if semantic else None
        canonical = existing.event_id if existing else req.event_id
        if existing is None:
            db.add(ConsumerEvent(event_id=req.event_id, payload_digest=digest, semantic_key=semantic,
                                 session_id=req.session_id, page_view_id=req.page_view_id,
                                 event_name=req.event_name, page=req.page, source_slot=req.source_slot,
                                 occurred_at=req.occurred_at.astimezone(timezone.utc).replace(tzinfo=None),
                                 payload_json=encoded))
        db.add(ConsumerEventReceipt(event_id=req.event_id, payload_digest=digest, canonical_event_id=canonical))
        db.commit()
        return _reply(canonical, existing is not None)
