"""Purpose-bound machine identities. Configuration is private and re-read per call."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
from fastapi import Request


class DirectAuthError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(code)


def read_config():
    if os.getenv('STYLING_DIRECT_ENABLED') != '1':
        raise DirectAuthError(503, 'DIRECT_NOT_CONFIGURED', '直接交接尚未配置。')
    try:
        path = Path(os.environ['STYLING_DIRECT_AUTH_FILE']).expanduser()
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError()
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or not isinstance(value.get('verifiers', []), list) or not isinstance(value.get('targets', []), list):
            raise ValueError()
        return value
    except (OSError, KeyError, ValueError, TypeError):
        raise DirectAuthError(503, 'DIRECT_CONFIGURATION_INVALID', '直接交接认证配置不可用。') from None


def require_verifier(request: Request):
    config = read_config()
    # Machine purposes never exchange browser cookies for service access.
    if request.headers.get('cookie'):
        raise DirectAuthError(403, 'DIRECT_AUTH_CONFLICT', '服务调用不能混用浏览器身份。')
    parts = request.headers.get('authorization', '').split(' ')
    if len(parts) != 2 or parts[0] != 'Bearer' or not 24 <= len(parts[1]) <= 512:
        raise DirectAuthError(401, 'DIRECT_UNAUTHORIZED', '需要指定用途的服务身份。')
    digest = hashlib.sha256(parts[1].encode()).hexdigest()
    matches = [p for p in config.get('verifiers', []) if isinstance(p, dict)
               and isinstance(p.get('token_sha256'), str) and hmac.compare_digest(p['token_sha256'], digest)]
    if len(matches) != 1 or matches[0].get('enabled') is not True:
        raise DirectAuthError(401, 'DIRECT_UNAUTHORIZED', '服务身份无效或已停用。')
    principal = matches[0]
    if (any(not isinstance(principal.get(key), str) or not 1 <= len(principal[key]) <= 160
            for key in ('subject', 'authorized_scope', 'source_instance_id', 'target_instance_id'))
            or principal['source_instance_id'] != os.getenv('STYLING_DIRECT_INSTANCE_ID')):
        raise DirectAuthError(403, 'DIRECT_SCOPE_FORBIDDEN', '服务身份与当前实例不匹配。')
    return {key: principal[key] for key in ('subject', 'authorized_scope', 'source_instance_id', 'target_instance_id')}
