"""Direct styling intake with a live, purpose-bound frozen approval check."""
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timezone

import httpx

from ..core.errors import AppError
from ..core.partner_auth import recheck_sender
from ..schemas.dh import decode_json
from ..schemas.direct import validate_direct, validate_proof
from .partner_db import connection


def now():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def ensure_tables(conn):
    # Schema ownership and creation are enforced by partner_db.connection.
    pass


def _find_identity(conn, sender, handoff_id, revision):
    return conn.execute("""SELECT * FROM direct_receipts WHERE scope=? AND source_instance_id=?
        AND target_instance_id=? AND source_agent='outfit' AND handoff_id=? AND revision=?""",
        (sender.scope, sender.source_instance_id, sender.target_instance_id, handoff_id, revision)).fetchone()


def _find_sender(conn, sender, direct_id):
    row = conn.execute("""SELECT * FROM direct_receipts WHERE direct_receive_id=? AND scope=?
        AND source_instance_id=? AND target_instance_id=? AND source_subject=?""",
        (direct_id, sender.scope, sender.source_instance_id, sender.target_instance_id, sender.subject)).fetchone()
    if row is None:
        raise AppError("RECEIPT_NOT_FOUND", "当前来源没有此接收记录", 404)
    return row


def _same_initial(row, delivery, sender):
    # The complete envelope has no client request timestamp; keeping it exact
    # prevents initial retries from silently becoming a supplement-append path.
    if row["source_subject"] != sender.subject:
        raise AppError("FORBIDDEN", "当前来源主体无权复用此交接身份", 403)
    if (bytes(row["payload"]) != delivery.payload_bytes
            or json.loads(row["envelope"]) != delivery.envelope):
        raise AppError("RECEIPT_CONFLICT", "同一交接版本的内容或首次补充不同，原记录已保留", 409)


def _proof_request(sender, delivery, purpose):
    e = delivery.envelope
    return {"proof_schema": "pa-direct-approval-proof/1", "verification_purpose": purpose,
            "nonce": secrets.token_hex(32), "source_product": "personal_styling",
            "target_product": "product_management", "source_instance_id": sender.source_instance_id,
            "target_instance_id": sender.target_instance_id, "authorized_scope": sender.scope,
            "source_approval_ref": e["source_approval_ref"], "handoff_id": e["handoff_id"],
            "revision": e["revision"], "payload_digest": e["payload_digest"],
            "supplement_id": delivery.supplement_id, "supplement_digest": delivery.supplement_digest}


def fetch_approval(sender, request):
    """One fixed, bounded call. Source errors never expose response bodies."""
    url = sender.verification_base_url.rstrip("/") + "/api/integrations/product-management/v1/verify-approval"
    try:
        with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
            with client.stream("POST", url, headers={"Authorization": "Bearer " + sender.verifier_token,
                              "Content-Type": "application/json", "Accept": "application/json"},
                              content=encoded(request).encode("utf-8")) as response:
                if response.status_code == 404:
                    raise AppError("SOURCE_APPROVAL_NOT_FOUND", "穿搭后台未找到对应冻结批准事实", 502)
                if response.status_code in (401, 403):
                    raise AppError("SOURCE_UNAUTHORIZED", "穿搭后台拒绝批准核验身份", 502)
                if response.status_code not in (200, 422):
                    raise AppError("SOURCE_RESPONSE_INVALID", "穿搭后台未返回有效批准证明", 502)
                is_json = response.headers.get("content-type", "").split(";")[0].strip().lower() == "application/json"
                if response.status_code == 200 and not is_json:
                    raise AppError("SOURCE_RESPONSE_INVALID", "穿搭后台证明响应格式不支持", 502)
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 256 * 1024:
                        raise AppError("SOURCE_RESPONSE_INVALID", "穿搭后台证明响应超过大小限制", 502)
                    chunks.append(chunk)
                raw = b"".join(chunks)
                if response.status_code == 422:
                    # Only recognized codes influence the local error. Remote
                    # messages and extra fields never leave this bounded read.
                    source_code = None
                    if is_json:
                        try:
                            source_error = decode_json(raw, max_bytes=256 * 1024).get("error")
                        except AppError:
                            source_error = None
                        if isinstance(source_error, dict) and isinstance(source_error.get("code"), str):
                            source_code = source_error["code"]
                    if source_code == "APPROVAL_IDENTITY_LEGACY":
                        raise AppError("APPROVAL_LEGACY_IDENTITY", "旧共享角色批准缺少账户归属证据，暂不能直接接收", 422)
                    if source_code in {"APPROVAL_BINDING_MISMATCH", "SUPPLEMENT_BINDING_MISMATCH",
                                       "APPROVAL_BINDING_CONFLICT"}:
                        raise AppError("APPROVAL_BINDING_MISMATCH", "来源批准证明与本次冻结交接或补充对象不一致", 422)
                    if source_code == "EVIDENCE_PRIVACY_BLOCKED":
                        raise AppError("PRIVACY_REJECTED", "来源冻结内容包含禁止传递的个人资料或凭据，接收已阻断", 422)
                    raise AppError("APPROVAL_UNVERIFIED", "来源批准尚未满足直接交接条件", 422)
                try:
                    proof = decode_json(raw, max_bytes=256 * 1024)
                except AppError:
                    raise AppError("SOURCE_RESPONSE_INVALID", "穿搭后台证明不是有效JSON对象", 502) from None
                return proof, raw
    except httpx.TimeoutException:
        raise AppError("SOURCE_TIMEOUT", "来源批准回查超时，请先查询原交接身份", 504) from None
    except httpx.HTTPError:
        raise AppError("SOURCE_UNREACHABLE", "来源批准暂时无法回查，请先查询原交接身份", 502) from None


def _attempt(sender, delivery, purpose):
    attempt = "DATT-" + uuid.uuid4().hex
    with connection(write=True) as conn:
        ensure_tables(conn)
        conn.execute("INSERT INTO integration_attempts VALUES(?,?,?,?,?,?,?,?,NULL,'pending',NULL,NULL)",
                     (attempt, sender.scope, sender.source_instance_id, sender.subject,
                      delivery.payload["handoff_id"], delivery.payload["revision"], purpose, now()))
    return attempt


def _finish(conn, attempt, direct_id):
    conn.execute("UPDATE integration_attempts SET state='received',finished_at=?,direct_receive_id=? WHERE attempt_id=?",
                 (now(), direct_id, attempt))


def _failure(attempt, error):
    state = "unconfirmed" if error.code in {"SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "STORAGE_UNAVAILABLE"} else "failed"
    try:
        with connection(write=True) as conn:
            ensure_tables(conn)
            conn.execute("UPDATE integration_attempts SET state=?,finished_at=?,error_code=? WHERE attempt_id=? AND state!='received'",
                         (state, now(), error.code, attempt))
    except AppError:
        # The durable pending attempt remains queryable in the database; failure
        # to annotate it must not invent success or replace the original error.
        pass


def _validate(sender, data):
    return validate_direct(data, source_instance_id=sender.source_instance_id,
                           target_instance_id=sender.target_instance_id, scope=sender.scope,
                           source_principal=sender.subject)


def receive(sender, data, idempotency_key, envelope_raw):
    sender = recheck_sender(sender, "deliver")
    delivery = _validate(sender, data)
    e = delivery.envelope
    if idempotency_key != f"{e['handoff_id']}:{e['revision']}":
        raise AppError("IDEMPOTENCY_KEY_INVALID", "交接幂等标识必须匹配原DH和版本", 422)
    with connection() as conn:
        ensure_tables(conn)
        sender = recheck_sender(sender, "deliver")
        old = _find_identity(conn, sender, e["handoff_id"], e["revision"])
        if old:
            _same_initial(old, delivery, sender)
            return {"receipt": json.loads(old["receipt"]), "duplicate": True}
    attempt = _attempt(sender, delivery, "initial_delivery")
    try:
        request = _proof_request(sender, delivery, "initial_delivery")
        started = datetime.now(timezone.utc)
        proof, proof_raw = fetch_approval(sender, request)
        validate_proof(proof, request=request, delivery=delivery, started_at=started)
        sender = recheck_sender(sender, "deliver")
        with connection(write=True) as conn:
            ensure_tables(conn)
            sender = recheck_sender(sender, "deliver")
            old = _find_identity(conn, sender, e["handoff_id"], e["revision"])
            if old:
                _same_initial(old, delivery, sender)
                receipt = json.loads(old["receipt"])
            else:
                receipt = {"receipt_schema": "pa-direct-receipt/1", "transport_schema": "pa-direct-delivery/1",
                           "direct_receive_id": "DPRCV-" + uuid.uuid4().hex,
                           **{k: e[k] for k in ("source_product", "target_product", "source_instance_id", "target_instance_id",
                                               "authorized_scope", "handoff_id", "revision", "payload_digest", "source_approval_ref")},
                           "status": "received", "received_at": now(), "verification_id": proof["verification_id"],
                           "supplement_id": delivery.supplement_id, "supplement_digest": delivery.supplement_digest}
                conn.execute("""INSERT INTO direct_receipts(direct_receive_id,scope,source_instance_id,target_instance_id,
                    source_agent,handoff_id,revision,payload_digest,payload,envelope,source_subject,approval_ref,receipt,
                    proof,proof_request,provenance_status,warnings,envelope_raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (receipt["direct_receive_id"], sender.scope, sender.source_instance_id, sender.target_instance_id,
                     "outfit", e["handoff_id"], e["revision"], e["payload_digest"], delivery.payload_bytes,
                     encoded(e), sender.subject, encoded(e["source_approval_ref"]), encoded(receipt), proof_raw,
                     encoded(request), delivery.provenance_status, encoded(delivery.warnings), envelope_raw))
                if delivery.supplement_bytes is not None:
                    _insert_supplement(conn, receipt["direct_receive_id"], delivery, proof, proof_raw, request)
                from .partner_projection import save_projection
                save_projection(conn, sender, delivery, proof, receipt)
            _finish(conn, attempt, receipt["direct_receive_id"])
        return {"receipt": receipt, "duplicate": old is not None}
    except AppError as error:
        _failure(attempt, error)
        raise


def _insert_supplement(conn, direct_id, delivery, proof, raw, request):
    receipt = {"receipt_schema": "pa-direct-supplement-receipt/1", "direct_receive_id": direct_id,
               "supplement_id": delivery.supplement_id, "digest": delivery.supplement_digest,
               "status": "received", "received_at": now(), "verification_id": proof["verification_id"]}
    conn.execute("INSERT INTO direct_supplements VALUES(?,?,?,?,?,?,?,?,?)",
                 (direct_id, delivery.supplement_id, delivery.supplement_digest, delivery.supplement_bytes,
                  encoded(receipt), raw, encoded(request), delivery.provenance_status, encoded(delivery.warnings)))
    return receipt


def lookup(sender, handoff_id, revision):
    sender = recheck_sender(sender, "lookup")
    with connection() as conn:
        ensure_tables(conn)
        sender = recheck_sender(sender, "lookup")
        row = _find_identity(conn, sender, handoff_id, revision)
        if row is None or row["source_subject"] != sender.subject:
            raise AppError("RECEIPT_NOT_FOUND", "当前来源没有此交接身份的接收记录", 404)
        supplement = conn.execute("SELECT supplement_id,digest FROM direct_supplements WHERE direct_receive_id=?",
                                  (row["direct_receive_id"],)).fetchone()
        return {"receipt": json.loads(row["receipt"]), "current_supplement": dict(supplement) if supplement else None}


def append_supplement(sender, direct_id, data, idempotency_key):
    sender = recheck_sender(sender, "supplement")
    keys = {"handoff_id", "revision", "payload_digest", "source_approval_ref", "supplement"}
    if not isinstance(data, dict) or set(data) != keys or not isinstance(data["supplement"], dict):
        raise AppError("DIRECT_SUPPLEMENT_INVALID", "补充追加字段不符合契约", 422)
    with connection() as conn:
        ensure_tables(conn)
        sender = recheck_sender(sender, "supplement")
        row = _find_sender(conn, sender, direct_id)
        envelope = json.loads(row["envelope"])
        if any(data[k] != envelope[k] or type(data[k]) is not type(envelope[k]) for k in keys - {"supplement"}):
            raise AppError("SUPPLEMENT_CONFLICT", "补充对象与已接收原身份不一致", 409)
        envelope["supplement"] = data["supplement"]
        delivery = _validate(sender, envelope)
        if idempotency_key != f"{direct_id}:{delivery.supplement_id}":
            raise AppError("IDEMPOTENCY_KEY_INVALID", "追加幂等标识必须匹配接收和补充身份", 422)
        previous = conn.execute("SELECT * FROM direct_supplements WHERE direct_receive_id=?", (direct_id,)).fetchone()
        if previous:
            return _duplicate_supplement(previous, delivery)
    attempt = _attempt(sender, delivery, "supplement_append")
    try:
        request = _proof_request(sender, delivery, "supplement_append")
        started = datetime.now(timezone.utc)
        proof, raw = fetch_approval(sender, request)
        validate_proof(proof, request=request, delivery=delivery, started_at=started)
        sender = recheck_sender(sender, "supplement")
        with connection(write=True) as conn:
            ensure_tables(conn)
            sender = recheck_sender(sender, "supplement")
            source_row = _find_sender(conn, sender, direct_id)
            initial_proof = json.loads(bytes(source_row["proof"]))
            if any(proof[k] != initial_proof[k] for k in ("metadata_digest", "approved_by", "approved_at", "approval_identity_kind", "data_origin")):
                raise AppError("APPROVAL_BINDING_MISMATCH", "追加补充的批准事实与首次接收不一致", 422)
            previous = conn.execute("SELECT * FROM direct_supplements WHERE direct_receive_id=?", (direct_id,)).fetchone()
            if previous:
                result = _duplicate_supplement(previous, delivery)
            else:
                receipt = _insert_supplement(conn, direct_id, delivery, proof, raw, request)
                result = {"supplement_receipt": receipt, "duplicate": False}
            _finish(conn, attempt, direct_id)
        return result
    except AppError as error:
        _failure(attempt, error)
        raise


def _duplicate_supplement(previous, delivery):
    if (previous["supplement_id"] != delivery.supplement_id or previous["digest"] != delivery.supplement_digest
            or bytes(previous["content"]) != delivery.supplement_bytes):
        raise AppError("SUPPLEMENT_CONFLICT", "已有冻结补充内容不同，原件不会覆盖", 409)
    return {"supplement_receipt": json.loads(previous["receipt"]), "duplicate": True}
