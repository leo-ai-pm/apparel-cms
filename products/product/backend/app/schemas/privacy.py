"""Conservative deterministic privacy checks, not comprehensive redaction.

The upstream approval/export process must still verify authorization and text.
This module rejects detectable prohibited content without changing source bytes.
"""
import re

from app.core.errors import AppError


_FORBIDDEN_KEYS = {
    "sessionid", "rawsessionid", "originalsessionid", "consumerprofile", "profilecontext", "bodyprofile", "profile",
    "body", "bodytype", "bodytypetag", "height", "heightcm", "weight", "weightkg", "bmi",
    "phone", "phonenumber", "mobile", "mobilenumber", "email", "emailaddress", "address", "realname",
    "idcard", "idnumber", "identitynumber", "passport", "authorization", "password", "passwd", "secret",
    "apikey", "accesskey", "secretkey", "accesstoken", "refreshtoken", "idtoken", "cookie", "setcookie",
    "csrftoken", "token", "credential", "credentials", "privatekey", "身高", "体重", "手机号", "电话号码",
    "身份证", "身份证号", "姓名", "家庭住址", "密码", "密钥",
}
_IDENTIFIER_KEYS = {
    "id", "handoff_id", "turn_id", "occurrence_id", "supplement_id", "approval_record_id", "verification_id",
    "source_instance_id", "target_instance_id", "direct_receive_id", "work_id", "assignment_id",
    "evidence_projection_id", "requirement_id", "prompt_id", "version_group_id", "submission_id",
}
_HEX_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_PROTOCOL_ID = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}\Z")
_EMAIL = re.compile(r"(?<![A-Za-z0-9_.+-])[A-Za-z0-9][A-Za-z0-9_.+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![A-Za-z0-9-])")
_PHONE = re.compile(r"(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])")
_IDENTITY = re.compile(r"(?<![A-Za-z0-9])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![A-Za-z0-9])")
_BODY = re.compile(r"(?:身高|体重|bmi|height(?:[_ -]?cm)?|weight(?:[_ -]?kg)?)\s*(?:为|是|大约|约)?\s*[:=：]?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:厘米|cm)\s*高", re.I)
_CREDENTIAL = re.compile(
    r"\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"(?:api[_ -]?key|access[_ -]?key|secret[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|密码|密钥)\s*[:=：]\s*\S+",
    re.I,
)
_ACCESSIBLE_RESOURCE = re.compile(r"(?:https?://|file://|data:image/|data:application/|blob:)", re.I)


def _reject():
    raise AppError("PRIVACY_REJECTED", "内容包含禁止传递的个人资料或凭据样式，请由来源方核对。", 422)


def assert_safe_content(value) -> None:
    """Reject known sensitive keys/text; preserve all supplied data unchanged."""
    pending = [(None, value)]
    while pending:
        key, current = pending.pop()
        if isinstance(current, dict):
            for name, item in current.items():
                if not isinstance(name, str):
                    _reject()
                normalized = re.sub(r"[\s_-]", "", name).lower()
                if normalized in _FORBIDDEN_KEYS:
                    _reject()
                # Dynamic maps (such as provenance) may use IDs as keys; text
                # in keys is still inspected instead of becoming a bypass.
                pending.append((name, item))
                pending.append(("id" if _PROTOCOL_ID.fullmatch(name) else None, name))
        elif isinstance(current, (list, tuple)):
            pending.extend((key, item) for item in current)
        elif isinstance(current, str):
            if _CREDENTIAL.search(current) or _EMAIL.search(current) or _BODY.search(current) or _ACCESSIBLE_RESOURCE.search(current):
                _reject()
            if _HEX_DIGEST.fullmatch(current):
                continue
            if key in _IDENTIFIER_KEYS and _PROTOCOL_ID.fullmatch(current):
                continue
            if _PHONE.search(current) or _IDENTITY.search(current):
                _reject()
