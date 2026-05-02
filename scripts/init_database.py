from __future__ import annotations

import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

from koc_backend.config import DATABASE_URL  # noqa: E402
from koc_backend.database import SCHEMA_PATH, init_production_database  # noqa: E402


def main() -> None:
    if not DATABASE_URL:
        raise SystemExit("KOC_DATABASE_URL is not configured. Copy .env.example to .env and set a PostgreSQL URL first.")
    if not SCHEMA_PATH.exists():
        raise SystemExit(f"Database schema is missing: {SCHEMA_PATH}")

    init_production_database()
    print("KOC production database schema is ready.")
    print(f"schema={SCHEMA_PATH}")


if __name__ == "__main__":
    main()
