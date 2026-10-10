"""Persisted S1 rule regressions; synthetic evidence, no network or model calls.

These are engineering assertions, not owner quality scores. The three undecided
cases retain their previous conservative behavior instead of adopting draft gold.
"""
import json
import socket
import uuid

import pytest

from app.core.database import SessionLocal
from app.core.request_admission import admit_request
from app.models.chat import ChatMessage, ChatSession
from app.models.demand import DemandOccurrence, DemandOccurrenceRevision, DemandTurn
from app.services import demand


@pytest.fixture(autouse=True)
def isolated_offline_rules(monkeypatch):
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "0")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("RUNNINGHUB_API_KEY", "")
    monkeypatch.setenv("TUDOU_API_KEY", "")

    def reject_network(*args, **kwargs):
        raise AssertionError("Rule-only regression attempted network access")

    monkeypatch.setattr(socket.socket, "connect", reject_network)
    with SessionLocal() as db:
        for model in (DemandOccurrenceRevision, DemandOccurrence, DemandTurn):
            db.query(model).delete()
        db.commit()


def record(text, *, session="synthetic-rules-regression"):
    request_id = uuid.uuid4().hex
    assert demand.record_turn(session, request_id, text)
    with SessionLocal() as db:
        turn = db.query(DemandTurn).filter_by(request_id=request_id).one()
        rows = db.query(DemandOccurrence).filter_by(turn_id=turn.id).all()
        return turn, rows


def attributes(*, season=None, scene=None, category=None, fit=None, silhouette=None):
    return dict(season=season, scene=scene, category=category, fit=fit, silhouette=silhouette)


def assert_current_only(row, turn, expected):
    assert json.loads(row.attributes_json) == expected
    assert row.normalizer_version == "rules-v2"
    assert row.group_key == demand.group_key(expected, "rules-v2")
    assert json.loads(row.field_sources_json) == {
        field: [turn.id] for field, value in expected.items() if value is not None
    }
    assert json.loads(row.context_turn_ids_json) == []


def test_e17_explicit_separate_same_category_choices_keep_both_fits():
    turn, rows = record("我想分别看一条修身裤和一条紧身裤。")
    assert turn.status == "extracted"
    assert turn.error_code == ""
    assert turn.extractor == demand.EXTRACTOR_VERSION
    assert json.loads(turn.negative_json) == []
    assert len(rows) == 2
    assert len({row.group_key for row in rows}) == 2
    by_fit = {json.loads(row.attributes_json)["fit"]: row for row in rows}
    assert set(by_fit) == {"修身", "紧身"}
    for fit, row in by_fit.items():
        assert_current_only(row, turn, attributes(category="裤子", fit=fit))


def test_real_chat_admission_processing_stamps_new_extractor_version():
    request_id = uuid.uuid4().hex
    text = "我想分别看一条修身裤和一条紧身裤。"
    assert admit_request(request_id, "synthetic-chat-admission-rules", text, "", "") == "accepted"
    assert demand.process_admitted_turn(request_id)
    assert not demand.process_admitted_turn(request_id)
    assert admit_request(request_id, "synthetic-chat-admission-rules", text, "", "") == "duplicate"
    with SessionLocal() as db:
        turn = db.query(DemandTurn).filter_by(request_id=request_id).one()
        rows = db.query(DemandOccurrence).filter_by(turn_id=turn.id).all()
        assert turn.extractor == "rules-v2.1"
        assert turn.extractor == demand.EXTRACTOR_VERSION
        assert turn.status == "extracted"
        assert turn.extraction_attempts == 1
        assert json.loads(turn.negative_json) == []
        assert len(rows) == 2
        assert {json.loads(row.attributes_json)["fit"] for row in rows} == {"修身", "紧身"}
        for row in rows:
            assert_current_only(row, turn, attributes(category="裤子", fit=json.loads(row.attributes_json)["fit"]))


def test_explicit_legacy_failed_retry_updates_version_but_completed_history_stays_old():
    request_id = uuid.uuid4().hex
    old_completed, _ = record("想要紧身裤。")
    failed_id = uuid.uuid4().hex
    with SessionLocal() as db:
        # Only isolated synthetic fixtures are labelled as preserved legacy rows.
        db.get(DemandTurn, old_completed.id).extractor = "rules-v2"
        db.add(DemandTurn(
            id=failed_id, request_id=request_id, session_id="synthetic-legacy-failed-retry",
            text="想要宽松裤。", status="extraction_failed", extractor="rules-v2",
            error_code="EXTRACTION_RULE_ERROR", extraction_attempts=1,
        ))
        db.commit()
    assert not demand.process_admitted_turn(old_completed.request_id)
    with SessionLocal() as db:
        assert db.get(DemandTurn, old_completed.id).extractor == "rules-v2"
    result = demand.retry_failed_turn(failed_id)
    assert result["status"] == "extracted"
    assert result["extraction_attempts"] == 2
    with SessionLocal() as db:
        retried = db.get(DemandTurn, failed_id)
        assert retried.extractor == "rules-v2.1"
        assert retried.extractor == demand.EXTRACTOR_VERSION
        rows = db.query(DemandOccurrence).filter_by(turn_id=failed_id).all()
        assert len(rows) == 1
        assert_current_only(rows[0], retried, attributes(category="裤子", fit="宽松"))
        assert db.get(DemandTurn, old_completed.id).extractor == "rules-v2"


@pytest.mark.parametrize("text", [
    "我想分别要一条修身裤和一条紧身裤。",
    "我想分别要修身裤，以及紧身裤。",
])
def test_separate_word_has_same_meaning_across_conjunctions(text):
    turn, rows = record(text)
    assert turn.status == "extracted"
    assert json.loads(turn.negative_json) == []
    assert len(rows) == 2
    assert {json.loads(row.attributes_json)["fit"] for row in rows} == {"修身", "紧身"}
    for row in rows:
        assert_current_only(row, turn, attributes(category="裤子", fit=json.loads(row.attributes_json)["fit"]))


def test_separate_repeated_same_group_still_counts_once():
    turn, rows = record("我想分别看一条宽松裤和一条宽松裤。")
    assert turn.status == "extracted"
    assert json.loads(turn.negative_json) == []
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="裤子", fit="宽松"))


@pytest.mark.parametrize("text", [
    "我想要特别宽松的裤子。",
    "我想要有区别的宽松裤子。",
    "我想要个别宽松裤子。",
    "我想分别要宽松裤子和宽松裤子。",
])
def test_ordinary_words_containing_bie_are_not_negation(text):
    turn, rows = record(text)
    assert turn.status == "extracted"
    assert json.loads(turn.negative_json) == []
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="裤子", fit="宽松"))


@pytest.mark.parametrize("text", ["别穿紧身裤。", "别买紧身裤。", "别要紧身裤。"])
def test_real_bie_commands_remain_negative(text):
    turn, rows = record(text)
    assert turn.status == "negative_preference"
    assert rows == []
    negative = json.loads(turn.negative_json)
    assert len(negative) == 1
    assert negative[0]["attributes"] == attributes(category="裤子", fit="紧身")


def test_e18_two_postposed_negative_preferences_both_persist():
    turn, rows = record("紧身裤我不要，修身上衣也不要。")
    assert turn.status == "negative_preference"
    assert turn.error_code == ""
    assert rows == []
    negative = json.loads(turn.negative_json)
    assert len(negative) == 2
    assert {item["text"] for item in negative} == {"紧身裤我不要", "修身上衣也不要"}
    assert {json.dumps(item["attributes"], sort_keys=True) for item in negative} == {
        json.dumps(attributes(category="裤子", fit="紧身"), sort_keys=True),
        json.dumps(attributes(category="上衣", fit="修身"), sort_keys=True),
    }


@pytest.mark.parametrize("text", [
    "不要紧身裤，别推荐修身上衣。",
    "紧身裤不要，修身上衣也不要。",
    "紧身裤都不要，修身上衣我也不要。",
    "紧身裤我也不要，修身上衣也不想要。",
    "我不喜欢紧身裤，也不喜欢修身上衣。",
])
def test_negative_prefix_suffix_also_and_all_preserve_each_item(text):
    turn, rows = record(text)
    assert turn.status == "negative_preference"
    assert rows == []
    negative = json.loads(turn.negative_json)
    assert len(negative) == 2
    assert {(item["attributes"]["category"], item["attributes"]["fit"]) for item in negative} == {
        ("裤子", "紧身"), ("上衣", "修身")
    }
    assert all(item["attributes"]["season"] is None and item["attributes"]["scene"] is None
               and item["attributes"]["silhouette"] is None for item in negative)


def test_negative_and_positive_separate_clauses_never_cross_contaminate():
    turn, rows = record("别给我紧身裤，想要宽松阔腿裤。")
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="裤子", fit="宽松", silhouette="阔腿"))
    assert [item["attributes"] for item in json.loads(turn.negative_json)] == [
        attributes(category="裤子", fit="紧身")
    ]


@pytest.mark.parametrize("text", [
    "你推荐的冬季运动紧身裤是什么面料？",
    "你推荐的秋季通勤阔腿裤是什么材质？",
    "我想了解你推荐的紧身裤是什么面料？",
])
def test_e19_existing_product_material_query_adds_no_demand(text):
    turn, rows = record(text)
    assert turn.status == "no_explicit_demand"
    assert turn.error_code == ""
    assert rows == []
    assert json.loads(turn.negative_json) == []


@pytest.mark.parametrize("text", [
    "你推荐的冬季运动紧身裤是什么面料？我想要宽松上衣。",
    "我想要宽松上衣，你推荐的冬季运动紧身裤是什么面料？",
    "你推荐的冬季运动紧身裤是什么材质；我想买宽松上衣。",
])
def test_material_query_does_not_hide_or_pollute_explicit_new_request(text):
    turn, rows = record(text)
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="上衣", fit="宽松"))
    assert json.loads(turn.negative_json) == []


def test_actual_product_recommendation_request_remains_positive():
    turn, rows = record("帮我推荐冬季运动紧身裤。")
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(
        season="冬", scene="运动", category="裤子", fit="紧身"))
    assert json.loads(turn.negative_json) == []


def test_explicit_breathable_material_preference_keeps_supported_dimensions_only():
    turn, rows = record("我想要面料透气的宽松裤子。")
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="裤子", fit="宽松"))
    assert json.loads(turn.negative_json) == []


def test_descriptive_separately_word_cannot_split_single_product_conflict():
    turn, rows = record("这两种版型的名字分别是修身和紧身，我想要一条修身裤，这同一条裤子也要紧身。")
    assert turn.status == "needs_review"
    assert turn.error_code == "CONFLICTING_DIMENSIONS"
    assert rows == []
    assert json.loads(turn.negative_json) == []


def test_separate_request_cannot_dissolve_later_single_object_conflict():
    turn, rows = record("我想分别看一条修身裤和一条紧身裤；我还想要另一条宽松裤，这同一条裤子也要紧身。")
    assert turn.status == "needs_review"
    assert turn.error_code == "CONFLICTING_DIMENSIONS"
    assert rows == []
    assert json.loads(turn.negative_json) == []


def test_later_same_object_compatible_dimension_reuses_its_request_bucket():
    turn, rows = record("我想分别看一条修身裤和一条紧身裤；我还想要另一条宽松裤，这同一条裤子也要阔腿。")
    assert turn.status == "extracted"
    assert turn.error_code == ""
    assert json.loads(turn.negative_json) == []
    assert len(rows) == 3
    by_fit = {json.loads(row.attributes_json)["fit"]: row for row in rows}
    assert set(by_fit) == {"修身", "紧身", "宽松"}
    for fit in ("修身", "紧身"):
        assert_current_only(by_fit[fit], turn, attributes(category="裤子", fit=fit))
    assert_current_only(by_fit["宽松"], turn, attributes(category="裤子", fit="宽松", silhouette="阔腿"))


@pytest.mark.parametrize("text", [
    "我要一条裤子，必须宽松，也必须紧身，两项要在同一条裤子上同时满足。",
    "我想要一条修身又紧身裤。",
])
def test_single_product_incompatible_fits_still_need_review(text):
    turn, rows = record(text)
    assert turn.status == "needs_review"
    assert turn.error_code == "CONFLICTING_DIMENSIONS"
    assert rows == []


def test_e11_undecided_unknown_category_retains_review_status():
    turn, rows = record("我想要一件云泡斗篷，具体算上衣还是裙子我还没确定。")
    assert turn.status == "needs_review"
    assert turn.error_code == "UNRESOLVED_CATEGORY"
    assert rows == []


def test_e20_undecided_trouser_leg_supplement_keeps_previous_conservative_sources():
    session = "synthetic-undecided-trouser-leg"
    _, prior = record("秋天通勤我要宽松裤子。", session=session)
    with SessionLocal() as db:
        db.add(ChatSession(id=session))
        db.add(ChatMessage(session_id=session, role="assistant", content="可以换成冬季运动的修身上衣。"))
        db.commit()
    turn, rows = record("裤脚要收口。", session=session)
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(category="裤子", silhouette="收口"))
    with SessionLocal() as db:
        assert json.loads(db.get(DemandOccurrence, prior[0].id).attributes_json) == attributes(
            season="秋", scene="通勤", category="裤子", fit="宽松")


def test_e22_excluded_context_without_new_object_retains_review_status():
    _, prior = record("冬天运动想要紧身裤。")
    with SessionLocal() as db:
        row = db.get(DemandOccurrence, prior[0].id)
        row.lifecycle = "excluded"
        row.review_state = "rejected"
        db.commit()
    turn, rows = record("再宽松一点。")
    assert turn.status == "needs_review"
    assert turn.error_code == "UNRESOLVED_CATEGORY"
    assert rows == []
    with SessionLocal() as db:
        row = db.get(DemandOccurrence, prior[0].id)
        assert row.lifecycle == "excluded"
        assert row.review_state == "rejected"
        assert row.revision == 1


def test_unrelated_excluded_source_does_not_block_self_contained_new_evidence():
    _, prior = record("冬天运动想要紧身裤。")
    with SessionLocal() as db:
        row = db.get(DemandOccurrence, prior[0].id)
        row.lifecycle = "excluded"
        row.review_state = "rejected"
        db.commit()
    turn, rows = record("夏天居家，我想要宽松收口裤。")
    assert turn.status == "extracted"
    assert len(rows) == 1
    assert_current_only(rows[0], turn, attributes(
        season="夏", scene="居家", category="裤子", fit="宽松", silhouette="收口"))


def test_d3_closed_retraction_never_changes_prior_occurrence():
    _, prior = record("想要紧身裤。")
    before = {field: getattr(prior[0], field) for field in (
        "attributes_json", "field_sources_json", "group_key", "lifecycle", "review_state", "revision")}
    turn, rows = record("刚才不要了，改成宽松裤。")
    assert turn.status == "needs_review"
    assert turn.error_code == "RETRACTION_PENDING_POLICY"
    assert rows == []
    with SessionLocal() as db:
        old = db.get(DemandOccurrence, prior[0].id)
        assert {field: getattr(old, field) for field in before} == before
        assert db.query(DemandOccurrenceRevision).count() == 0


def test_ordinary_same_session_user_supplement_still_inherits_original_sources():
    first, _ = record("秋天通勤想要阔腿裤。")
    second, rows = record("再宽松一点。")
    assert second.status == "extracted"
    assert len(rows) == 1
    assert json.loads(rows[0].attributes_json) == attributes(
        season="秋", scene="通勤", category="裤子", fit="宽松", silhouette="阔腿")
    assert json.loads(rows[0].field_sources_json) == {
        "season": [first.id], "scene": [first.id], "category": [first.id],
        "fit": [second.id], "silhouette": [first.id],
    }
    assert json.loads(rows[0].context_turn_ids_json) == [first.id]
