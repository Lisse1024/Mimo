from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.work_understanding import build_work_understanding
from koc_backend.homepage_signals import build_homepage_column_plan, build_homepage_evidence_map


def joined(items: list[object]) -> str:
    return "\n".join(str(item) for item in items)


def main() -> None:
    profile = {
        "id": "mock-work-ledger",
        "task_intent": "single_work_analysis",
        "result_mode": "single_work_analysis",
        "user_request": "请分析这条经典片段：宫廷玉液酒，一百八一杯。场景是太后大酒楼，人物线索有赵丽蓉、巩汉林、金珠。",
        "evidence_facts": [
            "台词：宫廷玉液酒，一百八一杯",
            "场景：太后大酒楼",
            "人物线索：赵丽蓉、巩汉林、金珠",
        ],
        "work_links": [
            {
                "shared_title": "经典小品片段：宫廷玉液酒，一百八一杯",
                "shared_tags": ["小品", "经典片段", "太后大酒楼"],
                "url": "https://example.com/mock-work",
            }
        ],
    }
    asset_analysis = {
        "status": "success",
        "confidence": "medium",
        "asset_summary": "mock：当前只有抽帧、OCR 和用户文字线索。",
        "source_identification": {
            "possible_title": "unknown",
            "content_type": "variety",
            "confidence": "medium",
            "evidence": ["OCR 出现“宫廷玉液酒，一百八一杯”；画面/文字线索出现“太后大酒楼”。"],
            "uncertainty": ["未获得原始链接、完整上下文和授权信息。"],
        },
        "clip_context": {
            "visible_plot": "画面/文字线索指向酒楼场景和推销式台词，但不能扩写完整剧情。",
            "characters_or_roles": ["赵丽蓉", "巩汉林", "金珠"],
            "missing_context": ["无完整视频上下文", "无评论区", "无后台数据", "无授权信息"],
        },
        "video_understanding": {
            "timeline": [
                {
                    "time_range": "00:00-00:03",
                    "visual_fact": "画面或字幕线索出现“太后大酒楼”。",
                    "ocr_text": "宫廷玉液酒，一百八一杯",
                    "audio_transcript": "",
                    "inference": "可能是经典小品片段，但需要更多证据确认片源。",
                    "confidence": "medium",
                }
            ],
            "observable_facts": ["抽帧中可见酒楼相关文字线索。"],
            "hook_candidates": ["“宫廷玉液酒，一百八一杯”这句具体台词具有记忆点", "“太后大酒楼”是明确场景符号"],
            "missing_evidence": ["评论区截图缺失", "后台数据缺失", "完整 ASR 缺失", "平台授权信息缺失"],
            "context_risk": "high",
        },
        "video_observations": ["可见线索集中在经典台词和酒楼场景。"],
        "traffic_mechanism": ["具体台词“宫廷玉液酒，一百八一杯”可作为开头记忆点。"],
        "evidence": ["OCR 文本：宫廷玉液酒，一百八一杯", "场景文字：太后大酒楼"],
        "limitations": ["无评论区截图", "无后台数据", "无授权信息", "只有少量抽帧，不能确认完整剧情"],
    }

    understanding = build_work_understanding(profile, asset_analysis)
    ledger = understanding.get("fact_ledger")
    assert isinstance(ledger, dict), "fact_ledger should exist"

    text_facts = joined(ledger.get("text_facts", []))
    visible_or_text = joined([*ledger.get("visible_facts", []), *ledger.get("text_facts", [])])
    assert "宫廷玉液酒，一百八一杯" in text_facts, text_facts
    assert "太后大酒楼" in visible_or_text, visible_or_text

    possible_source = ledger.get("possible_source")
    assert isinstance(possible_source, dict), possible_source
    for key in ["name", "confidence", "evidence"]:
        assert key in possible_source, possible_source

    characters = ledger.get("characters_or_people")
    assert isinstance(characters, list) and characters, characters
    for character in characters:
        assert "confidence" in character, character
        assert character.get("role") in {"unknown", "疑似"} or "疑似" in str(character.get("role")), character

    limitations = joined(ledger.get("limitations", []))
    assert "评论" in limitations, limitations
    assert "后台" in limitations, limitations
    assert "授权" in limitations, limitations
    assert "完整" in limitations or "上下文" in limitations, limitations

    hooks = ledger.get("growth_hooks")
    assert isinstance(hooks, list) and hooks, hooks
    generic = {"冲突", "反差", "情绪价值"}
    for hook in hooks:
        assert hook.get("hook") not in generic, hook
        assert hook.get("evidence"), hook

    homepage_profile = {
        "account_id": "待确认账号",
        "nickname": "本地用户",
        "desktop_context": "当前窗口进程 msedgewebview2；当前窗口标题 screen",
        "asset_notes": "upload metadata image/png file size 12345",
        "evidence_facts": [
            {"source_type": "active_window_process", "text": "msedgewebview2"},
            {"source_type": "file_name", "text": "screen-001.png"},
            {"source_type": "profile_bio", "text": "简介A"},
            {"source_type": "work_title", "text": "《作品标题A》第一条"},
            {"source_type": "work_cover_text", "text": "《作品标题A》封面文字A"},
            {"source_type": "work_visible_metric", "text": "可见指标A"},
        ],
    }
    homepage_map = build_homepage_evidence_map(homepage_profile, {"limitations": ["后台数据缺失", "评论区缺失"]})
    homepage_output = joined(
        [
            homepage_map.get("profile_signals", {}),
            homepage_map.get("visible_work_samples", []),
            homepage_map.get("content_patterns", []),
        ]
    )
    for forbidden in ["本地用户", "当前窗口进程", "当前窗口标题", "msedgewebview2", "image/png", "file size", "screen-001.png", "upload metadata"]:
        assert forbidden not in homepage_output, forbidden
    assert "简介A" in homepage_output, homepage_output
    assert "作品标题A" in homepage_output, homepage_output
    assert "封面文字A" in homepage_output, homepage_output
    assert homepage_map.get("content_patterns"), homepage_map
    homepage_plan, homepage_status = build_homepage_column_plan(homepage_map)
    assert homepage_status in {"specific", "direction_only"}, homepage_status
    assert homepage_plan, homepage_plan
    plan_text = joined(homepage_plan)
    assert "作品标题A" in plan_text or "封面文字A" in plan_text or "简介A" in plan_text, plan_text
    for forbidden in ["msedgewebview2", "image/png", "screen-001.png", "file size"]:
        assert forbidden not in plan_text, forbidden

    runtime_only_map = build_homepage_evidence_map(
        {
            "account_id": "待确认账号",
            "nickname": "本地用户",
            "desktop_context": "当前窗口进程 chrome；当前窗口标题 screen",
            "asset_notes": "upload asset image/png 文件大小 12345",
            "evidence_facts": [
                {"source_type": "active_window_title", "text": "screen"},
                {"source_type": "mime_type", "text": "image/png"},
                {"source_type": "file_size", "text": "文件大小 12345"},
            ],
        },
        {"limitations": ["后台数据缺失", "评论区缺失"]},
    )
    runtime_plan, runtime_status = build_homepage_column_plan(runtime_only_map)
    assert not runtime_only_map.get("content_patterns"), runtime_only_map
    assert runtime_status == "insufficient_evidence", runtime_status
    assert runtime_plan == [], runtime_plan

    print("koc work fact ledger regression passed")


if __name__ == "__main__":
    main()
