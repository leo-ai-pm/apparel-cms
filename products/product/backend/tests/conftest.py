import pytest

from app.core import config
from app.core.errors import AppError
from app.db import init_db
from app.schemas.signal import CmsSignal, OutfitItem, OutfitPlan


@pytest.fixture()
def db(tmp_path):
    config.settings.db_path = str(tmp_path / "test.db")
    init_db()
    yield


@pytest.fixture()
def make_signal():
    def _make(signal_id, feedback_type, scene="commute", season="秋", categories=None):
        items = [
            OutfitItem(product_id=f"P-{i}", name=f"商品{i}", category=c)
            for i, c in enumerate(categories or ["下装"])
        ]
        return CmsSignal(
            signal_id=signal_id,
            source_agent="outfit",
            timestamp="2026-09-23T10:00:00+08:00",
            scene=scene,
            season=season,
            preference="显高显瘦，预算500以内",
            outfit_plan=OutfitPlan(items=items),
            feedback_type=feedback_type,
            user_tag="女-25~30-通勤",
            status="uploaded",
        )

    return _make


class FakeCms:
    """测试用 CMS 假客户端：按失败计数模拟不可达，其余按真实契约返回。"""

    def __init__(self, signals=None):
        self.signals = signals or []
        self.packages = []
        self.pull_failures = 0
        self.publish_failures = 0

    def pull_signals(self):
        if self.pull_failures > 0:
            self.pull_failures -= 1
            raise AppError("CMS_UNREACHABLE", "mock unreachable", 502)
        return [s.model_dump() for s in self.signals]

    def publish_package(self, payload):
        if self.publish_failures > 0:
            self.publish_failures -= 1
            raise AppError("CMS_UNREACHABLE", "mock unreachable", 502)
        self.packages.append(payload)
        return {"package_id": payload["package_id"], "status": "pending"}


@pytest.fixture()
def fake_cms():
    return FakeCms()
