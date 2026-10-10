"""Isolated HTTP/process-restart verification; no paid keys or external receiver.

Run with .venv/bin/python -m scripts.verify_s1_restart --output <evidence.json>.
Only synthetic inputs, public IDs, hashes and check outcomes are exported.
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
import time
from datetime import datetime, timezone

import httpx


def verify():
    backend = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="styling-s1-http-") as tmp:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        password = secrets.token_urlsafe(24)
        env = {**os.environ, "DATA_DIR": str(Path(tmp) / "data"),
               "DATABASE_URL": f"sqlite:///{tmp}/s1.db", "DEEPSEEK_API_KEY": "",
               "RUNNINGHUB_API_KEY": "", "TUDOU_API_KEY": "", "CMS_API_KEY": "",
               "CMS_BASE_URL": "", "STYLING_ADMIN_PASSWORD": password,
               "STYLING_ADMIN_SECRET": secrets.token_urlsafe(48),
               "STYLING_ADMIN_COOKIE_SECURE": "0", "STYLING_DEMAND_D3_ENABLED": "0",
               "STYLING_DEMAND_RECEIVER_URL": "", "STYLING_DEMAND_RECEIVER_KEY": "",
               "STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES": "",
               "DAILY_CALL_LIMIT": "100", "MAX_CONCURRENCY": "5"}
        base = f"http://127.0.0.1:{port}"
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

        try:
            start()
            with httpx.Client(base_url=base, timeout=10) as client:
                checks = {}
                checks["unauthenticated_manager_query_401"] = client.get("/api/v1/admin/overview").status_code == 401
                request = {"request_id": "s1-http-fixed-0", "session_id": "synthetic-session-0",
                           "message": "秋天通勤想要宽松阔腿裤"}
                for number in range(7):
                    message = request["message"] if number < 5 else "秋天通勤想要紧身裤"
                    response = client.post("/api/v1/chat", json={**request, "request_id": f"s1-http-fixed-{number}",
                                                               "session_id": f"synthetic-session-{number}", "message": message})
                    assert response.status_code == 200 and "NO_API_KEY" in response.text
                # All inputs in this isolated fixture are synthetic. Classify them
                # explicitly before review/export; no business database is touched.
                with sqlite3.connect(Path(tmp) / "s1.db") as fixture_db:
                    fixture_db.execute("UPDATE demand_turns SET data_origin='simulation_fixture'")
                checks["model_keys_disabled_no_external_generation"] = True
                duplicate = client.post("/api/v1/chat", json=request)
                checks["duplicate_request_409"] = duplicate.status_code == 409
                assert client.post("/api/v1/admin/login", json={"password": password}).status_code == 200
                checks["scope_override_403"] = client.get("/api/v1/admin/overview?space_id=another-space").status_code == 403
                overview = client.get("/api/v1/admin/overview?days=0").json()
                groups = overview["groups"]
                checks["heat_5_above_2"] = [g["count"] for g in groups] == [5, 2]
                turns = client.get("/api/v1/admin/turns?days=0&page_size=100").json()
                turn_ids = sorted(t["id"] for t in turns["items"])
                checks["accepted_turns_durable_once"] = turns["total"] == 7
                group = client.get(f"/api/v1/admin/groups/{groups[0]['key']}?days=0").json()
                evidence = group["evidence"]
                approval = {"note": "合成输入，仅验证后端行为", "days": 0,
                            "expected_occurrence_ids": [e["id"] for e in evidence],
                            "expected_revisions": {e["id"]: e["revision"] for e in evidence},
                            "window_start": None, "window_end": None}
                response = client.post(f"/api/v1/admin/groups/{groups[0]['key']}/approve", json=approval)
                assert response.status_code == 200, response.text
                handoff_id = response.json()["id"]
                export = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
                assert export.status_code == 200
                payload = export.json()
                exported_hash = hashlib.sha256(export.content).hexdigest()
                checks["legacy_schema_1_4_preserved"] = payload["schema_version"] == "1.4"
                checks["export_contains_no_internal_session_id"] = "synthetic-session-" not in export.text
                checks["unconfigured_receiver_503_no_false_success"] = client.post(
                    f"/api/v1/admin/handoffs/{handoff_id}/send").status_code == 503
                handoff_document = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
                stop()
                start()
                recovered = client.get("/api/v1/admin/turns?days=0&page_size=100")
                checks["same_cookie_valid_after_restart"] = recovered.status_code == 200
                checks["same_turn_ids_after_restart"] = sorted(t["id"] for t in recovered.json()["items"]) == turn_ids
                export2 = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
                checks["same_frozen_payload_hash_after_restart"] = hashlib.sha256(export2.content).hexdigest() == exported_hash
                checks["same_handoff_id_after_restart"] = export2.json()["handoff_id"] == handoff_id
                copied_cookie = client.cookies.get("styling_admin_v1")
                assert client.post("/api/v1/admin/logout").status_code == 200
                stop()
                start()
                response = client.get("/api/v1/admin/overview", headers={"Cookie": f"styling_admin_v1={copied_cookie}"})
                checks["revoked_cookie_replay_401_after_restart"] = response.status_code == 401
                assert all(checks.values()), checks
                return {"verified_at": datetime.now(timezone.utc).isoformat(), "prd_version": "1.6",
                        "scope": "local isolated backend", "input_kind": "synthetic",
                        "execution_kind": "real HTTP and process restart", "extractor": "rules-v2",
                        "paid_calls": 0, "partner_received": False, "frontend_verified": False,
                        "cloud_deployed": False, "d3_enabled": False, "checks": checks,
                        "turn_ids": turn_ids, "handoff_id": handoff_id, "export_sha256": exported_hash,
                        "heat": [{"title": g["title"], "occurrences": g["count"],
                                  "session_count": g["session_count"]} for g in groups],
                        "persistent_storage": "temporary SQLite database reused across three process starts; removed after verification",
                        "api_samples": {"turn": turns["items"][0], "group": group,
                                        "handoff": handoff_document,
                                        "frozen_export": payload}}
        finally:
            stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify()
    samples = result.pop("api_samples")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.output.with_name("api-samples.json").write_text(json.dumps({"input_kind": "synthetic", "samples": samples},
                                                                ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checks_passed": len(result["checks"]), "output": str(args.output)}, ensure_ascii=False))
