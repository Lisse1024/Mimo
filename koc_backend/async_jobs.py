import json
import threading
import uuid
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any


class AsyncJobManager:
    def __init__(
        self,
        json_path: Path,
        persist_job: Callable[[str, dict[str, Any]], None],
        load_jobs_from_db: Callable[[], dict[str, dict[str, Any]]],
    ) -> None:
        self.json_path = json_path
        self.persist_job = persist_job
        self.load_jobs_from_db = load_jobs_from_db
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def snapshot(self, job: dict[str, Any]) -> dict[str, Any]:
        return json.loads(json.dumps(job, ensure_ascii=False))

    def save_locked(self) -> None:
        self.json_path.write_text(json.dumps(self.jobs, ensure_ascii=False, indent=2), encoding="utf-8")
        for job_id, job in self.jobs.items():
            self.persist_job(job_id, job)

    def load(self) -> None:
        with self.lock:
            loaded = self.load_jobs_from_db()
            if not loaded and self.json_path.exists():
                loaded = json.loads(self.json_path.read_text(encoding="utf-8"))
            for job_id, job in loaded.items():
                if job.get("status") in {"queued", "running"}:
                    job["status"] = "degraded"
                    job["error"] = job.get("error") or "服务重启后任务执行状态已丢失，请重新发起或查看已保存工作空间。"
                    job["finished_at"] = job.get("finished_at") or datetime.utcnow().isoformat()
                self.jobs[job_id] = job
            self.save_locked()

    def create(self, profile_id: str, mode: str, stages: list[dict[str, str]]) -> dict[str, Any]:
        job_id = f"job-{uuid.uuid4().hex[:10]}"
        now = datetime.utcnow().isoformat()
        job = {
            "id": job_id,
            "profile_id": profile_id,
            "mode": mode or "advisor",
            "type": "strategy",
            "status": "queued",
            "current_stage": "received",
            "error": "",
            "warnings": [],
            "created_at": now,
            "updated_at": now,
            "finished_at": "",
            "workspace": None,
            "events": [
                {
                    "stage": "received",
                    "status": "done",
                    "message": "资料已进入分析队列。",
                    "at": now,
                }
            ],
            "stages": [
                {
                    "key": item["key"],
                    "label": item["label"],
                    "status": "done" if item["key"] == "received" else "pending",
                    "message": "资料已进入分析队列。" if item["key"] == "received" else "",
                }
                for item in stages
            ],
        }
        with self.lock:
            self.jobs[job_id] = job
            self.save_locked()
        return self.snapshot(job)

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("未找到对应分析任务。")
            return self.snapshot(job)

    def update(self, job_id: str, **fields: Any) -> dict[str, Any]:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("未找到对应分析任务。")
            job.update(fields)
            job["updated_at"] = datetime.utcnow().isoformat()
            self.save_locked()
            return self.snapshot(job)

    def update_stage(self, job_id: str, stage_key: str, status: str, message: str = "") -> dict[str, Any]:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("未找到对应分析任务。")
            for stage in job.get("stages", []):
                if stage["key"] == stage_key:
                    stage["status"] = status
                    if message:
                        stage["message"] = message
                    break
            job["current_stage"] = stage_key
            if job["status"] in {"queued", "running"}:
                job["status"] = "running"
            job["updated_at"] = datetime.utcnow().isoformat()
            events = job.setdefault("events", [])
            events.append(
                {
                    "stage": stage_key,
                    "status": status,
                    "message": message,
                    "at": job["updated_at"],
                }
            )
            job["events"] = events[-120:]
            self.save_locked()
            return self.snapshot(job)
