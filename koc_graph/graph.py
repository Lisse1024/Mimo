from collections.abc import Callable
from typing import Any

from .nodes.assets import analyze_assets_node
from .nodes.common import add_stage_event
from .nodes.decision import decision_gate_node, plan_evidence_repair_node, request_user_evidence_node
from .nodes.evidence import build_evidence_and_followups_node
from .nodes.evidence_snapshot import collect_evidence_snapshot_node
from .nodes.hot_video import build_hot_video_analysis_node
from .nodes.intake import load_profile_node
from .nodes.internal_reports import build_internal_reports_node
from .nodes.persist import fail_job_node, finalize_job_node, persist_workspace_node
from .nodes.platform import resolve_platform_identity_node
from .nodes.strategy import generate_model_strategy_bundle_node, generate_rule_based_strategy_bundle_node
from .state import KOCGraphState

Node = Callable[[KOCGraphState], KOCGraphState]


def _node(
    runtime: dict[str, Any],
    name: str,
    fn: Callable[[KOCGraphState, dict[str, Any]], KOCGraphState],
) -> Node:
    def wrapped(state: KOCGraphState) -> KOCGraphState:
        try:
            return fn(state, runtime)
        except Exception as exc:  # noqa: BLE001
            message = f"{name} 执行失败：{exc}"
            errors = list(state.get("errors", []))
            errors.append(message)
            return {
                "errors": errors,
                "failed_node": name,
                "current_stage": state.get("current_stage", name),
                "stage_events": add_stage_event(state, name, state.get("current_stage", name), "failed", message),
            }

    return wrapped


def _has_errors(state: KOCGraphState) -> bool:
    return bool(state.get("errors"))


def _profile_link_only(state: KOCGraphState) -> bool:
    decision = state.get("graph_decision", {})
    if isinstance(decision, dict) and "profile_link_only" in decision:
        return bool(decision.get("profile_link_only"))
    profile = state.get("profile", {})
    work_links = profile.get("work_links", [])
    if not isinstance(work_links, list) or not work_links:
        return False
    has_profile_link = any(
        isinstance(item, dict) and item.get("page_kind_guess") == "profile"
        for item in work_links
    )
    has_visual_assets = bool(profile.get("asset_files"))
    return has_profile_link and not has_visual_assets and state.get("task_intent") != "single_work_analysis"


def _route_after_load_profile(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "resolve_platform_identity"


def _route_after_platform(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "analyze_assets"


def _route_after_assets(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "collect_evidence_snapshot"


def _route_after_evidence_snapshot(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "decision_gate"


def _route_after_decision(state: KOCGraphState) -> str:
    if _has_errors(state):
        return "fail"
    decision = state.get("graph_decision", {})
    if isinstance(decision, dict) and decision.get("should_pause_for_evidence"):
        return "request_user_evidence"
    if isinstance(decision, dict) and decision.get("needs_evidence_repair"):
        return "plan_evidence_repair"
    return _route_after_evidence_repair(state)


def _route_after_evidence_repair(state: KOCGraphState) -> str:
    if _has_errors(state):
        return "fail"
    decision = state.get("graph_decision", {})
    if isinstance(decision, dict):
        return "build_internal_reports" if decision.get("route_internal_reports") else "build_hot_video_analysis"
    if state.get("task_intent") == "single_work_analysis" or _profile_link_only(state):
        return "build_hot_video_analysis"
    return "build_internal_reports"


def _route_after_internal_reports(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "build_hot_video_analysis"


def _route_strategy_path(state: KOCGraphState) -> str:
    if _has_errors(state):
        return "fail"
    decision = state.get("graph_decision", {})
    if isinstance(decision, dict) and decision.get("preferred_strategy") in {"rule_based", "model"}:
        return "rule_based_strategy" if decision.get("preferred_strategy") == "rule_based" else "model_strategy"
    asset_status = state.get("asset_analysis", {}).get("status")
    if (
        asset_status in {"success", "homepage_fallback"}
        or state.get("task_intent") == "single_work_analysis"
        or _profile_link_only(state)
    ):
        return "rule_based_strategy"
    return "model_strategy"


def _route_to_evidence(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "build_evidence_and_followups"


def _route_to_persist(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "persist_workspace"


def _route_to_finalize(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "finalize_job"


def _route_to_end(state: KOCGraphState) -> str:
    return "fail" if _has_errors(state) else "end"


def build_koc_graph(runtime: dict[str, Any], checkpointer: Any | None = None) -> Any:
    from langgraph.graph import END, START, StateGraph

    graph = StateGraph(KOCGraphState)
    graph.add_node("load_profile", _node(runtime, "load_profile", load_profile_node))
    graph.add_node("resolve_platform_identity", _node(runtime, "resolve_platform_identity", resolve_platform_identity_node))
    graph.add_node("analyze_assets", _node(runtime, "analyze_assets", analyze_assets_node))
    graph.add_node("collect_evidence_snapshot", _node(runtime, "collect_evidence_snapshot", collect_evidence_snapshot_node))
    graph.add_node("decision_gate", _node(runtime, "decision_gate", decision_gate_node))
    graph.add_node("plan_evidence_repair", _node(runtime, "plan_evidence_repair", plan_evidence_repair_node))
    graph.add_node("request_user_evidence", _node(runtime, "request_user_evidence", request_user_evidence_node))
    graph.add_node("build_internal_reports", _node(runtime, "build_internal_reports", build_internal_reports_node))
    graph.add_node("build_hot_video_analysis", _node(runtime, "build_hot_video_analysis", build_hot_video_analysis_node))
    graph.add_node(
        "rule_based_strategy",
        _node(runtime, "rule_based_strategy", generate_rule_based_strategy_bundle_node),
    )
    graph.add_node("model_strategy", _node(runtime, "model_strategy", generate_model_strategy_bundle_node))
    graph.add_node(
        "build_evidence_and_followups",
        _node(runtime, "build_evidence_and_followups", build_evidence_and_followups_node),
    )
    graph.add_node("persist_workspace", _node(runtime, "persist_workspace", persist_workspace_node))
    graph.add_node("finalize_job", _node(runtime, "finalize_job", finalize_job_node))
    graph.add_node("fail_job", lambda state: fail_job_node(state, runtime))

    graph.add_edge(START, "load_profile")
    graph.add_conditional_edges(
        "load_profile",
        _route_after_load_profile,
        {"resolve_platform_identity": "resolve_platform_identity", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "resolve_platform_identity",
        _route_after_platform,
        {"analyze_assets": "analyze_assets", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "analyze_assets",
        _route_after_assets,
        {"collect_evidence_snapshot": "collect_evidence_snapshot", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "collect_evidence_snapshot",
        _route_after_evidence_snapshot,
        {"decision_gate": "decision_gate", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "decision_gate",
        _route_after_decision,
        {
            "request_user_evidence": "request_user_evidence",
            "plan_evidence_repair": "plan_evidence_repair",
            "build_internal_reports": "build_internal_reports",
            "build_hot_video_analysis": "build_hot_video_analysis",
            "fail": "fail_job",
        },
    )
    graph.add_conditional_edges(
        "plan_evidence_repair",
        _route_after_evidence_repair,
        {
            "build_internal_reports": "build_internal_reports",
            "build_hot_video_analysis": "build_hot_video_analysis",
            "fail": "fail_job",
        },
    )
    graph.add_conditional_edges(
        "build_internal_reports",
        _route_after_internal_reports,
        {"build_hot_video_analysis": "build_hot_video_analysis", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "build_hot_video_analysis",
        _route_strategy_path,
        {
            "rule_based_strategy": "rule_based_strategy",
            "model_strategy": "model_strategy",
            "fail": "fail_job",
        },
    )
    graph.add_conditional_edges(
        "rule_based_strategy",
        _route_to_evidence,
        {"build_evidence_and_followups": "build_evidence_and_followups", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "model_strategy",
        _route_to_evidence,
        {"build_evidence_and_followups": "build_evidence_and_followups", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "build_evidence_and_followups",
        _route_to_persist,
        {"persist_workspace": "persist_workspace", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "persist_workspace",
        _route_to_finalize,
        {"finalize_job": "finalize_job", "fail": "fail_job"},
    )
    graph.add_conditional_edges(
        "finalize_job",
        _route_to_end,
        {"end": END, "fail": "fail_job"},
    )
    graph.add_edge("request_user_evidence", END)
    graph.add_edge("fail_job", END)
    if checkpointer is not None:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()
