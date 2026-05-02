from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def build_evidence_and_followups_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    profile = state["profile"]
    bundle = state["bundle"]
    artifacts = {
        "asset_analysis": state.get("asset_analysis", {}),
        "platform_identity": state.get("platform_identity", {}),
        "evidence_snapshot": state.get("evidence_snapshot", {}),
        "graph_decision": state.get("graph_decision", {}),
        "work_understanding": state.get("work_understanding", {}),
        "hot_video_analysis": bundle.get("hot_video_analysis", {}),
        "strategy": bundle.get("strategy", {}),
        "advisor_summary": bundle.get("advisor_summary", {}),
        "tasks": bundle.get("tasks", []),
    }
    evidence_summary = runtime["build_evidence_summary"](profile, artifacts)
    artifacts["evidence_summary"] = evidence_summary
    evidence_contract = runtime["build_evidence_contract"](profile, artifacts)
    artifacts["evidence_contract"] = evidence_contract
    learning_packet = runtime["build_learning_packet"](profile, artifacts)
    followups = runtime["build_task_followups"](bundle.get("tasks", []), evidence_summary, profile)
    return {
        "evidence_summary": evidence_summary,
        "evidence_contract": evidence_contract,
        "learning_packet": learning_packet,
        "followups": followups,
        "stage_events": add_stage_event(
            state,
            "build_evidence_and_followups",
            "strategy_bundle",
            "done",
            f"已整理 {len(evidence_summary)} 条证据摘要和 {len(followups)} 个后续跟进。",
        ),
    }
