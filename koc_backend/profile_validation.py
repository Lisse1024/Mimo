import uuid
from datetime import datetime
from typing import Any

from .catalog import PLATFORM_LIBRARY, STAGE_LIBRARY, TRACK_LIBRARY
from .profile_intent import (
    extract_browser_structured_signals,
    normalize_task_intent,
    parse_work_links,
    platform_identity_snapshot,
)
from .profiles import parse_history_items, parse_hot_video_items
from .assets import persist_uploaded_assets

def validate_profile(payload: dict[str, Any]) -> dict[str, Any]:
    required = ["nickname", "account_name", "stage", "platform", "track", "cadence", "audience", "goal", "strengths", "constraints"]
    for key in required:
        if not str(payload.get(key, "")).strip():
            raise ValueError("请完整填写用户档案信息。")

    if payload["stage"] not in STAGE_LIBRARY:
        raise ValueError("无效的阶段。")
    platform = payload["platform"] if payload["platform"] in PLATFORM_LIBRARY else "custom-platform"
    track = payload["track"] if payload["track"] in TRACK_LIBRARY else "custom-track"

    history_raw = str(payload.get("historical_posts", "")).strip()
    hot_video_raw = str(payload.get("hot_videos", "")).strip()
    work_links_raw = str(payload.get("work_links", "")).strip()
    history_items = parse_history_items(history_raw)
    hot_video_items = parse_hot_video_items(hot_video_raw)
    work_links = parse_work_links(work_links_raw)
    platform_account_id = str(payload.get("platform_account_id", "")).strip()
    platform_snapshot = platform_identity_snapshot(platform, platform_account_id, work_links)
    profile_id = uuid.uuid4().hex[:8]
    asset_files = payload.get("asset_files", [])
    if not isinstance(asset_files, list):
        asset_files = []
    cleaned_assets = persist_uploaded_assets(profile_id, asset_files)
    created_at = datetime.utcnow().isoformat()
    video_understanding = payload.get("video_understanding", {})
    if not isinstance(video_understanding, dict):
        video_understanding = {}
    object_identity = payload.get("object_identity", {})
    if not isinstance(object_identity, dict):
        object_identity = {}
    desktop_context = str(payload.get("desktop_context", "")).strip()
    asset_notes = str(payload.get("asset_notes", "")).strip()
    platform_observed_metrics = extract_browser_structured_signals("\n".join([desktop_context, asset_notes]))
    fallback_intent_profile = {
        "work_links_raw": work_links_raw,
        "work_links": work_links,
        "user_request": str(payload.get("user_request", "")).strip(),
    }
    task_intent = normalize_task_intent(
        payload.get("result_mode") or payload.get("task_intent"),
        fallback_intent_profile,
    )

    return {
        "id": profile_id,
        "nickname": payload["nickname"].strip(),
        "account_name": payload["account_name"].strip(),
        "platform_account_id": platform_account_id,
        "stage": payload["stage"],
        "platform": platform,
        "track": track,
        "raw_platform": payload["platform"],
        "raw_track": payload["track"],
        "cadence": payload["cadence"].strip(),
        "audience": payload["audience"].strip(),
        "goal": payload["goal"].strip(),
        "strengths": payload["strengths"].strip(),
        "constraints": payload["constraints"].strip(),
        "historical_posts": history_raw,
        "history_items": history_items,
        "hot_videos": hot_video_raw,
        "hot_video_items": hot_video_items,
        "work_links_raw": work_links_raw,
        "work_links": work_links,
        "platform_snapshot": platform_snapshot,
        "task_intent": task_intent,
        "result_mode": task_intent,
        "node_task_type": str(payload.get("node_task_type", "")).strip(),
        "asset_context": str(payload.get("asset_context", "")).strip(),
        "evidence_level": str(payload.get("evidence_level", "")).strip(),
        "evidence_facts": payload.get("evidence_facts", []) if isinstance(payload.get("evidence_facts"), list) else [],
        "evidence_gaps": payload.get("evidence_gaps", []) if isinstance(payload.get("evidence_gaps"), list) else [],
        "video_understanding": video_understanding,
        "object_identity": object_identity,
        "memory_context": str(payload.get("memory_context", "")).strip(),
        "asset_notes": asset_notes,
        "asset_files": cleaned_assets,
        "user_request": str(payload.get("user_request", "")).strip(),
        "platform_observed_metrics": platform_observed_metrics,
        "growth_memory": {
            "stage_history": [
                {
                    "from_stage": "",
                    "to_stage": payload["stage"],
                    "reason": "用户首次建档。",
                    "created_at": created_at,
                }
            ],
            "experiments": [],
            "effective_patterns": [],
            "ineffective_patterns": [],
            "last_strategy_updated_at": "",
        },
        "created_at": created_at,
    }


