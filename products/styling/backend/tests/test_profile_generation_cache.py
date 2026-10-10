"""Private generation errors use the real app handlers, without TCP or models."""
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.core import consumer_identity
from app.core.config import settings
from app.main import app
from app.models.chat import Base, DailyUsage
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.services import consumer_profiles, generation, profile_snapshots


@pytest.fixture
def generation_cache_env(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path}/generation-cache.db",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    for module in (consumer_identity, consumer_profiles, profile_snapshots, generation):
        monkeypatch.setattr(module, "SessionLocal", factory)
    monkeypatch.setenv("CONSUMER_APP_SCOPE", "profile_generation_cache_test")
    monkeypatch.setenv("CONSUMER_ALLOWED_ORIGINS", "http://testserver")
    monkeypatch.setenv("STYLING_FIXED_ENABLED", "0")
    monkeypatch.setenv("STYLING_ADMIN_CONTEXT_ENABLED", "0")
    monkeypatch.setattr(settings, "deepseek_api_key", "")

    # Do not enter TestClient as a context manager: startup migration, recovery,
    # and seeding are not part of this query test. Every routed DB is isolated.
    client = TestClient(app, raise_server_exceptions=False)
    initialized = client.get("/api/v1/consumer-profile")
    assert initialized.status_code == 200
    cookie_name = consumer_identity.consumer_cookie_name()
    assert client.cookies.get(cookie_name) is not None
    with factory() as db:
        assert db.query(ConsumerProfileIdentity).count() == 1
    yield {"client": client, "db": factory}
    client.close()
    engine.dispose()


def query(ctx):
    return ctx["client"].get(
        "/api/v1/generation-requests/" + uuid4().hex,
        params={"session_id": "isolated-" + uuid4().hex},
    )


def no_formal_business(ctx):
    with ctx["db"]() as db:
        assert tuple(db.query(model).count() for model in
                     (DemandTurn, GenerationRequest, DemandRequestAdmission, DailyUsage)) == (0, 0, 0, 0)


def test_missing_generation_404_is_no_store(generation_cache_env):
    ctx = generation_cache_env
    response = query(ctx)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    no_formal_business(ctx)
    assert response.headers.get("cache-control") == "no-store"


def test_generation_storage_500_is_no_store(generation_cache_env, monkeypatch):
    ctx = generation_cache_env

    def unavailable():
        # Only the generation lookup's connection fails. Identity and scope
        # authorization remain real successful reads in the temporary DB.
        raise OperationalError("synthetic read outage", {}, RuntimeError("safe test fault"))

    monkeypatch.setattr(generation, "SessionLocal", unavailable)
    response = query(ctx)
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL"
    assert response.json()["detail"] == "服务内部错误，请稍后重试"
    no_formal_business(ctx)
    assert response.headers.get("cache-control") == "no-store"


def test_generation_http_error_preserves_extra_headers(generation_cache_env, monkeypatch):
    ctx = generation_cache_env

    def retry_later(_request_id, _session_id):
        raise HTTPException(429, "safe synthetic query retry", headers={
            "Retry-After": "7", "X-Retry-Test": "preserved",
        })

    monkeypatch.setattr(generation, "lookup", retry_later)
    response = query(ctx)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "RATE_LIMITED"
    assert response.headers["retry-after"] == "7"
    assert response.headers["x-retry-test"] == "preserved"
    no_formal_business(ctx)
    assert response.headers.get("cache-control") == "no-store"
