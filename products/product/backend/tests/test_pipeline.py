import pytest

from app.core.errors import AppError
from app.schemas.api import PublishRequest
from app.services import pipeline, store


def test_pull_creates_draft_and_filters_claimed(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "intent"), make_signal("S2", "real_purchase")]
    r = pipeline.pull(client=fake_cms)
    assert r["new_count"] == 2
    assert r["draft_id"] >= 1
    assert r["sample_count"]["real_purchase"] == 1
    assert store.get_draft_row(r["draft_id"])["priority"] == "P2"
    # 再拉：信号已被草稿占用
    r2 = pipeline.pull(client=fake_cms)
    assert r2["new_count"] == 0


def test_pull_empty(db, fake_cms):
    fake_cms.signals = []
    assert pipeline.pull(client=fake_cms) == {"new_count": 0, "message": "无新信号"}


def test_publish_success(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "real_purchase")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    body = PublishRequest(requirement_desc="通勤场景缺高腰直筒西裤", constraints=["预算≤500"], style_demand=True)
    res = pipeline.publish(draft_id, body, client=fake_cms)

    pkg = res["package"]
    assert pkg["package_id"].startswith("PKG-")
    assert pkg["version"] == "v1"
    assert pkg["source_agent"] == "product"
    assert pkg["signal_ids"] == ["S1"]
    assert pkg["sample_count"]["real_purchase"] == 1
    assert pkg["attribution"]["style_demand"] is True
    assert pkg["constraints"] == ["预算≤500"]
    assert pkg["priority"] == "P2"
    assert pkg["priority_basis"]
    assert store.get_package_row(pkg["package_id"])["status"] == "pending"
    assert "S1" in store.get_processed_signal_ids()


def test_priority_override_requires_fresh_basis(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "intent")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    with pytest.raises(AppError) as e:
        pipeline.publish(draft_id, PublishRequest(requirement_desc="紧急补款", priority="P0"), client=fake_cms)
    assert e.value.code == "INVALID_INPUT"
    result = pipeline.publish(draft_id, PublishRequest(requirement_desc="紧急补款", priority="P0", priority_basis="业务负责人确认紧急补款"), client=fake_cms)
    assert result["package"]["priority"] == "P0"
    assert result["package"]["priority_basis"] == "业务负责人确认紧急补款"

def test_publish_idempotent_on_retry(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "intent")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    body = PublishRequest(requirement_desc="desc")

    fake_cms.publish_failures = 1
    with pytest.raises(AppError) as e:
        pipeline.publish(draft_id, body, client=fake_cms)
    assert e.value.code == "CMS_UNREACHABLE"

    # 失败后草稿仍在、package_id 已固定
    row = store.get_draft_row(draft_id)
    assert row is not None
    assert row["package_id"].startswith("PKG-")
    first_pid = row["package_id"]

    # 重试成功：复用同一 package_id，只回传一次
    res = pipeline.publish(draft_id, body, client=fake_cms)
    assert res["package"]["package_id"] == first_pid
    assert len(fake_cms.packages) == 1


def test_publish_requires_desc(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "intent")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    with pytest.raises(AppError) as e:
        pipeline.publish(draft_id, PublishRequest(requirement_desc="   "), client=fake_cms)
    assert e.value.code == "INVALID_INPUT"


def test_publish_style_demand_override(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "intent")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    res = pipeline.publish(draft_id, PublishRequest(requirement_desc="desc", style_demand=True), client=fake_cms)
    assert res["package"]["attribution"]["style_demand"] is True
    assert res["package"]["dedup_key"].endswith("-真实需求")


def test_rework_version_bump(db, make_signal, fake_cms):
    fake_cms.signals = [make_signal("S1", "real_purchase")]
    draft_id = pipeline.pull(client=fake_cms)["draft_id"]
    pid = pipeline.publish(draft_id, PublishRequest(requirement_desc="desc"), client=fake_cms)["package"]["package_id"]

    rw = pipeline.rework(pid)
    assert rw["version"] == "v2"
    assert rw["signal_ids"] == ["S1"]

    res2 = pipeline.publish(rw["draft_id"], PublishRequest(requirement_desc="desc-v2"), client=fake_cms)
    assert res2["package"]["version"] == "v2"
    assert res2["package"]["package_id"] != pid
