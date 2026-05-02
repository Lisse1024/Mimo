from typing import Any


REQUIRED_RUNTIME_KEYS = {
    "get_async_job",
    "update_async_job",
    "update_async_job_stage",
    "load_store",
    "get_profile",
    "normalize_task_intent",
    "analyze_uploaded_assets",
    "build_advisor_internal_reports",
    "fallback_hot_video_analysis",
    "is_single_work_analysis_request",
    "is_profile_link_only_request",
    "build_rule_based_advisor_bundle",
    "generate_advisor_fast_bundle",
    "apply_business_guardrails",
    "annotate_workspace_bundle",
    "normalize_tasks",
    "build_evidence_summary",
    "build_task_followups",
    "commit_strategy_workspace",
}


def build_runtime(**deps: Any) -> dict[str, Any]:
    missing = sorted(key for key in REQUIRED_RUNTIME_KEYS if key not in deps or deps[key] is None)
    if missing:
        raise ValueError(f"Missing KOC graph runtime dependencies: {', '.join(missing)}")
    return dict(deps)


def graph_invoke_config(job_id: str, recursion_limit: int = 32) -> dict[str, Any]:
    return {
        "configurable": {"thread_id": job_id},
        "recursion_limit": recursion_limit,
    }
