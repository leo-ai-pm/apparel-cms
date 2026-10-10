"""Disconnect seams with a real StreamingResponse and SQLite; parser is an offline test double."""
import asyncio
import threading
import time
import uuid
import json
from fastapi import Request, Response
from app.core.consumer_identity import ConsumerOwner

import pytest

from app.api.chat import chat
from app.core.cost_guard import cost_guard
from app.core.database import SessionLocal
from app.models.demand import DemandTurn
from app.schemas.chat import ChatRequest
from app.services import fixed_styling as fixed, generation
from tests.test_fixed_styling import OfflineParser, ROOT


class GatedParser(OfflineParser):
    def __init__(self, fail=False):
        super().__init__()
        self.entered = threading.Event()
        self.proceed = threading.Event()
        self.fail = fail

    def parse(self, *args, **kwargs):
        self.entered.set()
        if not self.proceed.wait(4):
            raise RuntimeError("test worker gate timed out")
        if self.fail:
            from m2.core import Fault
            self.calls += 1
            raise Fault("MODEL_UNAVAILABLE", "离线测试注入模型失败")
        return super().parse(*args, **kwargs)


@pytest.fixture
def fixed_chat(monkeypatch, tmp_path):
    monkeypatch.setenv("STYLING_FIXED_ENABLED", "1")
    monkeypatch.setenv("STYLING_FIXED_ROOT", str(ROOT))
    monkeypatch.setenv("STYLING_FIXED_DB", str(tmp_path / "disconnect-fixed.sqlite3"))
    monkeypatch.setenv("STYLING_FIXED_MODEL_CALL_LIMIT", "12")
    parser = GatedParser()
    monkeypatch.setattr(fixed, "_make_model", lambda: parser)
    released = threading.Event()
    releases = []
    original_release = cost_guard.release_slot

    def counted_release():
        original_release()
        releases.append(threading.get_ident())
        released.set()

    monkeypatch.setattr(cost_guard, "release_slot", counted_release)
    fixed.close_service()
    yield parser, releases, released
    parser.proceed.set()
    fixed.close_service()


def request():
    return ChatRequest(session_id="disconnected-" + uuid.uuid4().hex,
                       request_id=uuid.uuid4().hex,
                       message="离线合成输入：预算800，上下装M，鞋38，通勤搭配")


async def terminal(req):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        row = generation.lookup(req.request_id, req.session_id)
        if row["status"] in ("succeeded", "failed"):
            return row
        await asyncio.sleep(.01)
    pytest.fail("worker did not persist a terminal request record")


async def direct_chat(req):
    async def receive():
        return {'type': 'http.request', 'body': json.dumps(req.model_dump(exclude_unset=True)).encode()}
    raw = Request({'type': 'http', 'method': 'POST', 'path': '/api/v1/chat', 'headers': []}, receive)
    return await chat(req, raw, Response(), ConsumerOwner('legacy_disconnect_test', 'device', 'isolated'))


@pytest.mark.parametrize("model_fails", [False, True])
def test_disconnect_after_worker_started_keeps_slot_and_persists_terminal(fixed_chat, client, model_fails):
    parser, releases, released = fixed_chat
    parser.fail = model_fails
    req = request()

    async def run():
        response = await direct_chat(req)
        iterator = response.body_iterator
        status = await iterator.__anext__()
        assert "正在为你搭配" in status
        reading = asyncio.create_task(iterator.__anext__())
        try:
            assert await asyncio.to_thread(parser.entered.wait, 3)
            reading.cancel()
            with pytest.raises(asyncio.CancelledError):
                await reading
            # Cancellation ends delivery, while the execution worker still owns its slot.
            assert releases == []
            assert generation.lookup(req.request_id, req.session_id)["status"] == "running"
        finally:
            parser.proceed.set()
        row = await terminal(req)
        assert await asyncio.to_thread(released.wait, 3)
        assert len(releases) == 1
        if model_fails:
            assert row["status"] == "failed" and row["error_code"] == "MODEL_UNAVAILABLE"
            assert row["effective_outfit"] is False and row["result"] is None
        else:
            assert row["status"] == "succeeded" and row["outcome"] == "complete_outfit"
            assert row["effective_outfit"] is True
            assert row["result"]["outfit"]["look_version_id"] == "lv-1"

    asyncio.run(run())
    # Reconnection is a read of the same request, not a second parse/generation.
    result = client.get(f"/api/v1/generation-requests/{req.request_id}", params={"session_id": req.session_id})
    assert result.status_code == 200
    assert result.json()["status"] == ("failed" if model_fails else "succeeded")
    assert parser.calls == 1 and len(releases) == 1
    with SessionLocal() as db:
        assert db.query(DemandTurn).filter_by(request_id=req.request_id).count() == 1
    assert fixed.health()["model_http_attempts"] == 0


def test_disconnect_before_worker_starts_records_cancel_and_releases_once(fixed_chat, client):
    parser, releases, _ = fixed_chat
    req = request()

    async def run():
        response = await direct_chat(req)
        iterator = response.body_iterator
        await iterator.__anext__()  # First status precedes creation of the model worker.
        await iterator.aclose()

    asyncio.run(run())
    assert not parser.entered.is_set() and parser.calls == 0
    assert len(releases) == 1
    result = client.get(f"/api/v1/generation-requests/{req.request_id}", params={"session_id": req.session_id})
    assert result.status_code == 200
    assert result.json()["status"] == "failed"
    assert result.json()["error_code"] == "CLIENT_DISCONNECTED"
    assert result.json()["effective_outfit"] is False
