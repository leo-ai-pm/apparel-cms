"""RunningHub 客户端：AI 应用（VTO 换装）提交/查询 + 文生图（商品白底图）。

统一用 httpx（同步），由调用方以 asyncio.to_thread 包裹，与 llm.py 保持一致。
所有失败抛 RunningHubError(code, message)；对外只透出 code/message，不泄露堆栈与内部 URL。
"""
from __future__ import annotations

import time
from pathlib import Path

import httpx

from app.core.config import settings


class RunningHubError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# —— 接口路径 ——
UPLOAD_PATH = "/task/openapi/upload"
AI_APP_RUN_PATH = "/task/openapi/ai-app/run"
QUERY_PATH = "/openapi/v2/query"
TEXT2IMG_PATH = "/openapi/v2/seedream-v5-pro/text-to-image"

# —— VTO 工作流「一键换装」节点 ——
VTO_NODE_MODEL_IMAGE = "107"     # 模特图（用户照片）
VTO_NODE_GARMENT_IMAGE = "285"   # 替换衣物图（白底商品图）
VTO_NODE_PROMPT = "223"          # 提示词

VTO_DEFAULT_PROMPT = "让图一的人物穿上图二的衣服，自然合身，保持人物脸部、发型与姿态一致"

# —— 换脸工作流「极速换脸」节点 ——
FACESWAP_WEBAPP_ID = "1889155568379092993"
FACESWAP_NODE_FACE = "163"    # 脸型（用户照片）
FACESWAP_NODE_MODEL = "145"   # 模特（穿着商品的模特图）

# —— 美颜/精修工作流「精简优化版丨最强保留纹理精修2」节点 ——
BEAUTIFY_WEBAPP_ID = "2013126423933886466"
BEAUTIFY_NODE_IMAGE = "57"    # 上传图像
BEAUTIFY_NODE_STRENGTH = "61"  # 精修强度

# —— 换头换脸（高质量）工作流「换头、换脸提高相似度优化版-直出4K-Flux 2 Klein」节点 ——
FACESWAP_V2_WEBAPP_ID = "2020760401977282562"
FACESWAP_V2_NODE_MAIN = "6"    # 主图（模特底图）
FACESWAP_V2_NODE_FACE = "26"   # 人像参考图（用户照片）


def _base() -> str:
    return settings.runninghub_base_url.rstrip("/")


def _host_header() -> dict:
    # RunningHub AI 应用接口要求显式 Host 头（与官方脚本一致）
    return {"Host": settings.runninghub_base_url.split("//")[-1].rstrip("/")}


def _require_key() -> str:
    if not settings.runninghub_api_key:
        raise RunningHubError("NO_API_KEY", "未配置图片模型 API Key（RUNNINGHUB_API_KEY）")
    return settings.runninghub_api_key


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {_require_key()}", "Content-Type": "application/json"}


def _json_or_raise(resp: httpx.Response, context: str) -> dict:
    try:
        data = resp.json()
    except ValueError:
        raise RunningHubError("RUNNINGHUB_API", f"{context}返回格式异常")
    if resp.status_code >= 400 or data.get("code") not in (0, None):
        code = data.get("code", resp.status_code)
        msg = data.get("msg") or data.get("message") or f"HTTP {resp.status_code}"
        low = f"{code} {msg}".lower()
        if any(k in low for k in ["balance", "insufficient", "余额", "credit"]):
            raise RunningHubError("INSUFFICIENT_BALANCE", "图片模型余额不足，请充值后重试")
        raise RunningHubError("RUNNINGHUB_API", f"{context}失败：{msg}")
    return data


# —— 文件上传（AI 应用） ——

def upload_ai_app_file(file_path: str) -> str:
    """上传图片到 RunningHub（AI 应用流程），返回服务器侧 fileName。"""
    key = _require_key()
    path = Path(file_path)
    if not path.exists():
        raise RunningHubError("FILE_NOT_FOUND", "待上传图片不存在")
    try:
        with open(path, "rb") as f:
            resp = httpx.post(
                f"{_base()}{UPLOAD_PATH}",
                data={"apiKey": key, "fileType": "input"},
                files={"file": (path.name, f, _guess_mime(path))},
                headers=_host_header(),
                timeout=settings.runninghub_timeout + 60,
            )
    except httpx.HTTPError:
        raise RunningHubError("UPLOAD_FAILED", "图片上传失败，请稍后重试")
    data = _json_or_raise(resp, "图片上传")
    file_name = (data.get("data") or {}).get("fileName")
    if not file_name:
        raise RunningHubError("UPLOAD_FAILED", "图片上传未返回文件标识")
    return file_name


# —— AI 应用任务提交 ——

def submit_tryon(photo_name: str, garment_name: str, prompt: str | None = None) -> str:
    """提交 VTO 换装任务，返回 RunningHub taskId。"""
    key = _require_key()
    node_info = [
        {"nodeId": VTO_NODE_MODEL_IMAGE, "fieldName": "image", "fieldValue": photo_name},
        {"nodeId": VTO_NODE_GARMENT_IMAGE, "fieldName": "image", "fieldValue": garment_name},
        {"nodeId": VTO_NODE_PROMPT, "fieldName": "value", "fieldValue": prompt or VTO_DEFAULT_PROMPT},
    ]
    payload = {
        "apiKey": key,
        "webappId": int(settings.runninghub_vto_webapp_id),
        "nodeInfoList": node_info,
    }
    try:
        resp = httpx.post(
            f"{_base()}{AI_APP_RUN_PATH}",
            json=payload,
            headers=_host_header(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    data = _json_or_raise(resp, "提交试穿任务")
    task_id = (data.get("data") or {}).get("taskId")
    if not task_id:
        raise RunningHubError("SUBMIT_FAILED", "试穿任务提交未返回任务 ID")
    return str(task_id)


def submit_faceswap(face_name: str, model_name: str) -> str:
    """提交换脸任务（极速换脸工作流），返回 RunningHub taskId。"""
    key = _require_key()
    node_info = [
        {"nodeId": FACESWAP_NODE_FACE, "fieldName": "image", "fieldValue": face_name},
        {"nodeId": FACESWAP_NODE_MODEL, "fieldName": "image", "fieldValue": model_name},
    ]
    payload = {"apiKey": key, "webappId": int(FACESWAP_WEBAPP_ID), "nodeInfoList": node_info}
    try:
        resp = httpx.post(
            f"{_base()}{AI_APP_RUN_PATH}",
            json=payload,
            headers=_host_header(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    data = _json_or_raise(resp, "提交换脸任务")
    task_id = (data.get("data") or {}).get("taskId")
    if not task_id:
        raise RunningHubError("SUBMIT_FAILED", "换脸任务提交未返回任务 ID")
    return str(task_id)


def submit_beautify(image_name: str, strength: str = "26") -> str:
    """提交美颜/精修任务（精修工作流），返回 RunningHub taskId。"""
    key = _require_key()
    node_info = [
        {"nodeId": BEAUTIFY_NODE_IMAGE, "fieldName": "image", "fieldValue": image_name},
        {"nodeId": BEAUTIFY_NODE_STRENGTH, "fieldName": "text", "fieldValue": strength},
    ]
    payload = {"apiKey": key, "webappId": int(BEAUTIFY_WEBAPP_ID), "nodeInfoList": node_info}
    try:
        resp = httpx.post(
            f"{_base()}{AI_APP_RUN_PATH}",
            json=payload,
            headers=_host_header(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    data = _json_or_raise(resp, "提交美颜任务")
    task_id = (data.get("data") or {}).get("taskId")
    if not task_id:
        raise RunningHubError("SUBMIT_FAILED", "美颜任务提交未返回任务 ID")
    return str(task_id)


def submit_faceswap_v2(main_name: str, face_name: str) -> str:
    """提交换头换脸任务（高质量版，Flux 2 Klein，4K），返回 RunningHub taskId。"""
    key = _require_key()
    node_info = [
        {"nodeId": FACESWAP_V2_NODE_MAIN, "fieldName": "image", "fieldValue": main_name},
        {"nodeId": FACESWAP_V2_NODE_FACE, "fieldName": "image", "fieldValue": face_name},
    ]
    payload = {"apiKey": key, "webappId": int(FACESWAP_V2_WEBAPP_ID), "nodeInfoList": node_info}
    try:
        resp = httpx.post(
            f"{_base()}{AI_APP_RUN_PATH}",
            json=payload,
            headers=_host_header(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    data = _json_or_raise(resp, "提交换头换脸任务")
    task_id = (data.get("data") or {}).get("taskId")
    if not task_id:
        raise RunningHubError("SUBMIT_FAILED", "换头换脸任务提交未返回任务 ID")
    return str(task_id)


# —— 任务查询 ——

def query_task(task_id: str) -> dict:
    """查询单个任务状态，返回原始响应（含 status / results / usage）。"""
    try:
        resp = httpx.post(
            f"{_base()}{QUERY_PATH}",
            json={"taskId": task_id},
            headers=_auth_headers(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    return _json_or_raise(resp, "查询任务")


def poll_until_done(task_id: str, max_seconds: int | None = None) -> dict:
    """阻塞轮询直到 SUCCESS/FAILED，返回最终响应。用于文生图（商品图批量生成）。"""
    max_seconds = max_seconds or settings.runninghub_poll_max_seconds
    interval = settings.runninghub_poll_interval
    elapsed = 0
    while elapsed < max_seconds:
        time.sleep(interval)
        elapsed += interval
        resp = query_task(task_id)
        status = resp.get("status", "UNKNOWN")
        if status == "SUCCESS":
            return resp
        if status == "FAILED":
            err = resp.get("errorMessage") or "未知错误"
            raise RunningHubError("TASK_FAILED", f"图片生成失败：{err}")
    raise RunningHubError("TASK_TIMEOUT", "图片生成超时，请稍后重试")


# —— 结果下载 ——

def download(url: str, output_path: str) -> str:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=300) as r:
            r.raise_for_status()
            with open(output_path, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
    except httpx.HTTPError:
        raise RunningHubError("DOWNLOAD_FAILED", "结果图片下载失败")
    return str(Path(output_path).resolve())


def _first_result_url(resp: dict) -> str | None:
    results = resp.get("results") or []
    for item in results:
        url = item.get("url") or item.get("outputUrl")
        if url:
            return url
    return None


# —— 文生图（商品白底图） ——

def submit_text_to_image(prompt: str, width: int = 1024, height: int = 1024,
                         resolution: str = "1k", output_format: str = "png") -> str:
    """提交文生图（seedream-v5-pro），返回 taskId（异步，需另行轮询）。"""
    payload = {
        "prompt": prompt,
        "width": width,
        "height": height,
        "resolution": resolution,
        "outputFormat": output_format,
    }
    try:
        resp = httpx.post(
            f"{_base()}{TEXT2IMG_PATH}",
            json=payload,
            headers=_auth_headers(),
            timeout=settings.runninghub_timeout,
        )
    except httpx.HTTPError:
        raise RunningHubError("RUNNINGHUB_API", "图片生成服务连接失败，请稍后重试")
    data = _json_or_raise(resp, "提交文生图")
    task_id = data.get("taskId")
    if not task_id:
        raise RunningHubError("SUBMIT_FAILED", "文生图提交未返回任务 ID")
    return str(task_id)


def text_to_image(prompt: str, output_path: str,
                  width: int = 1024, height: int = 1024,
                  resolution: str = "1k", output_format: str = "png") -> dict:
    """文生图（seedream-v5-pro）提交 → 轮询 → 下载。返回 {path, cost, duration}。"""
    task_id = submit_text_to_image(prompt, width, height, resolution, output_format)
    final = poll_until_done(task_id)
    url = _first_result_url(final)
    if not url:
        raise RunningHubError("TASK_FAILED", "文生图未返回结果图片")
    download(url, output_path)
    usage = final.get("usage") or {}
    return {
        "path": str(Path(output_path).resolve()),
        "cost": usage.get("consumeMoney") or usage.get("thirdPartyConsumeMoney"),
        "duration": usage.get("taskCostTime"),
    }


def _guess_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")
