"""Reproduce the confirmed S1 source-approval policy over real isolated HTTP.

Run with the backend virtualenv:
  python -m scripts.verify_s1_source_eligibility --output <report.json>

Uses a random loopback port, temporary SQLite and synthetic rule evidence only.
Never connects to existing 3026/8026 services, a model, receiver or partner.
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
from datetime import datetime, timedelta, timezone

import httpx

from scripts.verify_s1_sources import SEED


def verify():
    backend = Path(__file__).resolve().parents[1]
    checks, samples, process = {}, {}, None
    starts = 0

    def check(name, condition):
        checks[name] = bool(condition)
        if not condition:
            raise AssertionError(name)

    def stop():
        nonlocal process
        if process is None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process = None

    with tempfile.TemporaryDirectory(prefix="styling-s1-source-policy-") as temporary:
        database = Path(temporary) / "policy.db"
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            port = available.getsockname()[1]
        # A fresh random port must never reuse the known development endpoints.
        if port in {3026, 8026}:
            raise RuntimeError("random port unexpectedly matched an existing service")
        password = secrets.token_urlsafe(24)
        env = {key: "" if key.endswith("_API_KEY") else value for key, value in os.environ.items()}
        env.update({
            "DATABASE_URL": f"sqlite:///{database}", "DATA_DIR": str(Path(temporary) / "data"),
            "DEEPSEEK_API_KEY": "", "RUNNINGHUB_API_KEY": "", "TUDOU_API_KEY": "",
            "OPENAI_API_KEY": "", "ANTHROPIC_API_KEY": "", "CMS_API_KEY": "", "CMS_BASE_URL": "",
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:1", "RUNNINGHUB_BASE_URL": "http://127.0.0.1:1",
            "TUDOU_BASE_URL": "http://127.0.0.1:1", "STYLING_ADMIN_PASSWORD": password,
            "STYLING_ADMIN_SECRET": secrets.token_urlsafe(48), "STYLING_ADMIN_COOKIE_SECURE": "0",
            "STYLING_DEMAND_D3_ENABLED": "0", "STYLING_DEMAND_RECEIVER_URL": "",
            "STYLING_DEMAND_RECEIVER_KEY": "", "STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES": "",
        })
        seeded = subprocess.run([sys.executable, "-c", SEED], cwd=backend, env=env,
                                check=True, capture_output=True, text=True)
        fixtures = json.loads(seeded.stdout)
        base = f"http://127.0.0.1:{port}"

        def query(sql, params=()):
            with sqlite3.connect(database) as connection:
                connection.row_factory = sqlite3.Row
                return [dict(row) for row in connection.execute(sql, params).fetchall()]

        def counts():
            names = ("demand_turns", "demand_occurrences", "demand_handoffs", "demand_send_attempts")
            return {**{name: query(f"SELECT COUNT(*) AS n FROM {name}")[0]["n"] for name in names},
                    "approve_audits": query("SELECT COUNT(*) AS n FROM demand_audit WHERE action='approve'")[0]["n"]}

        def frozen(handoff_id):
            row = query("SELECT id,version,status,payload_json,metadata_json FROM demand_handoffs WHERE id=?", (handoff_id,))[0]
            return {"id": row["id"], "version": row["version"], "status": row["status"],
                    "payload_sha256": hashlib.sha256(row["payload_json"].encode()).hexdigest(),
                    "metadata_sha256": hashlib.sha256(row["metadata_json"].encode()).hexdigest()}

        def target_fact(case):
            return query("SELECT id,turn_id,group_key,title,description,attributes_json,revision,lifecycle,review_state "
                         "FROM demand_occurrences WHERE id=?", (case["target_occurrence_id"],))[0]

        def start():
            nonlocal process, starts
            process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                        "--port", str(port)], cwd=backend, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            starts += 1
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("isolated backend exited before readiness")
                try:
                    if httpx.get(base + "/api/v1/health", timeout=1, trust_env=False).status_code == 200:
                        return
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            raise RuntimeError("isolated backend readiness timed out")

        blocked = fixtures["reject"]
        # Fixture-only preparation proves out-of-window external sources count.
        old_time = (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=9)).isoformat(sep=" ")
        with sqlite3.connect(database) as connection:
            connection.execute("UPDATE demand_turns SET created_at=? WHERE id=?", (old_time, blocked["source_turn_id"]))
        initial_counts = counts()
        legacy_before = frozen(fixtures["legacy"]["handoff_id"])

        try:
            start()
            with httpx.Client(base_url=base, timeout=20, trust_env=False) as client:
                route = f"/api/v1/admin/groups/{blocked['target_group_key']}/approval-set"
                unauthenticated = client.get(route)
                samples["unauthenticated"] = {"status": unauthenticated.status_code, "body": unauthenticated.json()}
                check("unauthenticated_preview_401", unauthenticated.status_code == 401)
                check("manager_login_200", client.post("/api/v1/admin/login", json={"password": password}).status_code == 200)

                def baseline(case, params=None):
                    response = client.get(f"/api/v1/admin/groups/{case['target_group_key']}/approval-set", params=params or {"days": 7})
                    if response.status_code != 200:
                        raise AssertionError(f"preview failed: {response.status_code} {response.text}")
                    return response.json()

                def bounds(data):
                    return {"days": data["days"], "window_end": data["window_end"],
                            **({"window_start": data["window_start"]} if data["window_start"] is not None else {})}

                def body(data, note="合成样例逐条来源核对"):
                    return {**bounds(data), "note": note, "expected_occurrence_ids": data["expected_occurrence_ids"],
                            "expected_revisions": data["expected_revisions"], "expected_evidence_digest": data["evidence_digest"]}

                def approve(case, review):
                    return client.post(f"/api/v1/admin/groups/{case['target_group_key']}/approve", json=review)

                def detail(handoff_id):
                    response = client.get(f"/api/v1/admin/handoffs/{handoff_id}")
                    if response.status_code != 200:
                        raise AssertionError(response.text)
                    return response.json()

                a = baseline(blocked)
                check("default_7_days_exact_168_hours", datetime.fromisoformat(a["window_end"].replace("Z", "+00:00"))
                      - datetime.fromisoformat(a["window_start"].replace("Z", "+00:00")) == timedelta(hours=168))
                check("default_active_source_is_eligible", a["approval_eligibility"]["eligible"] is True)
                check("referenced_source_outside_window_is_resolved", a["source_snapshot"][0]["turn"]["created_at"] < a["window_start"])
                pre_exclusion = approve(blocked, body(a))
                check("historical_target_approval_before_exclusion_200", pre_exclusion.status_code == 200)
                historical_id = pre_exclusion.json()["id"]
                historical_before = frozen(historical_id)
                before_target = target_fact(blocked)
                before_send = {key: detail(historical_id)[key] for key in ("status", "send_eligible", "needs_review", "review_reasons")}
                before_pause_counts = counts()

                exclusion = client.post(f"/api/v1/admin/occurrences/{blocked['source_occurrence_id']}/reject",
                                        json={"note": "合成规则验证：公开排除外部出处", "expected_revision": 1})
                samples["public_source_reject"] = {"status": exclusion.status_code, "body": exclusion.json()}
                check("public_source_reject_200", exclusion.status_code == 200)
                outdated = approve(blocked, body(a))
                samples["outdated_a_approval"] = {"status": outdated.status_code, "body": outdated.json()}
                check("old_a_approval_409_conflict", outdated.status_code == 409 and outdated.json()["error"]["code"] == "CONFLICT")
                fresh = baseline(blocked, bounds(a))
                eligibility = fresh["approval_eligibility"]
                samples["fresh_preview"] = fresh
                check("fresh_preview_200_eligible_false", eligibility["eligible"] is False)
                check("fresh_preview_identifies_exact_excluded_source", eligibility["blocked_sources"] == [{
                    "turn_id": blocked["source_turn_id"], "occurrence_id": blocked["source_occurrence_id"],
                    "revision": 2, "review_state": "rejected", "lifecycle": "excluded"}])
                refused = approve(blocked, body(fresh))
                samples["fresh_a_approval"] = {"status": refused.status_code, "body": refused.json()}
                check("fresh_a_approval_409_source_approval_blocked", refused.status_code == 409
                      and refused.json()["error"]["code"] == "SOURCE_APPROVAL_BLOCKED")
                check("blocked_approval_exposes_same_top_level_eligibility", refused.json()["approval_eligibility"] == eligibility)
                reread = baseline(blocked, bounds(a))
                repeated = approve(blocked, body(reread, "再次人工读取全部出处，但不解除暂停"))
                check("rereading_sources_does_not_unblock", reread["approval_eligibility"] == eligibility
                      and repeated.status_code == 409 and repeated.json()["error"]["code"] == "SOURCE_APPROVAL_BLOCKED")
                forged = {**body(fresh), "approval_eligibility": {"eligible": True, "blocked_sources": []},
                          "source_snapshot": [], "eligible": True}
                forged_response = approve(blocked, forged)
                samples["forged_client_eligibility"] = {"status": forged_response.status_code, "body": forged_response.json()}
                check("client_cannot_forge_eligibility", forged_response.status_code == 409
                      and forged_response.json()["approval_eligibility"] == eligibility)
                check("pause_does_not_change_target_fact_or_revision", target_fact(blocked) == before_target)
                check("pause_does_not_remove_target_from_heat", fresh["active_count"] == a["active_count"] == 1)
                check("blocked_approvals_create_no_package_or_approve_audit", counts() == before_pause_counts)
                check("historical_target_payload_metadata_status_are_immutable", frozen(historical_id) == historical_before)
                after_send = {key: detail(historical_id)[key] for key in before_send}
                check("source_policy_does_not_propagate_historical_send_eligibility", after_send == before_send)
                check("legacy_schema14_snapshot_not_changed", frozen(fixtures["legacy"]["handoff_id"]) == legacy_before)

                valid = fixtures["valid"]
                normal = baseline(valid)
                check("unrelated_excluded_source_does_not_block_valid_preview", normal["approval_eligibility"]["eligible"] is True)
                normal_response = approve(valid, body(normal))
                check("valid_active_source_target_approval_200", normal_response.status_code == 200)
                valid_id = normal_response.json()["id"]
                valid_frozen = frozen(valid_id)
                normal_repeat = approve(valid, body(normal))
                check("valid_target_approval_idempotent", normal_repeat.status_code == 200 and normal_repeat.json()["id"] == valid_id)
                # Changing only active pending -> approved is normal progress.
                source_case = {"target_group_key": valid["source_group_key"]}
                source_baseline = baseline(source_case)
                source_response = approve(source_case, body(source_baseline))
                check("source_without_external_context_can_approve_200", source_response.status_code == 200)
                after_source_approval = baseline(valid, bounds(normal))
                check("active_pending_to_approved_preserves_digest_and_eligibility",
                      after_source_approval["evidence_digest"] == normal["evidence_digest"]
                      and after_source_approval["approval_eligibility"] == normal["approval_eligibility"])
                check("normal_progress_keeps_target_idempotency", approve(valid, body(normal)).json()["id"] == valid_id)

                cumulative = baseline(valid, {"days": 0})
                check("cumulative_has_null_start_and_fixed_end", cumulative["window_start"] is None and cumulative["window_end"] is not None)
                later_seed = """
import json
from app.core.database import SessionLocal
from app.models.demand import DemandTurn
from app.services.demand import record_turn
assert record_turn('synthetic-policy-later', 'synthetic-policy-later-1', '春天约会想要修身直筒裤')
with SessionLocal() as db:
    row = db.query(DemandTurn).filter_by(request_id='synthetic-policy-later-1').one()
    row.data_origin = 'simulation_fixture'
    db.commit()
    print(json.dumps({'id': row.id, 'created_at': row.created_at.isoformat() + 'Z'}))
"""
                later = json.loads(subprocess.run([sys.executable, "-c", later_seed], cwd=backend, env=env,
                                                 check=True, capture_output=True, text=True).stdout)
                fixed_normal = baseline(valid, bounds(normal))
                updated_normal = baseline(valid)
                fixed_cumulative = baseline(valid, bounds(cumulative))
                updated_cumulative = baseline(valid, {"days": 0})
                check("later_record_is_after_original_cutoff", later["created_at"] > normal["window_end"])
                check("fixed_7day_range_does_not_slide_on_refresh", fixed_normal["window_start"] == normal["window_start"]
                      and fixed_normal["window_end"] == normal["window_end"] and fixed_normal["active_count"] == normal["active_count"] == 1)
                check("fixed_7day_digest_does_not_admit_later_turn", fixed_normal["evidence_digest"] == normal["evidence_digest"])
                check("updated_7day_range_includes_later_turn", updated_normal["active_count"] == 2
                      and updated_normal["window_end"] > normal["window_end"])
                check("fixed_cumulative_end_excludes_later_turn", fixed_cumulative["window_start"] is None
                      and fixed_cumulative["window_end"] == cumulative["window_end"] and fixed_cumulative["active_count"] == 1)
                check("updated_cumulative_end_includes_later_turn", updated_cumulative["active_count"] == 2)
                check("new_evidence_does_not_mutate_valid_frozen_package", frozen(valid_id) == valid_frozen)
                malformed = client.get(route, params={"days": 7, "window_start": "2026-10-01T00:00:00",
                                                     "window_end": "2026-10-08T00:00:00"})
                check("non_utc_window_rejected_422", malformed.status_code == 422)
                samples["fixed_window_and_updated_window"] = {"original": bounds(normal), "fixed": bounds(fixed_normal),
                    "updated": bounds(updated_normal), "later_turn": later,
                    "active_counts": {"original": normal["active_count"], "fixed": fixed_normal["active_count"],
                                      "updated": updated_normal["active_count"]}}

                before_restart_counts = counts()
                stop()
                start()
                recovered = client.get(route, params=bounds(a))
                check("same_admin_cookie_survives_service_restart", recovered.status_code == 200)
                recovered_a = recovered.json()
                check("restart_preserves_source_pause_eligibility", recovered_a["approval_eligibility"] == eligibility)
                restarted_refusal = approve(blocked, body(recovered_a))
                samples["restarted_fresh_approval"] = {"status": restarted_refusal.status_code, "body": restarted_refusal.json()}
                check("restart_preserves_source_blocked_error", restarted_refusal.status_code == 409
                      and restarted_refusal.json()["error"]["code"] == "SOURCE_APPROVAL_BLOCKED"
                      and restarted_refusal.json()["approval_eligibility"] == eligibility)
                check("restart_preserves_target_and_historical_frozen_records", target_fact(blocked) == before_target
                      and frozen(historical_id) == historical_before and frozen(valid_id) == valid_frozen
                      and frozen(fixtures["legacy"]["handoff_id"]) == legacy_before)
                check("restart_and_blocked_post_create_no_new_records", counts() == before_restart_counts)
                final_counts = counts()
                check("no_receiver_attempts_were_created", final_counts["demand_send_attempts"] == 0)
                result = {"verified_at": datetime.now(timezone.utc).isoformat(), "prd_version": "1.6",
                    "policy": "pause-inactive-sources-v1", "scope": "random loopback real HTTP; independent temporary SQLite",
                    "input_kind": "simulation_fixture", "checks_passed": len(checks), "checks": checks,
                    "http_response_samples": samples, "counts": {"initial": initial_counts,
                        "before_source_exclusion": before_pause_counts, "before_restart": before_restart_counts, "final": final_counts},
                    "historical_snapshot": historical_before, "legacy_snapshot": legacy_before, "valid_snapshot": valid_frozen,
                    "target_facts_preserved": before_target, "service_process_starts": starts,
                    "window_contract": {"official_days": 7, "official_hours": 168, "interval": "UTC[start,end)",
                        "fixed_cutoff": "reuse returned UTC bounds; each unbounded request is a new query", "cumulative_start": None},
                    "paid_calls": 0, "partner_received": False, "receiver_configured": False, "partner_send_attempts": 0,
                    "d3_enabled": False, "frontend_verified": False, "cloud_deployed": False,
                    "existing_3026_8026_services_or_databases_accessed": False,
                    "persistent_storage": "same independent temporary SQLite across two process starts; removed after verification"}
                stop()
                return result
        finally:
            stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"checks_passed": result["checks_passed"], "output": str(args.output)}, ensure_ascii=False))
