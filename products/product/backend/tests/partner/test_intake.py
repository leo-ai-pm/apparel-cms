"""Isolated product ASGI/SQLite tests with a synthetic source MockTransport."""
import base64
import copy
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.errors import AppError
from app.core.partner_config import config
from app.services import partner_direct, partner_projection
from app.services.partner_db import connection
from fixtures import make_payload, make_supplement, raw_json, sha256

TOKEN = "synthetic-sender-token-0000000001"
READER = "synthetic-reader-token-0000000001"
VERIFY = "synthetic-verifier-token-00000001"
PATH = "/api/integrations/styling/v1/handoffs"


def cfg():
    return {"config_version": 1, "instance_id": "product", "authorized_scope": "synthetic-scope",
            "allow_loopback_http": True, "services": [
                {"subject": "synthetic-outfit", "purpose": "styling_sender", "source_instance_id": "styling",
                 "target_instance_id": "product", "authorized_scope": "synthetic-scope", "enabled": True,
                 "token_sha256": sha256(TOKEN.encode()), "operations": ["deliver", "lookup", "supplement"],
                 "verification": {"subject": "product-verifier", "purpose": "product_verifier",
                                  "source_instance_id": "styling", "target_instance_id": "product", "authorized_scope": "synthetic-scope",
                                  "base_url": "http://127.0.0.1:18090", "token": VERIFY}},
                {"subject": "product-next", "purpose": "product_workbench_reader", "source_instance_id": "product",
                 "target_instance_id": "product", "authorized_scope": "synthetic-scope", "enabled": True,
                 "token_sha256": sha256(READER.encode())}]}


def envelope(number=1, supplement=True):
    payload = make_payload(number)
    raw = raw_json(payload)
    supp = make_supplement(payload, raw)
    supp_raw = raw_json(supp)
    return {"transport_schema": "pa-direct-delivery/1", "source_product": "personal_styling",
            "target_product": "product_management", "source_instance_id": "styling", "target_instance_id": "product",
            "authorized_scope": "synthetic-scope", "handoff_id": payload["handoff_id"], "revision": 1,
            "payload_digest": sha256(raw), "payload_base64": base64.b64encode(raw).decode(),
            "source_approval_ref": {"approval_record_id": f"APPR-synthetic-{number}"},
            "supplement": {"supplement_id": f"SUP-{number}", "digest": sha256(supp_raw),
                           "content_base64": base64.b64encode(supp_raw).decode()} if supplement else None}


def headers(token=TOKEN):
    return {"Authorization": "Bearer " + token}


def send(client, data, token=TOKEN, raw=None):
    return client.post(PATH, content=raw or raw_json(data), headers={**headers(token), "Content-Type": "application/json",
                       "Idempotency-Key": f"{data['handoff_id']}:{data['revision']}"})


@pytest.fixture
def env(tmp_path, monkeypatch):
    conf = cfg()
    path = tmp_path / "config.json"
    path.write_text(json.dumps(conf))
    path.chmod(0o600)
    db = tmp_path / "new.sqlite3"
    monkeypatch.setenv("PARTNER_CONFIG_FILE", str(path))
    monkeypatch.setenv("PARTNER_DB_PATH", str(db))
    monkeypatch.setenv("PARTNER_MODE", "managed")
    client = TestClient(app)
    yield client, conf, path, db
    client.close()


def rewrite(env):
    env[2].write_text(json.dumps(env[1]))


def counts():
    with connection() as conn:
        return [conn.execute("SELECT COUNT(*) FROM " + t).fetchone()[0] for t in ("direct_receipts", "direct_supplements", "signals_v2")]


def source(monkeypatch, mutate=None, status=200, content=None, error=None):
    calls = []
    client_class = httpx.Client
    def handler(request):
        assert str(request.url) == "http://127.0.0.1:18090/api/integrations/product-management/v1/verify-approval"
        assert request.method == "POST" and request.headers["authorization"] == "Bearer " + VERIFY
        req = json.loads(request.content)
        assert len(req) == 14
        calls.append(req)
        if error:
            raise error
        proof = {**req, "metadata_digest": sha256(b"synthetic-original-metadata-bytes"),
                 "approved_by": "synthetic-manager", "approval_identity_kind": "account_bound",
                 "approved_at": "2026-10-01T10:00:00+00:00", "verification_id": "VERIFY-synthetic",
                 "verified_at": datetime.now(timezone.utc).isoformat(), "approval_state": "approved",
                 "operation_eligible": True, "data_origin": "synthetic"}
        if mutate:
            mutate(proof)
        return httpx.Response(status, content=content if content is not None else raw_json(proof),
                              headers={"Content-Type": "application/json", "Location": "https://untrusted.invalid/"})
    def factory(*args, **kwargs):
        assert kwargs["follow_redirects"] is False and kwargs["trust_env"] is False
        return client_class(*args, **kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(partner_direct.httpx, "Client", factory)
    return calls


def test_receive_query_retry_original_and_reopen(env, monkeypatch):
    client = env[0]
    data = envelope()
    calls = source(monkeypatch)
    raw = raw_json(data, indent=2)
    first = send(client, data, raw=raw)
    assert first.status_code == 201, first.text
    receipt = first.json()["receipt"]
    assert len(receipt) == 17 and receipt["status"] == "received"
    assert send(client, data).json() == {"receipt": receipt, "duplicate": True}
    assert len(calls) == 1 and len(calls[0]["nonce"]) == 64
    query = client.get(PATH + "/lookup", params={"handoff_id": data["handoff_id"], "revision": 1}, headers=headers())
    assert query.json()["receipt"] == receipt
    result = client.get("/api/internal/signals", headers=headers(READER)).json()
    signal = result["items"][0]
    assert result["next_cursor"] is None and signal["provenance_status"] == "complete"
    assert signal["signal_id"] == partner_projection.signal_identity("styling", "synthetic-scope", data["handoff_id"], 1)
    assert signal["signal_revision"] == 1 and signal["feedback_type"] == "demand_expression"
    assert signal["body_type_tag"] is None and signal["outfit_plan"] == {"items": [], "note": None}
    assert signal["demand"]["occurrences"] == 1 and "sample_count" not in signal
    text = json.dumps(signal)
    assert "session_ref" not in text and "review_note" not in text and "group_key" not in text
    assert signal["evidence_projection"][0]["revision"] == 1
    projection_raw = base64.b64decode(signal["projection_base64"])
    assert json.loads(projection_raw) == signal["evidence_projection"] and sha256(projection_raw) == signal["projection_digest"]
    eid = signal["evidence_projection"][0]["evidence_id"]
    assert signal["evidence_projection"][0]["field_sources"]["fit"] == [eid]
    for kind, expected, digest in (("payload", base64.b64decode(data["payload_base64"]), data["payload_digest"]),
                                   ("supplement", base64.b64decode(data["supplement"]["content_base64"]), data["supplement"]["digest"])):
        r = client.get(f"/api/internal/receipts/{receipt['direct_receive_id']}/{kind}", headers=headers(READER))
        assert r.content == expected and digest in r.headers.values() and r.headers["cache-control"] == "no-store"
    with connection() as conn:
        assert bytes(conn.execute("SELECT envelope_raw FROM direct_receipts").fetchone()[0]) == raw
        assert len(json.loads(bytes(conn.execute("SELECT proof FROM direct_receipts").fetchone()[0]))) == 23
    assert counts() == [1, 1, 1]
    monkeypatch.setattr(partner_direct, "fetch_approval", lambda *args: pytest.fail("duplicate must not call upstream"))
    with TestClient(app) as reopened:
        assert send(reopened, data).json()["receipt"] == receipt
        assert reopened.get("/api/internal/signals/" + signal["signal_id"], headers=headers(READER)).json()["signal"] == signal


@pytest.mark.parametrize("change", ["payload_whitespace", "supplement_whitespace", "approval", "supplement_remove"])
def test_conflicts_keep_original(env, monkeypatch, change):
    data = envelope()
    calls = source(monkeypatch)
    assert send(env[0], data).status_code == 201
    new = copy.deepcopy(data)
    if change == "payload_whitespace":
        raw = base64.b64decode(new["payload_base64"]) + b" "
        new.update(payload_base64=base64.b64encode(raw).decode(), payload_digest=sha256(raw), supplement=None)
    elif change == "supplement_whitespace":
        raw = base64.b64decode(new["supplement"]["content_base64"]) + b" "
        new["supplement"].update(content_base64=base64.b64encode(raw).decode(), digest=sha256(raw))
    elif change == "approval":
        new["source_approval_ref"]["approval_record_id"] += "-changed"
    else:
        new["supplement"] = None
    r = send(env[0], new)
    assert r.status_code == 409 and r.json()["error"]["code"] == "RECEIPT_CONFLICT", r.text
    assert counts() == [1, 1, 1] and len(calls) == 1


def test_late_supplement_is_independent_and_does_not_expand_signal(env, monkeypatch):
    client = env[0]
    calls = source(monkeypatch)
    first = send(client, envelope(supplement=False)).json()["receipt"]
    before = client.get("/api/internal/signals", headers=headers(READER)).json()
    assert before["items"][0]["provenance_status"] == "incomplete"
    full = envelope()
    body = {k: full[k] for k in ("handoff_id", "revision", "payload_digest", "source_approval_ref", "supplement")}
    url = PATH + "/" + first["direct_receive_id"] + "/supplements"
    h = {**headers(), "Idempotency-Key": first["direct_receive_id"] + ":" + full["supplement"]["supplement_id"]}
    result = client.post(url, json=body, headers=h)
    assert result.status_code == 201, result.text
    sr = result.json()["supplement_receipt"]
    assert len(sr) == 7 and calls[-1]["verification_purpose"] == "supplement_append"
    assert client.post(url, json=body, headers=h).json() == {"supplement_receipt": sr, "duplicate": True}
    assert client.get("/api/internal/signals", headers=headers(READER)).json() == before
    assert send(client, full).status_code == 409
    assert send(client, envelope(supplement=False)).json()["receipt"] == first
    changed = copy.deepcopy(body)
    raw = base64.b64decode(changed["supplement"]["content_base64"]) + b" "
    changed["supplement"].update(content_base64=base64.b64encode(raw).decode(), digest=sha256(raw))
    assert client.post(url, json=changed, headers=h).status_code == 409
    assert counts() == [1, 1, 1] and len(calls) == 2


@pytest.mark.parametrize("field,value", [("approval_identity_kind", "legacy_shared_role"), ("approval_state", "pending"),
    ("operation_eligible", False), ("operation_eligible", 1), ("nonce", "0" * 64), ("source_instance_id", "other"),
    ("target_instance_id", "other"), ("authorized_scope", "other"), ("payload_digest", "0" * 64),
    ("supplement_digest", "0" * 64), ("metadata_digest", "0" * 64), ("approved_by", "other"),
    ("approved_at", "2026-09-29T10:00:00+00:00"), ("verified_at", "2020-01-01T00:00:00+00:00"),
    ("data_origin", "runtime_demo"), ("unexpected", True)])
def test_source_proof_bad_binding_no_receipt(env, monkeypatch, field, value):
    source(monkeypatch, mutate=lambda proof: proof.update({field: value}))
    r = send(env[0], envelope())
    assert r.status_code == 422, r.text
    assert counts() == [0, 0, 0]


@pytest.mark.parametrize("status,code,expected", [(404, None, 502), (401, None, 502), (403, None, 502),
    (500, None, 502), (302, None, 502), (422, "APPROVAL_IDENTITY_LEGACY", 422),
    (422, "APPROVAL_BINDING_MISMATCH", 422), (422, "EVIDENCE_PRIVACY_BLOCKED", 422)])
def test_source_http_failures_safe(env, monkeypatch, status, code, expected):
    calls = source(monkeypatch, status=status, content=raw_json({"error": {"code": code, "message": "SECRET_REMOTE_BODY"}}))
    r = send(env[0], envelope())
    assert r.status_code == expected and "SECRET_REMOTE_BODY" not in r.text and VERIFY not in r.text
    assert len(calls) == 1 and counts() == [0, 0, 0]


@pytest.mark.parametrize("error,expected", [(httpx.ReadTimeout("secret"), 504), (httpx.ConnectError("secret"), 502)])
def test_network_failure_no_success(env, monkeypatch, error, expected):
    source(monkeypatch, error=error)
    r = send(env[0], envelope())
    assert r.status_code == expected and "secret" not in r.text and counts() == [0, 0, 0]
    with connection() as conn:
        assert conn.execute("SELECT state FROM integration_attempts").fetchone()[0] == "unconfirmed"


@pytest.mark.parametrize("content", [b"not json", b'{"a":1,"a":2}', b'{"a":NaN}', b"x" * (256 * 1024 + 1)])
def test_bad_source_content(env, monkeypatch, content):
    source(monkeypatch, content=content)
    assert send(env[0], envelope()).status_code == 502
    assert counts() == [0, 0, 0]


@pytest.mark.parametrize("text", ["电话13812345678", "a@example.com", "身高175cm", "密码:secret", "Bearer secret-token",
                                  "https://example.com/photo.png", "data:image/png;base64,secret", "file:///secret"])
def test_privacy_blocked_before_source(env, monkeypatch, text):
    data = envelope(supplement=False)
    p = json.loads(base64.b64decode(data["payload_base64"]))
    p["evidence"][0]["text"] = text
    raw = raw_json(p)
    data.update(payload_base64=base64.b64encode(raw).decode(), payload_digest=sha256(raw))
    calls = source(monkeypatch)
    r = send(env[0], data)
    assert r.status_code == 422 and r.json()["error"]["code"] == "PRIVACY_REJECTED", r.text
    assert calls == []


@pytest.mark.parametrize("method,path", [("GET", "/api/agent/signals"), ("GET", "/api/agent/status"),
    ("POST", "/api/agent/analyze"), ("POST", "/api/agent/chat"), ("POST", "/api/pull"), ("GET", "/api/drafts"),
    ("GET", "/api/drafts/1"), ("PATCH", "/api/drafts/1"), ("POST", "/api/drafts/1/publish"),
    ("GET", "/api/packages"), ("GET", "/api/packages/PKG-test"), ("POST", "/api/packages/PKG-test/rework")])
def test_legacy_routes_closed_without_io(env, monkeypatch, method, path):
    def forbidden(*args, **kwargs):
        pytest.fail("legacy must not use network")
    monkeypatch.setattr(httpx, "get", forbidden)
    monkeypatch.setattr(httpx, "post", forbidden)
    assert env[0].request(method, path).status_code == 401
    assert env[0].request(method, path, headers=headers()).status_code == 403
    assert not env[3].exists()


def test_health_and_static_no_config_no_network(env, monkeypatch):
    monkeypatch.delenv("PARTNER_CONFIG_FILE")
    monkeypatch.setattr(httpx, "get", lambda *a, **k: pytest.fail("no probe"))
    r = env[0].get("/health")
    assert r.status_code == 200 and r.json()["capabilities"]["paid_models"] is False
    assert env[0].get("/").status_code == 404 and not env[3].exists()


def test_auth_purpose_and_person_separation(env, monkeypatch):
    c = env[0]
    assert c.post("/api/agent/signals", json={}).status_code == 401
    assert c.post("/api/agent/signals", json={}, headers={"X-Signal-Key": TOKEN}).status_code == 401
    assert c.post("/api/agent/signals", json={}, headers=headers()).status_code == 409
    assert c.post("/api/agent/signals", json={}, headers=headers(READER)).status_code == 403
    assert send(c, envelope(), token=READER).status_code == 403
    assert c.get("/api/internal/signals", headers=headers()).status_code == 403
    assert c.get("/api/internal/signals", headers=headers(VERIFY)).status_code == 401
    assert c.get("/api/internal/signals", headers={"Cookie": "zhixu_session=person"}).status_code == 403
    assert c.get("/api/internal/signals", headers={**headers(READER), "Cookie": "zhixu_session=person"}).status_code == 403
    assert not env[3].exists()
    assert c.get(PATH + "/lookup").status_code == 401
    assert c.get("/api/internal/signals?limit=9999").status_code == 401


def test_revoke_before_duplicate_and_during_proof(env, monkeypatch):
    def revoke(proof):
        env[1]["services"][0]["enabled"] = False
        rewrite(env)
    source(monkeypatch, mutate=revoke)
    assert send(env[0], envelope()).status_code == 401 and counts() == [0, 0, 0]


@pytest.mark.parametrize("mutation", ["scope", "target", "purpose", "insecure_url", "duplicate_key", "file_mode", "mode", "same_token"])
def test_bad_configuration_fails_closed(env, monkeypatch, mutation):
    if mutation == "scope":
        env[1]["services"][0]["authorized_scope"] = "other"
    elif mutation == "target":
        env[1]["services"][0]["target_instance_id"] = "other"
    elif mutation == "purpose":
        env[1]["services"][0]["verification"]["purpose"] = "styling_sender"
    elif mutation == "insecure_url":
        env[1]["services"][0]["verification"]["base_url"] = "http://untrusted.example"
    elif mutation == "same_token":
        env[1]["services"][0]["verification"]["token"] = READER
    rewrite(env)
    if mutation == "duplicate_key":
        env[2].write_text('{"config_version":1,"config_version":1}')
    elif mutation == "file_mode":
        env[2].chmod(0o644)
    elif mutation == "mode":
        monkeypatch.setenv("PARTNER_MODE", "legacy")
    assert env[0].get("/api/internal/signals", headers=headers(READER)).status_code == 503
    assert not env[3].exists()


@pytest.mark.parametrize("kind", ["foreign", "future", "wrong_scope", "bad_parent"])
def test_foreign_db_never_migrated(env, monkeypatch, kind):
    if kind == "bad_parent":
        blocker = env[3].parent / "blocked"
        blocker.write_text("preserve")
        monkeypatch.setenv("PARTNER_DB_PATH", str(blocker / "db"))
        assert env[0].get("/api/internal/signals", headers=headers(READER)).status_code == 503
        assert blocker.read_text() == "preserve"
        return
    if kind == "foreign":
        with sqlite3.connect(env[3]) as conn:
            conn.execute("CREATE TABLE old_business(value TEXT)")
    else:
        with connection(write=True) as conn:
            conn.execute("UPDATE partner_meta SET value=? WHERE key=?", ("99", "schema_version") if kind == "future" else ("other", "authorized_scope"))
    env[3].chmod(0o600)
    before = env[3].read_bytes()
    assert env[0].get("/api/internal/signals", headers=headers(READER)).status_code == 503
    assert env[3].read_bytes() == before


def test_projection_atomic_rollback(env, monkeypatch):
    source(monkeypatch)
    def fail(*args):
        raise AppError("STORAGE_UNAVAILABLE", "synthetic fault", 503)
    monkeypatch.setattr(partner_projection, "save_projection", fail)
    assert send(env[0], envelope()).status_code == 503
    assert counts() == [0, 0, 0]


def test_concurrent_same_body_only_one_receipt_signal(env, monkeypatch):
    source(monkeypatch)
    data = envelope()
    def request(_):
        with TestClient(app) as client:
            return send(client, data)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(request, range(4)))
    assert sorted(r.status_code for r in responses) == [200, 200, 200, 201], [r.text for r in responses]
    assert len({r.json()["receipt"]["direct_receive_id"] for r in responses}) == 1
    assert counts() == [1, 1, 1]


def test_pagination_bound_limit_cursor_and_snapshot(env, monkeypatch):
    source(monkeypatch)
    for number in range(1, 53):
        assert send(env[0], envelope(number, supplement=False)).status_code == 201
    first = env[0].get("/api/internal/signals?limit=50", headers=headers(READER)).json()
    assert len(first["items"]) == 50 and first["next_cursor"]
    assert send(env[0], envelope(53, supplement=False)).status_code == 201
    second = env[0].get("/api/internal/signals", params={"cursor": first["next_cursor"]}, headers=headers(READER)).json()
    assert len(second["items"]) == 2 and second["next_cursor"] is None
    assert env[0].get("/api/internal/signals?limit=51", headers=headers(READER)).status_code == 422
    assert env[0].get("/api/internal/signals?cursor=bad", headers=headers(READER)).status_code == 422
    env[1]["services"][1]["subject"] = "changed-next"
    rewrite(env)
    assert env[0].get("/api/internal/signals", params={"cursor": first["next_cursor"]}, headers=headers(READER)).status_code == 422


@pytest.mark.parametrize("raw", [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":"\xff"}', b"x" * (8 * 1024 * 1024 + 1)])
def test_ambiguous_or_large_input(env, monkeypatch, raw):
    calls = source(monkeypatch)
    r = send(env[0], envelope(), raw=raw)
    assert r.status_code in {422, 413} and calls == [] and not env[3].exists()


@pytest.mark.parametrize("field,value,expected", [("authorized_scope", "other", 403),
    ("source_instance_id", "other", 422), ("target_instance_id", "other", 422),
    ("transport_schema", "pa-dh-delivery/1", 422), ("revision", True, 422),
    ("revision", 2**64, 422), ("payload_digest", "A" * 64, 422),
    ("payload_base64", "***", 422), ("cms_instance_id", "forbidden", 422),
    ("source_approval_ref", {"approval_record_id": "a", "url": "https://invalid"}, 422)])
def test_envelope_binding_strict_before_source(env, monkeypatch, field, value, expected):
    data = envelope()
    data[field] = value
    calls = source(monkeypatch)
    assert send(env[0], data).status_code == expected
    assert calls == [] and not env[3].exists()


def test_only_necessary_cross_turn_evidence_is_projected(env, monkeypatch):
    data = envelope()
    supp = json.loads(base64.b64decode(data["supplement"]["content_base64"]))
    target = supp["source_snapshot"][0]
    own = target["turn"]["id"]
    for suffix in ("needed", "unrelated"):
        snap = copy.deepcopy(target)
        tid = "context-" + suffix
        snap["turn"].update(id=tid, text="宽松" if suffix == "needed" else "无关的合成讨论", created_at="2026-09-20T08:00:00+00:00")
        occurrence = snap["occurrences"][0]
        occurrence.update(id="occ-" + suffix, turn_id=tid)
        occurrence["field_sources"] = {key: [tid] for key in occurrence["field_sources"]}
        supp["source_snapshot"].append(snap)
    for prov in (supp["provenance"][target["occurrences"][0]["id"]], target["occurrences"][0]):
        prov["context_turn_ids"] = ["context-needed"]
        prov["field_sources"]["fit"] = ["context-needed"]
    raw = raw_json(supp)
    data["supplement"].update(content_base64=base64.b64encode(raw).decode(), digest=sha256(raw))
    source(monkeypatch)
    r = send(env[0], data)
    assert r.status_code == 201, r.text
    signal = env[0].get("/api/internal/signals", headers=headers(READER)).json()["items"][0]
    assert signal["provenance_status"] == "complete"
    projection = signal["evidence_projection"]
    assert len(projection) == 2 and projection[1]["text"] == "宽松"
    assert projection[0]["field_sources"]["fit"] == [projection[1]["evidence_id"]]
    assert "无关" not in json.dumps(projection, ensure_ascii=False) and own not in json.dumps(projection)


def test_one_aggregate_dh_stays_one_signal(env, monkeypatch):
    data = envelope(supplement=False)
    payload = json.loads(base64.b64decode(data["payload_base64"]))
    another = copy.deepcopy(payload["evidence"][0])
    another.update(occurrence_id="occ-another", turn_id="turn-another")
    payload["evidence"].append(another)
    payload["demand"]["occurrences"] = 2
    raw = raw_json(payload)
    data.update(payload_base64=base64.b64encode(raw).decode(), payload_digest=sha256(raw))
    source(monkeypatch)
    assert send(env[0], data).status_code == 201
    signals = env[0].get("/api/internal/signals", headers=headers(READER)).json()["items"]
    assert len(signals) == 1 and len(signals[0]["evidence_projection"]) == 2
    assert signals[0]["demand"]["occurrences"] == 2 and signals[0]["demand"]["session_count"] == 1


def test_received_identity_cannot_be_reused_by_another_subject(env, monkeypatch):
    data = envelope()
    source(monkeypatch)
    assert send(env[0], data).status_code == 201
    env[1]["services"][0]["subject"] = "other-sender"
    rewrite(env)
    # Lookup must enforce the original sending subject, independently of the
    # schema validator's separate supplement-exporter check.
    assert env[0].get(PATH + "/lookup", params={"handoff_id": data["handoff_id"], "revision": 1}, headers=headers()).status_code == 404
    assert counts() == [1, 1, 1]


def test_disabled_sender_cannot_get_stored_duplicate(env, monkeypatch):
    data = envelope()
    source(monkeypatch)
    assert send(env[0], data).status_code == 201
    env[1]["services"][0]["enabled"] = False
    rewrite(env)
    assert send(env[0], data).status_code == 401
    assert counts() == [1, 1, 1]
