"""S1 engineering invariants: migration, sessions and exactly-once quota."""
import json
import os
import sqlite3
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.core import admin_auth
from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.core.request_admission import admit_request
from app.models.chat import DailyUsage
from app.models.demand import DemandAdminSession, DemandRequestAdmission, DemandTurn


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    with SessionLocal() as db:
        for model in (DemandAdminSession, DemandRequestAdmission, DemandTurn, DailyUsage):
            db.query(model).delete()
        db.commit()


def test_logout_rejects_copied_cookie_after_database_reopen(client):
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
    cookie = client.cookies.get(admin_auth.COOKIE)
    assert client.post("/api/v1/admin/logout").status_code == 200
    engine.dispose()
    response = client.get("/api/v1/admin/overview", headers={"Cookie": f"{admin_auth.COOKIE}={cookie}"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_two_logins_have_distinct_revocable_sessions(client):
    first = admin_auth.token()
    second = admin_auth.token()
    assert first != second
    with SessionLocal() as db:
        assert db.query(DemandAdminSession).count() == 2


def test_validation_response_does_not_echo_sensitive_input(client):
    secret = "do-not-echo-this-password"
    response = client.post("/api/v1/admin/login", json={"password": [secret]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert secret not in response.text


def test_unexpected_error_has_safe_structured_response(monkeypatch):
    from app.api import admin
    from app.main import app
    from fastapi.testclient import TestClient
    def unavailable(*args, **kwargs):
        raise RuntimeError("private-path-and-secret-must-not-escape")
    monkeypatch.setattr(admin, "_rows", unavailable)
    with TestClient(app, raise_server_exceptions=False) as safe_client:
        assert safe_client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
        response = safe_client.get("/api/v1/admin/overview")
        assert response.status_code == 500 and response.json()["error"]["code"] == "INTERNAL"
        assert "private-path-and-secret" not in response.text


@pytest.mark.parametrize("expiry", ["²", "９９９９９９９９９９", "9" * 5000, "", "-1"])
def test_malformed_cookie_expiry_is_unauthorized(client, expiry):
    # Starlette accepts decoded Unicode cookies; exercise the parser directly
    # because an HTTP client cannot encode non-ASCII header bytes.
    from fastapi import HTTPException
    from starlette.requests import Request
    request = Request({"type": "http", "method": "GET", "headers": []})
    request._cookies = {admin_auth.COOKIE: f"{expiry}.{'a' * 32}.{'0' * 64}"}
    with pytest.raises(HTTPException) as caught:
        admin_auth.require_admin(request)
    assert caught.value.status_code == 401


@pytest.mark.parametrize("nonce,signature", [("a" * 32, "é"), ("é" * 32, "a" * 64),
                                             ("g" * 32, "a" * 64), ("a" * 32, "0" * 5000)])
def test_malformed_cookie_signature_is_unauthorized(nonce, signature):
    from fastapi import HTTPException
    from starlette.requests import Request
    request = Request({"type": "http", "method": "GET", "headers": []})
    request._cookies = {admin_auth.COOKIE: f"9999999999.{nonce}.{signature}"}
    with pytest.raises(HTTPException) as caught:
        admin_auth.require_admin(request)
    assert caught.value.status_code == 401


def test_interrupted_admission_remains_recoverable_without_second_quota():
    from app.services.demand import process_admitted_turn
    assert admit_request("core-interrupted", "core-session", "想要通勤阔腿裤", "", "") == "accepted"
    with SessionLocal() as db:
        original_id = db.query(DemandTurn).one().id
    engine.dispose()  # accepted but processing never ran before process restart
    assert process_admitted_turn("core-interrupted") is True
    assert process_admitted_turn("core-interrupted") is False
    assert admit_request("core-interrupted", "core-session", "想要通勤阔腿裤", "", "") == "duplicate"
    with SessionLocal() as db:
        turn = db.query(DemandTurn).one()
        assert turn.id == original_id and turn.status == "extracted"
        assert db.query(DailyUsage).one().count == 1


def test_duplicate_request_admission_consumes_quota_once():
    assert admit_request("core-fixed", "core-session", "想要裤子", "800", "通勤") == "accepted"
    for _ in range(3):
        assert admit_request("core-fixed", "core-session", "想要裤子", "800", "通勤") == "duplicate"
    assert admit_request("core-fixed", "core-session", "想要鞋子", "800", "通勤") == "conflict"
    assert admit_request("core-fixed", "other-session", "想要裤子", "800", "通勤") == "conflict"
    with SessionLocal() as db:
        assert db.query(DemandRequestAdmission).count() == 1
        assert db.query(DailyUsage).one().count == 1
        turn = db.query(DemandTurn).one()
        assert turn.status == "extraction_failed"
        assert turn.error_code == "EXTRACTION_INTERRUPTED"
        assert turn.text == "想要裤子"


def test_concurrent_duplicate_admission_consumes_quota_once():
    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(lambda _: admit_request("core-race", "core-session", "想要裤子", "", ""), range(8)))
    assert statuses.count("accepted") == 1
    assert statuses.count("duplicate") == 7
    with SessionLocal() as db:
        assert db.query(DailyUsage).one().count == 1


def test_quota_denial_is_not_accepted_dialogue(monkeypatch):
    monkeypatch.setattr(settings, "daily_call_limit", 1)
    assert admit_request("core-first", "s", "想要裤子", "", "") == "accepted"
    assert admit_request("core-second", "s", "想要鞋子", "", "") == "quota"
    assert admit_request("core-first", "s", "想要裤子", "", "") == "duplicate"
    with SessionLocal() as db:
        assert db.get(DemandRequestAdmission, "core-second") is None
        assert db.query(DemandTurn).count() == 1  # only the first accepted request, never the denied one


def test_legacy_database_upgrade_preserves_payload_and_runs_twice(tmp_path):
    db_path = tmp_path / "legacy.db"
    payload = '{"schema_version":"1.4","demand":{"occurrences":1},"evidence":[]}'
    with sqlite3.connect(db_path) as db:
        db.executescript("""
        CREATE TABLE demand_turns (id VARCHAR(36) PRIMARY KEY, request_id VARCHAR(64) UNIQUE,
          session_id VARCHAR(100), text TEXT, status VARCHAR(30), extractor VARCHAR(30),
          data_origin VARCHAR(30), created_at DATETIME);
        CREATE TABLE demand_occurrences (id VARCHAR(36) PRIMARY KEY, turn_id VARCHAR(36),
          group_key VARCHAR(64), title VARCHAR(160), description TEXT, attributes_json TEXT,
          review_state VARCHAR(20), reason TEXT, UNIQUE(turn_id,group_key));
        CREATE TABLE demand_handoffs (id VARCHAR(40) PRIMARY KEY, group_key VARCHAR(64),
          version INTEGER, fingerprint VARCHAR(64), payload_json TEXT, status VARCHAR(20),
          last_error TEXT, created_at DATETIME, received_at DATETIME,
          UNIQUE(group_key,version), UNIQUE(group_key,fingerprint));
        CREATE TABLE demand_audit (id VARCHAR(36) PRIMARY KEY, action VARCHAR(30),
          target_id VARCHAR(64), actor VARCHAR(30), note TEXT, created_at DATETIME);
        INSERT INTO demand_turns VALUES ('legacy-turn','legacy-request','legacy-session',
          '想要裤子','extracted','rules-v1','runtime_demo','2026-10-01 00:00:00');
        INSERT INTO demand_occurrences VALUES ('legacy-occ','legacy-turn','legacy-group',
          '裤子','原始需求','{"category":"裤子"}','approved','');
        INSERT INTO demand_audit VALUES ('legacy-audit','approve','legacy-handoff',
          'styling-manager','原始审批','2026-10-01 00:00:00');
        """)
        db.execute("INSERT INTO demand_handoffs VALUES (?,?,?,?,?,?,?,?,?)",
                   ("legacy-handoff", "legacy-group", 1, "legacy-fingerprint", payload, "approved", "", "2026-10-01 00:00:00", None))
    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}", "DATA_DIR": str(tmp_path / "data"),
           "DEEPSEEK_API_KEY": "", "RUNNINGHUB_API_KEY": "", "TUDOU_API_KEY": ""}
    command = [str(backend / ".venv/bin/python"), "-c", "from app.core.database import init_db; init_db()"]
    for _ in range(2):
        subprocess.run(command, cwd=backend, env=env, check=True, capture_output=True, text=True, timeout=30)
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT payload_json FROM demand_handoffs").fetchone()[0] == payload
        assert db.execute("SELECT id,revision,lifecycle,field_sources_json FROM demand_occurrences").fetchone() == ("legacy-occ", 1, "active", "{}")
        assert db.execute("SELECT id,error_code,negative_json FROM demand_turns").fetchone() == ("legacy-turn", "", "[]")
        assert db.execute("SELECT COUNT(*) FROM demand_audit").fetchone()[0] == 1
