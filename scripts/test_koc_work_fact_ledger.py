from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.work_understanding import build_work_understanding


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

    print("koc work fact ledger regression passed")


if __name__ == "__main__":
    main()
