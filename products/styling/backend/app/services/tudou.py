"""土豆API 客户端（Gemini 图像编辑）：上传照片 + 指令 → 换装效果图。

接口为 OpenAI 兼容 /v1/chat/completions；Gemini 图像模型在 content 里以
base64 图片（markdown 格式）返回。

发送前压缩图片（缩放 + 转 JPEG），减小请求体积、降低超时概率与费用；
网络/服务端瞬态错误有限重试。
"""
from __future__ import annotations

import base64
import io
import re
import time

import httpx

from app.core.config import settings


class TudouError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _require_key() -> str:
    if not settings.tudou_api_key:
        raise TudouError("NO_API_KEY", "未配置图片模型 API Key（TUDOU_API_KEY）")
    return settings.tudou_api_key


def _mime_b64(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _compress_image(data: bytes, max_side: int = 1024) -> bytes:
    """压缩图片：长边缩放到 max_side、转 JPEG，减小体积；失败则原样返回。"""
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        if im.mode in ("RGBA", "P", "LA", "CMYK"):
            im = im.convert("RGB")
        w, h = im.size
        scale = max_side / max(w, h)
        if scale < 1:
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        return buf.getvalue()
    except Exception:
        return data


def generate_tryon_image(photo_bytes: bytes, garment_images: list[bytes], instruction: str) -> bytes:
    """图片编辑：给照片里的人物换装（传入多张商品参考图，确保款式准确）。返回结果图片字节。"""
    key = _require_key()
    content: list[dict] = [{"type": "text", "text": instruction}]
    # 图1 = 用户照片（保留脸部细节，缩放到 1536）；图2.. = 商品参考图（缩放到 1024）
    content.append({"type": "image_url", "image_url": {"url": _to_data_url(_compress_image(photo_bytes, 1536))}})
    for g in garment_images:
        content.append({"type": "image_url", "image_url": {"url": _to_data_url(_compress_image(g, 1024))}})

    payload = {
        "model": settings.tudou_model,
        "messages": [{"role": "user", "content": content}],
    }
    for attempt in range(settings.tudou_retries + 1):
        try:
            resp = httpx.post(
                f"{settings.tudou_base_url.rstrip('/')}/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                timeout=settings.tudou_timeout,
            )
        except httpx.HTTPError:
            # 网络抖动/超时：可重试
            if attempt < settings.tudou_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise TudouError("NETWORK", "图片生成服务连接失败，请稍后重试")

        if resp.status_code >= 500:
            # 服务端错误：可重试
            if attempt < settings.tudou_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise TudouError("API_ERROR", "图片生成服务暂时不可用，请稍后重试")

        if resp.status_code >= 400:
            try:
                err = resp.json().get("error", {})
                msg = err.get("message") if isinstance(err, dict) else str(err)
            except ValueError:
                msg = resp.text[:300]
            raise TudouError("API_ERROR", f"图片生成失败：{msg}")

        data = resp.json()
        try:
            c = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise TudouError("BAD_RESPONSE", "图片生成未返回结果")

        if not isinstance(c, str):
            c = str(c)

        m = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)", c)
        if not m:
            raise TudouError("NO_IMAGE", "图片生成结果中未找到图片")
        try:
            return base64.b64decode(m.group(1))
        except Exception:
            raise TudouError("DECODE_FAILED", "图片结果解码失败")

    raise TudouError("NETWORK", "图片生成服务连接失败，请稍后重试")


def _to_data_url(data: bytes) -> str:
    return f"data:{_mime_b64(data)};base64," + base64.b64encode(data).decode()
