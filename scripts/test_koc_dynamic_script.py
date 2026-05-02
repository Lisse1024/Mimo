from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.rule_strategy import build_rule_based_advisor_bundle


def main() -> None:
    fact_ledger = {
        "visible_facts": ["太后大酒楼", "经理夸张推销动作"],
        "audio_facts": [],
        "text_facts": ["宫廷玉液酒，一百八一杯"],
        "possible_source": {
            "name": "疑似经典春晚小品",
            "confidence": "medium",
            "evidence": ["OCR/台词线索：宫廷玉液酒，一百八一杯", "场景线索：太后大酒楼"],
        },
        "characters_or_people": [
            {"name": "赵丽蓉", "role": "unknown", "confidence": "medium", "evidence": ["用户提供人物线索"]},
            {"name": "巩汉林", "role": "unknown", "confidence": "medium", "evidence": ["用户提供人物线索"]},
            {"name": "金珠", "role": "unknown", "confidence": "low", "evidence": ["用户提供人物线索"]},
        ],
        "timeline": [
            {
                "time_range": "00:00-00:03",
                "visible_facts": ["太后大酒楼", "经理夸张推销动作"],
                "audio_facts": [],
                "text_facts": ["宫廷玉液酒，一百八一杯"],
                "inferred_claims": ["疑似经典小品片段，需要更多上下文确认"],
                "confidence": "medium",
            }
        ],
        "growth_hooks": [
            {
                "hook": "“宫廷玉液酒，一百八一杯”这句台词有强记忆点",
                "evidence": "text_facts: 宫廷玉液酒，一百八一杯",
                "confidence": "medium",
            },
            {
                "hook": "太后大酒楼和夸张推销动作形成可识别场景",
                "evidence": "visible_facts: 太后大酒楼；经理夸张推销动作",
                "confidence": "medium",
            },
        ],
        "limitations": ["无评论区", "无后台数据", "无授权信息", "只有短片段"],
    }
    profile = {
        "id": "mock-dynamic-script",
        "task_intent": "single_work_analysis",
        "result_mode": "single_work_analysis",
        "platform": "douyin",
        "stage": "cold-start",
        "track": "custom-track",
        "account_name": "待确认账号",
        "user_request": "分析这条视频并生成下一条可复刻脚本。",
        "work_links": [],
    }
    asset_analysis = {
        "status": "success",
        "confidence": "medium",
        "asset_summary": "mock：经典片段短素材，只有短片段和文字线索。",
        "fact_ledger": fact_ledger,
        "work_understanding": {"fact_ledger": fact_ledger},
        "source_identification": {
            "possible_title": "疑似经典春晚小品",
            "content_type": "variety",
            "confidence": "medium",
            "evidence": fact_ledger["possible_source"]["evidence"],
            "uncertainty": ["无授权信息", "无完整上下文"],
        },
        "video_understanding": {"timeline": fact_ledger["timeline"], "context_risk": "high", "missing_evidence": fact_ledger["limitations"]},
        "evidence": ["宫廷玉液酒，一百八一杯", "太后大酒楼", "经理夸张推销动作"],
        "limitations": fact_ledger["limitations"],
        "evidence_contract": {
            "forbidden_claims": ["不能声称评论区共识", "不能声称后台数据证明", "不能升级账号长期方向"],
        },
    }

    bundle = build_rule_based_advisor_bundle(profile, asset_analysis)
    strategy = bundle["strategy"]
    script_steps = strategy.get("script_steps")
    assert isinstance(script_steps, list) and len(script_steps) >= 3, script_steps
    required = {"time", "visual", "caption_or_voiceover", "purpose", "evidence", "growth_reason", "confidence"}
    for step in script_steps:
        assert required.issubset(step.keys()), step

    output = json.dumps(bundle, ensure_ascii=False)
    assert any(
        clue in output
        for clue in ["宫廷玉液酒", "太后大酒楼", "夸张推销动作"]
    ), output
    for forbidden in ["最强冲突", "情绪爆点", "评论区都在说", "后台数据证明", "账号长期方向已经确定", "官方/授权搬运已确认", "完整剧情已经确认"]:
        assert forbidden not in output, forbidden

    metrics = strategy.get("validation_metrics")
    for metric in ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"]:
        assert metric in metrics, metrics
    assert strategy.get("decision_rules"), strategy
    assert strategy.get("review_template"), strategy
    assert "完整搬运原片" in output
    assert "不建议完整搬运原片" in output or "不能理解为搬运原片" in output

    polluted_profile = {
        **profile,
        "id": "mock-operational-pollution",
        "user_request": "请分析我当前刷到的这条视频，不要默认把它当成账号主页诊断。",
        "evidence_facts": [
            "用户请求：请分析我当前刷到的这条视频，不要默认把它当成账号主页诊断。",
            "平台线索：hints=2 status=partial",
            "素材处理：video:current-video-recording-123.mp4:完成:8frames",
        ],
    }
    polluted_asset = {
        "status": "vision_parse_failed",
        "confidence": "low",
        "asset_summary": "vision_parse_failed",
        "fact_ledger": {
            "visible_facts": ["Uploaded video assets: 1.", "current-video-recording-123.mp4 sampling: fallback-frame"],
            "text_facts": ["用户请求：请分析我当前刷到的这条视频", "platform hints=2 status=partial"],
            "growth_hooks": [{"hook": "Uploaded assets: 1", "evidence": "current-video-recording-123.mp4", "confidence": "low"}],
            "limitations": ["vision_parse_failed"],
        },
        "video_understanding": {
            "observable_facts": ["Uploaded video assets: 1.", "Sampled video frames available: 8."],
            "timeline": [
                {
                    "time_range": "00:00-00:03",
                    "visible_facts": ["sampled opening frame available; concrete visual facts must be extracted by the vision model from this image."],
                    "text_facts": [],
                    "audio_facts": [],
                    "confidence": "low",
                }
            ],
            "missing_evidence": ["OCR text", "ASR transcript"],
        },
        "source_identification": {"possible_title": "", "confidence": "low", "evidence": ["platform hints=2 status=partial"]},
        "evidence": ["Uploaded assets: 1", "current-video-recording-123.mp4"],
        "limitations": ["视觉结构化失败，本轮仅基于可见标题、字幕、截图帧和页面信息做保守判断。"],
    }
    polluted_bundle = build_rule_based_advisor_bundle(polluted_profile, polluted_asset)
    polluted_output = json.dumps(polluted_bundle, ensure_ascii=False)
    for forbidden in [
        "请分析我当前刷到的这条视频",
        "current-video-recording",
        "Uploaded assets",
        "Uploaded video assets",
        "hints=2",
        "status=partial",
        "fallback-frame",
    ]:
        assert forbidden not in polluted_output, forbidden
    assert "当前可用内容证据不足" in polluted_output or "不能生成具体脚本" in polluted_output, polluted_output

    content_asset = {
        "status": "vision_parse_failed",
        "confidence": "low",
        "fact_ledger": {
            "visible_facts": [{"source_type": "on_screen_text", "text": "屏幕文字A"}],
            "text_facts": [{"source_type": "title", "text": "内容标题A"}, {"source_type": "hashtag", "text": "#测试标签A"}],
            "growth_hooks": [{"hook": "屏幕文字A形成明确开头", "evidence": "屏幕文字A", "confidence": "medium"}],
            "limitations": ["视觉结构化失败"],
        },
        "source_identification": {"possible_title": "", "confidence": "low", "evidence": ["内容标题A", "#测试标签A", "屏幕文字A"]},
        "evidence": ["内容标题A", "#测试标签A", "屏幕文字A"],
        "limitations": ["视觉结构化失败，本轮仅基于可见标题、字幕、截图帧和页面信息做保守判断。"],
    }
    content_bundle = build_rule_based_advisor_bundle(profile, content_asset)
    content_output = json.dumps(content_bundle, ensure_ascii=False)
    assert any(item in content_output for item in ["内容标题A", "#测试标签A", "屏幕文字A"]), content_output
    for forbidden in ["current-video-recording", "Uploaded assets", "hints=2", "status=partial"]:
        assert forbidden not in content_output, forbidden

    tutorial_fact_ledger = {
        "visible_facts": [{"source_type": "visual_frame", "text": "手部操作近景"}],
        "audio_facts": [],
        "text_facts": [
            {"source_type": "on_screen_text", "text": "第N集：不要只会片段A，完整版教学"},
            {"source_type": "hashtag", "text": "#测试技能 #教学"},
            {"source_type": "visible_metric", "text": "收藏数高于评论数"},
        ],
        "possible_source": {"name": "", "confidence": "unknown", "evidence": []},
        "growth_hooks": [
            {"hook": "完整版教学回应学习痛点", "evidence": "第N集：不要只会片段A，完整版教学", "confidence": "medium"},
            {"hook": "手部操作近景降低学习成本", "evidence": "手部操作近景", "confidence": "medium"},
        ],
        "limitations": ["无评论区", "无后台数据", "无完整 ASR"],
    }
    tutorial_asset = {
        "status": "success",
        "confidence": "medium",
        "fact_ledger": tutorial_fact_ledger,
        "work_understanding": {
            "fact_ledger": tutorial_fact_ledger,
            "content_type": "tutorial",
            "content_type_confidence": "high",
            "content_type_evidence": ["完整版教学", "#测试技能 #教学", "手部操作近景"],
        },
        "source_identification": {"possible_title": "", "content_type": "unknown", "confidence": "low", "evidence": []},
        "evidence": ["完整版教学", "#测试技能 #教学", "手部操作近景", "收藏数高于评论数"],
        "limitations": tutorial_fact_ledger["limitations"],
    }
    tutorial_bundle = build_rule_based_advisor_bundle(profile, tutorial_asset)
    tutorial_strategy = tutorial_bundle["strategy"]
    tutorial_output = json.dumps(tutorial_bundle, ensure_ascii=False)
    assert "内容类型判断" in tutorial_output, tutorial_output
    assert "教程" in tutorial_output or "教学" in tutorial_output, tutorial_output
    assert "片源判断" not in tutorial_output, tutorial_output
    assert "完整搬运原片" not in tutorial_output, tutorial_output
    assert any(metric in tutorial_strategy.get("validation_metrics", []) for metric in ["收藏率", "反复观看", "评论关键词：求教程/求资料/求慢速"]), tutorial_strategy.get("validation_metrics")
    for step in tutorial_strategy.get("script_steps", []):
        assert step.get("evidence"), step
        assert step.get("growth_reason"), step
    assert any(item in tutorial_output for item in ["学习痛点", "手部操作近景", "收藏"]), tutorial_output

    media_clip_asset = {
        "status": "success",
        "confidence": "medium",
        "fact_ledger": {
            "visible_facts": [{"source_type": "visual_frame", "text": "影视剧人物对话"}],
            "text_facts": [{"source_type": "title", "text": "某剧片段"}, {"source_type": "hashtag", "text": "#影视剪辑"}],
            "growth_hooks": [{"hook": "人物对话形成片段看点", "evidence": "影视剧人物对话", "confidence": "medium"}],
            "limitations": ["无授权信息", "只有短片段"],
        },
        "work_understanding": {
            "content_type": "media_clip",
            "content_type_confidence": "medium",
            "content_type_evidence": ["某剧片段", "#影视剪辑", "影视剧人物对话"],
        },
        "source_identification": {"possible_title": "某剧片段", "content_type": "tv_drama", "confidence": "medium", "evidence": ["某剧片段", "#影视剪辑"]},
        "evidence": ["某剧片段", "#影视剪辑", "影视剧人物对话"],
        "limitations": ["无授权信息", "只有短片段"],
    }
    media_bundle = build_rule_based_advisor_bundle(profile, media_clip_asset)
    media_output = json.dumps(media_bundle, ensure_ascii=False)
    assert "片源判断" in media_output, media_output
    assert "完整搬运原片" in media_output or "授权" in media_output, media_output
    assert any(metric in media_bundle["strategy"].get("validation_metrics", []) for metric in ["完播率", "评论关键词", "关注转化"]), media_bundle["strategy"].get("validation_metrics")

    print("koc dynamic script regression passed")


if __name__ == "__main__":
    main()
