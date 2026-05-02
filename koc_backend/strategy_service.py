import json
import re
from datetime import datetime
from typing import Any

from .artifacts import annotate_workspace_bundle, apply_business_guardrails, build_evidence_summary
from .catalog import PLATFORM_LIBRARY, TRACK_LIBRARY
from .llm import call_kimi_json
from .profile_intent import (
    bundle_has_cross_type_residue,
    infer_video_prompt_profile,
    is_profile_link_only_request,
    is_single_work_analysis_request,
    normalize_task_intent,
    video_prompt_capsule_text,
)
from .profiles import profile_brief
from .schemas import (
    ADVISOR_FAST_BUNDLE_SCHEMA,
    ADVISOR_SUMMARY_SCHEMA,
    AGENT_RUN_SCHEMA,
    HOT_VIDEO_SCHEMA,
    INTERNAL_DIAGNOSTIC_SCHEMA,
    STRATEGY_SCHEMA,
)

from .strategy_reports import *  # noqa: F403

def generate_advisor_fast_bundle(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    internal_reports: list[dict[str, Any]],
    hot_video_analysis: dict[str, Any],
) -> dict[str, Any]:
    video_profile = infer_video_prompt_profile(profile, asset_analysis)
    task_intent = normalize_task_intent(profile.get("result_mode") or profile.get("task_intent"), profile)
    intent_guardrail = (
        "本轮任务类型：账号主页诊断。必须围绕账号定位、主页转粉、内容结构、作品矩阵和冷启动下一步输出。"
        "即使截图里出现单条作品封面、动漫/游戏/孩子/图文内容，也只能把它们当作主页作品矩阵证据，"
        "禁止输出片源判断、影视/剧情切片、片段语义、镜头复刻或单条视频脚本。"
        if task_intent != "single_work_analysis"
        else video_prompt_capsule_text(video_profile)
    )
    system_prompt = (
        "你是一个 KOC 主控增长 Agent，必须以统一执行者身份完成诊断、判断和行动规划。"
        + intent_guardrail
        + "\n"
        "请一次性输出 strategy、advisor_summary 和 tasks 三部分。"
        "输出必须基于用户资料、主页/素材视觉证据、平台线索和现实限制。"
        "要求专业、具体、可执行，但要克制：不要承诺具体涨粉数、固定转粉率、完播率或搜索占比。"
        "没有真实平台连接器数据时，只能说基于主页截图、用户输入和模型推断。"
        "不要直接要求删除、隐藏、私密旧作品；如涉及历史内容处理，只能建议先停止混发或后续结合后台数据再决定。"
        "第一条内容任务必须能直接拍摄和剪辑，给出标题、开头钩子、镜头步骤和剪辑注意事项。"
        "如果用户需求是分析当前刷到的单条视频，必须优先输出片源判断、片段语义、流量机制和复刻方案；不要输出账号主页诊断模板。"
        "如果用户粘贴了抖音、小红书、B站等作品分享文案，必须优先读取分享标题、话题标签和链接文本本身；"
        "除非用户明确要求分析本桌宠产品，否则禁止把 DeskMate、桌宠、当前软件窗口当成用户内容资产或创作主角。"
        "当作品分享文案中出现剧名、片名、话题标签时，必须围绕这些线索展开，不要转移到无关赛道。"
        "tasks 只输出 3 条，但必须来自本轮真实诊断：视频任务覆盖片源确认、镜头脚本复刻、发布后验证；账号任务才覆盖定位验证、内容执行和复盘。"
    )
    user_prompt = (
        "请为以下用户生成主控增长 Agent 的首轮结果。\n\n"
        + profile_brief(profile)
        + "\n视觉素材分析：\n"
        + json.dumps(asset_analysis, ensure_ascii=False, indent=2)
        + "\n内部观察摘要：\n"
        + json.dumps(internal_reports, ensure_ascii=False, indent=2)
        + "\n对标与规则化收敛：\n"
        + json.dumps({"hot_video_analysis": hot_video_analysis}, ensure_ascii=False, indent=2)
    )
    try:
        bundle = call_kimi_json(system_prompt, user_prompt, ADVISOR_FAST_BUNDLE_SCHEMA, max_tokens=3200)
    except RuntimeError as exc:
        strategy = fallback_strategy(profile, asset_analysis, internal_reports, str(exc))
        advisor_summary = fallback_advisor_summary(profile, asset_analysis, strategy, str(exc))
        bundle = {"strategy": strategy, "advisor_summary": advisor_summary, "tasks": []}
    bundle["strategy"] = bundle.get("strategy") or fallback_strategy(profile, asset_analysis, internal_reports, "Agent 快链路缺少策略字段。")
    bundle["advisor_summary"] = bundle.get("advisor_summary") or fallback_advisor_summary(
        profile,
        asset_analysis,
        bundle["strategy"],
        "Agent 快链路缺少摘要字段。",
    )
    bundle["tasks"] = normalize_tasks(bundle.get("tasks", []), profile)
    work_links = profile.get("work_links", []) if isinstance(profile.get("work_links"), list) else []
    link_titles = [
        str(item.get("shared_title", ""))
        for item in work_links
        if isinstance(item, dict) and item.get("shared_title")
    ]
    if link_titles:
        bundle_text = json.dumps(bundle, ensure_ascii=False)
        title_hit = any(part and part in bundle_text for title in link_titles for part in re.split(r"[，,。！？\s]+", title) if len(part) >= 4)
        product_drift = any(word in bundle_text for word in ["DeskMate", "桌宠", "当前软件窗口"])
        if product_drift or not title_hit or bundle_has_cross_type_residue(bundle, video_profile):
            return build_rule_based_advisor_bundle(profile, asset_analysis)
    elif task_intent == "single_work_analysis" and bundle_has_cross_type_residue(bundle, video_profile):
        return build_rule_based_advisor_bundle(profile, asset_analysis)
    return bundle


from .rule_strategy import build_rule_based_advisor_bundle

def generate_workspace_strategy_bundle(profile: dict[str, Any], asset_analysis: dict[str, Any], mode: str = "advisor") -> dict[str, Any]:
    internal_reports = build_advisor_internal_reports(profile, asset_analysis)
    hot_video_analysis = fallback_hot_video_analysis(profile, asset_analysis, "主控增长 Agent 快链路不展开外部爆款长分析。")
    if asset_analysis.get("status") in {"success", "homepage_fallback"} or is_single_work_analysis_request(profile) or is_profile_link_only_request(profile):
        fast_bundle = build_rule_based_advisor_bundle(profile, asset_analysis)
    else:
        fast_bundle = generate_advisor_fast_bundle(profile, asset_analysis, internal_reports, hot_video_analysis)

    bundle = {
        "hot_video_analysis": hot_video_analysis,
        "strategy": fast_bundle.get("strategy", {}),
        "advisor_summary": fast_bundle.get("advisor_summary", {}),
        "tasks": fast_bundle.get("tasks", []),
    }
    bundle = apply_business_guardrails(bundle, profile)
    bundle = annotate_workspace_bundle(bundle, asset_analysis)
    bundle["hot_video_analysis"] = bundle.get("hot_video_analysis") or {}
    bundle["strategy"] = bundle.get("strategy") or {}
    advisor_summary = bundle.get("advisor_summary") or {}
    advisor_summary["advisor_name"] = advisor_summary.get("advisor_name") or "主控增长 Agent"
    advisor_summary["tone"] = advisor_summary.get("tone") or "冷静、专业、愿意一起推进"
    bundle["advisor_summary"] = advisor_summary
    bundle["tasks"] = normalize_tasks(bundle.get("tasks", []), profile)
    return bundle


from .task_service import *  # noqa: F403


