"""Real persisted synthetic identity facts for profile service-level tests."""
import hashlib
from datetime import timedelta
from app.core.consumer_identity import ConsumerAuthorization
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.tryon import utcnow
from app.services import consumer_profiles
from app.schemas.consumer_profile import ProfileMutation


def device_authorization(owner, factory):
    digest = hashlib.sha256(("synthetic-test-cookie-" + owner.owner_ref).encode()).hexdigest()
    with factory() as db:
        if db.get(ConsumerProfileIdentity, owner.owner_ref) is None:
            db.add(ConsumerProfileIdentity(owner_ref=owner.owner_ref, app_scope=owner.app_scope,
                                          token_hash=digest, expires_at=utcnow() + timedelta(days=1)))
            db.commit()
    return ConsumerAuthorization(owner, identity_token_digest=digest)


def service_mutation(owner, body, factory):
    authorization = device_authorization(owner, factory)
    context = consumer_profiles.read_profile(owner, authorization=authorization)["authorization_context"]
    expected = {key: context[key] for key in ("context_contract", "context_id", "operation_token")}
    return consumer_profiles.mutate_profile(owner, ProfileMutation.model_validate({
        **body, "expected_authorization_context": expected}), authorization=authorization)
