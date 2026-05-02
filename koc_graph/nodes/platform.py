from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def resolve_platform_identity_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    profile = state["profile"]
    task_intent = state.get("task_intent", "")
    tool_runs = list(state.get("tool_runs", []))

    tool_registry = runtime.get("tool_registry")
    if tool_registry and tool_registry.has("platform.resolve_identity"):
        platform_identity, tool_run = tool_registry.run(
            "platform.resolve_identity",
            profile=profile,
            task_intent=task_intent,
        )
        tool_runs.append(tool_run)
        if tool_run.get("status") == "failed" or not isinstance(platform_identity, dict):
            platform_identity = {
                "status": "degraded",
                "message": f"平台线索解析失败，已保留原始用户资料继续分析：{tool_run.get('error') or '未知错误'}",
                "evidence": [],
                "confidence": "low",
            }
    else:
        is_single_work = task_intent == "single_work_analysis"
        platform_identity = {
            "status": "resolved",
            "message": (
                "已识别为单条作品分析：优先读取作品标题、话题标签、链接文本和上传素材，不上升为账号长期诊断。"
                if is_single_work
                else profile.get("platform_snapshot", {}).get("explain", "已写入平台身份线索。")
            ),
            "evidence": [],
            "confidence": "medium",
        }
        tool_runs.append({"tool": "platform.resolve_identity", "status": "success"})

    message = str(platform_identity.get("message") or "平台线索解析已完成。")
    runtime["update_async_job_stage"](job_id, "platform_identity", "done", message)
    return {
        "platform_identity": platform_identity,
        "tool_runs": tool_runs,
        "current_stage": "platform_identity",
        "stage_events": add_stage_event(state, "resolve_platform_identity", "platform_identity", "done", message),
    }
