from datetime import datetime
from typing import Any

from .catalog import STAGE_LIBRARY

def ensure_growth_memory(profile: dict[str, Any]) -> dict[str, Any]:
    memory = profile.setdefault("growth_memory", {})
    memory.setdefault("stage_history", [])
    memory.setdefault("experiments", [])
    memory.setdefault("effective_patterns", [])
    memory.setdefault("ineffective_patterns", [])
    memory.setdefault("last_strategy_updated_at", "")
    if not memory["stage_history"]:
        memory["stage_history"].append(
            {
                "from_stage": "",
                "to_stage": profile.get("stage", "cold-start"),
                "reason": "已补齐历史阶段记录。",
                "created_at": datetime.utcnow().isoformat(),
            }
        )
    return memory


def append_unique_patterns(target: list[str], items: list[str], limit: int = 8) -> list[str]:
    for item in items:
        text = str(item).strip()
        if text and text not in target:
            target.append(text)
    return target[:limit]


def maybe_shift_profile_stage(profile: dict[str, Any], recommended_stage: str, reason: str) -> bool:
    if recommended_stage not in STAGE_LIBRARY:
        return False
    current_stage = profile.get("stage", "cold-start")
    if recommended_stage == current_stage:
        return False
    memory = ensure_growth_memory(profile)
    profile["stage"] = recommended_stage
    memory["stage_history"].append(
        {
            "from_stage": current_stage,
            "to_stage": recommended_stage,
            "reason": reason or "根据复盘结果调整阶段。",
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    return True


