from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def _strategy_running_message(state: KOCGraphState) -> str:
    is_single_work = state.get("task_intent") == "single_work_analysis"
    return (
        "正在围绕这条作品拆解片源线索、钩子、剪辑结构和复刻路径。"
        if is_single_work
        else "正在综合内部诊断、爆款兜底和执行策略。"
    )


def _strategy_done_message(state: KOCGraphState) -> str:
    is_single_work = state.get("task_intent") == "single_work_analysis"
    return (
        "单条作品拆解、复刻步骤和验证任务已生成。"
        if is_single_work
        else "策略分析、任务拆解与 Agent 摘要已生成。"
    )


def _complete_bundle(
    state: KOCGraphState,
    runtime: dict[str, Any],
    fast_bundle: dict[str, Any],
    strategy_path: str,
) -> KOCGraphState:
    job_id = state["job_id"]
    profile = state["profile"]
    asset_analysis = state["asset_analysis"]
    hot_video_analysis = state.get("hot_video_analysis", {})

    bundle = {
        "hot_video_analysis": hot_video_analysis,
        "strategy": fast_bundle.get("strategy", {}),
        "advisor_summary": fast_bundle.get("advisor_summary", {}),
        "tasks": fast_bundle.get("tasks", []),
    }
    bundle = runtime["apply_business_guardrails"](bundle, profile)
    bundle = runtime["annotate_workspace_bundle"](bundle, asset_analysis)
    bundle["hot_video_analysis"] = bundle.get("hot_video_analysis") or {}
    bundle["strategy"] = bundle.get("strategy") or {}
    advisor_summary = bundle.get("advisor_summary") or {}
    advisor_summary["advisor_name"] = advisor_summary.get("advisor_name") or "主控增长 Agent"
    advisor_summary["tone"] = advisor_summary.get("tone") or "冷静、专业、愿意一起推进"
    bundle["advisor_summary"] = advisor_summary
    bundle["tasks"] = runtime["normalize_tasks"](bundle.get("tasks", []), profile)

    message = _strategy_done_message(state)
    runtime["update_async_job_stage"](job_id, "strategy_bundle", "done", message)
    return {
        "bundle": bundle,
        "hot_video_analysis": bundle.get("hot_video_analysis", {}),
        "strategy": bundle.get("strategy", {}),
        "advisor_summary": bundle.get("advisor_summary", {}),
        "tasks": bundle.get("tasks", []),
        "strategy_path": strategy_path,
        "current_stage": "strategy_bundle",
        "stage_events": add_stage_event(state, "generate_strategy_bundle", "strategy_bundle", "done", message),
    }


def generate_rule_based_strategy_bundle_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    runtime["update_async_job_stage"](job_id, "strategy_bundle", "running", _strategy_running_message(state))
    fast_bundle = runtime["build_rule_based_advisor_bundle"](state["profile"], state["asset_analysis"])
    return _complete_bundle(state, runtime, fast_bundle, "rule_based")


def generate_model_strategy_bundle_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    runtime["update_async_job_stage"](job_id, "strategy_bundle", "running", _strategy_running_message(state))
    fast_bundle = runtime["generate_advisor_fast_bundle"](
        state["profile"],
        state["asset_analysis"],
        state.get("internal_reports", []),
        state.get("hot_video_analysis", {}),
    )
    return _complete_bundle(state, runtime, fast_bundle, "model")


def generate_strategy_bundle_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    profile = state["profile"]
    asset_analysis = state["asset_analysis"]
    if (
        asset_analysis.get("status") in {"success", "homepage_fallback"}
        or runtime["is_single_work_analysis_request"](profile)
        or runtime["is_profile_link_only_request"](profile)
    ):
        return generate_rule_based_strategy_bundle_node(state, runtime)
    return generate_model_strategy_bundle_node(state, runtime)
