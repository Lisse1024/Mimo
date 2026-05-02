from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def load_profile_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    initial_job = runtime["get_async_job"](job_id)
    profile_id = initial_job["profile_id"]
    runtime["update_async_job"](job_id, status="running")

    store = runtime["load_store"]()
    profile = runtime["get_profile"](store, profile_id)
    task_intent = runtime["normalize_task_intent"](profile.get("result_mode") or profile.get("task_intent"), profile)
    mode = initial_job.get("mode", "advisor")

    return {
        "profile_id": profile_id,
        "profile": profile,
        "mode": mode,
        "task_intent": task_intent,
        "warnings": list(initial_job.get("warnings", [])),
        "errors": [],
        "current_stage": "received",
        "stage_events": add_stage_event(state, "load_profile", "received", "done", "资料已进入 LangGraph 工作流。"),
    }
