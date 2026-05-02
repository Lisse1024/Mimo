import json
from typing import Any

from .assets import normalize_store_assets
from .memory import ensure_growth_memory
from .catalog import PLATFORM_LIBRARY, STAGE_LIBRARY, TRACK_LIBRARY
from .config import STORE_PATH
from .storage import sqlite_get_json, sqlite_put_kv

def load_store() -> dict[str, Any]:
    stored = sqlite_get_json("kv_store", "store")
    if isinstance(stored, dict):
        store = stored
    elif STORE_PATH.exists():
        store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        sqlite_put_kv("store", store)
    else:
        store = {"profiles": [], "workspaces": {}}
    if normalize_store_assets(store):
        save_store(store)
    return store


def save_store(store: dict[str, Any]) -> None:
    sqlite_put_kv("store", store)
    STORE_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def profile_for_client(profile: dict[str, Any]) -> dict[str, Any]:
    ensure_growth_memory(profile)
    history_items = profile.get("history_items", [])
    hot_video_items = profile.get("hot_video_items", [])
    work_links = profile.get("work_links", [])
    safe_profile = {**profile}
    safe_profile["asset_files"] = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "mime": item.get("mime"),
            "size": item.get("size"),
            "kind": item.get("kind"),
            "path": item.get("path"),
            "note": item.get("note"),
            "has_file": bool(item.get("path")),
        }
        for item in profile.get("asset_files", [])
    ]
    safe_profile["source_type"] = "user_input"
    safe_profile["confidence"] = "high"
    safe_profile["memory_summary"] = build_profile_memory_summary(profile)
    return {
        **safe_profile,
        "track_name": TRACK_LIBRARY[profile["track"]]["name"],
        "platform_name": PLATFORM_LIBRARY[profile["platform"]]["name"],
        "stage_label": STAGE_LIBRARY[profile["stage"]],
        "history_count": len(history_items),
        "hot_video_count": len(hot_video_items),
        "work_link_count": len(work_links),
    }


def build_profile_memory_summary(profile: dict[str, Any]) -> dict[str, Any]:
    memory = profile.get("growth_memory", {})
    stage_history = memory.get("stage_history", [])
    experiments = memory.get("experiments", [])
    return {
        "current_stage": profile.get("stage"),
        "current_stage_label": STAGE_LIBRARY.get(profile.get("stage", "cold-start"), "冷启动期"),
        "stage_history_count": len(stage_history),
        "experiment_count": len(experiments),
        "effective_patterns": memory.get("effective_patterns", [])[:3],
        "ineffective_patterns": memory.get("ineffective_patterns", [])[:3],
        "last_stage_event": stage_history[-1] if stage_history else None,
    }


def get_profile(store: dict[str, Any], profile_id: str) -> dict[str, Any]:
    for profile in store["profiles"]:
        if profile["id"] == profile_id:
            return profile
    raise ValueError("未找到对应的用户档案。")


def profile_brief(profile: dict[str, Any]) -> str:
    history_text = json.dumps(profile.get("history_items", []), ensure_ascii=False, indent=2)
    hot_text = json.dumps(profile.get("hot_video_items", []), ensure_ascii=False, indent=2)
    asset_text = json.dumps(
        [
            {
                "name": item.get("name"),
                "mime": item.get("mime"),
                "size": item.get("size"),
                "kind": item.get("kind"),
                "path": item.get("path"),
                "note": item.get("note"),
                "has_file": bool(item.get("path")),
            }
            for item in profile.get("asset_files", [])
        ],
        ensure_ascii=False,
        indent=2,
    )
    work_links_text = json.dumps(profile.get("work_links", []), ensure_ascii=False, indent=2)
    platform_snapshot_text = json.dumps(profile.get("platform_snapshot", {}), ensure_ascii=False, indent=2)
    asset_analysis_text = json.dumps(profile.get("asset_analysis", {}), ensure_ascii=False, indent=2)
    growth_memory_text = json.dumps(profile.get("growth_memory", {}), ensure_ascii=False, indent=2)
    return (
        f"用户昵称：{profile['nickname']}\n"
        f"账号名称：{profile['account_name']}\n"
        f"当前阶段：{STAGE_LIBRARY[profile['stage']]}\n"
        f"目标平台：{PLATFORM_LIBRARY[profile['platform']]['name']}，平台偏好：{PLATFORM_LIBRARY[profile['platform']]['bias']}\n"
        f"内容赛道：{TRACK_LIBRARY[profile['track']]['name']}，赛道关键词：{', '.join(TRACK_LIBRARY[profile['track']]['keywords'])}\n"
        f"更新频率：{profile['cadence']}\n"
        f"目标人群：{profile['audience']}\n"
        f"创作目标：{profile['goal']}\n"
        f"用户优势：{profile['strengths']}\n"
        f"现实限制：{profile['constraints']}\n"
        f"历史内容样本：{history_text}\n"
        f"平台爆款样本：{hot_text}\n"
        f"用户提供的主页/作品链接：{work_links_text}\n"
        f"平台账号身份解析：{platform_snapshot_text}\n"
        f"主页截图/视频文件说明：{profile.get('asset_notes', '')}\n"
        f"上传素材清单：{asset_text}\n"
        f"Kimi视觉素材分析：{asset_analysis_text}\n"
        f"长期增长记忆：{growth_memory_text}\n"
        f"用户当前需求：{profile.get('user_request', '')}\n"
    )


def parse_history_items(raw: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for index, line in enumerate(raw.splitlines(), start=1):
        text = line.strip()
        if not text:
            continue
        if text.lower().startswith(("title,", "标题,", "title|", "标题|")):
            continue

        parts = [part.strip() for part in text.replace(",", "|").split("|")]
        while len(parts) < 8:
            parts.append("")

        def to_int(value: str) -> int:
            try:
                return int(float(value.replace("w", "0000").replace("万", "0000")))
            except ValueError:
                return 0

        items.append(
            {
                "index": index,
                "title": parts[0],
                "platform": parts[1],
                "views": to_int(parts[2]),
                "likes": to_int(parts[3]),
                "saves": to_int(parts[4]),
                "comments": to_int(parts[5]),
                "publish_time": parts[6],
                "note": parts[7],
            }
        )
    return items[:30]


def parse_hot_video_items(raw: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for index, line in enumerate(raw.splitlines(), start=1):
        text = line.strip()
        if not text:
            continue
        if text.lower().startswith(("title,", "标题,", "title|", "标题|")):
            continue

        parts = [part.strip() for part in text.replace(",", "|").split("|")]
        while len(parts) < 8:
            parts.append("")

        def to_int(value: str) -> int:
            try:
                return int(float(value.replace("w", "0000").replace("万", "0000")))
            except ValueError:
                return 0

        items.append(
            {
                "index": index,
                "title": parts[0],
                "platform": parts[1],
                "url": parts[2],
                "views": to_int(parts[3]),
                "likes": to_int(parts[4]),
                "saves": to_int(parts[5]),
                "comments": to_int(parts[6]),
                "observed_pattern": parts[7],
            }
        )
    return items[:30]

