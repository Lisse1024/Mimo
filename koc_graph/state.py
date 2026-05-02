from typing import Any, TypedDict


class KOCGraphState(TypedDict, total=False):
    job_id: str
    profile_id: str
    mode: str
    task_intent: str

    profile: dict[str, Any]
    asset_analysis: dict[str, Any]
    platform_identity: dict[str, Any]
    evidence_snapshot: dict[str, Any]
    work_understanding: dict[str, Any]
    internal_reports: list[dict[str, Any]]
    hot_video_analysis: dict[str, Any]
    strategy: dict[str, Any]
    advisor_summary: dict[str, Any]
    tasks: list[dict[str, Any]]
    evidence_summary: list[dict[str, Any]]
    evidence_contract: dict[str, Any]
    learning_packet: dict[str, Any]
    graph_decision: dict[str, Any]
    tool_runs: list[dict[str, Any]]
    followups: list[dict[str, Any]]
    workspace: dict[str, Any]
    agent_run: dict[str, Any]
    bundle: dict[str, Any]

    route: str
    strategy_path: str
    failed_node: str
    warnings: list[str]
    errors: list[str]
    current_stage: str
    stage_events: list[dict[str, Any]]
