from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import BASE_DIR, DATABASE_URL, DB_PROVIDER


SCHEMA_PATH = BASE_DIR / "database" / "schema.sql"


def production_database_enabled() -> bool:
    return DB_PROVIDER in {"postgres", "postgresql"} or bool(DATABASE_URL)


def load_schema_sql() -> str:
    return SCHEMA_PATH.read_text(encoding="utf-8")


def _require_psycopg() -> Any:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "psycopg is required for PostgreSQL mode. Run `.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt`."
        ) from exc
    return psycopg


def connect_postgres():
    if not DATABASE_URL:
        raise RuntimeError("KOC_DATABASE_URL is not configured.")
    psycopg = _require_psycopg()
    return psycopg.connect(DATABASE_URL)


def init_production_database() -> None:
    schema_sql = load_schema_sql()
    with connect_postgres() as conn:
        with conn.cursor() as cur:
            cur.execute(schema_sql)
        conn.commit()
