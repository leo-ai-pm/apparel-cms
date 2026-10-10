"""隔离的真实 CMS + 产品 Agent 联调栈。仅使用自动创建的临时库与合成样本。

运行：backend/.venv/bin/python backend/scripts/preview_test_stack.py
CMS 8101 / Agent 8102。标准输入支持 status、stop-cms、start-cms、
restart-backend、reject-latest、quit。不会读取或改写现有业务库或现有 API Key。
"""

import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[2]
CMS = PROJECT.parent / "CMS平台" / "backend"
BACKEND = PROJECT / "backend"


def main():
    for port in [8101, 8102]:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.3):
                raise RuntimeError(f"测试端口 {port} 已被占用，请先停止之前的测试栈")
        except (ConnectionRefusedError, TimeoutError):
            pass
    root = Path(tempfile.mkdtemp(prefix="product-agent-frontend-e2e-"))
    key = secrets.token_urlsafe(32)
    cms_env = {**os.environ, "DATABASE_URL": f"sqlite:///{root / 'cms.db'}", "DEMO_USERS": "", "SMOKE_PRODUCT_KEY": key}
    backend_env = {**os.environ, "CMS_BASE_URL": "http://127.0.0.1:8101", "CMS_API_KEY": key, "DB_PATH": str(root / "agent.db"), "CMS_TIMEOUT": "1", "CMS_RETRIES": "3"}
    seed = '''
import os
from app.db import engine, SessionLocal
from app.models import Base
from app.models.api_key import ApiKey
from app.models.signal import Signal
from app.core.security import hash_key
Base.metadata.create_all(engine)
with SessionLocal() as db:
    db.add(ApiKey(key_hash=hash_key(os.environ["SMOKE_PRODUCT_KEY"]), name="isolated-product-preview", source_agent="product"))
    for index, feedback in enumerate(["intent", "simulated_cart", "real_purchase", "out_of_stock", "missing_image"], 1):
        db.add(Signal(signal_id=f"SIG-FRONTEND-TEST-{index:04}", source_agent="outfit", timestamp="2026-09-26T10:00:00+08:00", scene="commute", season="秋", preference="预算500以内", outfit_plan={"items": [{"product_id": "TEST-ITEM", "name": "测试西裤", "category": "下装"}]}, feedback_type=feedback, user_tag="测试-通勤", status="uploaded"))
    db.commit()
'''
    subprocess.run([str(CMS / ".venv/bin/python"), "-c", seed], cwd=CMS, env=cms_env, check=True, stdout=subprocess.DEVNULL)
    processes = {}

    def start(name):
        path, env, port = (CMS, cms_env, 8101) if name == "cms" else (BACKEND, backend_env, 8102)
        processes[name] = subprocess.Popen([str(path / ".venv/bin/python"), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--no-access-log"], cwd=path, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(80):
            if processes[name].poll() is not None:
                raise RuntimeError(f"{name} 未能启动，请确认测试端口空闲")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=.5) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(.1)
        raise RuntimeError(f"{name} 启动超时")

    def stop(name):
        process = processes.get(name)
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)

    def status():
        for name in ["agent", "cms"]:
            with sqlite3.connect(root / f"{name}.db") as conn:
                rows = conn.execute("SELECT package_id, version, status FROM packages").fetchall()
                print(json.dumps({"database": name, "packages": rows}, ensure_ascii=False), flush=True)

    try:
        start("cms")
        start("backend")
        print(f"隔离联调栈已启动：CMS 8101 / Agent 8102。测试数据目录：{root}", flush=True)
        for line in iter(input, "quit"):
            command = line.strip()
            if command == "status":
                status()
            elif command == "stop-cms":
                stop("cms")
                print("测试 CMS 已停止", flush=True)
            elif command == "start-cms":
                start("cms")
                print("测试 CMS 已恢复", flush=True)
            elif command == "restart-backend":
                stop("backend")
                start("backend")
                status()
                print("测试 Agent 已重启", flush=True)
            elif command == "reject-latest":
                with sqlite3.connect(root / "cms.db") as conn:
                    conn.execute("UPDATE packages SET status='rejected' WHERE package_id=(SELECT package_id FROM packages ORDER BY created_at DESC LIMIT 1)")
                print("测试库中最新包已标记退回（用于返工场景；未验证 CMS 审批界面）", flush=True)
            else:
                print("命令：status / stop-cms / start-cms / restart-backend / reject-latest / quit", flush=True)
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        stop("backend")
        stop("cms")
        print("隔离服务已停止，临时测试库保留供核对。", flush=True)


if __name__ == "__main__":
    main()
