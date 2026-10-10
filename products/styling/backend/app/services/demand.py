"""Auditable, conservative demand rules; no model calls or market-value claims.

Only DemandTurn user evidence in the current database/session can supply context.
New rules are versioned separately from preserved historical rows.
"""
import hashlib
import json
import os
import re
import uuid

from sqlalchemy.exc import IntegrityError

from app.core.database import SessionLocal
from app.core.demand_versions import EXTRACTOR_VERSION, NORMALIZER_VERSION
from app.models.demand import DemandOccurrence, DemandOccurrenceRevision, DemandTurn
from app.services.signals import desensitize

FIELDS = ("season", "scene", "category", "fit", "silhouette")
MAX_AUTO_ATTEMPTS = 2
MAX_TOTAL_ATTEMPTS = 4
DICTIONARY = {
    "season": {"春": ["春天", "春季"], "夏": ["夏天", "夏季"], "秋": ["秋天", "秋季"], "冬": ["冬天", "冬季"]},
    "scene": {"通勤": ["通勤", "上班", "办公室"], "出游": ["出游", "旅行", "旅游"], "运动": ["运动", "健身"], "约会聚会": ["约会", "聚会"], "居家": ["居家", "在家"]},
    "category": {"裤子": ["裤子", "裤", "下装"], "上衣": ["上衣", "上装", "衬衫", "T恤", "外套"], "鞋履": ["鞋", "鞋履"], "裙子": ["裙子", "裙"]},
    "fit": {"宽松": ["宽松", "宽宽松松"], "修身": ["修身"], "紧身": ["紧身", "紧贴"]},
    "silhouette": {"阔腿": ["阔腿", "宽腿"], "收口": ["收口", "收紧", "束脚"], "直筒": ["直筒"]},
}
_NEGATION = re.compile(r"不要|不想|不需要|不喜欢|不穿|不买|不考虑|拒绝|避免|(?<![分区特个类性])别|不能|不适合|不是|不好看|不合适")
_TRANSITION = re.compile(r"但是|不过|而是|换成|改成|再配|(?<!不)(?:想要|需要|喜欢)")
_INTENT = re.compile(r"想|要|需要|希望|推荐|找|买|换|穿|喜欢|来一|帮我|配|选")
_NEW_DEMAND = re.compile(r"(?<!不)(?:想要|需要|希望|推荐|找|买|换|穿|喜欢|来一|帮我搭|帮我配|再配)")
_READ_QUERY = re.compile(r"多少钱|价格|库存|有货|订单|物流|尺码|什么码|多大码|(?:什么|哪种|啥)(?:面料|材质)|(?:面料|材质)(?:是什么|是啥|如何|怎么|哪种|好不好|吗|呢|[？?])")
_SEPARATE_REQUEST = re.compile(r"(?<!不)(?:想|希望|需要|要)分别(?:看|要|选|找|买|推荐|搭|配)")
_SAME_OBJECT = re.compile(r"同一(?:条|件|双|个)")
_REQUEST = re.compile(r"想要|(?<!不)需要|希望|推荐|找|买|换|喜欢|来一|帮我|再配|(?<!不)要|穿一|穿上")
_VIEW = re.compile(r"谢谢|展示|看看|看下|看一下|看一眼|图片|照片|上传|导出|发送|批准|保存|下载")
_SUPPLEMENT = re.compile(r"再|更|一点|改|换|刚才|之前|这条|那条|还是")
_RETRACTION = re.compile(r"刚才不要了|之前不要了|(?:撤回|取消)(?:刚才|之前|前面)?(?:的)?(?:需求|要求)|(?:刚才|之前|前面)(?:的)?.{0,12}(?:不要了|不需要了)")
_SPLIT = re.compile(r"[，。；、,;！？!\n]|还有|以及|再配|搭配|然后|同时|但是|不过|而是|和")


class ExtractionResult(list):
    """List-compatible public result with safe dialogue-level classification."""
    def __init__(self, items=(), *, status="no_explicit_demand", error_code="", negatives=None, retract_target=None):
        super().__init__(items)
        self.status = status
        self.error_code = error_code
        self.negatives = negatives or []
        self.retract_target = retract_target


def group_key(attributes: dict, version: str = NORMALIZER_VERSION) -> str:
    payload = {field: attributes.get(field) or None for field in FIELDS}
    payload["normalizer_version"] = version
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _is_negative(clause: str, start: int, end: int) -> bool:
    prefix = _TRANSITION.split(clause[:start])[-1]
    if _NEGATION.search(prefix):
        return True
    # Also preserve ordinary Chinese postposed negation: “紧身裤不要”.
    suffix = clause[end:]
    return bool(re.match(r"(?:子|裤子|裤|上衣|鞋履|鞋|裙子|裙)?(?:的)?(?:我)?(?:也|都)?(?:不要|不想|不喜欢|不穿|不买|不需要|不适合|不是|不好看|不合适)", suffix))


def _values(clause: str, field: str, negative: bool = False) -> list[str]:
    values = []
    for value, terms in DICTIONARY[field].items():
        if any(_is_negative(clause, match.start(), match.end()) == negative
               for term in terms for match in re.finditer(re.escape(term), clause, re.I)
               if not (field == "scene" and value == "运动" and re.match(r"鞋|裤|衣|衫|风", clause[match.end():]))):
            values.append(value)
    return values


def _positive(text: str, terms: list[str]) -> bool:
    """Compatibility helper; polarity is evaluated inside each clause."""
    return any(not _is_negative(clause, match.start(), match.end())
               for clause in _SPLIT.split(text) for term in terms
               for match in re.finditer(re.escape(term), clause, re.I))


def _has_local_demand(clause: str) -> bool:
    # Product questions and viewing/ownership mentions are not purchase preferences.
    if (_VIEW.search(clause) or _READ_QUERY.search(clause)) and not re.search(
            r"想要|想买|要一|买一|换成|改成|推荐.*(?:搭|配)|帮我搭|帮我配", clause):
        return False
    if _REQUEST.search(clause) or _SEPARATE_REQUEST.search(clause):
        return True
    # A bare supported product phrase is the direct shorthand used by AC-05.
    rest = clause
    for fields in DICTIONARY.values():
        for terms in fields.values():
            for term in sorted(terms, key=len, reverse=True):
                rest = re.sub(re.escape(term), "", rest, flags=re.I)
    rest = re.sub(r"一条|一件|一双|的|又|且|再|更|一点|[ /\s]", "", rest)
    return not rest


def _item(attributes: dict, sources: dict, current_turn_id: str | None) -> dict:
    title = "".join([attributes["season"] + "季" if attributes["season"] else "",
                     attributes["scene"] or "", attributes["fit"] or "",
                     attributes["silhouette"] or "", attributes["category"] or ""])
    refs = sorted({ref for values in sources.values() for ref in values if ref != current_turn_id})
    return {"group_key": group_key(attributes), "title": title,
            "description": f"用户明确表达：{title}。未明确的属性为未知，需人工核对。",
            "attributes": attributes, "normalizer_version": NORMALIZER_VERSION,
            "field_sources": sources, "context_turn_ids": refs}


def extract(text: str, *, context: list[dict] | None = None, turn_id: str | None = None) -> list[dict]:
    """Extract explicit dimensions. Unknown dimensions are null, never inferred.

    context is supplied solely by the same-session persisted user evidence loader.
    Public callers without a turn ID receive empty provenance, useful for pure tests.
    """
    clauses = [clause.strip() for clause in _SPLIT.split(text) if clause.strip()]
    negatives = []
    for clause in clauses:
        if _NEGATION.search(clause):
            attrs = {field: (_values(clause, field, True) or [None])[0] for field in FIELDS}
            if any(attrs.values()):
                negatives.append({"text": clause, "attributes": attrs})
    if (_VIEW.search(text) or _READ_QUERY.search(text)) and not _NEW_DEMAND.search(text):
        return ExtractionResult(negatives=negatives, status="negative_preference" if negatives else "no_explicit_demand")
    explicit_retraction = bool(_RETRACTION.search(text))
    if explicit_retraction and os.getenv("STYLING_DEMAND_D3_ENABLED") != "1":
        return ExtractionResult(status="needs_review", error_code="RETRACTION_PENDING_POLICY", negatives=negatives)

    # A consultation must not supply dimensions to another explicit request.
    clauses = [clause for clause in clauses
               if not _READ_QUERY.search(clause) or _has_local_demand(clause)]
    if not clauses:
        return ExtractionResult(status="negative_preference" if negatives else "no_explicit_demand", negatives=negatives)
    demand_text = "，".join(clauses)
    categories = [value for value in DICTIONARY["category"]
                  if any(_has_local_demand(c) and value in _values(c, "category") for c in clauses)]
    by_category = {value: {field: [] for field in FIELDS} for value in categories}
    separate_requests = bool(_SEPARATE_REQUEST.search(demand_text))
    separate_buckets = []
    global_fields = {field: [] for field in FIELDS}
    seen_category = False
    last_buckets = []
    for clause in clauses:
        local_categories = [value for value in _values(clause, "category")
                            if value in by_category and _has_local_demand(clause)]
        if local_categories:
            seen_category = True
            previous_buckets = last_buckets
            last_buckets = []
            same_object = separate_requests and _SAME_OBJECT.search(clause)
            if same_object and (len(local_categories) != 1 or len(previous_buckets) != 1 or
                                previous_buckets[0][0] != local_categories[0]):
                return ExtractionResult(status="needs_review", error_code="AMBIGUOUS_CONTEXT", negatives=negatives)
            for category in local_categories:
                if same_object:
                    # Explicit same-object continuation reuses the current object;
                    # compatible fields merge and the existing conflict check applies.
                    bucket = previous_buckets[0][1]
                else:
                    bucket = {field: [] for field in FIELDS} if separate_requests else by_category[category]
                if separate_requests and not same_object:
                    # Each explicitly separate object gets its own dimensions;
                    # conflicting values inside that object still require review.
                    separate_buckets.append((category, bucket))
                last_buckets.append((category, bucket))
                for field in FIELDS:
                    bucket[field].extend(_values(clause, field))
        elif not _NEGATION.search(clause):
            target = global_fields if not seen_category else None
            for field in FIELDS:
                values = _values(clause, field)
                if target is not None:
                    target[field].extend(values)
                elif len(last_buckets) == 1:
                    last_buckets[0][1][field].extend(values)

    inherited = None
    # A new current product mention is independent unless explicitly a supplement.
    contextual_supplement = any(
        _SUPPLEMENT.search(clause) and not (_VIEW.search(clause) or _READ_QUERY.search(clause)) and
        (not categories or any(category in _values(clause, "category") for category in categories))
        for clause in clauses)
    if contextual_supplement and context and len(categories) <= 1 and len(separate_buckets) <= 1:
        candidates = [item for item in context if not categories or item["attributes"].get("category") in categories]
        if len(candidates) == 1:
            inherited = candidates[0]
        elif not categories:
            return ExtractionResult(status="needs_review", error_code="AMBIGUOUS_CONTEXT", negatives=negatives)
    if not categories:
        if any(_values(clause, "category") for clause in clauses) and not _SUPPLEMENT.search(demand_text):
            return ExtractionResult(status="negative_preference" if negatives else "no_explicit_demand", negatives=negatives)
        current_values = {field: list(dict.fromkeys(_values(demand_text, field))) for field in FIELDS}
        has_dimensions = any(current_values[field] for field in FIELDS if field != "category")
        if explicit_retraction and not has_dimensions:
            if len(context or []) != 1:
                return ExtractionResult(status="needs_review", error_code="AMBIGUOUS_RETRACTION", negatives=negatives)
            target = context[0]
            return ExtractionResult(status="negative_preference",
                                    negatives=negatives or [{"text": text, "attributes": target["attributes"]}],
                                    retract_target=target["occurrence_id"])
        if inherited and has_dimensions:
            categories = [inherited["attributes"]["category"]]
            by_category = {categories[0]: current_values}
        elif negatives and not any(_values(c, "category") for c in clauses):
            return ExtractionResult(status="negative_preference", negatives=negatives)
        elif _INTENT.search(demand_text) or (has_dimensions and _SUPPLEMENT.search(demand_text)):
            return ExtractionResult(status="needs_review", error_code="UNRESOLVED_CATEGORY", negatives=negatives)
        else:
            return ExtractionResult(negatives=negatives)

    items = []
    for category, bucket in separate_buckets or by_category.items():
        attributes = {field: None for field in FIELDS}
        sources = {}
        for field in FIELDS:
            if field == "category":
                values = [category]
            elif field == "silhouette" and category != "裤子":
                values = []
            else:
                local = list(dict.fromkeys(bucket[field]))
                values = local or list(dict.fromkeys(global_fields[field]))
            if len(values) > 1:
                return ExtractionResult(status="needs_review", error_code="CONFLICTING_DIMENSIONS", negatives=negatives)
            if values:
                attributes[field] = values[0]
                if turn_id:
                    sources[field] = [turn_id]
            elif inherited and inherited["attributes"].get("category") == category:
                attributes[field] = inherited["attributes"].get(field) or None
                if attributes[field] is not None:
                    refs = inherited.get("field_sources", {}).get(field) or [inherited["turn_id"]]
                    sources[field] = list(dict.fromkeys(refs))
        # Omitted category in a cross-round supplement has its prior user source.
        if inherited and not any(_values(c, "category") for c in clauses):
            sources["category"] = inherited.get("field_sources", {}).get("category") or [inherited["turn_id"]]
        items.append(_item(attributes, sources, turn_id))

    retract_target = None
    if explicit_retraction:
        # A same-session latest user occurrence must uniquely identify the target.
        targets = context or []
        if len(categories) == 1:
            targets = [item for item in targets if item["attributes"].get("category") == categories[0]]
        if len(targets) != 1:
            return ExtractionResult(status="needs_review", error_code="AMBIGUOUS_RETRACTION", negatives=negatives)
        retract_target = targets[0]["occurrence_id"]
    # The same dimensions repeat within a round only once, including separate choices.
    unique = {item["group_key"]: item for item in items}
    return ExtractionResult(unique.values(), status="extracted", negatives=negatives, retract_target=retract_target)


def _context(db, session_id: str, current_turn_id: str) -> list[dict]:
    """Use the last applicable *user* turn; no assistant/chat-message fallback."""
    current = db.get(DemandTurn, current_turn_id)
    if not current:
        return []
    turns = db.query(DemandTurn).filter(DemandTurn.session_id == session_id,
                                       DemandTurn.created_at < current.created_at).order_by(
        DemandTurn.created_at.desc(), DemandTurn.id.desc()).all()
    for turn in turns:
        if turn.status == "needs_review":
            # Never cross an unresolved consumer ambiguity to find a convenient older fact.
            return []
        if turn.status != "extracted":
            continue
        rows = db.query(DemandOccurrence).filter_by(turn_id=turn.id, lifecycle="active").filter(
            DemandOccurrence.review_state.notin_(["excluded", "rejected"])).all()
        if not rows:
            continue
        result = []
        for row in rows:
            attrs = json.loads(row.attributes_json)
            sources = json.loads(row.field_sources_json)
            if not isinstance(attrs, dict) or set(attrs) != set(FIELDS):
                raise ValueError("INVALID_CONTEXT_ATTRIBUTES")
            if any(attrs[field] not in (None, "") and attrs[field] not in DICTIONARY[field] for field in FIELDS):
                raise ValueError("INVALID_CONTEXT_ATTRIBUTES")
            if not isinstance(sources, dict) or not set(sources).issubset(FIELDS):
                raise ValueError("INVALID_CONTEXT_SOURCES")
            if any(not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs)
                   for refs in sources.values()):
                raise ValueError("INVALID_CONTEXT_SOURCES")
            result.append({"occurrence_id": row.id, "turn_id": turn.id, "attributes": attrs,
                           "field_sources": sources})
        return result
    return []


def _validate(result, turn_id: str, allowed_sources: set[str]) -> None:
    if not isinstance(result, list):
        raise ValueError("INVALID_EXTRACTION_RESULT")
    keys = set()
    for item in result:
        if not isinstance(item, dict) or not isinstance(item.get("attributes"), dict):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        attrs = item["attributes"]
        if set(attrs) != set(FIELDS) or attrs["category"] not in DICTIONARY["category"]:
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if any(attrs[field] is not None and attrs[field] not in DICTIONARY[field] for field in FIELDS):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if not isinstance(item.get("title"), str) or not isinstance(item.get("description"), str):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if item.get("normalizer_version") != NORMALIZER_VERSION:
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if item.get("group_key") != group_key(attrs) or item["group_key"] in keys:
            raise ValueError("INVALID_EXTRACTION_RESULT")
        keys.add(item["group_key"])
        sources = item.get("field_sources", {})
        if not isinstance(sources, dict) or not set(sources).issubset(FIELDS):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if any(attrs[field] is not None and not sources.get(field) for field in FIELDS):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if any(not isinstance(refs, list) or any(not isinstance(ref, str) or ref not in allowed_sources for ref in refs)
               for refs in sources.values()):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        refs = item.get("context_turn_ids", [])
        if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs):
            raise ValueError("INVALID_EXTRACTION_RESULT")
        if set(refs) != {ref for values in sources.values() for ref in values if ref != turn_id}:
            raise ValueError("INVALID_EXTRACTION_RESULT")
    status = getattr(result, "status", "extracted" if result else "no_explicit_demand")
    if status not in {"extracted", "no_explicit_demand", "negative_preference", "needs_review"}:
        raise ValueError("INVALID_EXTRACTION_RESULT")
    if (status == "extracted") != bool(result):
        raise ValueError("INVALID_EXTRACTION_RESULT")
    error = getattr(result, "error_code", "")
    if not isinstance(error, str) or not re.fullmatch(r"[A-Z0-9_]{0,64}", error):
        raise ValueError("INVALID_EXTRACTION_RESULT")
    negatives = getattr(result, "negatives", [])
    if not isinstance(negatives, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("text"), str) or
            not isinstance(item.get("attributes"), dict) for item in negatives):
        raise ValueError("INVALID_EXTRACTION_RESULT")


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "EXTRACTION_TIMEOUT"
    if isinstance(exc, ValueError):
        return "EXTRACTION_FORMAT_ERROR"
    return "EXTRACTION_RULE_ERROR"


def _revision_snapshot(row: DemandOccurrence) -> str:
    return json.dumps({"id": row.id, "turn_id": row.turn_id, "group_key": row.group_key,
                       "attributes": json.loads(row.attributes_json), "review_state": row.review_state,
                       "reason": row.reason, "revision": row.revision, "lifecycle": row.lifecycle,
                       "field_sources": json.loads(row.field_sources_json),
                       "context_turn_ids": json.loads(row.context_turn_ids_json)}, ensure_ascii=False)


def _process_turn(db, turn: DemandTurn, budget: int) -> None:
    # Stamp only an actual attempt; successful historical turns are not reprocessed.
    turn.extractor = EXTRACTOR_VERSION
    try:
        context = _context(db, turn.session_id, turn.id)
    except (ValueError, TypeError, KeyError):
        turn.status, turn.error_code = "extraction_failed", "EXTRACTION_CONTEXT_FORMAT_ERROR"
        turn.extraction_attempts += 1
        return
    allowed = {turn.id}
    for item in context:
        allowed.add(item["turn_id"])
        allowed.update(ref for values in item["field_sources"].values() for ref in values)
    # Validate every referenced ID against same-session user evidence, including old chains.
    allowed = {row.id for row in db.query(DemandTurn).filter(DemandTurn.session_id == turn.session_id,
                                                             DemandTurn.id.in_(allowed)).all()
               if row.id == turn.id or row.created_at < turn.created_at}
    result = None
    for _ in range(budget):
        turn.extraction_attempts += 1
        try:
            result = extract(turn.text, context=context, turn_id=turn.id)
            _validate(result, turn.id, allowed)
            break
        except Exception as exc:
            turn.status = "extraction_failed"
            turn.error_code = _safe_error(exc)
            result = None
    if result is None:
        return
    turn.status = getattr(result, "status", "extracted" if result else "no_explicit_demand")
    turn.error_code = getattr(result, "error_code", "")
    turn.negative_json = json.dumps(getattr(result, "negatives", []), ensure_ascii=False)
    target_id = getattr(result, "retract_target", None)
    if target_id:
        target = db.query(DemandOccurrence).filter_by(id=target_id, lifecycle="active").first()
        target_turn = db.get(DemandTurn, target.turn_id) if target else None
        if not target or not target_turn or target_turn.session_id != turn.session_id:
            turn.status, turn.error_code = "needs_review", "AMBIGUOUS_RETRACTION"
            return
        # Versioned user withdrawal is gated by a confirmed policy flag above.
        if not db.query(DemandOccurrenceRevision).filter_by(occurrence_id=target.id, revision=target.revision).first():
            db.add(DemandOccurrenceRevision(id=uuid.uuid4().hex, occurrence_id=target.id, revision=target.revision,
                                           snapshot_json=_revision_snapshot(target), action="original", actor="consumer"))
        target.lifecycle = "retracted"
        target.revision += 1
        target.reason = "用户明确撤回，来源交流：" + turn.id
        db.add(DemandOccurrenceRevision(id=uuid.uuid4().hex, occurrence_id=target.id, revision=target.revision,
                                       snapshot_json=_revision_snapshot(target), action="retract", actor="consumer"))
    for item in result:
        db.add(DemandOccurrence(id=uuid.uuid4().hex, turn_id=turn.id, group_key=item["group_key"],
                                title=item["title"], description=item["description"],
                                attributes_json=json.dumps(item["attributes"], ensure_ascii=False),
                                normalizer_version=NORMALIZER_VERSION,
                                context_turn_ids_json=json.dumps(item["context_turn_ids"], ensure_ascii=False),
                                field_sources_json=json.dumps(item["field_sources"], ensure_ascii=False)))


def record_turn(session_id: str, request_id: str, text: str) -> bool:
    """Reserve one durable user dialogue before extraction/generation.

    Matching and conflicting duplicates both return False without changing evidence.
    HTTP callers can distinguish conflicting payloads before invoking this bool API.
    """
    clean = desensitize(text)
    turn_id = uuid.uuid4().hex
    with SessionLocal() as db:
        turn = DemandTurn(id=turn_id, request_id=request_id, session_id=session_id, text=clean,
                          status="extraction_failed", extractor=EXTRACTOR_VERSION,
                          error_code="EXTRACTION_INTERRUPTED", extraction_attempts=0)
        db.add(turn)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if db.query(DemandTurn).filter_by(request_id=request_id).first():
                return False
            raise
        if db.bind.dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        _process_turn(db, turn, MAX_AUTO_ATTEMPTS)
        db.commit()
    return True


def retry_failed_turn(turn_id: str, *, db=None, before_execute=None) -> dict | None:
    """One explicit manager recovery, same dialogue; finite total attempt budget."""
    from contextlib import nullcontext
    owns_transaction = db is None
    with SessionLocal() if owns_transaction else nullcontext(db) as db:
        if owns_transaction and db.bind.dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        turn = db.get(DemandTurn, turn_id)
        if not turn:
            return None
        if turn.status != "extraction_failed" or db.query(DemandOccurrence).filter_by(turn_id=turn_id).first():
            raise ValueError("TURN_NOT_RETRYABLE")
        remaining = MAX_TOTAL_ATTEMPTS - turn.extraction_attempts
        if remaining <= 0:
            raise ValueError("EXTRACTION_RETRY_LIMIT")
        # Claim the failed state atomically so concurrent retry calls cannot both run.
        changed = db.query(DemandTurn).filter_by(id=turn_id, status="extraction_failed",
                                                extraction_attempts=turn.extraction_attempts).update(
            {DemandTurn.error_code: "EXTRACTION_RETRY_IN_PROGRESS"}, synchronize_session=False)
        if not changed:
            raise ValueError("TURN_NOT_RETRYABLE")
        if before_execute is not None:
            before_execute()
        _process_turn(db, turn, min(MAX_AUTO_ATTEMPTS, remaining))
        if owns_transaction:
            db.commit()
        return {"id": turn.id, "status": turn.status, "error_code": turn.error_code,
                "extraction_attempts": turn.extraction_attempts}


def process_admitted_turn(request_id: str) -> bool:
    """Process an admission-created durable turn once; no quota or model actions.

    SQLite serializes this claim with BEGIN IMMEDIATE before reading its state.
    An interrupted reserved turn remains durable and available for manager recovery.
    """
    with SessionLocal() as db:
        if db.bind.dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        turn = db.query(DemandTurn).filter_by(request_id=request_id).first()
        if not turn or turn.extraction_attempts != 0 or turn.error_code != "EXTRACTION_INTERRUPTED":
            return False
        _process_turn(db, turn, MAX_AUTO_ATTEMPTS)
        db.commit()
        return True
