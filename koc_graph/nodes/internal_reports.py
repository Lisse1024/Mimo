from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def build_internal_reports_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    reports = runtime["build_advisor_internal_reports"](state["profile"], state["asset_analysis"])
    return {
        "internal_reports": reports,
        "stage_events": add_stage_event(
            state,
            "build_internal_reports",
            "strategy_bundle",
            "done",
            f"已生成 {len(reports)} 条内部诊断视角。",
        ),
    }
