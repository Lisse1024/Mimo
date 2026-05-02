from __future__ import annotations

import json
import sys
import time
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))


def main() -> None:
    from koc_backend.agent_runner import create_strategy_job_and_start
    from koc_backend.jobs_state import get_async_job
    from koc_backend.profile_validation import validate_profile
    from koc_backend.profiles import load_store, save_store

    store = load_store()
    profile = validate_profile(
        {
            "nickname": "测试用户",
            "account_name": "测试账号",
            "stage": "cold-start",
            "platform": "douyin",
            "track": "knowledge-edu",
            "cadence": "每周 3 条",
            "audience": "新手创作者",
            "goal": "分析当前刷到的视频",
            "strengths": "表达清楚",
            "constraints": "时间有限",
            "work_links": "https://v.douyin.com/test/ 分析当前视频为什么能火，怎么复刻",
            "result_mode": "single_work_analysis",
        }
    )
    store["profiles"].append(profile)
    store["workspaces"][profile["id"]] = {}
    save_store(store)

    job = create_strategy_job_and_start(store, profile["id"], "advisor")
    status = job
    for _ in range(10):
        time.sleep(1)
        status = get_async_job(job["id"])
        if status["status"] not in {"queued", "running"}:
            break

    if status["status"] == "failed":
        raise AssertionError(status.get("error") or "single-work smoke failed")
    if not status.get("workspace"):
        raise AssertionError(f"single-work smoke did not produce workspace: {status['status']}")

    print("single-work smoke passed")
    print(json.dumps({"job_id": status["id"], "status": status["status"], "stage": status["current_stage"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
