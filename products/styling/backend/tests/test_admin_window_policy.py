"""Confirmed S1 rolling windows, fixed query bounds and legacy exact ranges.

All records are synthetic, use conftest's temporary database and make no model
or receiver calls. Freeze the API clock so a natural-day implementation or a
refresh that silently advances the cutoff changes the observable membership.
"""
import json
from datetime import datetime, timedelta

import pytest

from app.api import admin
from app.core.database import SessionLocal
from app.models.demand import (DemandAdminSession, DemandAudit, DemandHandoff,
                               DemandOccurrence, DemandOccurrenceRevision,
                               DemandSendAttempt, DemandTurn)


NOW = datetime(2026, 10, 9, 23, 17, 43, 123456)
GROUP = "synthetic-window-group"


@pytest.fixture(autouse=True)
def isolated_window_policy(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "synthetic-window-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "synthetic-window-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "0")
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_URL", raising=False)
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_KEY", raising=False)
    with SessionLocal() as db:
        for model in (DemandOccurrenceRevision, DemandSendAttempt, DemandOccurrence,
                      DemandTurn, DemandHandoff, DemandAudit, DemandAdminSession):
            db.query(model).delete()
        db.commit()
    admin._attempts.clear()


@pytest.fixture
def clock(monkeypatch):
    clock = {"now": NOW}
    monkeypatch.setattr(admin, "utcnow", lambda: clock["now"])
    return clock


def seed(prefix, created_at, group=GROUP):
    with SessionLocal() as db:
        db.add(DemandTurn(id=f"{prefix}-turn", request_id=f"{prefix}-request",
                         session_id=f"{prefix}-session", text=f"合成时间窗口需求 {prefix}",
                         status="extracted", data_origin="synthetic_demo", created_at=created_at))
        db.add(DemandOccurrence(id=f"{prefix}-occ", turn_id=f"{prefix}-turn",
                                group_key=group, title="合成时间窗口需求", description="仅验证窗口边界",
                                attributes_json=json.dumps({"season": None, "scene": None,
                                    "category": "裤子", "fit": None, "silhouette": None}),
                                normalizer_version="rules-v1", review_state="pending", lifecycle="active"))
        db.commit()


def login(client):
    response = client.post("/api/v1/admin/login", json={"password": "synthetic-window-password"})
    assert response.status_code == 200, response.text


def get(client, path, params=None):
    response = client.get(f"/api/v1/admin/{path}", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def bounds(value, days=7):
    query = {"days": days, "window_end": value["window_end"]}
    if value["window_start"] is not None:
        query["window_start"] = value["window_start"]
    return query


def body(value):
    return {**bounds(value, value["days"]), "note": "人工核对全部合成窗口证据",
            "expected_occurrence_ids": value["expected_occurrence_ids"],
            "expected_revisions": value["expected_revisions"],
            "expected_evidence_digest": value["evidence_digest"]}


def assert_window(value, expected):
    assert value["window_start"] == expected["window_start"]
    assert value["window_end"] == expected["window_end"]


def test_default_seven_days_is_exact_168_hours_across_dates_and_half_open(client, clock):
    start = NOW - timedelta(hours=168)
    seed("before-start", start - timedelta(microseconds=1))
    seed("at-start", start)
    seed("before-end", NOW - timedelta(microseconds=1))
    seed("at-end", NOW)
    login(client)

    overview = get(client, "overview")
    assert overview["days"] == 7
    assert overview["window_start"] == "2026-10-02T23:17:43.123456Z"
    assert overview["window_end"] == "2026-10-09T23:17:43.123456Z"
    assert overview["counts"]["turns"] == overview["counts"]["occurrences"] == 2
    # Preserve exact non-midnight timestamps; do not substitute Beijing dates.
    expected_ids = {"at-start-occ", "before-end-occ"}
    query = bounds(overview)
    records = get(client, "turns", query)
    detail = get(client, f"groups/{GROUP}", {**query, "page_size": 1})
    last_page = get(client, f"groups/{GROUP}", {**query, "page": 2, "page_size": 1})
    baseline = get(client, f"groups/{GROUP}/approval-set", query)
    for value in (records, detail, last_page, baseline):
        assert_window(value, overview)
    assert {item["id"] for item in records["items"]} == {"at-start-turn", "before-end-turn"}
    assert detail["total"] == last_page["total"] == baseline["active_count"] == 2
    assert {item["id"] for item in detail["evidence"] + last_page["evidence"]} == expected_ids
    assert set(baseline["expected_occurrence_ids"]) == expected_ids


@pytest.mark.parametrize("days", [0, 7])
def test_fixed_refresh_and_approval_keep_cutoff_until_new_range_is_requested(client, clock, days):
    seed("old", NOW - timedelta(days=9))
    seed("current", NOW - timedelta(hours=1))
    seed("other-group", NOW - timedelta(minutes=30), "synthetic-other-window-group")
    login(client)
    first = get(client, "overview", {"days": days, "page_size": 1})
    query = bounds(first, days)
    baseline = get(client, f"groups/{GROUP}/approval-set", query)
    expected_ids = {"current-occ", "old-occ"} if days == 0 else {"current-occ"}
    assert (first["window_start"] is None) == (days == 0)
    assert set(baseline["expected_occurrence_ids"]) == expected_ids

    # The clock crosses UTC midnight while a consumer adds a later exchange.
    seed("later", NOW + timedelta(hours=1))
    clock["now"] = NOW + timedelta(hours=2)
    keys = []
    for page in (1, 2):
        fixed = get(client, "overview", {**query, "page": page, "page_size": 1})
        assert_window(fixed, first)
        assert fixed["counts"] == first["counts"]
        keys += [group["key"] for group in fixed["groups"]]
    assert len(set(keys)) == len(keys) == first["groups_total"] == 2
    fixed_turns = get(client, "turns", query)
    fixed_detail = get(client, f"groups/{GROUP}", {**query, "page_size": 1})
    fixed_baseline = get(client, f"groups/{GROUP}/approval-set", query)
    for value in (fixed_turns, fixed_detail, fixed_baseline):
        assert_window(value, first)
    assert "later-turn" not in {item["id"] for item in fixed_turns["items"]}
    assert fixed_detail["total"] == len(expected_ids)
    assert fixed_baseline == baseline

    approved = client.post(f"/api/v1/admin/groups/{GROUP}/approve", json=body(baseline))
    assert approved.status_code == 200, approved.text
    assert_window(approved.json()["metadata"], first)
    handoff = get(client, f'handoffs/{approved.json()["id"]}')
    assert_window(handoff["metadata"], first)
    assert {item["occurrence_id"] for item in handoff["payload"]["evidence"]} == expected_ids

    updated = get(client, "overview", {"days": days})
    assert updated["window_end"] == "2026-10-10T01:17:43.123456Z"
    assert updated["counts"]["turns"] == first["counts"]["turns"] + 1
    updated_baseline = get(client, f"groups/{GROUP}/approval-set", bounds(updated, days))
    assert set(updated_baseline["expected_occurrence_ids"]) == expected_ids | {"later-occ"}
    if days == 0:
        assert updated["window_start"] is None
    else:
        assert updated["window_start"] == "2026-10-03T01:17:43.123456Z"


def test_legacy_explicit_range_remains_exact_without_claiming_default_seven_days(client, clock):
    seed("within-day", NOW - timedelta(hours=1))
    seed("outside-day", NOW - timedelta(hours=25))
    login(client)
    exact = {"days": 7, "window_start": "2026-10-08T23:17:43.123456Z",
             "window_end": "2026-10-09T23:17:43.123456Z"}
    explicit = get(client, "overview", exact)
    assert_window(explicit, exact)
    assert explicit["counts"]["turns"] == 1
    # Compatibility permits an explicit one-day range; only the default query
    # is the official rolling seven-day selector.
    default = get(client, "overview", {"days": 7})
    assert default["counts"]["turns"] == 2
    assert default["window_start"] == "2026-10-02T23:17:43.123456Z"
