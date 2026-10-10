"""Profile-only endpoints; they never submit a chat, generation or observation."""
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from app.core.consumer_identity import ConsumerOwner, resolve_consumer_owner
from app.schemas.consumer_profile import (Identifier, ProfileError, ProfileMutation,
                                         ProfileOperationResponse, SavedProfileReadResponse)
from app.services import consumer_profiles

router = APIRouter(prefix="/api/v1/consumer-profile", tags=["consumer-profile"])


async def profile_error_handler(_request: Request, exc: ProfileError):
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}},
                        headers={"Cache-Control": "no-store"})


@router.get("", response_model=SavedProfileReadResponse)
def get_profile(request: Request, response: Response, owner: ConsumerOwner = Depends(resolve_consumer_owner)):
    response.headers["Cache-Control"] = "no-store"
    return consumer_profiles.read_profile(owner, authorization=request.state.consumer_authorization)


@router.post("/mutations", response_model=ProfileOperationResponse)
def mutate(req: ProfileMutation, request: Request, response: Response, owner: ConsumerOwner = Depends(resolve_consumer_owner)):
    response.headers["Cache-Control"] = "no-store"
    return consumer_profiles.mutate_profile(owner, req, authorization=request.state.consumer_authorization)


@router.get("/operations/{action_id}", response_model=ProfileOperationResponse)
def operation(action_id: Identifier, request: Request, response: Response, owner: ConsumerOwner = Depends(resolve_consumer_owner)):
    response.headers["Cache-Control"] = "no-store"
    return consumer_profiles.lookup_operation(owner, action_id, authorization=request.state.consumer_authorization)
