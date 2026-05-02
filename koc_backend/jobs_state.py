from typing import Any

from .async_jobs import AsyncJobManager
from .config import ASYNC_JOBS_PATH
from .storage import sqlite_load_async_jobs, sqlite_put_async_job


def strategy_stage_definitions() -> list[dict[str, str]]:
    return [
        {"key": "received", "label": "资料接收"},
        {"key": "platform_identity", "label": "平台线索解析"},
        {"key": "asset_analysis", "label": "素材分析"},
        {"key": "evidence_collection", "label": "证据快照"},
        {"key": "decision_gate", "label": "路由决策"},
        {"key": "evidence_repair_plan", "label": "补证据规划"},
        {"key": "evidence_request", "label": "等待补充证据"},
        {"key": "strategy_bundle", "label": "专家分析与策略生成"},
        {"key": "finalize", "label": "结果收拢"},
    ]


ASYNC_JOBS = AsyncJobManager(ASYNC_JOBS_PATH, sqlite_put_async_job, sqlite_load_async_jobs)
ASYNC_JOBS.load()


def create_strategy_job(profile_id: str, mode: str = "advisor") -> dict[str, Any]:
    return ASYNC_JOBS.create(profile_id, mode, strategy_stage_definitions())


def snapshot_async_job(job: dict[str, Any]) -> dict[str, Any]:
    return ASYNC_JOBS.snapshot(job)


def get_async_job(job_id: str) -> dict[str, Any]:
    return ASYNC_JOBS.get(job_id)


def update_async_job(job_id: str, **fields: Any) -> dict[str, Any]:
    return ASYNC_JOBS.update(job_id, **fields)


def update_async_job_stage(job_id: str, stage_key: str, status: str, message: str = "") -> dict[str, Any]:
    return ASYNC_JOBS.update_stage(job_id, stage_key, status, message)
