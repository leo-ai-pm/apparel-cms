import time

import httpx

from ..core.config import settings
from ..core.errors import AppError


def _err_text(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict) and "error" in body:
            return body["error"].get("message", str(body))
        return str(body)
    except Exception:
        return resp.text or resp.reason_phrase


class CmsClient:
    """CMS 客户端：拉取信号 + 回传证据包，失败有限重试。"""

    def __init__(self, transport=None) -> None:
        self.base = settings.cms_base_url
        self.key = settings.cms_api_key
        self._transport = transport

    def _headers(self) -> dict:
        return {"X-API-Key": self.key, "Content-Type": "application/json"}

    def _request(self, method: str, path: str, **kw) -> httpx.Response:
        if not self.key:
            raise AppError("NO_API_KEY", "未配置 CMS_API_KEY，请在 .env 填写", 500)
        last_err: Exception | None = None
        for attempt in range(1, settings.cms_retries + 1):
            try:
                if self._transport is not None:
                    with httpx.Client(transport=self._transport) as client:
                        return client.request(
                            method, self.base + path, headers=self._headers(),
                            timeout=settings.cms_timeout, **kw,
                        )
                return httpx.request(
                    method, self.base + path, headers=self._headers(),
                    timeout=settings.cms_timeout, trust_env=False, **kw,
                )
            except httpx.HTTPError as exc:
                last_err = exc
                if attempt < settings.cms_retries:
                    time.sleep(0.5 * attempt)
        raise AppError("CMS_UNREACHABLE", f"调用 CMS 失败（重试 {settings.cms_retries} 次）：{last_err}", 502)

    def pull_signals(self, limit: int = 100) -> list[dict]:
        resp = self._request("GET", f"/api/signals?limit={limit}")
        if resp.status_code != 200:
            raise AppError("CMS_ERROR", f"拉取信号失败：{_err_text(resp)}", 502)
        data = resp.json()
        return data if isinstance(data, list) else []

    def publish_package(self, payload: dict) -> dict:
        resp = self._request("POST", "/api/packages", json=payload)
        if resp.status_code not in (200, 201):
            raise AppError("CMS_ERROR", f"回传证据包失败：{_err_text(resp)}", 502)
        return resp.json()
