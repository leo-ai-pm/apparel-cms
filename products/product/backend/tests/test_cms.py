import httpx
import pytest

from app.core import config
from app.core.errors import AppError
from app.services.cms import CmsClient


def test_retry_then_success(monkeypatch):
    monkeypatch.setattr(config.settings, "cms_api_key", "test-key")
    monkeypatch.setattr(config.settings, "cms_retries", 3)
    state = {"count": 0}

    def handler(request):
        state["count"] += 1
        if state["count"] < 3:
            raise httpx.ConnectError("down", request=request)
        return httpx.Response(200, json=[{"signal_id": "S1"}])

    client = CmsClient(transport=httpx.MockTransport(handler))
    result = client.pull_signals()
    assert result == [{"signal_id": "S1"}]
    assert state["count"] == 3


def test_retry_exhausted(monkeypatch):
    monkeypatch.setattr(config.settings, "cms_api_key", "test-key")
    monkeypatch.setattr(config.settings, "cms_retries", 3)

    def handler(request):
        raise httpx.ConnectError("down", request=request)

    client = CmsClient(transport=httpx.MockTransport(handler))
    with pytest.raises(AppError) as e:
        client.pull_signals()
    assert e.value.code == "CMS_UNREACHABLE"


def test_no_api_key(monkeypatch):
    monkeypatch.setattr(config.settings, "cms_api_key", "")
    client = CmsClient()
    with pytest.raises(AppError) as e:
        client.pull_signals()
    assert e.value.code == "NO_API_KEY"


def test_publish_error_surfaces_cms_message(monkeypatch):
    monkeypatch.setattr(config.settings, "cms_api_key", "test-key")
    monkeypatch.setattr(config.settings, "cms_retries", 1)

    def handler(request):
        return httpx.Response(422, json={"error": {"code": "SIGNAL_NOT_FOUND", "message": "signal_ids 不存在"}})

    client = CmsClient(transport=httpx.MockTransport(handler))
    with pytest.raises(AppError) as e:
        client.publish_package({"package_id": "PKG-1"})
    assert e.value.code == "CMS_ERROR"
    assert "signal_ids 不存在" in e.value.message
