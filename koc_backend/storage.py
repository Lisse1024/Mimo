import json
import sqlite3
import uuid
from datetime import datetime
from typing import Any

from .config import SQLITE_PATH


def sqlite_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_sqlite() -> None:
    with sqlite_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS async_jobs (
                id TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS model_calls (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                prompt_chars INTEGER NOT NULL,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                error TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def sqlite_get_json(table: str, key: str) -> Any | None:
    if table not in {"kv_store", "async_jobs"}:
        raise ValueError("invalid sqlite table")
    column = "key" if table == "kv_store" else "id"
    with sqlite_connect() as conn:
        row = conn.execute(f"SELECT value FROM {table} WHERE {column} = ?", (key,)).fetchone()
    if not row:
        return None
    return json.loads(row["value"])


def sqlite_put_kv(key: str, value: Any) -> None:
    now = datetime.utcnow().isoformat()
    with sqlite_connect() as conn:
        conn.execute(
            "INSERT INTO kv_store(key, value, updated_at) VALUES(?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value, ensure_ascii=False), now),
        )
        conn.commit()


def sqlite_put_async_job(job_id: str, job: dict[str, Any]) -> None:
    now = datetime.utcnow().isoformat()
    with sqlite_connect() as conn:
        conn.execute(
            "INSERT INTO async_jobs(id, value, status, updated_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET value=excluded.value, status=excluded.status, updated_at=excluded.updated_at",
            (job_id, json.dumps(job, ensure_ascii=False), str(job.get("status", "unknown")), now),
        )
        conn.commit()


def sqlite_load_async_jobs() -> dict[str, dict[str, Any]]:
    with sqlite_connect() as conn:
        rows = conn.execute("SELECT id, value FROM async_jobs").fetchall()
    jobs: dict[str, dict[str, Any]] = {}
    for row in rows:
        try:
            parsed = json.loads(row["value"])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            jobs[str(row["id"])] = parsed
    return jobs


def record_model_call(
    kind: str,
    model: str,
    status: str,
    prompt_chars: int,
    payload: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    usage = payload.get("usage", {}) if isinstance(payload, dict) else {}
    with sqlite_connect() as conn:
        conn.execute(
            "INSERT INTO model_calls(id, model, kind, status, prompt_chars, completion_tokens, total_tokens, error, created_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                uuid.uuid4().hex,
                model,
                kind,
                status,
                prompt_chars,
                usage.get("completion_tokens") if isinstance(usage, dict) else None,
                usage.get("total_tokens") if isinstance(usage, dict) else None,
                error[:500],
                datetime.utcnow().isoformat(),
            ),
        )
        conn.commit()


init_sqlite()
