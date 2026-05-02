import threading
from datetime import datetime
from typing import Any

from .artifacts import annotate_workspace_bundle, apply_business_guardrails, build_evidence_contract, build_evidence_summary, build_learning_packet
from .assets import analyze_uploaded_assets, run_asr_for_video, run_ocr_for_image
from .checkpoints import CheckpointManager
from .config import ENABLE_IN_MEMORY_CHECKPOINTS
from .graph_jobs import run_strategy_graph_job as run_graph_job
from .jobs_state import create_strategy_job, get_async_job, update_async_job, update_async_job_stage
from .profile_intent import is_profile_link_only_request, is_single_work_analysis_request, normalize_task_intent
from .platform_tools import resolve_platform_identity
from .profiles import get_profile, load_store
from .strategy_service import (
    build_advisor_internal_reports,
    build_rule_based_advisor_bundle,
    build_task_followups,
    fallback_hot_video_analysis,
    generate_advisor_fast_bundle,
    normalize_tasks,
)
from .tool_registry import build_default_tool_registry
from .workspace_service import commit_strategy_workspace
from .work_understanding import build_work_understanding


CHECKPOINTS = CheckpointManager(ENABLE_IN_MEMORY_CHECKPOINTS)
TOOLS = build_default_tool_registry(
    analyze_uploaded_assets=analyze_uploaded_assets,
    build_work_understanding=build_work_understanding,
    run_ocr_for_image=run_ocr_for_image,
    run_asr_for_video=run_asr_for_video,
    resolve_platform_identity=resolve_platform_identity,
)


def run_strategy_graph_job(job_id: str) -> None:
    def mark_failed(error: str) -> None:
        update_async_job(
            job_id,
            status="failed",
            error=error,
            finished_at=datetime.utcnow().isoformat(),
        )

    run_graph_job(
        job_id,
        {
            "get_async_job": get_async_job,
            "update_async_job": update_async_job,
            "update_async_job_stage": update_async_job_stage,
            "load_store": load_store,
            "get_profile": get_profile,
            "normalize_task_intent": normalize_task_intent,
            "analyze_uploaded_assets": analyze_uploaded_assets,
            "build_work_understanding": build_work_understanding,
            "tool_registry": TOOLS,
            "build_advisor_internal_reports": build_advisor_internal_reports,
            "fallback_hot_video_analysis": fallback_hot_video_analysis,
            "is_single_work_analysis_request": is_single_work_analysis_request,
            "is_profile_link_only_request": is_profile_link_only_request,
            "build_rule_based_advisor_bundle": build_rule_based_advisor_bundle,
            "generate_advisor_fast_bundle": generate_advisor_fast_bundle,
            "apply_business_guardrails": apply_business_guardrails,
            "annotate_workspace_bundle": annotate_workspace_bundle,
            "normalize_tasks": normalize_tasks,
            "build_evidence_summary": build_evidence_summary,
            "build_evidence_contract": build_evidence_contract,
            "build_learning_packet": build_learning_packet,
            "build_task_followups": build_task_followups,
            "commit_strategy_workspace": commit_strategy_workspace,
        },
        CHECKPOINTS.get(),
        mark_failed,
    )


def run_strategy_job(job_id: str) -> None:
    run_strategy_graph_job(job_id)


def create_strategy_job_and_start(store: dict[str, Any], profile_id: str, mode: str = "advisor") -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    job = create_strategy_job(profile_id, mode)
    job = update_async_job(job["id"], task_intent=normalize_task_intent(profile.get("result_mode") or profile.get("task_intent"), profile))
    thread = threading.Thread(target=run_strategy_job, args=(job["id"],), daemon=True)
    thread.start()
    return job
