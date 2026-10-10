import threading
from datetime import date

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.chat import DailyUsage


class CostGuard:
    """成本保护：每日调用上限（持久化）+ 最大并发（单进程内）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._semaphore = threading.BoundedSemaphore(settings.max_concurrency)

    def acquire_slot(self) -> bool:
        return self._semaphore.acquire(blocking=False)

    def release_slot(self) -> None:
        self._semaphore.release()

    def check_and_increment(self) -> bool:
        """返回 True 表示本日配额内，可继续；False 表示已达上限。"""
        with self._lock:
            db = SessionLocal()
            try:
                today = date.today().isoformat()
                row = db.query(DailyUsage).filter_by(day=today).first()
                if row is None:
                    row = DailyUsage(day=today, count=0)
                    db.add(row)
                if row.count >= settings.daily_call_limit:
                    return False
                row.count += 1
                db.commit()
                return True
            finally:
                db.close()


cost_guard = CostGuard()
