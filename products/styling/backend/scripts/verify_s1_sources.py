"""Real isolated HTTP checks for resolved-source approval consistency.

Run: .venv/bin/python -m scripts.verify_s1_sources --output <evidence.json>
Every input is synthetic. Direct SQLite changes below are maintenance
experiments in the temporary fixture, not a public text-editing capability.
No receiver is configured; no paid model, partner send or deployment is used.
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


SEED = """
import hashlib
import json
from app.core.database import init_db, SessionLocal
from app.models.demand import DemandTurn, DemandOccurrence, DemandHandoff
from app.services.demand import record_turn
init_db()
cases = {
    'reject': ('秋天通勤想要宽松阔腿裤', '再修身一点'),
    'text': ('夏天出游想要宽松上衣', '再修身一点'),
    'revision': ('冬天居家想要修身裙子', '再宽松一点'),
    'valid': ('春天约会想要宽松直筒裤', '再修身一点'),
    'cross_session': ('秋天运动想要宽松上衣', '再修身一点'),
    'future': ('夏天通勤想要宽松直筒裤', '再紧身一点'),
    'same_group': ('冬天出游想要宽松阔腿裤', '再宽松一点'),
}
index = {}
for name, (source_text, target_text) in cases.items():
    session = f'synthetic-sources-{name}'
    assert record_turn(session, f'{session}-first', source_text)
    assert record_turn(session, f'{session}-second', target_text)
    with SessionLocal() as db:
        source = db.query(DemandTurn).filter_by(request_id=f'{session}-first').one()
        target = db.query(DemandTurn).filter_by(request_id=f'{session}-second').one()
        source_occ = db.query(DemandOccurrence).filter_by(turn_id=source.id).one()
        target_occ = db.query(DemandOccurrence).filter_by(turn_id=target.id).one()
        index[name] = {'source_turn_id': source.id, 'source_occurrence_id': source_occ.id,
                       'source_group_key': source_occ.group_key,
                       'target_turn_id': target.id, 'target_occurrence_id': target_occ.id,
                       'target_group_key': target_occ.group_key}
assert record_turn('synthetic-legacy-source-free', 'synthetic-legacy-source-free-1', '春天居家想要紧身上衣')
with SessionLocal() as db:
    db.query(DemandTurn).update({'data_origin': 'simulation_fixture'})
    turn = db.query(DemandTurn).filter_by(request_id='synthetic-legacy-source-free-1').one()
    occurrence = db.query(DemandOccurrence).filter_by(turn_id=turn.id).one()
    legacy_id = 'DH-sources-legacy-schema14'
    payload = {'schema_version': '1.4', 'handoff_id': legacy_id, 'revision': 1,
               'source_agent': 'outfit', 'target_agent': 'product', 'data_origin': 'simulation_fixture',
               'approved_at': turn.created_at.isoformat() + 'Z', 'review_note': '模拟升级前冻结包',
               'demand': {'group_key': occurrence.group_key, 'title': occurrence.title,
                          'description': occurrence.description, 'attributes': json.loads(occurrence.attributes_json),
                          'occurrences': 1, 'session_count': 1, 'window_days': 0,
                          'material': None, 'craft': None, 'knowledge_status': 'pending_database'},
               'evidence': [{'occurrence_id': occurrence.id, 'turn_id': turn.id,
                             'session_ref': hashlib.sha256(turn.session_id.encode()).hexdigest(),
                             'text': turn.text, 'created_at': turn.created_at.isoformat() + 'Z',
                             'extractor': turn.extractor, 'data_origin': 'simulation_fixture'}]}
    db.add(DemandHandoff(id=legacy_id, group_key=occurrence.group_key, version=1,
                        fingerprint=hashlib.sha256(b'synthetic-legacy-source-free').hexdigest(),
                        payload_json=json.dumps(payload, ensure_ascii=False, indent=2) + '\\n', metadata_json='{}'))
    index['legacy'] = {'handoff_id': legacy_id, 'group_key': occurrence.group_key}
    db.commit()
print(json.dumps(index))
"""


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def verify():
    backend = Path(__file__).resolve().parents[1]
    process = None
    checks = {}
    experiment_results = []

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

    with tempfile.TemporaryDirectory(prefix="styling-s1-sources-") as tmp:
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
               "STYLING_DEMAND_RECEIVER_URL": "", "STYLING_DEMAND_RECEIVER_KEY": "",
               "STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES": ""}
        seeded = subprocess.run([sys.executable, "-c", SEED], cwd=backend, env=env,
                                check=True, capture_output=True, text=True)
        fixtures = json.loads(seeded.stdout)
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

        def query(sql, params=()):
            with sqlite3.connect(database) as db:
                db.row_factory = sqlite3.Row
                return [dict(row) for row in db.execute(sql, params).fetchall()]

        def maintenance(sql, params=()):
            with sqlite3.connect(database) as db:
                db.execute(sql, params)

        def frozen(handoff_id):
            row = query("SELECT payload_json,metadata_json FROM demand_handoffs WHERE id=?", (handoff_id,))[0]
            return row["payload_json"].encode("utf-8"), row["metadata_json"]

        def target_facts(case):
            return query("SELECT id,revision,lifecycle FROM demand_occurrences WHERE id=?", (case["target_occurrence_id"],))[0]

        def source_entries(snapshot):
            return list(snapshot.values()) if isinstance(snapshot, dict) else snapshot

        def source_turn_id(entry):
            return entry["turn"].get("id", entry["turn"].get("turn_id"))

        # An earlier source outside the 7-day window remains an audited fact.
        valid_source = fixtures["valid"]["source_turn_id"]
        old_time = (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=9)).isoformat(sep=" ")
        maintenance("UPDATE demand_turns SET created_at=? WHERE id=?", (old_time, valid_source))
        legacy_before = frozen(fixtures["legacy"]["handoff_id"])

        try:
            start()
            with httpx.Client(base_url=base, timeout=20) as client:
                checks["unauthenticated_approval_set_401"] = client.get(
                    f"/api/v1/admin/groups/{fixtures['valid']['target_group_key']}/approval-set").status_code == 401
                assert client.post("/api/v1/admin/login", json={"password": password}).status_code == 200

                def baseline(case, days=0):
                    response = client.get(f"/api/v1/admin/groups/{case['target_group_key']}/approval-set", params={"days": days})
                    assert response.status_code == 200, response.text
                    data = response.json()
                    assert data["evidence_digest_version"] == "resolved-sources-v1"
                    return data

                def review(data, note="合成出处一致性核对"):
                    return {"note": note, "days": data["days"], "window_start": data["window_start"],
                            "window_end": data["window_end"], "expected_occurrence_ids": data["expected_occurrence_ids"],
                            "expected_revisions": data["expected_revisions"], "expected_evidence_digest": data["evidence_digest"]}

                def approve(case, body):
                    return client.post(f"/api/v1/admin/groups/{case['target_group_key']}/approve", json=body)

                rejected = fixtures["reject"]
                old_a = baseline(rejected)
                old_target = target_facts(rejected)
                exclusion = client.post(f"/api/v1/admin/occurrences/{rejected['source_occurrence_id']}/reject",
                                        json={"note": "合成实验公开排除源记录", "expected_revision": 1})
                assert exclusion.status_code == 200, exclusion.text
                response = approve(rejected, review(old_a))
                checks["public_cross_group_source_reject_invalidates_old_a_409"] = response.status_code == 409
                checks["source_reject_does_not_propagate_target_id_revision_lifecycle"] = target_facts(rejected) == old_target
                after_exclusion = client.get(f"/api/v1/admin/groups/{rejected['target_group_key']}/approval-set", params={"days": 0})
                after_body = after_exclusion.json()
                experiment_results.append({"experiment": "public_source_reject", "old_a_approval_http_status": response.status_code,
                                           "fresh_approval_set_http_status": after_exclusion.status_code,
                                           "fresh_digest_changed_if_returned": after_body.get("evidence_digest") != old_a["evidence_digest"]
                                           if after_exclusion.status_code == 200 else None,
                                           "fresh_a_business_eligibility_asserted": False})

                for name, mutation in (
                    ("text", ("UPDATE demand_turns SET text=text||? WHERE id=?", ("；临时维护校正", fixtures["text"]["source_turn_id"]))),
                    ("revision", ("UPDATE demand_occurrences SET revision=revision+1 WHERE id=?", (fixtures["revision"]["source_occurrence_id"],))),
                ):
                    case = fixtures[name]
                    old_a = baseline(case)
                    old_target = target_facts(case)
                    maintenance(*mutation)
                    changed = baseline(case)
                    response = approve(case, review(old_a))
                    checks[f"maintenance_source_{name}_changes_resolved_digest"] = changed["evidence_digest"] != old_a["evidence_digest"]
                    checks[f"maintenance_source_{name}_old_a_409"] = response.status_code == 409
                    checks[f"maintenance_source_{name}_does_not_change_target_facts"] = target_facts(case) == old_target
                    experiment_results.append({"experiment": f"temporary_sqlite_source_{name}",
                                               "public_edit_api": False, "temporary_database_only": True,
                                               "old_a_approval_http_status": response.status_code})

                # Valid external facts require the external-fact digest at the
                # final write even when target ID/revision membership is complete.
                valid = fixtures["valid"]
                a = baseline(valid, days=7)
                entries = source_entries(a["source_snapshot"])
                source = next(entry for entry in entries if source_turn_id(entry) == valid["source_turn_id"])
                source_text = query("SELECT text FROM demand_turns WHERE id=?", (valid["source_turn_id"],))[0]["text"]
                checks["window_external_source_snapshot_contains_original_turn_and_occurrences"] = (
                    len(entries) == 1 and source["turn"]["text"] == source_text
                    and any(occurrence["id"] == valid["source_occurrence_id"] for occurrence in source["occurrences"]))
                checks["valid_source_before_window_is_still_bound"] = source["turn"]["created_at"] < a["window_start"]
                body = review(a)
                without_digest = {key: value for key, value in body.items() if key != "expected_evidence_digest"}
                checks["external_source_final_post_without_digest_422"] = approve(valid, without_digest).status_code == 422
                response = approve(valid, body)
                assert response.status_code == 200, response.text
                handoff_id = response.json()["id"]
                payload_before, metadata_before = frozen(handoff_id)
                meta = json.loads(metadata_before)
                checks["fresh_valid_source_baseline_approved_200"] = response.json()["status"] == "approved"
                checks["source_snapshot_version_frozen_only_in_local_metadata"] = (
                    meta["evidence_digest_version"] == "resolved-sources-v1" and meta["source_snapshot"] == a["source_snapshot"]
                    and "source_snapshot" not in json.loads(payload_before)
                    and json.loads(payload_before)["schema_version"] == "1.4")
                export = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
                checks["export_exact_frozen_utf8_and_payload_digest"] = (
                    export.content == payload_before and sha256(export.content) == meta["payload_digest"])

                source_set = client.get(f"/api/v1/admin/groups/{valid['source_group_key']}/approval-set", params={"days": 0}).json()
                source_approve = client.post(f"/api/v1/admin/groups/{valid['source_group_key']}/approve", json=review(source_set))
                assert source_approve.status_code == 200, source_approve.text
                # Use the original frozen range
                # to test facts without conflating normal query-window motion.
                exact_b = client.get(f"/api/v1/admin/groups/{valid['target_group_key']}/approval-set",
                                     params={"days": 7, "window_start": a["window_start"], "window_end": a["window_end"]}).json()
                repeated = approve(valid, body)
                checks["source_pending_to_approved_not_a_fact_digest_change"] = exact_b["evidence_digest"] == a["evidence_digest"]
                checks["source_normal_approval_target_repeat_is_idempotent"] = (
                    repeated.status_code == 200 and repeated.json()["id"] == handoff_id and repeated.json()["version"] == 1)

                same = fixtures["same_group"]
                same_a = baseline(same)
                same_body = review(same_a)
                first_same = approve(same, same_body)
                assert first_same.status_code == 200, first_same.text
                repeated_same = approve(same, same_body)
                checks["same_group_pending_to_approved_repeat_idempotent"] = (
                    repeated_same.status_code == 200 and repeated_same.json()["id"] == first_same.json()["id"])

                for name in ("cross_session", "future"):
                    case = fixtures[name]
                    old_a = baseline(case)
                    if name == "cross_session":
                        maintenance("UPDATE demand_turns SET session_id=? WHERE id=?", ("synthetic-unrelated-session", case["source_turn_id"]))
                    else:
                        target_time = query("SELECT created_at FROM demand_turns WHERE id=?", (case["target_turn_id"],))[0]["created_at"]
                        future_time = (datetime.fromisoformat(target_time) + timedelta(days=1)).isoformat(sep=" ")
                        maintenance("UPDATE demand_turns SET created_at=? WHERE id=?", (future_time, case["source_turn_id"]))
                    impossible = client.get(f"/api/v1/admin/groups/{case['target_group_key']}/approval-set", params={"days": 0})
                    response = approve(case, review(old_a))
                    checks[f"{name}_source_cannot_return_usable_baseline_409"] = impossible.status_code == 409
                    checks[f"{name}_source_final_post_blocked_409"] = response.status_code == 409
                    experiment_results.append({"experiment": f"temporary_sqlite_{name}",
                                               "public_edit_api": False, "temporary_database_only": True,
                                               "approval_set_http_status": impossible.status_code,
                                               "approval_http_status": response.status_code})

                # Post-approval facts may change; local source metadata and old
                # cross-product bytes remain the facts frozen at approval time.
                maintenance("UPDATE demand_turns SET text=text||? WHERE id=?", ("；批准后维护实验", valid["source_turn_id"]))
                checks["approved_local_source_snapshot_immutable_after_maintenance"] = frozen(handoff_id) == (payload_before, metadata_before)
                legacy_id = fixtures["legacy"]["handoff_id"]
                checks["preexisting_schema14_payload_and_empty_metadata_not_backfilled"] = (
                    frozen(legacy_id) == legacy_before and client.get(f"/api/v1/admin/handoffs/{legacy_id}/export").content == legacy_before[0])
                detail = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
                checks["receiver_unconfigured_no_partner_send_attempts"] = detail["send_attempts"] == []
                stop()
                start()
                recovered = client.get(f"/api/v1/admin/handoffs/{handoff_id}")
                checks["same_admin_cookie_authorized_after_restart"] = recovered.status_code == 200
                checks["restart_preserves_handoff_id_version_approved_status"] = (
                    recovered.json()["id"] == handoff_id and recovered.json()["version"] == 1
                    and recovered.json()["status"] == "approved" and recovered.json()["send_attempts"] == [])
                checks["restart_preserves_source_metadata_and_frozen_bytes"] = (
                    frozen(handoff_id) == (payload_before, metadata_before)
                    and client.get(f"/api/v1/admin/handoffs/{handoff_id}/export").content == payload_before)
                checks["restart_preserves_preexisting_schema14_bytes_and_metadata"] = frozen(legacy_id) == legacy_before
                assert all(checks.values()), {key: value for key, value in checks.items() if not value}
                result = {"verified_at": datetime.now(timezone.utc).isoformat(), "prd_version": "1.6",
                          "scope": "real random loopback HTTP and temporary SQLite",
                          "input_kind": "simulation_fixture", "paid_calls": 0, "partner_received": False,
                          "partner_send_attempts": 0, "receiver_configured": False, "d3_enabled": False,
                          "frontend_verified": False, "cloud_deployed": False,
                          "evidence_digest_version": "resolved-sources-v1", "checks_passed": len(checks), "checks": checks,
                          "maintenance_experiments": experiment_results,
                          "source_rejection_fresh_a_eligibility": "business decision pending; not asserted by this script",
                          "handoff_id": handoff_id, "payload_bytes": len(payload_before), "payload_sha256": sha256(payload_before),
                          "source_snapshot_sha256": sha256(json.dumps(meta["source_snapshot"], sort_keys=True, ensure_ascii=False).encode("utf-8")),
                          "legacy_handoff_id": legacy_id, "legacy_payload_sha256": sha256(legacy_before[0]),
                          "source_snapshot": meta["source_snapshot"],
                          "persistent_storage": "same temporary SQLite across two process starts; removed after verification"}
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
