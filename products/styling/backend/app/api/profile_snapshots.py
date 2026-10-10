"""Technical preparation is not a formal demand or a generation call."""
from fastapi import APIRouter, Body, Depends, Request, Response
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.core.consumer_identity import ConsumerOwner, resolve_consumer_owner
from app.schemas.consumer_profile import Identifier, ProfileError
from app.services import profile_snapshots

router = APIRouter(prefix="/api/v1/consumer-profile", tags=["consumer-profile"])


@router.post("/prepare")
def prepare(request: Request, response: Response, body: dict = Body(...),
            owner: ConsumerOwner = Depends(resolve_consumer_owner)):
    response.headers["Cache-Control"] = "no-store"
    try:
        return profile_snapshots.prepare(owner, body, authorization=request.state.consumer_authorization)
    except ValidationError:
        # Validation errors contain raw input; never return those values.
        raise ProfileError("PROFILE_INVALID_REQUEST", "准备字段无效，请核对类型、范围和身份。", 422) from None
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料准备存储暂不可用，请保留原编号和原体。", 503) from None


@router.get("/snapshots/{snapshot_id}")
def snapshot(snapshot_id: Identifier, request: Request, response: Response,
             owner: ConsumerOwner = Depends(resolve_consumer_owner)):
    response.headers["Cache-Control"] = "no-store"
    return profile_snapshots.lookup_snapshot(owner, snapshot_id,
                                            authorization=request.state.consumer_authorization)
