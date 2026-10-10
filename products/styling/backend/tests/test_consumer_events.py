"""Consumer telemetry boundaries; real API/SQLite, no model or provider calls."""
import uuid
from copy import deepcopy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.consumer_events import router
from app.core.database import SessionLocal
from app.models.consumer_event import ConsumerEvent, ConsumerEventReceipt
from app.models.demand import DemandTurn
from app.services import fixed_styling


@pytest.fixture
def events_client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def payload(name="page_view", **extra):
    return {"schema_version": 1, "event_id": uuid.uuid4().hex,
            "session_id": "events-" + uuid.uuid4().hex,
            "page_view_id": uuid.uuid4().hex, "page": "discover",
            "occurred_at": "2026-10-10T10:00:00+08:00", "source_slot": "catalog",
            "event_name": name, **extra}


def test_transport_idempotence_and_no_business_writes(events_client):
    body = payload()
    with SessionLocal() as db:
        before = db.query(DemandTurn).count()
    first = events_client.post("/api/v1/consumer-events", json=body)
    repeat = events_client.post("/api/v1/consumer-events", json=body)
    assert first.status_code == repeat.status_code == 200
    assert first.json()["duplicate"] is False
    assert repeat.json()["duplicate"] is True
    with SessionLocal() as db:
        assert db.query(ConsumerEvent).filter_by(event_id=body["event_id"]).count() == 1
        assert db.query(ConsumerEventReceipt).filter_by(event_id=body["event_id"]).count() == 1
        assert db.query(DemandTurn).count() == before


def test_event_id_changed_payload_conflicts(events_client):
    body = payload()
    assert events_client.post("/api/v1/consumer-events", json=body).status_code == 200
    assert events_client.post("/api/v1/consumer-events", json={**body, "page": "home"}).status_code == 409


@pytest.mark.parametrize("name", ["generation_succeeded", "cart_added", "request_accepted", "order_paid"])
def test_client_cannot_write_server_business_facts(events_client, name):
    assert events_client.post("/api/v1/consumer-events", json=payload(name)).status_code == 422


@pytest.mark.parametrize("extra", [{"message": "private draft"}, {"draft": "private draft"},
                                   {"source": "server"}, {"is_simulated": False}, {"schema_version": 2},
                                   {"schema_version": True}, {"schema_version": "1"}])
def test_forbidden_fields_and_schema_are_rejected(events_client, extra):
    assert events_client.post("/api/v1/consumer-events", json=payload(**extra)).status_code == 422


@pytest.mark.parametrize("image,visible,dwell", [(False, .9, 2000), (True, .49, 2000), (True, .8, 999)])
def test_impression_requires_actual_frontend_observation_fields(events_client, image, visible, dwell):
    body = payload("product_impression", product_id="P001", image_loaded=image,
                   visible_fraction=visible, dwell_ms=dwell)
    assert events_client.post("/api/v1/consumer-events", json=body).status_code == 422


def test_exposure_semantic_dedup_keeps_transport_digest(events_client):
    first = payload("product_impression", product_id="P001", image_loaded=True,
                    visible_fraction=.7, dwell_ms=1500)
    second = {**first, "event_id": uuid.uuid4().hex, "dwell_ms": 2000}
    a = events_client.post("/api/v1/consumer-events", json=first)
    b = events_client.post("/api/v1/consumer-events", json=second)
    assert a.status_code == b.status_code == 200
    assert b.json()["duplicate"] is True
    assert b.json()["event_id"] == first["event_id"]
    with SessionLocal() as db:
        assert db.query(ConsumerEvent).filter_by(session_id=first["session_id"]).count() == 1
        assert db.query(ConsumerEventReceipt).filter_by(canonical_event_id=first["event_id"]).count() == 2
    # A semantic duplicate still reserves its transport ID; it cannot be reused for a different event.
    assert events_client.post("/api/v1/consumer-events", json={**second, "product_id": "P002"}).status_code == 409


@pytest.mark.parametrize("name", ["product_detail_open", "draft_prefill", "message_submit", "history_restore", "example_exposure"])
def test_allowed_non_business_events_are_recorded(events_client, name):
    extra = {"product_id": "P001"} if name == "product_detail_open" else {}
    extra = {"request_id": uuid.uuid4().hex} if name == "message_submit" else extra
    response = events_client.post("/api/v1/consumer-events", json=payload(name, **extra))
    assert response.status_code == 200
    with SessionLocal() as db:
        row = db.get(ConsumerEvent, response.json()["event_id"])
        assert row.source == "client" and row.is_simulated is True
        assert row.data_origin == "runtime_demo"


def test_outfit_display_requires_persistent_own_version(events_client):
    body = payload("outfit_displayed", page="outfit", source_slot="workspace",
                   look_version_id="missing-" + uuid.uuid4().hex,
                   sku_ids=["T101-M", "B101-M", "S101-38"], image_loaded=True, canvas_visible=True)
    assert events_client.post("/api/v1/consumer-events", json=body).status_code in (404, 409, 503)
    with SessionLocal() as db:
        assert db.get(ConsumerEvent, body["event_id"]) is None


def test_outfit_display_cannot_skip_three_slot_observation(events_client):
    body = payload("outfit_displayed", look_version_id="a-version", sku_ids=["only-one"],
                   image_loaded=True, canvas_visible=True)
    assert events_client.post("/api/v1/consumer-events", json=body).status_code == 422


def test_client_time_requires_timezone(events_client):
    assert events_client.post("/api/v1/consumer-events", json=payload(occurred_at="2026-10-10T10:00:00")).status_code == 422


def test_identical_page_view_ids_in_different_sessions_do_not_merge(events_client):
    first = payload("product_impression", product_id="P001", image_loaded=True,
                    visible_fraction=.7, dwell_ms=1500)
    second = {**first, "event_id": uuid.uuid4().hex, "session_id": uuid.uuid4().hex}
    assert events_client.post("/api/v1/consumer-events", json=first).json()["duplicate"] is False
    assert events_client.post("/api/v1/consumer-events", json=second).json()["duplicate"] is False


def test_outfit_event_validates_canonical_three_slot_shape_and_example_boundary(events_client, monkeypatch):
    # Controlled persisted-version read seam; no model is called or represented as live validation.
    version = {"look_version_id": "lv-1", "look_id": "M1V2-L001",
               "image_url": "/api/v1/outfits/assets/M1V2-L001", "origin": {"type": "self_generated"},
               "acceptance_status": "accepted_by_user",
               "items": {slot: {"sku_id": sku} for slot, sku in
                         zip(("top", "bottom", "shoes"), ("T101-M", "B101-M", "S101-38"))}}
    owner = uuid.uuid4().hex
    monkeypatch.setattr(fixed_styling, "get_version", lambda session, ident: deepcopy(version) if session == owner else None)
    body = payload("outfit_displayed", session_id=owner, page="outfit", source_slot="workspace",
                   look_version_id="lv-1", sku_ids=["T101-M", "B101-M", "S101-38"],
                   image_loaded=True, canvas_visible=True)
    assert events_client.post("/api/v1/consumer-events", json=body).status_code == 200
    other = {**body, "event_id": uuid.uuid4().hex, "session_id": uuid.uuid4().hex}
    assert events_client.post("/api/v1/consumer-events", json=other).status_code == 404
    wrong = {**body, "event_id": uuid.uuid4().hex, "sku_ids": ["T102-M", "B101-M", "S101-38"]}
    assert events_client.post("/api/v1/consumer-events", json=wrong).status_code == 409
    version["is_example"] = True
    example = {**body, "event_id": uuid.uuid4().hex}
    assert events_client.post("/api/v1/consumer-events", json=example).status_code == 409
    # A transport replay is immutable and does not depend on today's asset availability.
    assert events_client.post("/api/v1/consumer-events", json=body).json()["duplicate"] is True
