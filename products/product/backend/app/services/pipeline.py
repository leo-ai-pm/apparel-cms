"""核心编排：拉取 → 归因去重 → 生成证据包 → 回传 CMS（+ 返工）。"""

from ..core.errors import AppError
from ..schemas.api import PublishRequest
from ..schemas.package import Attribution, PackagePayload, SampleCount
from ..schemas.signal import CmsSignal
from . import store
from .aggregate import aggregate, main_type_of
from .cms import CmsClient


def _recompute_dedup_key(old: str, attribution: dict) -> str:
    prefix = old.rsplit("-", 1)[0] if "-" in old else old
    return f"{prefix}-{main_type_of(attribution)}"


def pull(client: CmsClient | None = None) -> dict:
    client = client or CmsClient()
    raw = client.pull_signals()
    signals = [CmsSignal.model_validate(x) for x in raw]
    claimed = store.get_claimed_signal_ids()
    new_signals = [s for s in signals if s.signal_id not in claimed]
    if not new_signals:
        return {"new_count": 0, "message": "无新信号"}

    agg = aggregate(new_signals)
    draft_id = store.create_draft(agg)
    return {
        "new_count": len(new_signals),
        "draft_id": draft_id,
        "signal_ids": agg["signal_ids"],
        "sample_count": agg["sample_count"].model_dump(),
        "attribution": agg["attribution"].model_dump(),
        "dedup_key": agg["dedup_key"],
        "default_constraints": agg["default_constraints"],
    }


def save_draft(draft_id: int, body: PublishRequest) -> dict:
    """只保存人工编辑，不分配包编号、不向 CMS 发送。"""
    row = store.get_draft_row(draft_id)
    if row is None:
        raise AppError("DRAFT_NOT_FOUND", "草稿不存在或已回传", 404)
    attribution = dict(row["attribution"])
    if body.style_demand is not None:
        attribution["style_demand"] = body.style_demand
    constraints = body.constraints if body.constraints is not None else row["constraints"]
    priority = body.priority or row["priority"]
    priority_basis = (body.priority_basis if body.priority_basis is not None else row["priority_basis"] or "").strip()
    if body.priority and body.priority != row["priority"] and not (body.priority_basis or "").strip():
        raise AppError("INVALID_INPUT", "调整优先级需填写依据", 422)
    store.update_draft_fields(
        draft_id, body.requirement_desc.strip(), constraints, attribution,
        _recompute_dedup_key(row["dedup_key"], attribution),
        priority, priority_basis,
    )
    return store.get_draft_row(draft_id)


def publish(draft_id: int, body: PublishRequest, client: CmsClient | None = None) -> dict:
    client = client or CmsClient()
    row = store.get_draft_row(draft_id)
    if row is None:
        raise AppError("DRAFT_NOT_FOUND", "草稿不存在或已回传", 404)

    requirement_desc = body.requirement_desc.strip()
    if not requirement_desc:
        raise AppError("INVALID_INPUT", "requirement_desc 不能为空", 422)

    attribution = dict(row["attribution"])
    if body.style_demand is not None:
        attribution["style_demand"] = body.style_demand
    dedup_key = _recompute_dedup_key(row["dedup_key"], attribution)
    constraints = body.constraints if body.constraints is not None else (row["constraints"] or [])
    priority = body.priority or row["priority"]
    priority_basis = (body.priority_basis if body.priority_basis is not None else row["priority_basis"] or "").strip()
    if body.priority and body.priority != row["priority"] and not (body.priority_basis or "").strip():
        raise AppError("INVALID_INPUT", "调整优先级需填写依据", 422)
    if not priority or not priority_basis:
        raise AppError("INVALID_INPUT", "回传前请核对优先级及依据", 422)

    package_id = row.get("package_id")
    if not package_id:
        package_id = store.next_package_id()
        store.set_draft_package_id(draft_id, package_id)

    payload = PackagePayload(
        package_id=package_id,
        source_agent="product",
        signal_ids=row["signal_ids"],
        source=row["source"],
        dedup_key=dedup_key,
        dedup_rule=row["dedup_rule"],
        sample_count=SampleCount(**row["sample_count"]),
        attribution=Attribution(**attribution),
        constraints=constraints,
        requirement_desc=requirement_desc,
        version=row["version"],
        priority=priority,
        priority_basis=priority_basis,
    )

    # 先落盘可编辑字段与 package_id，再 POST（失败可重试、重启可续跑）
    store.update_draft_fields(draft_id, requirement_desc, constraints, attribution, dedup_key, priority, priority_basis)
    result = client.publish_package(payload.model_dump())
    store.finalize_publish(draft_id, package_id)

    return {"package": payload.model_dump(), "cms": result}


def rework(package_id: str) -> dict:
    package = store.get_package_row(package_id)
    if package is None:
        raise AppError("PACKAGE_NOT_FOUND", "证据包不存在", 404)
    new_draft_id = store.create_rework_draft(package)
    return {"draft_id": new_draft_id, "version": _bump(package["version"]), "signal_ids": package["signal_ids"]}


def _bump(version: str) -> str:
    try:
        return f"v{int(version.lstrip('v')) + 1}"
    except ValueError:
        return "v2"
