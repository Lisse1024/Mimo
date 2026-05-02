from datetime import datetime
from typing import Any

from koc_graph.state import KOCGraphState


def add_stage_event(
    state: KOCGraphState,
    node: str,
    stage: str,
    status: str,
    message: str = "",
) -> list[dict[str, Any]]:
    events = list(state.get("stage_events", []))
    events.append(
        {
            "node": node,
            "stage": stage,
            "status": status,
            "message": message,
            "at": datetime.utcnow().isoformat(),
        }
    )
    return events


def append_warning(state: KOCGraphState, warning: str) -> list[str]:
    warnings = list(state.get("warnings", []))
    if warning:
        warnings.append(warning)
    return warnings
