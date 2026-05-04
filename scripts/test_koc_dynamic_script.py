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

    disclaimer_fact_ledger = {
        "visible_facts": [
            {"source_type": "visual_frame", "text": "人物争执画面A"},
            {"source_type": "visual_frame", "text": "作者声明：'虚构演绎，仅供娱乐'"},
        ],
        "audio_facts": [],
        "text_facts": [
            {"source_type": "ocr_text", "text": "情绪转折字幕A"},
            {"source_type": "ocr_text", "text": "作者声明：'虚构演绎，仅供娱乐'"},
        ],
        "possible_source": {"name": "", "confidence": "unknown", "evidence": []},
        "growth_hooks": [
            {"hook": "作者声明：'虚构演绎，仅供娱乐'", "evidence": "作者声明：'虚构演绎，仅供娱乐'", "confidence": "medium"},
            {"hook": "情绪转折字幕A制造讨论入口", "evidence": "情绪转折字幕A", "confidence": "medium"},
        ],
        "limitations": ["作者声明属于边界信息，不能当作增长钩子"],
    }
    disclaimer_asset = {
        "status": "success",
        "confidence": "medium",
        "fact_ledger": disclaimer_fact_ledger,
        "work_understanding": {
            "fact_ledger": disclaimer_fact_ledger,
            "content_type": "platform_native",
            "content_type_confidence": "medium",
            "content_type_evidence": ["人物争执画面A", "情绪转折字幕A"],
        },
        "source_identification": {"possible_title": "", "content_type": "unknown", "confidence": "low", "evidence": []},
        "evidence": ["人物争执画面A", "情绪转折字幕A"],
        "limitations": disclaimer_fact_ledger["limitations"],
    }
    disclaimer_bundle = build_rule_based_advisor_bundle(profile, disclaimer_asset)
    disclaimer_strategy = disclaimer_bundle["strategy"]
    disclaimer_script = json.dumps(disclaimer_strategy.get("script_steps", []), ensure_ascii=False)
    for forbidden in ["作者声明", "虚构演绎", "仅供娱乐"]:
        assert forbidden not in disclaimer_script, disclaimer_script
    assert "情绪转折字幕A" in disclaimer_script or "人物争执画面A" in disclaimer_script, disclaimer_script

    inferred_audience_ledger = {
        "visible_facts": [],
        "audio_facts": [],
        "text_facts": [
            {"source_type": "hashtag", "text": "标签明确标注#关系标签A，这是热门CP组合"},
            {"source_type": "ocr_text", "text": "字幕00:00：内容字幕A"},
            {"source_type": "ocr_text", "text": "字幕00:03：内容字幕B"},
        ],
        "possible_source": {"name": "作品A", "confidence": "medium", "evidence": ["标题明确标注作品A"]},
        "growth_hooks": [
            {"hook": "CP向标签#关系标签A吸引BL同人受众", "evidence": "标签明确标注#关系标签A，这是热门CP组合", "confidence": "medium"},
            {"hook": "字幕00:00：内容字幕A形成开头讨论点", "evidence": "字幕00:00：内容字幕A", "confidence": "medium"},
        ],
        "timeline": [
            {"time_range": "00:00-00:02", "text_facts": ["字幕00:00：内容字幕A"]},
            {"time_range": "00:03-00:05", "text_facts": ["字幕00:03：内容字幕B"]},
        ],
        "limitations": [],
    }
    inferred_bundle = build_rule_based_advisor_bundle(
        profile,
        {
            "status": "success",
            "confidence": "medium",
            "fact_ledger": inferred_audience_ledger,
            "work_understanding": {
                "fact_ledger": inferred_audience_ledger,
                "content_type": "media_clip",
                "content_type_confidence": "medium",
                "content_type_evidence": ["标题明确标注作品A", "字幕00:00：内容字幕A"],
            },
            "source_identification": {"possible_title": "作品A", "content_type": "tv_drama", "confidence": "medium", "evidence": ["标题明确标注作品A"]},
            "evidence": ["#关系标签A", "字幕00:00：内容字幕A", "字幕00:03：内容字幕B"],
            "limitations": [],
        },
    )
    inferred_steps = inferred_bundle["strategy"].get("script_steps", [])
    inferred_script = json.dumps(inferred_steps, ensure_ascii=False)
    for forbidden in ["热门CP", "BL同人", "吸引BL同人受众", "CP向"]:
        assert forbidden not in inferred_script, inferred_script
    assert "#关系标签A" in inferred_script or "字幕00:00：内容字幕A" in inferred_script, inferred_script
    times = [str(step.get("time", "")) for step in inferred_steps if isinstance(step, dict)]
    assert not {"0-3 秒", "4-10 秒", "11-25 秒"}.intersection(times), times

    page_context_ledger = {
        "visible_facts": [
            {"source_type": "page_visible_text", "text": "搜索框文字：作品番外篇"},
            {"source_type": "page_visible_text", "text": "账号信息：@测试账号 · 2月8日"},
            {"source_type": "page_visible_text", "text": "合集标签：第427集：#作品A #话题A"},
        ],
        "audio_facts": [],
        "text_facts": [
            {"source_type": "ocr_text", "text": "字幕00:09-00:14：我只跟过去的自己比"},
            {"source_type": "ocr_text", "text": "字幕00:03：内容转折A"},
            {"source_type": "on_screen_text", "text": "集数标题：第480集：简直太精彩了~~~"},
            {"source_type": "on_screen_text", "text": "章节信息：第2章：动物的烦恼"},
            {"source_type": "ocr_text", "text": "字幕文本序列：'做人类好累啊'→'永远要分一二三等'→'人还分三六九等'→'做动物就好了'→'不分阶级'→'没有烦恼'→'不是的动物也有'→'我看过泰国当地一个新闻'"},
        ],
        "possible_source": {"name": "作品A", "confidence": "medium", "evidence": ["搜索框文字：作品番外篇", "标签#作品A"]},
        "growth_hooks": [
            {"hook": "搜索框文字：作品番外篇", "evidence": "搜索框文字：作品番外篇", "confidence": "medium"},
            {"hook": "字幕00:09-00:14：我只跟过去的自己比", "evidence": "字幕00:09-00:14：我只跟过去的自己比", "confidence": "medium"},
        ],
        "timeline": [
            {"time_range": "00:09-00:14", "text_facts": ["字幕00:09-00:14：我只跟过去的自己比"]},
        ],
        "limitations": [],
    }
    page_context_bundle = build_rule_based_advisor_bundle(
        profile,
        {
            "status": "success",
            "confidence": "medium",
            "fact_ledger": page_context_ledger,
            "work_understanding": {
                "fact_ledger": page_context_ledger,
                "content_type": "media_clip",
                "content_type_confidence": "medium",
                "content_type_evidence": ["字幕00:09-00:14：我只跟过去的自己比"],
            },
            "source_identification": {"possible_title": "作品A", "content_type": "tv_drama", "confidence": "medium", "evidence": ["标签#作品A"]},
            "evidence": ["搜索框文字：作品番外篇", "字幕00:09-00:14：我只跟过去的自己比"],
            "limitations": [],
        },
    )
    page_context_strategy = page_context_bundle["strategy"]
    page_context_output = json.dumps(page_context_bundle, ensure_ascii=False)
    script_only = json.dumps(page_context_strategy.get("script_steps", []), ensure_ascii=False)
    for forbidden in ["搜索框", "搜索栏", "账号信息", "@测试账号", "合集标签", "第427集", "集数标题", "第480集", "章节信息", "第2章"]:
        assert forbidden not in script_only, script_only
    assert "字幕00:09-00:14：我只跟过去的自己比" in script_only, script_only
    assert "字幕00:09-00:14：我只跟过去的自己比" in script_only, script_only
    assert "我看过泰国当地一个新闻" not in script_only, script_only
    assert "你最先记住的是" not in script_only, script_only
    assert "核心看点是「搜索框文字" not in page_context_output, page_context_output
    page_times = [str(step.get("time", "")) for step in page_context_strategy.get("script_steps", []) if isinstance(step, dict)]
    for forbidden_time in ["承接：解释可见内容价值", "核心看点：放大可验证细节"]:
        assert forbidden_time not in page_times, page_times

    performance_ledger = {
        "visible_facts": [
            {"source_type": "visual_frame", "text": "画面：手部吉他指弹近景"},
            {"source_type": "runtime_context", "text": "平台：抖音网页版（Microsoft 微软浏览器浏览器）"},
            {"source_type": "visual_frame", "text": "平台UI元素：抖音精选、推荐、关注等导航栏"},
            {"source_type": "page_visible_text", "text": "视频时长：29秒（进度条显示00:01/00:29）"},
            {"source_type": "page_visible_text", "text": "抖音原生界面元素完整（点赞/评论/收藏按钮布局）"},
            {"source_type": "on_screen_text", "text": "时间戳：7小时前"},
            {"source_type": "visible_metric", "text": "右下角互动数据：点赞7628，评论120，收藏418，分享589"},
        ],
        "audio_facts": [{"source_type": "asr_text", "text": "可听到吉他旋律进入"}],
        "text_facts": [
            {"source_type": "title", "text": "标题：在这寂寞的季节~~ 抱歉最近更新晚了"},
            {"source_type": "on_screen_text", "text": "屏幕文字：吉他指弹Cover"},
        ],
        "possible_source": {"name": "原创音乐演奏（非影视片段）", "confidence": "medium", "evidence": ["画面为真人实拍吉他演奏，非影视剧画面", "屏幕文字：吉他指弹Cover"]},
        "growth_hooks": [
            {
                "hook": "选择测试歌曲A这类90后/00后集体记忆歌曲，配合秋天关键词",
                "evidence": "标题：在这寂寞的季节~~ 抱歉最近更新晚了",
                "confidence": "low",
            },
            {
                "hook": "文案'在这寂寞的季节'直接点出歌曲名与情绪关键词'寂寞'，引发秋日/深夜情绪共鸣",
                "evidence": "文案'在这寂寞的季节'",
                "confidence": "medium",
            },
            {
                "hook": "文案直接引用测试歌曲名，配合慢节奏吉他演奏，目标受众为夜间寻求情绪慰藉的用户",
                "evidence": "文案'在这寂寞的季节'",
                "confidence": "low",
            },
            {
                "hook": "吉他旋律进入 + 手部指弹近景",
                "evidence": "画面：手部吉他指弹近景；可听到吉他旋律进入",
                "confidence": "medium",
            },
        ],
        "timeline": [
            {
                "time_range": "00:00-00:05",
                "visible_facts": ["画面：手部吉他指弹近景"],
                "audio_facts": ["可听到吉他旋律进入"],
            }
        ],
        "limitations": ["无后台数据", "无评论区截图"],
    }
    performance_bundle = build_rule_based_advisor_bundle(
        {**profile, "id": "mock-performance-core-hook", "task_intent": "single_work_analysis", "work_links": []},
        {
            "status": "success",
            "confidence": "medium",
            "fact_ledger": performance_ledger,
            "work_understanding": {"fact_ledger": performance_ledger, "content_type": "media_clip", "content_type_confidence": "medium", "content_type_evidence": ["视频时长：29秒（进度条显示00:01/00:29）"]},
            "source_identification": {"possible_title": "原创音乐演奏（非影视片段）", "content_type": "unknown", "confidence": "medium", "evidence": ["画面为真人实拍吉他演奏，非影视剧画面", "屏幕文字：吉他指弹Cover"]},
            "video_understanding": {"timeline": performance_ledger["timeline"], "observable_facts": ["画面：手部吉他指弹近景", "可听到吉他旋律进入"]},
            "evidence": ["画面：手部吉他指弹近景", "可听到吉他旋律进入", "屏幕文字：吉他指弹Cover"],
            "limitations": performance_ledger["limitations"],
        },
    )
    performance_strategy = performance_bundle["strategy"]
    performance_text = json.dumps(performance_bundle, ensure_ascii=False)
    performance_script = json.dumps(performance_strategy.get("script_steps", []), ensure_ascii=False)
    assert performance_strategy.get("content_type") == "performance", performance_strategy.get("content_type")
    for forbidden in ["标题：在这寂寞的季节", "抱歉最近更新晚了", "平台：抖音网页版", "Microsoft", "微软浏览器", "浏览器浏览器", "视频时长", "进度条", "00:01/00:29", "抖音原生界面", "点赞/评论/收藏按钮布局", "平台UI元素", "抖音精选", "时间戳", "7小时前", "右下角互动数据", "点赞7628", "收藏418", "90后", "00后", "集体记忆", "情怀金曲", "氛围感演奏", "秋日/深夜情绪共鸣", "引发秋日", "目标受众", "夜间寻求", "流量密码", "治愈陪伴感", "片源判断", "完整剧情"]:
        assert forbidden not in performance_script, performance_script
    assert "画面：手部吉他指弹近景" in performance_script or "可听到吉他旋律进入" in performance_script, performance_script
    assert "核心看点是「标题：" not in performance_text, performance_text
    assert "片源判断" not in performance_text, performance_text
    assert "避免完整搬运原片" not in performance_text, performance_text
    assert any(metric in performance_strategy.get("validation_metrics", []) for metric in ["分享率", "评论关键词：点歌/求曲名"]), performance_strategy.get("validation_metrics")

    print("koc dynamic script regression passed")


if __name__ == "__main__":
    main()
