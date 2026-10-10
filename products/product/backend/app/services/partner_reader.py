"""Authenticated Next reader interface over frozen signal projections."""
import base64
import hashlib
import hmac
import json

from ..core.errors import AppError
from ..core.partner_auth import recheck
from ..schemas.dh import decode_json
from .partner_db import connection
from .partner_projection import encoded

MAX_RESPONSE = 16 * 1024 * 1024


def _cursor(actor, after, upper):
    raw = encoded({"subject": actor.subject, "source": actor.source_instance_id,
                   "target": actor.target_instance_id, "scope": actor.scope, "after": after, "upper": upper})
    mac = hmac.new(actor.token_sha256.encode(), raw, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=") + "." + mac


def _read_cursor(actor, cursor):
    try:
        if not isinstance(cursor, str) or len(cursor) > 2048:
            raise ValueError()
        content, mac = cursor.split(".")
        raw = base64.b64decode(content + "=" * (-len(content) % 4), altchars=b"-_", validate=True)
        if not hmac.compare_digest(hmac.new(actor.token_sha256.encode(), raw, hashlib.sha256).hexdigest(), mac):
            raise ValueError()
        obj = decode_json(raw, max_bytes=2048)
        if (set(obj) != {"subject", "source", "target", "scope", "after", "upper"}
                or obj["subject"] != actor.subject or obj["source"] != actor.source_instance_id
                or obj["target"] != actor.target_instance_id or obj["scope"] != actor.scope
                or type(obj["after"]) is not int or type(obj["upper"]) is not int
                or not 0 <= obj["after"] <= obj["upper"] <= 2 ** 63 - 1):
            raise ValueError()
        return obj["after"], obj["upper"]
    except (ValueError, TypeError, UnicodeError, AppError):
        raise AppError("INVALID_CURSOR", "分页标识无效，请从第一页重新读取", 422) from None


def list_signals(actor, limit, cursor):
    actor = recheck(actor, "product_workbench_reader")
    after, upper = _read_cursor(actor, cursor) if cursor is not None else (0, None)
    with connection() as conn:
        actor = recheck(actor, "product_workbench_reader")
        if upper is None:
            upper = conn.execute("SELECT COALESCE(MAX(id),0) FROM signals_v2 WHERE scope=? AND target_instance_id=?",
                                 (actor.scope, actor.target_instance_id)).fetchone()[0]
        rows = conn.execute("""SELECT id,content FROM signals_v2 WHERE scope=? AND target_instance_id=?
            AND id>? AND id<=? ORDER BY id LIMIT ?""", (actor.scope, actor.target_instance_id, after, upper, limit + 1)).fetchall()
        items, size = [], 4096
        for row in rows[:limit]:
            if size + len(row["content"]) > MAX_RESPONSE:
                if not items:
                    raise AppError("INPUT_TOO_LARGE", "单条信号超过响应上限", 413)
                break
            items.append(json.loads(bytes(row["content"])))
            size += len(row["content"]) + 1
        more = len(rows) > len(items)
        return {"items": items, "next_cursor": _cursor(actor, rows[len(items) - 1]["id"], upper) if more else None}


def get_signal(actor, signal_id):
    actor = recheck(actor, "product_workbench_reader")
    with connection() as conn:
        actor = recheck(actor, "product_workbench_reader")
        row = conn.execute("SELECT content FROM signals_v2 WHERE signal_id=? AND scope=? AND target_instance_id=?",
                           (signal_id, actor.scope, actor.target_instance_id)).fetchone()
        if row is None:
            raise AppError("SIGNAL_NOT_FOUND", "当前范围没有此信号", 404)
        return {"signal": json.loads(bytes(row["content"]))}


def get_blob(actor, direct_id, kind):
    actor = recheck(actor, "product_workbench_reader")
    with connection() as conn:
        actor = recheck(actor, "product_workbench_reader")
        row = conn.execute("SELECT payload,payload_digest FROM direct_receipts WHERE direct_receive_id=? AND scope=? AND target_instance_id=?",
                           (direct_id, actor.scope, actor.target_instance_id)).fetchone()
        if row is None:
            raise AppError("RECEIPT_NOT_FOUND", "当前范围没有此原件", 404)
        if kind == "payload":
            return bytes(row["payload"]), row["payload_digest"]
        supplement = conn.execute("SELECT content,digest FROM direct_supplements WHERE direct_receive_id=?", (direct_id,)).fetchone()
        if supplement is None:
            raise AppError("SUPPLEMENT_NOT_FOUND", "没有已接收的冻结补充", 404)
        return bytes(supplement["content"]), supplement["digest"]
