from datetime import datetime
from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def persist_workspace_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    runtime["update_async_job_stage"](job_id, "finalize", "running", "正在收拢结果并写入工作空间。")
    store = runtime["load_store"]()
    workspace = runtime["commit_strategy_workspace"](
        store,
        state["profile_id"],
        state["asset_analysis"],
        state["bundle"],
    )
    return {
        "workspace": workspace,
        "evidence_summary": workspace.get("evidence_summary", []),
        "evidence_contract": workspace.get("evidence_contract", {}),
        "learning_packet": workspace.get("learning_packet", {}),
        "followups": workspace.get("followups", []),
        "agent_run": workspace.get("agent_run"),
        "current_stage": "finalize",
        "stage_events": add_stage_event(state, "persist_workspace", "finalize", "running", "工作空间写入完成。"),
    }


def finalize_job_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    runtime["update_async_job_stage"](job_id, "finalize", "done", "工作空间已完成，可进入追问与任务推进。")
    final_job = runtime["get_async_job"](job_id)
    final_status = "degraded" if final_job.get("warnings") else "completed"
    runtime["update_async_job"](
        job_id,
        status=final_status,
        finished_at=datetime.utcnow().isoformat(),
        workspace=state.get("workspace"),
        graph_state={
            "stage_events": state.get("stage_events", []),
            "warnings": state.get("warnings", []),
            "task_intent": state.get("task_intent"),
            "strategy_path": state.get("strategy_path"),
            "platform_identity": state.get("platform_identity"),
            "evidence_snapshot": state.get("evidence_snapshot"),
            "graph_decision": state.get("graph_decision"),
            "work_understanding": state.get("work_understanding"),
            "tool_runs": state.get("tool_runs", []),
        },
    )
    return {
        "current_stage": "finalize",
        "stage_events": add_stage_event(state, "finalize_job", "finalize", "done", "LangGraph 工作流已完成。"),
    }


def fail_job_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    errors = list(state.get("errors", []))
    failed_node = state.get("failed_node", "unknown")
    message = errors[-1] if errors else "LangGraph 工作流执行失败。"
    runtime["update_async_job_stage"](job_id, state.get("current_stage", "finalize"), "failed", message)
    runtime["update_async_job"](
        job_id,
        status="failed",
        error=message,
        finished_at=datetime.utcnow().isoformat(),
        graph_state={
            "stage_events": state.get("stage_events", []),
            "warnings": state.get("warnings", []),
            "errors": errors,
            "failed_node": failed_node,
            "task_intent": state.get("task_intent"),
            "strategy_path": state.get("strategy_path"),
            "platform_identity": state.get("platform_identity"),
            "evidence_snapshot": state.get("evidence_snapshot"),
            "tool_runs": state.get("tool_runs", []),
        },
    )
    return {
        "current_stage": "failed",
        "stage_events": add_stage_event(state, "fail_job", "failed", "failed", message),
    }
