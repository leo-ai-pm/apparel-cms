"""Uncached private service configuration; never reads a dotenv file."""
import hashlib
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit

from .errors import AppError
from ..schemas.dh import decode_json

REPOSITORY = Path(__file__).resolve().parents[3]
ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
COMMON = {"subject", "purpose", "source_instance_id", "target_instance_id", "authorized_scope",
          "token_sha256", "enabled"}


def _check(value):
    if not value:
        raise ValueError()


def _shape(value, keys):
    _check(isinstance(value, dict) and set(value) == keys)


def _id(value):
    _check(isinstance(value, str) and ID.fullmatch(value))


def _token(value):
    _check(isinstance(value, str) and 20 <= len(value) <= 512
           and all(33 <= ord(c) <= 126 for c in value))


def _url(value, allow_loopback):
    _check(isinstance(value, str) and not any(c.isspace() or ord(c) < 32 for c in value))
    parsed = urlsplit(value)
    parsed.port
    _check(parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username
           and not parsed.password and not parsed.query and not parsed.fragment and parsed.path in {"", "/"})
    _check(parsed.scheme == "https" or (allow_loopback and parsed.hostname in {"127.0.0.1", "localhost", "::1"}))


def config():
    try:
        _check(os.getenv("PARTNER_MODE", "managed") == "managed")
        path = Path(os.environ["PARTNER_CONFIG_FILE"])
        info = path.lstat()
        _check(path.is_absolute() and not path.resolve().is_relative_to(REPOSITORY)
               and stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
               and info.st_size <= 262144)
        data = decode_json(path.read_bytes(), max_bytes=262144)
        _shape(data, {"config_version", "instance_id", "authorized_scope", "allow_loopback_http", "services"})
        _check(type(data["config_version"]) is int and data["config_version"] == 1
               and type(data["allow_loopback_http"]) is bool and isinstance(data["services"], list))
        _id(data["instance_id"])
        _id(data["authorized_scope"])
        subjects, hashes, verifier_hashes = set(), set(), set()
        for service in data["services"]:
            _check(isinstance(service, dict))
            purpose = service.get("purpose")
            _check(purpose in {"styling_sender", "product_workbench_reader"})
            _shape(service, COMMON | ({"operations", "verification"} if purpose == "styling_sender" else set()))
            for key in ("subject", "source_instance_id", "target_instance_id", "authorized_scope"):
                _id(service[key])
            _check(type(service["enabled"]) is bool and service["target_instance_id"] == data["instance_id"]
                   and service["authorized_scope"] == data["authorized_scope"])
            digest = service["token_sha256"]
            _check(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
                   and digest not in hashes and service["subject"] not in subjects)
            subjects.add(service["subject"])
            hashes.add(digest)
            if purpose == "styling_sender":
                ops = service["operations"]
                _check(isinstance(ops, list) and ops and all(isinstance(op, str) and op in {"deliver", "lookup", "supplement"} for op in ops)
                       and len(ops) == len(set(ops)))
                v = service["verification"]
                _shape(v, {"subject", "purpose", "source_instance_id", "target_instance_id", "authorized_scope", "base_url", "token"})
                _id(v["subject"])
                _check(v["purpose"] == "product_verifier" and v["subject"] not in subjects
                       and all(v[k] == service[k] for k in ("source_instance_id", "target_instance_id", "authorized_scope")))
                _url(v["base_url"], data["allow_loopback_http"])
                _token(v["token"])
                verifier_hashes.add(hashlib.sha256(v["token"].encode()).hexdigest())
        _check(not hashes.intersection(verifier_hashes))
        return data
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError, RecursionError, AppError):
        raise AppError("NOT_CONFIGURED", "产品接收服务配置无效或未就绪", 503) from None
