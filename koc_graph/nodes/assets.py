from typing import Any

from koc_graph.nodes.common import add_stage_event, append_warning
from koc_graph.state import KOCGraphState


DEGRADED_ASSET_STATUSES = {"no_assets", "vision_disabled", "no_inline_assets", "vision_timeout"}


def analyze_assets_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    profile = state["profile"]
    is_single_work = state.get("task_intent") == "single_work_analysis"
    running_message = "正在整理作品链接、标题标签和可见素材。" if is_single_work else "正在分析主页截图、封面与视频素材。"
    runtime["update_async_job_stage"](job_id, "asset_analysis", "running", running_message)

    warnings = list(state.get("warnings", []))
    tool_runs = list(state.get("tool_runs", []))
    try:
        tool_registry = runtime.get("tool_registry")
        if tool_registry and tool_registry.has("media.analyze_uploaded_assets"):
            asset_analysis, tool_run = tool_registry.run("media.analyze_uploaded_assets", profile=profile)
            tool_runs.append(tool_run)
            if tool_run.get("status") == "failed":
                raise RuntimeError(tool_run.get("error", "asset analysis failed"))
        else:
            asset_analysis = runtime["analyze_uploaded_assets"](profile)
            tool_runs.append({"tool": "media.analyze_uploaded_assets", "status": "success"})

        if isinstance(asset_analysis, dict) and isinstance(asset_analysis.get("tool_runs"), list):
            tool_runs.extend(item for item in asset_analysis["tool_runs"] if isinstance(item, dict))

        stage_status = "degraded" if asset_analysis.get("status") in DEGRADED_ASSET_STATUSES else "done"
        message = asset_analysis.get("asset_summary", "素材分析已完成。")
        runtime["update_async_job_stage"](job_id, "asset_analysis", stage_status, message)
        if stage_status == "degraded":
            warnings = append_warning({"warnings": warnings}, message)
            runtime["update_async_job"](job_id, warnings=warnings)
    except Exception as exc:  # noqa: BLE001
        if not any(item.get("tool") == "media.analyze_uploaded_assets" and item.get("status") == "failed" for item in tool_runs):
            tool_runs.append({"tool": "media.analyze_uploaded_assets", "status": "failed", "error": str(exc)[:500]})
        asset_analysis = {
            "status": "analysis_failed",
            "asset_summary": f"素材分析失败，已降级为文本链路继续：{exc}",
            "homepage_diagnosis": [],
            "video_observations": [],
            "visual_style": [],
            "content_opportunities": [],
            "shooting_and_editing_advice": [],
            "evidence": [],
            "limitations": [f"视觉分析失败：{exc}"],
            "source_type": "visual_observation",
            "confidence": "low",
        }
        warnings = append_warning({"warnings": warnings}, asset_analysis["asset_summary"])
        runtime["update_async_job"](job_id, warnings=warnings)
        runtime["update_async_job_stage"](job_id, "asset_analysis", "degraded", asset_analysis["asset_summary"])

    work_understanding = {}
    if state.get("task_intent") == "single_work_analysis" and "build_work_understanding" in runtime:
        tool_registry = runtime.get("tool_registry")
        if tool_registry and tool_registry.has("media.build_work_understanding"):
            work_understanding, tool_run = tool_registry.run(
                "media.build_work_understanding",
                profile=profile,
                asset_analysis=asset_analysis,
            )
            tool_runs.append(tool_run)
            if tool_run.get("status") == "failed":
                work_understanding = {}
        else:
            work_understanding = runtime["build_work_understanding"](profile, asset_analysis)
            tool_runs.append({"tool": "media.build_work_understanding", "status": "success"})
        asset_analysis["work_understanding"] = work_understanding

    return {
        "asset_analysis": asset_analysis,
        "work_understanding": work_understanding,
        "tool_runs": tool_runs,
        "warnings": warnings,
        "current_stage": "asset_analysis",
        "stage_events": add_stage_event(
            state,
            "analyze_assets",
            "asset_analysis",
            "degraded" if asset_analysis.get("status") in DEGRADED_ASSET_STATUSES | {"analysis_failed"} else "done",
            asset_analysis.get("asset_summary", "素材分析已完成。"),
        ),
    }
