"""Verify S1 fixes over real isolated HTTP, raw-body receipts and process restart.

Run: .venv/bin/python -m scripts.verify_s1_integration --output <evidence.json>
All input records are synthetic. The receiver is loopback-only and is not a
partner system. Credentials are random, never exported; paid provider keys are
disabled. Temporary data and services are removed after verification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx


def sha256(body):
    return hashlib.sha256(body).hexdigest()


class ReceiptState:
    def __init__(self):
        self.mode = "matching"
        self.events = []


def receiver_handler(state):
    class StrictReceiver(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            payload = json.loads(raw)
            digest = sha256(raw)
            event = {"raw": raw, "handoff_id": payload["handoff_id"],
                     "raw_body_sha256": digest, "raw_body_bytes": len(raw),
                     "declared_sha256": self.headers.get("X-Handoff-Content-SHA256"),
                     "content_type": self.headers.get("Content-Type"),
                     "idempotency_key": self.headers.get("Idempotency-Key"),
                     "receiver_mode": state.mode}
            state.events.append(event)
            receipt = {"handoff_id": payload["handoff_id"], "status": "received",
                       "revision": payload["revision"], "payload_digest": digest,
                       "private_data": "synthetic-field-that-must-not-be-persisted"}
            if state.mode == "wrong_digest":
                receipt["payload_digest"] = "0" * 64
            elif state.mode == "wrong_id":
                receipt["handoff_id"] = "synthetic-wrong-handoff-id"
            encoded = json.dumps(receipt).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    return StrictReceiver


SEED = """
from itertools import product
from app.core.database import init_db, SessionLocal
from app.models.demand import DemandTurn, DemandOccurrence
from app.services.demand import record_turn
init_db()
for index in range(140):
    assert record_turn(f'synthetic-large-session-{index}', f'synthetic-large-request-{index}',
                       '秋天通勤想要宽松阔腿裤')
combinations = product(('春天', '夏天', '秋天', '冬天'),
                       ('通勤', '出游', '运动', '约会', '居家'),
                       ('上衣', '裤子', '裙子'), ('宽松', '修身'))
for index, (season, scene, category, fit) in enumerate(combinations):
    if index == 60:
        break
    assert record_turn(f'synthetic-other-session-{index}', f'synthetic-other-request-{index}',
                       f'{season}{scene}想要{fit}{category}')
with SessionLocal() as db:
    db.query(DemandTurn).update({'data_origin': 'simulation_fixture'})
    db.commit()
    assert db.query(DemandTurn).count() == 200
    assert db.query(DemandOccurrence.group_key).distinct().count() == 61
"""


def verify():
    backend = Path(__file__).resolve().parents[1]
    checks = {}
    state = ReceiptState()
    receiver = ThreadingHTTPServer(("127.0.0.1", 0), receiver_handler(state))
    receiver_thread = threading.Thread(target=receiver.serve_forever, daemon=True)
    receiver_thread.start()
    process = None

    def stop():
        nonlocal process
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process = None

    try:
        with tempfile.TemporaryDirectory(prefix="styling-s1-integration-") as tmp:
            database = Path(tmp) / "s1.db"
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            password = secrets.token_urlsafe(24)
            env = {**os.environ, "DATA_DIR": str(Path(tmp) / "data"),
                   "DATABASE_URL": f"sqlite:///{database}", "DEEPSEEK_API_KEY": "",
                   "RUNNINGHUB_API_KEY": "", "TUDOU_API_KEY": "", "CMS_API_KEY": "",
                   "CMS_BASE_URL": "", "STYLING_ADMIN_PASSWORD": password,
                   "STYLING_ADMIN_SECRET": secrets.token_urlsafe(48),
                   "STYLING_ADMIN_COOKIE_SECURE": "0", "STYLING_DEMAND_D3_ENABLED": "0",
                   "STYLING_DEMAND_RECEIVER_URL": f"http://127.0.0.1:{receiver.server_address[1]}/receive",
                   "STYLING_DEMAND_RECEIVER_KEY": secrets.token_urlsafe(24),
                   "STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES": "revision,payload_digest"}
            subprocess.run([sys.executable, "-c", SEED], cwd=backend, env=env,
                           check=True, stdout=subprocess.DEVNULL)
            base = f"http://127.0.0.1:{port}"

            def start():
                nonlocal process
                process = subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
                    cwd=backend, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("isolated service did not start")
                    try:
                        if httpx.get(base + "/api/v1/health", timeout=1).status_code == 200:
                            return
                    except httpx.TransportError:
                        pass
                    time.sleep(0.1)
                raise RuntimeError("isolated service readiness timed out")

            def stored(handoff_id):
                with sqlite3.connect(database) as db:
                    row = db.execute("SELECT payload_json,metadata_json FROM demand_handoffs WHERE id=?", (handoff_id,)).fetchone()
                return row[0].encode("utf-8"), row[1]

            start()
            with httpx.Client(base_url=base, timeout=20) as client:
                checks["unauthenticated_query_401"] = client.get("/api/v1/admin/overview").status_code == 401
                assert client.post("/api/v1/admin/login", json={"password": password}).status_code == 200
                first = client.get("/api/v1/admin/overview", params={"days": 0, "page": 1, "page_size": 20}).json()
                fixed_window = {"days": 0, "window_end": first["window_end"]}
                all_groups, group_page_sizes = [], []
                for page in range(1, 5):
                    response = client.get("/api/v1/admin/overview", params={**fixed_window, "page": page, "page_size": 20})
                    assert response.status_code == 200, response.text
                    listing = response.json()
                    assert listing["groups_total"] == 61 and listing["counts"]["groups"] == 61
                    assert listing["has_more"] is (page < 4)
                    all_groups.extend(listing["groups"])
                    group_page_sizes.append(len(listing["groups"]))
                checks["all_61_heat_groups_paginated_without_loss"] = (
                    group_page_sizes == [20, 20, 20, 1] and len({group["key"] for group in all_groups}) == 61)
                checks["overview_page_size_101_rejected_422"] = client.get(
                    "/api/v1/admin/overview", params={"page_size": 101}).status_code == 422
                target = all_groups[0]
                checks["ranking_keeps_140_count_above_single_occurrences"] = target["count"] == 140
                evidence, evidence_page_sizes = [], []
                for page in range(1, 5):
                    response = client.get(f"/api/v1/admin/groups/{target['key']}",
                                          params={**fixed_window, "page": page, "page_size": 40})
                    assert response.status_code == 200, response.text
                    listing = response.json()
                    assert listing["total"] == 140 and listing["pagination_mode"] == "paged"
                    assert listing["has_more"] is (page < 4)
                    evidence.extend(listing["evidence"])
                    evidence_page_sizes.append(len(listing["evidence"]))
                checks["all_140_evidence_paginated_without_loss"] = (
                    evidence_page_sizes == [40, 40, 40, 20] and len({row["id"] for row in evidence}) == 140)
                legacy_full = client.get(f"/api/v1/admin/groups/{target['key']}", params=fixed_window).json()
                checks["legacy_group_detail_full_response_compatible"] = (
                    legacy_full["pagination_mode"] == "legacy_full" and len(legacy_full["evidence"]) == 140)
                approval_set = client.get(f"/api/v1/admin/groups/{target['key']}/approval-set", params=fixed_window).json()
                checks["approval_set_covers_complete_ids_revisions_digest"] = (
                    approval_set["active_count"] == 140
                    and set(approval_set["expected_occurrence_ids"]) == {row["id"] for row in evidence}
                    and approval_set["expected_revisions"] == {row["id"]: row["revision"] for row in evidence}
                    and len(approval_set["evidence_digest"]) == 64)
                body = {**fixed_window, "note": "合成输入，仅核对完整集合与字节",
                        "expected_occurrence_ids": approval_set["expected_occurrence_ids"],
                        "expected_revisions": approval_set["expected_revisions"],
                        "expected_evidence_digest": approval_set["evidence_digest"]}
                partial = {**body, "expected_occurrence_ids": body["expected_occurrence_ids"][:40],
                           "expected_revisions": {row["id"]: row["revision"] for row in evidence[:40]}}
                checks["partial_page_cannot_approve_409"] = client.post(
                    f"/api/v1/admin/groups/{target['key']}/approve", json=partial).status_code == 409
                approval = client.post(f"/api/v1/admin/groups/{target['key']}/approve", json=body)
                assert approval.status_code == 200, approval.text
                handoff_id = approval.json()["id"]
                checks["full_approval_set_approved_200"] = approval.json()["occurrences"] == 140
                frozen, metadata_json = stored(handoff_id)
                digest = sha256(frozen)
                export = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
                checks["stored_export_metadata_raw_bytes_identical"] = (
                    export.content == frozen and json.loads(metadata_json)["payload_digest"] == digest)
                checks["export_json_headers_match_bytes"] = (
                    export.headers["content-type"].startswith("application/json")
                    and int(export.headers["content-length"]) == len(frozen))

                errors = []
                for mode, error_code in (("wrong_digest", "receipt_digest_mismatch"), ("wrong_id", "receipt_mismatch")):
                    state.mode = mode
                    failed = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
                    detail = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
                    errors.append(detail["send_attempts"][-1]["error_code"])
                    checks[f"{mode}_genuine_failed_502"] = (
                        failed.status_code == 502 and failed.json()["error"]["code"] == "RECEIVER_UNCONFIRMED"
                        and detail["status"] == "failed" and detail["received_at"] is None
                        and errors[-1] == error_code)
                state.mode = "matching"
                success = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
                detail = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
                checks["same_id_manual_retry_received_200"] = (
                    success.status_code == 200 and success.json()["id"] == handoff_id
                    and success.json()["status"] == "received" and len(detail["send_attempts"]) == 3)
                checks["every_outbound_raw_body_header_and_metadata_matches_frozen"] = all(
                    event["raw"] == frozen and event["raw_body_sha256"] == event["declared_sha256"] == digest
                    and event["idempotency_key"] == handoff_id and event["content_type"].startswith("application/json")
                    for event in state.events)
                checks["partner_private_receipt_fields_not_persisted"] = (
                    "synthetic-field-that-must-not-be-persisted" not in json.dumps(detail))
                event_count = len(state.events)
                assert client.post(f"/api/v1/admin/handoffs/{handoff_id}/send").status_code == 200
                checks["received_repeat_does_not_send_network_again"] = len(state.events) == event_count
                checks["new_snapshot_payload_and_metadata_never_rewritten"] = stored(handoff_id) == (frozen, metadata_json)

                # Model one pre-metadata schema 1.4 immutable record in this
                # temporary fixture only; original formatting is part of its bytes.
                old_group = all_groups[1]
                old_set = client.get(f"/api/v1/admin/groups/{old_group['key']}/approval-set", params=fixed_window).json()
                old_approval = client.post(f"/api/v1/admin/groups/{old_group['key']}/approve", json={
                    **fixed_window, "note": "模拟历史schema1.4原始格式",
                    "expected_occurrence_ids": old_set["expected_occurrence_ids"],
                    "expected_revisions": old_set["expected_revisions"],
                    "expected_evidence_digest": old_set["evidence_digest"]})
                assert old_approval.status_code == 200, old_approval.text
                legacy_id = old_approval.json()["id"]
                original, _ = stored(legacy_id)
                formatted = (json.dumps(json.loads(original), ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE demand_handoffs SET payload_json=?,metadata_json='{}' WHERE id=?",
                               (formatted.decode("utf-8"), legacy_id))
                legacy_export = client.get(f"/api/v1/admin/handoffs/{legacy_id}/export")
                legacy_sent = client.post(f"/api/v1/admin/handoffs/{legacy_id}/send")
                checks["legacy_unicode_whitespace_schema14_exact_bytes_preserved"] = (
                    legacy_export.content == formatted and legacy_export.json()["schema_version"] == "1.4"
                    and legacy_sent.status_code == 200 and legacy_sent.json()["status"] == "received"
                    and state.events[-1]["raw"] == formatted
                    and state.events[-1]["declared_sha256"] == sha256(formatted)
                    and stored(legacy_id) == (formatted, "{}"))
                history = client.get("/api/v1/admin/handoffs").json()["items"]
                histories = {row["id"]: row for row in history}
                checks["history_group_title_comes_from_frozen_payload"] = all(
                    histories[id_]["group_key"] == json.loads(raw)["demand"]["group_key"]
                    and histories[id_]["title"] == json.loads(raw)["demand"]["title"]
                    for id_, raw in ((handoff_id, frozen), (legacy_id, formatted)))

                stop()
                start()
                recovered = client.get(f"/api/v1/admin/handoffs/{handoff_id}")
                checks["same_cookie_authorized_after_process_restart"] = recovered.status_code == 200
                recovered_detail = recovered.json()
                checks["received_handoff_ids_versions_attempts_survive_restart"] = (
                    recovered_detail["id"] == handoff_id and recovered_detail["version"] == detail["version"]
                    and recovered_detail["status"] == "received" and recovered_detail["received_at"] == detail["received_at"]
                    and recovered_detail["send_attempts"] == detail["send_attempts"])
                checks["new_and_legacy_bytes_hashes_survive_restart"] = all(
                    client.get(f"/api/v1/admin/handoffs/{id_}/export").content == raw
                    for id_, raw in ((handoff_id, frozen), (legacy_id, formatted)))
                event_count = len(state.events)
                for id_ in (handoff_id, legacy_id):
                    response = client.post(f"/api/v1/admin/handoffs/{id_}/send")
                    assert response.status_code == 200 and response.json()["status"] == "received"
                checks["restart_received_repeats_do_not_send_again"] = len(state.events) == event_count
                checks["legacy_metadata_and_payload_remain_unmodified_after_restart"] = stored(legacy_id) == (formatted, "{}")
                assert all(checks.values()), {key: value for key, value in checks.items() if not value}
                events = [{key: value for key, value in event.items() if key != "raw"} for event in state.events]
                return {"verified_at": datetime.now(timezone.utc).isoformat(), "prd_version": "1.6",
                        "scope": "temporary SQLite and real loopback backend/receiver HTTP",
                        "input_kind": "simulation_fixture", "paid_calls": 0, "partner_received": False,
                        "frontend_verified": False, "cloud_deployed": False, "d3_enabled": False,
                        "checks": checks, "checks_passed": len(checks),
                        "fixture": {"turns": 200, "heat_groups": 61, "largest_group_evidence": 140},
                        "pagination": {"group_page_sizes": group_page_sizes, "evidence_page_sizes": evidence_page_sizes},
                        "handoff_id": handoff_id, "frozen_payload_bytes": len(frozen), "frozen_payload_sha256": digest,
                        "legacy_handoff_id": legacy_id, "legacy_payload_bytes": len(formatted),
                        "legacy_payload_sha256": sha256(formatted), "failed_attempt_error_codes": errors,
                        "receiver_events": events,
                        "persistent_storage": "same temporary SQLite across two service process starts; removed after verification"}
    finally:
        stop()
        receiver.shutdown()
        receiver.server_close()
        receiver_thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checks_passed": result["checks_passed"], "output": str(args.output)}, ensure_ascii=False))
