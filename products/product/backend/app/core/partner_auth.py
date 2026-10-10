"""Purpose-bound machine authentication; no browser identity is accepted."""
from dataclasses import dataclass, field
import hashlib
import hmac

from .errors import AppError
from .partner_config import config


@dataclass(frozen=True)
class Service:
    subject: str
    purpose: str
    source_instance_id: str
    target_instance_id: str
    scope: str
    token_sha256: str = field(repr=False)
    operations: tuple = ()
    verification_base_url: str = ""
    verifier_token: str = field(default="", repr=False)
    verifier_subject: str = ""


def _service(entry):
    v = entry.get("verification", {})
    return Service(entry["subject"], entry["purpose"], entry["source_instance_id"], entry["target_instance_id"],
                   entry["authorized_scope"], entry["token_sha256"], tuple(sorted(entry.get("operations", []))),
                   v.get("base_url", ""), v.get("token", ""), v.get("subject", ""))


def authenticate(request, purpose=None, operation=None):
    if request.headers.getlist("cookie"):
        raise AppError("FORBIDDEN", "服务接口不接受浏览器会话", 403)
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        raise AppError("UNAUTHORIZED", "缺少有效服务凭据", 401)
    parts = values[0].split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not 20 <= len(parts[1]) <= 512 or not all(33 <= ord(c) <= 126 for c in parts[1]):
        raise AppError("UNAUTHORIZED", "服务凭据无效", 401)
    cfg = config()
    digest = hashlib.sha256(parts[1].encode()).hexdigest()
    entry = next((s for s in cfg["services"] if hmac.compare_digest(s["token_sha256"], digest)), None)
    if entry is None or not entry["enabled"]:
        raise AppError("UNAUTHORIZED", "服务凭据无效或已停用", 401)
    if (purpose and entry["purpose"] != purpose) or (operation and operation not in entry.get("operations", [])):
        raise AppError("FORBIDDEN", "服务用途或操作未授权", 403)
    return _service(entry)


def recheck(actor, purpose=None, operation=None):
    entry = next((s for s in config()["services"] if s["subject"] == actor.subject), None)
    if entry is None or not entry["enabled"] or not hmac.compare_digest(entry["token_sha256"], actor.token_sha256):
        raise AppError("UNAUTHORIZED", "服务身份已失效", 401)
    current = _service(entry)
    if current != actor or (purpose and current.purpose != purpose) or (operation and operation not in current.operations):
        raise AppError("FORBIDDEN", "服务用途或实例范围已改变", 403)
    return current


def recheck_sender(actor, operation):
    return recheck(actor, "styling_sender", operation)
