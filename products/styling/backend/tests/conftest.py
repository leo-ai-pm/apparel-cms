import os
import tempfile

# 必须在导入 app 之前设置环境变量（config 在导入时读取）
_TMP = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["DATA_DIR"] = f"{_TMP}/data"
os.environ["DEEPSEEK_API_KEY"] = ""  # 测试期无 Key
os.environ["RUNNINGHUB_API_KEY"] = ""  # 测试期无 Key（mock 覆盖）
os.environ["TUDOU_API_KEY"] = ""  # 全套测试不得读取本机付费图片凭据
os.environ["STYLING_DEMAND_D3_ENABLED"] = "0"  # 待确认规则仅由独立用例显式启用
os.environ["DAILY_CALL_LIMIT"] = "1000"
os.environ["MAX_CONCURRENCY"] = "10"
os.environ["CMS_BASE_URL"] = ""  # 测试隔离：默认不配 CMS，联调用例自行 monkeypatch
os.environ["CMS_API_KEY"] = ""

import pytest

from app.core.database import init_db
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture(scope="session", autouse=True)
def _init():
    init_db()


@pytest.fixture()
def client():
    return TestClient(app)


def collect_sse(response) -> list[tuple[str, dict]]:
    """把 SSE 响应解析成 [(event, data_dict), ...] 列表。"""
    import json

    events = []
    ev, data = "", ""
    for raw in response.iter_lines():
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if line == "":
            if data:
                events.append((ev, json.loads(data)))
                ev, data = "", ""
        elif line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            data += line[5:].strip()
    if data:
        events.append((ev, json.loads(data)))
    return events
