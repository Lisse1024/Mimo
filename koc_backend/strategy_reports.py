import json
from datetime import datetime
from typing import Any

from .artifacts import ensure_confidence
from .catalog import PLATFORM_LIBRARY, STAGE_LIBRARY, TRACK_LIBRARY
from .homepage_signals import build_homepage_column_plan, build_homepage_evidence_map
from .llm import call_kimi_json
from .profiles import profile_brief
from .schemas import ADVISOR_SUMMARY_SCHEMA, AGENT_RUN_SCHEMA, HOT_VIDEO_SCHEMA, INTERNAL_DIAGNOSTIC_SCHEMA, STRATEGY_SCHEMA

def build_agent_run(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    hot_video_analysis: dict[str, Any],
    strategy: dict[str, Any],
) -> dict[str, Any]:
    has_assets = bool(profile.get("asset_files"))
    work_links = profile.get("work_links", [])
    platform_snapshot = profile.get("platform_snapshot", {})
    mode = "vision_plus_strategy" if has_assets else "link_and_text_strategy"
    tool_calls = [
        {
            "tool": "ProfileMemory.write",
            "owner_agent": "主控增长 Agent",
            "input": "用户画像、平台、赛道、目标、限制和当前问题",
            "output": f"已写入 {profile.get('nickname', '用户')} 的增长档案，阶段为 {STAGE_LIBRARY[profile['stage']]}。",
            "status": "done",
        },
        {
            "tool": "PlatformProfileResolver.resolve",
            "owner_agent": "平台线索解析器",
            "input": "平台账号 ID、主页地址、作品链接和目标平台",
            "output": platform_snapshot.get("explain", "已保存平台身份线索，等待数据连接器拉取作品信息。"),
            "status": "done" if platform_snapshot.get("connector_status") == "ready_for_fetch" else platform_snapshot.get("connector_status", "skipped"),
        },
        {
            "tool": "LinkIntake.parse",
            "owner_agent": "链接解析器",
            "input": "用户提交的主页/作品链接",
            "output": f"识别到 {len(work_links)} 条链接；当前作为待核验线索，不假装已观看外链内容。",
            "status": "done" if work_links else "skipped",
        },
        {
            "tool": "VisionAnalyzer.inspect",
            "owner_agent": "视觉素材分析器",
            "input": "主页截图、封面、视频样本",
            "output": asset_analysis.get("asset_summary", "未获得视觉素材分析结果。"),
            "status": "done" if has_assets else "skipped",
        },
        {
            "tool": "BenchmarkReasoner.compare",
            "owner_agent": "对标拆解器",
            "input": "用户赛道、平台偏好、作品链接和上传素材",
            "output": hot_video_analysis.get("benchmark_summary", "已根据可用资料推断可复刻结构。"),
            "status": "done",
        },
        {
            "tool": "StrategyPlanner.generate",
            "owner_agent": "主控增长 Agent",
            "input": "定位、KPI、内容支柱、风险和阶段目标",
            "output": strategy.get("north_star_goal") or strategy.get("positioning") or "已生成增长策略。",
            "status": "done",
        },
    ]
    memory_written = [
        f"平台={PLATFORM_LIBRARY[profile['platform']]['name']}",
        f"赛道={TRACK_LIBRARY[profile['track']]['name']}",
        f"平台身份={profile.get('platform_account_id') or '未提供'}",
        f"素材={len(profile.get('asset_files', []))} 个上传文件",
        f"链接={len(work_links)} 条作品/主页链接",
        f"需求={profile.get('user_request', '未填写')[:80]}",
    ]
    return {
        "run_id": f"agent-run-{profile['id']}",
        "objective": f"为 {profile.get('account_name', '该账号')} 制定低成本 KOC 涨粉策略，并给出下一步可执行动作。",
        "mode": mode,
        "memory_written": memory_written,
        "tool_calls": tool_calls,
        "handoffs": [],
        "next_actions": (strategy.get("kpis") or strategy.get("message_framework") or [])[:5],
    }


def generate_advisor_summary(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    internal_reports: list[dict[str, Any]],
    hot_video_analysis: dict[str, Any],
    strategy: dict[str, Any],
) -> dict[str, Any]:
    system_prompt = (
        "你是一个真正负责落地结果的 KOC 主控增长 Agent。"
        "你会吸收内部诊断摘要，但只以一个 Agent 身份对外输出。"
        "请先给一句诊断，再给证据链，再给最小可执行动作，再给一条可以直接开拍的内容任务。"
        "你的表达要专业、完整、克制，不要夸大，不要空话。"
        "如果资料里只有平台账号 ID、主页链接或作品链接而没有真实连接器返回数据，必须把它们视为待核验线索。"
        "不要承诺具体涨粉数或精确转粉率；不要强制建议隐藏旧作品，只能给出低风险的测试动作。"
    )
    user_prompt = (
        "请把以下内部诊断结果收敛成主控增长 Agent 的统一结论。\n\n"
        + profile_brief(profile)
        + "\n视觉素材分析：\n"
        + json.dumps(asset_analysis, ensure_ascii=False, indent=2)
        + "\n内部诊断摘要：\n"
        + json.dumps(internal_reports, ensure_ascii=False, indent=2)
        + "\n爆款对标分析：\n"
        + json.dumps(hot_video_analysis, ensure_ascii=False, indent=2)
        + "\n最终策略：\n"
        + json.dumps(strategy, ensure_ascii=False, indent=2)
    )
    summary = call_kimi_json(system_prompt, user_prompt, ADVISOR_SUMMARY_SCHEMA)
    summary["advisor_name"] = summary.get("advisor_name") or "主控增长 Agent"
    summary["tone"] = summary.get("tone") or "冷静、专业、愿意一起推进"
    return summary


def generate_growth_strategy(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    internal_reports: list[dict[str, Any]],
    hot_video_analysis: dict[str, Any],
) -> dict[str, Any]:
    system_prompt = (
        "你是短视频账号增长策略智能体。"
        "请只输出最终增长策略，不要输出内部诊断摘要或其它外层字段。"
        "策略必须适配用户当前阶段、目标平台、素材证据和现实限制。"
        "如果缺少真实平台连接器数据，要明确这是基于主页截图、用户资料和模型推断。"
        "不要承诺具体涨粉数、固定转粉率、完播率或搜索占比；没有后台数据时只能提出观察指标。"
        "不要直接要求删除、隐藏、私密旧作品；如确有必要，只能建议结合后台数据和用户意愿再决定。"
    )
    user_prompt = (
        "请基于以下资料生成一套可执行增长策略。\n\n"
        + profile_brief(profile)
        + "\n视觉素材分析：\n"
        + json.dumps(asset_analysis, ensure_ascii=False, indent=2)
        + "\n内部诊断摘要：\n"
        + json.dumps(internal_reports, ensure_ascii=False, indent=2)
        + "\n爆款对标分析：\n"
        + json.dumps(hot_video_analysis, ensure_ascii=False, indent=2)
    )
    try:
        return call_kimi_json(system_prompt, user_prompt, STRATEGY_SCHEMA)
    except RuntimeError as exc:
        return fallback_strategy(profile, asset_analysis, internal_reports, str(exc))


def fallback_hot_video_analysis(profile: dict[str, Any], asset_analysis: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "benchmark_summary": "本轮没有稳定获得爆款样本结构化分析，先基于抖音冷启动常识和主页截图做保守对标。",
        "hot_video_patterns": [
            {
                "pattern": "先用明确人设或固定栏目降低用户理解成本",
                "evidence": "主页截图显示内容类型较杂，用户很难一眼判断账号会持续提供什么。",
                "why_it_works": "抖音冷启动阶段需要让系统和用户都快速理解账号内容标签。",
            },
            {
                "pattern": "开头优先使用当前素材里已经能核验的台词、动作、字幕、标题或场景符号",
                "evidence": "降级时缺少稳定爆款样本，不能套用固定三段式，只能做基于当前证据的最小测试。",
                "why_it_works": "具体素材线索比抽象模板更容易验证 3 秒留存、完播和评论关键词。",
            },
        ],
        "gap_against_user": [
            "当前账号更像个人随手记录，还没有形成可复制栏目。",
            "封面、标题、内容主题缺少统一识别点，难以积累用户预期。",
        ],
        "shooting_advice": [
            "先固定一个低成本栏目，例如“游戏嘴替日常”或“发疯式游戏吐槽”。",
            "每条视频开头先使用当前素材中最具体、可核验的一句台词、一个动作、一个字幕或一个场景符号。",
        ],
        "editing_tutorial": [
            "降级时只生成“基于当前证据的最小测试脚本”：先放可核验证据，再补必要上下文，最后引导发布后观察评论关键词。",
            "统一字幕样式和封面关键词，避免每条视频像不同账号发的。",
        ],
        "replication_template": [
            "标题模板：我以为这局稳了，结果队友一句话把我打醒。",
            "脚本模板：先放当前素材中最具体的可见/可听/可读线索，再解释这条线索为什么值得看，最后引导复盘真实指标。",
        ],
        "source_type": "model_inference",
        "confidence": "low",
        "limitations": [f"爆款分析降级原因：{reason[:180]}"],
    }


def fallback_strategy(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    internal_reports: list[dict[str, Any]],
    reason: str,
) -> dict[str, Any]:
    platform_name = PLATFORM_LIBRARY.get(profile.get("platform", "custom-platform"), PLATFORM_LIBRARY["custom-platform"])["name"]
    homepage_evidence_map = build_homepage_evidence_map(profile, asset_analysis)
    homepage_column_plan, homepage_column_plan_status = build_homepage_column_plan(homepage_evidence_map)
    patterns = [
        item
        for item in homepage_evidence_map.get("content_patterns", [])
        if isinstance(item, dict) and item.get("pattern_name") and item.get("evidence")
    ]
    strongest = str(patterns[0].get("pattern_name", "")) if patterns else "证据最明确的主页内容方向"
    return {
        "positioning": f"{platform_name} 主页诊断已降级为证据驱动模式：先围绕当前可见证据最明确的方向做小样本验证，不直接套垂类模板。",
        "north_star_goal": f"围绕“{strongest}”连续发布同证据来源的小样本内容，并用真实后台数据验证是否值得继续。",
        "kpis": ["24/48 小时播放量", "3 秒留存", "完播率", "评论关键词", "主页点击率", "关注转化", "负反馈"],
        "audience_insights": [
            "当前只基于主页可见信息判断，缺少后台播放、完播、转粉、评论区和时间序列数据。",
            "不能证明平台推荐、转粉效率或账号趋势已经发生变化，只能先做小样本实验。",
        ],
        "strategic_diagnosis": (
            asset_analysis.get("homepage_diagnosis", [])[:3]
            or [report.get("key_findings", ["定位和内容结构需要收敛。"])[0] for report in internal_reports[:3]]
        ),
        "content_pillars": [
            {
                "name": str(item.get("pattern_name", "")),
                "why": str(item.get("why_it_matters", "该候选方向来自 homepage_evidence_map.content_patterns，需要小样本验证。")),
                "themes": [str(value) for value in item.get("evidence", [])[:3]],
                "formats": ["同证据来源连续测试", "统一封面标题结构", "发布后回填真实指标"],
            }
            for item in patterns[:3]
        ],
        "growth_phases": [
            {
                "phase": "第 1 周",
                "objective": "验证主页可见证据中最明确的内容模式",
                "actions": ["选择 1 个证据最明确的方向", "连发同证据来源的小样本内容", "统一封面关键词、标题句式和结尾提问"],
                "expected_signal": "24/48 小时播放、3 秒留存、完播、评论关键词、主页点击和关注转化出现可比较变化。",
            }
        ],
        "message_framework": ["证据来源", "栏目假设", "小样本动作", "复盘指标"],
        "risks": ["没有后台数据时不能声称平台已经验证某方向。", f"策略生成降级原因：{reason[:160]}"],
        "rationale": asset_analysis.get("evidence", [])[:3] or ["基于主页截图、用户输入和可见线索做保守判断。"],
        "homepage_evidence_map": homepage_evidence_map,
        "homepage_column_plan": homepage_column_plan,
        "homepage_column_plan_status": homepage_column_plan_status,
        "source_type": "model_inference",
        "confidence": "low",
    }


def fallback_advisor_summary(
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    strategy: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    homepage_evidence_map = strategy.get("homepage_evidence_map") if isinstance(strategy.get("homepage_evidence_map"), dict) else build_homepage_evidence_map(profile, asset_analysis)
    patterns = [
        item
        for item in homepage_evidence_map.get("content_patterns", [])
        if isinstance(item, dict) and item.get("pattern_name") and item.get("evidence")
    ]
    strongest = str(patterns[0].get("pattern_name", "")) if patterns else "证据最明确的主页内容方向"
    return {
        "advisor_name": "主控增长 Agent",
        "tone": "冷静、专业、愿意一起推进",
        "one_sentence_diagnosis": "本轮主页诊断只基于可见证据做保守判断：具体栏目建议必须来自上游主页证据图，不能按垂类模板硬套。",
        "core_judgements": [
            f"先围绕“{strongest}”做小样本测试；如果证据不足，则先补最近作品详情、封面标题、后台数据和评论区截图。",
            "当前没有后台数据，不能证明平台推荐、转粉效率或账号趋势已经发生变化。",
            "没有 evidence_basis 的具体栏目建议不应展示给用户。",
        ],
        "evidence_chain": (
            asset_analysis.get("homepage_diagnosis", [])[:3]
            or [asset_analysis.get("asset_summary", "依据主页截图、用户资料和平台线索做模型推断。")]
        ),
        "first_actions": [
            "先选择证据最明确的一个主页方向。",
            "连续发布同证据来源的小样本内容，不混发其它方向。",
            "48 小时后回填播放、3 秒留存、完播率、评论关键词、主页点击率、关注转化和负反馈。",
        ],
        "first_content_task": {},
        "why_this_path": [
            "主页诊断阶段只做栏目实验，不生成单条作品脚本。",
            strategy.get("north_star_goal", "先验证证据最明确的主页模式是否值得连续发布。"),
        ],
        "follow_up_question": "补充最近作品详情、封面标题、后台数据和评论区截图后，可以继续生成更具体的 evidence_basis 栏目方案。",
        "source_type": "model_inference",
        "confidence": "low",
        "limitations": [f"Agent 摘要降级原因：{reason[:180]}"],
    }


def build_advisor_internal_reports(profile: dict[str, Any], asset_analysis: dict[str, Any]) -> list[dict[str, Any]]:
    diagnosis = asset_analysis.get("homepage_diagnosis", [])
    opportunities = asset_analysis.get("content_opportunities", [])
    editing = asset_analysis.get("shooting_and_editing_advice", [])
    evidence = asset_analysis.get("evidence", [])
    return [
        {
            "agent_name": "内容结构诊断模块",
            "professional_lens": "判断账号定位、内容结构和系列化机会。",
            "key_findings": diagnosis[:2] or ["当前账号需要先收敛内容主线，避免多方向随机发布。"],
            "evidence": evidence[:2] or [asset_analysis.get("asset_summary", "依据主页截图和用户资料判断。")],
            "optimization_opportunities": opportunities[:2] or ["选择一个低成本、可连续更新的主栏目进行测试。"],
            "risks": ["如果继续多赛道混发，系统和用户都难以形成稳定预期。"],
            "source_type": "visual_observation",
            "confidence": ensure_confidence(asset_analysis.get("confidence"), "medium"),
        },
        {
            "agent_name": "流量数据洞察模块",
            "professional_lens": "判断播放波动、互动不足和冷启动指标观察重点。",
            "key_findings": [
                "当前只有主页截图和可见公开数据，不能替代后台播放、完播和互动来源数据。",
                "播放波动更可能来自内容标签不稳定和开头钩子不明确，而不是单纯发布时间问题。",
            ],
            "evidence": evidence[:2] or ["未接入真实平台连接器，指标判断属于模型推断。"],
            "optimization_opportunities": ["第一周记录每条视频的播放、点赞、评论、收藏和主页点击，形成复盘样本。"],
            "risks": ["不要用单条公开视频表现直接推断长期转粉能力。"],
            "source_type": "model_inference",
            "confidence": "medium",
        },
        {
            "agent_name": "创意表达优化模块",
            "professional_lens": "给出拍摄、剪辑、封面和开头钩子建议。",
            "key_findings": editing[:2] or ["当前缺少后台完播、评论来源和逐条留存数据，不能判断哪种脚本结构已经被验证有效。"],
            "evidence": evidence[:2] or [asset_analysis.get("asset_summary", "依据主页截图和素材说明判断。")],
            "optimization_opportunities": editing[:3] or ["下一轮可以用固定栏目结构做小样本测试，并用播放、评论、收藏和主页点击验证效果。"],
            "risks": ["剪辑复杂度过高会让低成本冷启动难以坚持。"],
            "source_type": "visual_observation",
            "confidence": ensure_confidence(asset_analysis.get("confidence"), "medium"),
        },
    ]


