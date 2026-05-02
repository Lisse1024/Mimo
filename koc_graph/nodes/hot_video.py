from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def build_hot_video_analysis_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    hot_video_analysis = runtime["fallback_hot_video_analysis"](
        state["profile"],
        state["asset_analysis"],
        "LangGraph 主控链路不展开外部爆款长分析，先使用保守对标兜底。",
    )
    return {
        "hot_video_analysis": hot_video_analysis,
        "stage_events": add_stage_event(
            state,
            "build_hot_video_analysis",
            "strategy_bundle",
            "done",
            "爆款对标兜底分析已生成。",
        ),
    }
