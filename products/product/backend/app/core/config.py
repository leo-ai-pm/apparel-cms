import os
from pathlib import Path

from dotenv import load_dotenv

# backend/ 目录（app/core/config.py 向上两级）
BACKEND_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_DIR / ".env")


class Settings:
    def __init__(self) -> None:
        self.cms_base_url: str = os.getenv("CMS_BASE_URL", "http://localhost:8001").rstrip("/")
        self.cms_api_key: str = os.getenv("CMS_API_KEY", "")
        self.app_port: int = int(os.getenv("APP_PORT", "8002"))
        self.db_path: str = os.getenv("DB_PATH", str(BACKEND_DIR / "data" / "product_agent.db"))
        self.cms_timeout: float = float(os.getenv("CMS_TIMEOUT", "10"))
        self.cms_retries: int = int(os.getenv("CMS_RETRIES", "3"))


settings = Settings()
