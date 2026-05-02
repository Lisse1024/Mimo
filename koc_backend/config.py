import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
STORE_PATH = DATA_DIR / "store.json"
UPLOAD_DIR = DATA_DIR / "uploads"
ASYNC_JOBS_PATH = DATA_DIR / "async_jobs.json"
SQLITE_PATH = DATA_DIR / "koc_agent.sqlite3"
OBJECT_STORAGE_DIR = DATA_DIR / "objects"


def load_local_env() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env()

HOST = os.environ.get("KOC_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOC_PORT", "8010") or 8010)
DATABASE_URL = os.environ.get("KOC_DATABASE_URL", "").strip()
DB_PROVIDER = os.environ.get("KOC_DB_PROVIDER", "local").strip().lower()
VECTOR_PROVIDER = os.environ.get("KOC_VECTOR_PROVIDER", "pgvector").strip().lower()

MOONSHOT_API_KEY = os.environ.get("MOONSHOT_API_KEY", "")
KIMI_TEXT_MODEL = os.environ.get("KIMI_TEXT_MODEL", "kimi-k2.5")
KIMI_VISION_MODEL = os.environ.get("KIMI_VISION_MODEL", "kimi-k2.5")
KIMI_BASE_URL = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.cn/v1")
KIMI_API_TIMEOUT_SECONDS = int(os.environ.get("KIMI_API_TIMEOUT_SECONDS", "480") or 480)
KIMI_MAX_TOKENS = int(os.environ.get("KIMI_MAX_TOKENS", "8192") or 8192)
KIMI_VISION_ASSET_LIMIT = max(3, int(os.environ.get("KIMI_VISION_ASSET_LIMIT", "8") or 8))
KIMI_MAX_REQUEST_CHARS = max(4000, int(os.environ.get("KIMI_MAX_REQUEST_CHARS", "90000") or 90000))
KIMI_RETRY_ATTEMPTS = max(1, int(os.environ.get("KIMI_RETRY_ATTEMPTS", "4") or 4))
KIMI_RETRY_BACKOFF_SECONDS = max(0.2, float(os.environ.get("KIMI_RETRY_BACKOFF_SECONDS", "2.0") or 2.0))
OCR_PROVIDER = os.environ.get("KOC_OCR_PROVIDER", "auto").strip().lower()
ASR_PROVIDER = os.environ.get("KOC_ASR_PROVIDER", "auto").strip().lower()
ENABLE_IN_MEMORY_CHECKPOINTS = os.environ.get("KOC_LANGGRAPH_IN_MEMORY_CHECKPOINTS", "1").strip().lower() not in {
    "0",
    "false",
    "no",
}

DATA_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)
OBJECT_STORAGE_DIR.mkdir(exist_ok=True)
