"""PRD v1.6 S1 rule behavior, with synthetic dialogue and isolated test DB."""
import json
import uuid

import pytest

from app.core.database import SessionLocal
from app.models.chat import ChatMessage, ChatSession
from app.models.demand import DemandOccurrence, DemandOccurrenceRevision, DemandTurn
from app.services import demand


@pytest.fixture(autouse=True)
def isolated_demands(monkeypatch):
    monkeypatch.delenv("STYLING_DEMAND_D3_ENABLED", raising=False)
    with SessionLocal() as db:
        for model in (DemandOccurrenceRevision, DemandOccurrence, DemandTurn):
            db.query(model).delete()
        db.commit()


def record(text, session="synthetic-s1", request=None):
    assert demand.record_turn(session, request or uuid.uuid4().hex, text)
    with SessionLocal() as db:
        turn = db.query(DemandTurn).filter_by(session_id=session).order_by(DemandTurn.created_at.desc()).first()
        rows = db.query(DemandOccurrence).filter_by(turn_id=turn.id).all()
        return turn, rows


def test_ac01_five_dimensions_null_unknown_and_versioned_group():
    turn, rows = record("秋天通勤想要宽松阔腿裤")
    assert turn.status == "extracted"
    assert turn.extractor == "rules-v2.1"
    assert turn.extraction_attempts == 1
    assert len(rows) == 1
    attrs = json.loads(rows[0].attributes_json)
    assert attrs == {"season": "秋", "scene": "通勤", "category": "裤子", "fit": "宽松", "silhouette": "阔腿"}
    assert json.loads(rows[0].field_sources_json) == {field: [turn.id] for field in demand.FIELDS}
    unknown = demand.extract("想要裤子")[0]["attributes"]
    assert unknown == {"season": None, "scene": None, "category": "裤子", "fit": None, "silhouette": None}
    assert demand.group_key(unknown, "rules-v1") != demand.group_key(unknown, "rules-v2")


def test_ac03_request_idempotence_and_conflicting_duplicate_preserve_evidence():
    original, _ = record("想要阔腿裤", request="synthetic-fixed")
    assert not demand.record_turn("synthetic-s1", "synthetic-fixed", "想要阔腿裤")
    assert not demand.record_turn("other-session", "synthetic-fixed", "想要紧身裤")
    record("想要阔腿裤")
    with SessionLocal() as db:
        assert db.query(DemandTurn).count() == 2
        assert db.query(DemandOccurrence).count() == 2
        assert db.get(DemandTurn, original.id).text == "想要阔腿裤"


def test_ac04_multicategory_duplicates_do_not_contaminate_dimensions():
    turn, rows = record("想要通勤阔腿裤，再配运动鞋，阔腿裤")
    assert turn.status == "extracted"
    assert len(rows) == 2
    attrs = {json.loads(row.attributes_json)["category"]: json.loads(row.attributes_json) for row in rows}
    assert attrs["裤子"]["scene"] == "通勤"
    assert attrs["裤子"]["silhouette"] == "阔腿"
    assert attrs["鞋履"]["scene"] is None
    assert attrs["鞋履"]["silhouette"] is None
    separate = demand.extract("想要宽松上衣，还有修身裤子")
    assert separate[0]["attributes"]["category"] == "裤子"
    assert separate[0]["attributes"]["fit"] == "修身"
    assert separate[1]["attributes"]["fit"] == "宽松"


def test_ac05_synonyms_and_distinct_fit_are_separate():
    assert demand.extract("阔腿裤")[0]["group_key"] == demand.extract("宽腿裤")[0]["group_key"]
    assert demand.extract("修身裤")[0]["group_key"] != demand.extract("紧身裤")[0]["group_key"]
    assert demand.extract("宽松裤")[0]["attributes"]["silhouette"] is None
    assert demand.extract("阔腿裤")[0]["attributes"]["fit"] is None


def test_ac06_negation_retained_not_counted():
    turn, rows = record("不要紧身裤，想要宽松阔腿裤")
    assert len(rows) == 1
    assert json.loads(rows[0].attributes_json)["fit"] == "宽松"
    negative = json.loads(turn.negative_json)
    assert negative[0]["text"] == "不要紧身裤"
    assert negative[0]["attributes"]["fit"] == "紧身"
    turn, rows = record("不要紧身裤")
    assert turn.status == "negative_preference"
    assert len(rows) == 0
    assert demand.extract("紧身裤不要") == []


def test_ac07_cross_round_user_sources_and_no_repeat():
    first, original = record("秋天通勤要阔腿裤")
    original_attrs = json.loads(original[0].attributes_json)
    second, supplemented = record("再宽松一点")
    assert second.status == "extracted"
    assert len(supplemented) == 1
    attrs = json.loads(supplemented[0].attributes_json)
    assert attrs == {**original_attrs, "fit": "宽松"}
    assert json.loads(supplemented[0].context_turn_ids_json) == [first.id]
    sources = json.loads(supplemented[0].field_sources_json)
    assert sources["fit"] == [second.id]
    assert all(sources[field] == [first.id] for field in ("season", "scene", "category", "silhouette"))
    last, rows = record("谢谢，展示图片")
    assert last.status == "no_explicit_demand"
    assert rows == []
    with SessionLocal() as db:
        assert json.loads(db.get(DemandOccurrence, original[0].id).attributes_json) == original_attrs
        assert db.query(DemandTurn).count() == 3
        assert db.query(DemandOccurrence).count() == 2


def test_assistant_and_other_session_never_supply_context():
    record("秋天通勤要阔腿裤", session="different-user")
    with SessionLocal() as db:
        db.add(ChatSession(id="assistant-only"))
        db.add(ChatMessage(session_id="assistant-only", role="assistant", content="建议秋天通勤阔腿裤"))
        db.commit()
    turn, rows = record("再宽松一点", session="assistant-only")
    assert turn.status == "needs_review"
    assert turn.error_code == "UNRESOLVED_CATEGORY"
    assert rows == []


def test_ambiguous_multicategory_context_not_guessed():
    record("想要上衣和裤子")
    turn, rows = record("再宽松一点")
    assert turn.status == "needs_review"
    assert turn.error_code == "AMBIGUOUS_CONTEXT"
    assert rows == []


@pytest.mark.parametrize("text,error", [
    ("我想要宽松又紧身裤", "CONFLICTING_DIMENSIONS"),
    ("秋天冬天想要裤子", "CONFLICTING_DIMENSIONS"),
    ("我想要某种未知的产品", "UNRESOLVED_CATEGORY"),
])
def test_ac09_uncertain_or_conflicting_is_review_not_heat(text, error):
    turn, rows = record(text)
    assert turn.status == "needs_review"
    assert turn.error_code == error
    assert rows == []


@pytest.mark.parametrize("failure,code", [
    (TimeoutError("sensitive timeout detail"), "EXTRACTION_TIMEOUT"),
    (RuntimeError("sensitive rule detail"), "EXTRACTION_RULE_ERROR"),
])
def test_execution_failure_is_distinct_finite_and_durable(monkeypatch, failure, code):
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise failure
    monkeypatch.setattr(demand, "extract", fail)
    turn, rows = record("想要阔腿裤", request="synthetic-failure")
    assert len(calls) == 2
    assert turn.status == "extraction_failed"
    assert turn.error_code == code
    assert turn.extraction_attempts == 2
    assert rows == []
    assert "sensitive" not in turn.error_code
    assert not demand.record_turn("synthetic-s1", "synthetic-failure", "想要阔腿裤")
    assert len(calls) == 2


def test_format_failure_not_no_demand_and_retry_success_same_dialogue(monkeypatch):
    real = demand.extract
    monkeypatch.setattr(demand, "extract", lambda *args, **kwargs: [{"attributes": {}}])
    turn, _ = record("想要阔腿裤")
    assert turn.status == "extraction_failed"
    assert turn.error_code == "EXTRACTION_FORMAT_ERROR"
    monkeypatch.setattr(demand, "extract", real)
    result = demand.retry_failed_turn(turn.id)
    assert result["status"] == "extracted"
    assert result["extraction_attempts"] == 3
    with SessionLocal() as db:
        assert db.query(DemandTurn).count() == 1
        assert db.query(DemandOccurrence).count() == 1
    with pytest.raises(ValueError, match="TURN_NOT_RETRYABLE"):
        demand.retry_failed_turn(turn.id)


def test_explicit_retry_budget_cannot_be_extended(monkeypatch):
    monkeypatch.setattr(demand, "extract", lambda *args, **kwargs: "invalid-format")
    turn, _ = record("想要裤子")
    result = demand.retry_failed_turn(turn.id)
    assert result["status"] == "extraction_failed"
    assert result["extraction_attempts"] == 4
    with pytest.raises(ValueError, match="EXTRACTION_RETRY_LIMIT"):
        demand.retry_failed_turn(turn.id)
    assert demand.retry_failed_turn("missing-turn") is None


def test_one_transient_exception_then_success_has_one_occurrence(monkeypatch):
    real = demand.extract
    calls = []
    def transient(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError("temporary")
        return real(*args, **kwargs)
    monkeypatch.setattr(demand, "extract", transient)
    turn, rows = record("想要阔腿裤")
    assert turn.status == "extracted"
    assert turn.extraction_attempts == 2
    assert turn.error_code == ""
    assert len(rows) == 1


def test_ac08_d3_default_off_preserves_old_heat_and_requires_review():
    first, rows = record("想要紧身裤")
    turn, replacement = record("刚才不要了，改成宽松裤")
    assert turn.status == "needs_review"
    assert turn.error_code == "RETRACTION_PENDING_POLICY"
    assert replacement == []
    with SessionLocal() as db:
        assert db.get(DemandOccurrence, rows[0].id).lifecycle == "active"
        assert db.get(DemandOccurrence, rows[0].id).revision == 1


def test_ac08_confirmed_policy_gate_retracts_only_same_session(monkeypatch):
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "1")
    _, other = record("想要紧身裤", session="other-user")
    first, original = record("想要紧身裤")
    turn, replacement = record("刚才不要了，改成宽松裤")
    assert turn.status == "extracted"
    assert len(replacement) == 1
    with SessionLocal() as db:
        old = db.get(DemandOccurrence, original[0].id)
        assert old.lifecycle == "retracted"
        assert old.revision == 2
        assert turn.id in old.reason
        assert db.get(DemandOccurrence, other[0].id).lifecycle == "active"
        history = db.query(DemandOccurrenceRevision).filter_by(occurrence_id=old.id).order_by(DemandOccurrenceRevision.revision).all()
        assert [row.revision for row in history] == [1, 2]
        assert json.loads(history[0].snapshot_json)["lifecycle"] == "active"
        assert json.loads(history[1].snapshot_json)["lifecycle"] == "retracted"
        assert json.loads(db.get(DemandOccurrence, replacement[0].id).attributes_json)["fit"] == "宽松"


def test_manual_retry_never_borrows_later_same_session_user_turn(monkeypatch):
    real = demand.extract
    monkeypatch.setattr(demand, "extract", lambda *args, **kwargs: "invalid-format")
    failed, _ = record("再宽松一点")
    monkeypatch.setattr(demand, "extract", real)
    record("秋天通勤要阔腿裤")
    result = demand.retry_failed_turn(failed.id)
    assert result["status"] == "needs_review"
    assert result["error_code"] == "UNRESOLVED_CATEGORY"
    with SessionLocal() as db:
        assert db.query(DemandOccurrence).filter_by(turn_id=failed.id).count() == 0


def test_confirmed_policy_unambiguous_withdrawal_without_replacement(monkeypatch):
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "1")
    _, original = record("想要紧身裤")
    withdrawn, rows = record("取消刚才的需求")
    assert withdrawn.status == "negative_preference"
    assert rows == []
    with SessionLocal() as db:
        assert db.get(DemandOccurrence, original[0].id).lifecycle == "retracted"


@pytest.mark.parametrize("text", [
    "紧身裤不想要", "阔腿裤不适合我", "裤子不喜欢",
    "我已经有阔腿裤了", "我的裤子坏了", "只看看裤子，顺便买菜",
    "阔腿裤多少钱", "阔腿裤价格", "紧身裤库存多少", "宽松裤有货吗",
    "裤子订单到哪了", "裤子物流怎么查", "推荐阔腿裤的尺码", "裤子尺码怎么选",
])
def test_readonly_mentions_and_postposed_negations_never_add_heat(text):
    turn, rows = record(text)
    assert rows == []
    assert turn.status in {"negative_preference", "no_explicit_demand"}


def test_sports_shoe_compound_is_not_sports_scene():
    assert demand.extract("想要运动鞋")[0]["attributes"]["scene"] is None
    assert demand.extract("健身时想要鞋子")[0]["attributes"]["scene"] == "运动"


def test_durable_admitted_turn_processes_exactly_once():
    with SessionLocal() as db:
        turn = DemandTurn(id="admitted-turn", request_id="admitted-request", session_id="synthetic-s1",
                          text="想要阔腿裤", status="extraction_failed", extractor="rules-v2",
                          error_code="EXTRACTION_INTERRUPTED", extraction_attempts=0)
        db.add(turn)
        db.commit()
    assert demand.process_admitted_turn("admitted-request")
    assert not demand.process_admitted_turn("admitted-request")
    assert not demand.process_admitted_turn("missing-request")
    with SessionLocal() as db:
        assert db.query(DemandTurn).count() == 1
        assert db.query(DemandOccurrence).count() == 1
        assert db.get(DemandTurn, "admitted-turn").status == "extracted"


def test_interrupted_admission_is_durable_and_manager_recoverable():
    with SessionLocal() as db:
        db.add(DemandTurn(id="restart-turn", request_id="restart-request", session_id="synthetic-s1",
                          text="想要裤子", status="extraction_failed", extractor="rules-v2",
                          error_code="EXTRACTION_INTERRUPTED", extraction_attempts=0))
        db.commit()
    result = demand.retry_failed_turn("restart-turn")
    assert result["status"] == "extracted"
    assert result["extraction_attempts"] == 1
    assert not demand.process_admitted_turn("restart-request")


def test_legacy_rejected_active_projection_is_not_user_context():
    _, rejected = record("秋天通勤想要阔腿裤")
    with SessionLocal() as db:
        row = db.get(DemandOccurrence, rejected[0].id)
        row.review_state = "rejected"
        row.lifecycle = "active"  # Pre-migration projection must still stay excluded.
        db.commit()
    turn, rows = record("再宽松一点")
    assert turn.status == "needs_review"
    assert rows == []


@pytest.mark.parametrize("field,value", [("field_sources_json", "[]"), ("attributes_json", "[]"),
                                          ("field_sources_json", '{"fit":[{}]}')])
def test_malformed_context_stays_durable_failed_format(field, value):
    _, original = record("想要裤子")
    with SessionLocal() as db:
        setattr(db.get(DemandOccurrence, original[0].id), field, value)
        db.commit()
    turn, rows = record("再宽松一点")
    assert turn.status == "extraction_failed"
    assert turn.error_code == "EXTRACTION_CONTEXT_FORMAT_ERROR"
    assert rows == []


def test_new_multicategory_turn_does_not_borrow_old_season_from_unrelated_supplement():
    record("秋天通勤想要阔腿裤")
    _, rows = record("想要通勤阔腿裤，再配运动鞋")
    assert len(rows) == 2
    assert all(json.loads(row.attributes_json)["season"] is None for row in rows)
    assert all(json.loads(row.context_turn_ids_json) == [] for row in rows)


def test_new_explicit_request_with_view_action_or_local_addition_is_independent():
    record("秋天通勤想要阔腿裤")
    _, rows = record("想要裤子，再看看图片")
    assert len(rows) == 1
    assert json.loads(rows[0].attributes_json)["season"] is None
    _, rows = record("想要阔腿裤，再宽松一点")
    assert len(rows) == 1
    attrs = json.loads(rows[0].attributes_json)
    assert attrs["fit"] == "宽松"
    assert attrs["season"] is None
