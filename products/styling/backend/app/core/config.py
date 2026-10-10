import os
from pathlib import Path

from dotenv import load_dotenv

# backend/ 目录（core -> app -> backend）
BASE_DIR = Path(__file__).resolve().parents[2]
# 数据目录（数据库/图片等）；测试时可经 DATA_DIR 环境变量隔离
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))

load_dotenv(BASE_DIR / ".env")
# 公共商品素材可显式复用已授权目录，业务数据库/结果仍由DATA_DIR隔离。
PRODUCT_IMAGE_DIR = Path(os.getenv("PRODUCT_IMAGE_DIR", str(DATA_DIR / "product-images")))


class Settings:
    def __init__(self) -> None:
        self.app_name = "个性化穿搭Agent"
        self.deepseek_api_key = os.getenv("DEEPSEEK_API_KEY", "")
        self.deepseek_base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.deepseek_model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        self.llm_timeout = float(os.getenv("LLM_TIMEOUT", "30"))
        self.llm_retries = int(os.getenv("LLM_RETRIES", "2"))
        self.max_agent_steps = int(os.getenv("MAX_AGENT_STEPS", "6"))
        self.daily_call_limit = int(os.getenv("DAILY_CALL_LIMIT", "200"))
        self.max_concurrency = int(os.getenv("MAX_CONCURRENCY", "5"))
        self.port = int(os.getenv("PORT", "8000"))
        default_db = f"sqlite:///{DATA_DIR / 'app.db'}"
        self.database_url = os.getenv("DATABASE_URL", default_db)
        # RunningHub 图片模型（VTO 换装 + 商品白底图）
        self.runninghub_api_key = os.getenv("RUNNINGHUB_API_KEY", "")
        self.runninghub_base_url = os.getenv("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn")
        self.runninghub_vto_webapp_id = os.getenv("RUNNINGHUB_VTO_WEBAPP_ID", "2012848202482978818")
        self.runninghub_timeout = float(os.getenv("RUNNINGHUB_TIMEOUT", "60"))
        self.runninghub_poll_interval = int(os.getenv("RUNNINGHUB_POLL_INTERVAL", "5"))
        self.runninghub_poll_max_seconds = int(os.getenv("RUNNINGHUB_POLL_MAX_SECONDS", "600"))
        # 照片上传限制（PRD 第 6 节 + 强制底线 6）
        self.photo_max_bytes = int(os.getenv("PHOTO_MAX_BYTES", str(5 * 1024 * 1024)))
        # 土豆API（图片模型，Gemini 图像编辑）
        self.tudou_api_key = os.getenv("TUDOU_API_KEY", "")
        self.tudou_base_url = os.getenv("TUDOU_BASE_URL", "https://api.ai-tudou.net")
        self.tudou_model = os.getenv("TUDOU_MODEL", "gemini-3-pro-image-preview")
        self.tudou_timeout = float(os.getenv("TUDOU_TIMEOUT", "120"))
        self.tudou_retries = int(os.getenv("TUDOU_RETRIES", "2"))
        # CMS 管理系统（PRD v1.3 第 12.7 节：需求信号上传，G1 交接）
        self.cms_base_url = os.getenv("CMS_BASE_URL", "")
        self.cms_api_key = os.getenv("CMS_API_KEY", "")
        self.cms_signal_retries = int(os.getenv("CMS_SIGNAL_RETRIES", "3"))
        self.cms_timeout = float(os.getenv("CMS_TIMEOUT", "10"))


settings = Settings()
