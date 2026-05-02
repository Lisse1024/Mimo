import json
import re
from typing import Any

from .catalog import PLATFORM_LIBRARY, TRACK_LIBRARY
from .profile_intent import (
    infer_video_prompt_profile,
    infer_homepage_content_categories,
    is_profile_link_only_request,
    is_single_work_analysis_request,
    normalize_task_intent,
    video_prompt_capsule_text,
)
from .homepage_signals import build_homepage_column_plan, build_homepage_evidence_map
from .task_service import normalize_tasks

OPERATIONAL_METADATA_RE = re.compile(
    r"用户请求|請分析|请分析|不要默认把它当成账号主页诊断|platform|hints\s*=|status\s*=|状态\s*=|partial|"
    r"视频[:：].*\.mp4.*完成|\.mp4[:：]?完成|Uploaded\s+assets|Uploaded video assets|asset count|"
    r"current-video-recording|fallback-frame|mediaContext|runtimeContext|runtime context|tool trace|"
    r"platform connector|media processing|素材处理|平台线索|frame-\d+\.jpg|sampling:|duration:|"
    r"sampled .* frame available|pending vision analysis|No uploaded video asset|No video timeline|"
    r"Built sparse video timeline|Sampled video frames available|ffmpeg|cached uploaded media",
    re.IGNORECASE,
)

INSUFFICIENT_CONTENT_EVIDENCE = "当前可用内容证据不足，不能生成具体脚本。请补充连续画面、标题/字幕、ASR/OCR 或作品链接。"


def _compact_visible_phrase(value: Any, max_len: int = 48) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip(" ，。；;")
    if OPERATIONAL_METADATA_RE.search(text):
        return ""
    return text[:max_len].strip()


def _as_text_list(value: Any, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = _compact_visible_phrase(item, 120)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _fact_ledger(asset_analysis: dict[str, Any]) -> dict[str, Any]:
    ledger = asset_analysis.get("fact_ledger") if isinstance(asset_analysis.get("fact_ledger"), dict) else {}
    if ledger:
        return ledger
    work = asset_analysis.get("work_understanding") if isinstance(asset_analysis.get("work_understanding"), dict) else {}
    if isinstance(work.get("fact_ledger"), dict):
        return work["fact_ledger"]
    if isinstance(work.get("work_fact_ledger"), dict):
        return work["work_fact_ledger"]
    return {}


def _ledger_source(ledger: dict[str, Any], fallback_name: str, fallback_confidence: str, fallback_evidence: list[str]) -> dict[str, Any]:
    source = ledger.get("possible_source") if isinstance(ledger.get("possible_source"), dict) else {}
    name = str(source.get("name") or fallback_name or "").strip()
    confidence = str(source.get("confidence") or fallback_confidence or "low")
    if confidence not in {"high", "medium", "low", "unknown"}:
        confidence = "low"
    evidence = _as_text_list(source.get("evidence"), 6) or fallback_evidence[:4]
    return {"name": name, "confidence": confidence, "evidence": evidence}


def _ledger_materials(ledger: dict[str, Any], link_titles: list[str], link_tags: list[str]) -> dict[str, Any]:
    visible = _as_text_list(ledger.get("visible_facts"), 12)
    audio = _as_text_list(ledger.get("audio_facts"), 8)
    text = _as_text_list(ledger.get("text_facts"), 12)
    for title in link_titles[:3]:
        clean_title = _compact_visible_phrase(title, 120)
        if clean_title:
            text.append(f"标题：{clean_title}")
    for tag in link_tags[:5]:
        clean_tag = _compact_visible_phrase(tag, 60)
        if clean_tag:
            text.append(f"标签：{clean_tag}")
    timeline = ledger.get("timeline") if isinstance(ledger.get("timeline"), list) else []
    timeline_lines: list[str] = []
    for item in timeline[:8]:
        if not isinstance(item, dict):
            continue
        time_range = str(item.get("time_range") or item.get("timeRange") or "").strip()
        parts = [
            *_as_text_list(item.get("visible_facts"), 3),
            *_as_text_list(item.get("text_facts"), 3),
            *_as_text_list(item.get("audio_facts"), 2),
        ]
        if parts:
            timeline_lines.append(f"{time_range}：{'；'.join(parts[:3])}" if time_range else "；".join(parts[:3]))
    hooks = ledger.get("growth_hooks") if isinstance(ledger.get("growth_hooks"), list) else []
    hook_items: list[dict[str, str]] = []
    for item in hooks[:8]:
        if not isinstance(item, dict):
            continue
        hook = _compact_visible_phrase(item.get("hook"), 100)
        evidence = _compact_visible_phrase(item.get("evidence"), 120)
        confidence = str(item.get("confidence") or "low")
        if hook and hook not in {"冲突", "反差", "情绪价值", "情绪点", "爆点"}:
            hook_items.append({"hook": hook, "evidence": evidence or hook, "confidence": confidence if confidence in {"high", "medium", "low"} else "low"})
    characters: list[str] = []
    for item in ledger.get("characters_or_people", []) if isinstance(ledger.get("characters_or_people"), list) else []:
        if not isinstance(item, dict):
            continue
        name = _compact_visible_phrase(item.get("name"), 40)
        role = _compact_visible_phrase(item.get("role"), 40)
        confidence = str(item.get("confidence") or "low")
        if name:
            characters.append(f"{name}{f'（{role}，{confidence}置信）' if role else f'（{confidence}置信）'}")
    all_materials = [*text, *visible, *audio, *timeline_lines, *[item["hook"] for item in hook_items], *characters]
    return {
        "visible": list(dict.fromkeys(visible)),
        "audio": list(dict.fromkeys(audio)),
        "text": list(dict.fromkeys(text)),
        "timeline": list(dict.fromkeys(timeline_lines)),
        "hooks": hook_items,
        "characters": list(dict.fromkeys(characters)),
        "all": list(dict.fromkeys(item for item in all_materials if item))[:20],
}


def _has_content_materials(ledger: dict[str, Any], link_titles: list[str], link_tags: list[str]) -> bool:
    materials = _ledger_materials(ledger, link_titles, link_tags)
    return bool(materials.get("all"))


def _single_work_content_type(asset_analysis: dict[str, Any], ledger: dict[str, Any]) -> dict[str, Any]:
    work = asset_analysis.get("work_understanding") if isinstance(asset_analysis.get("work_understanding"), dict) else {}
    content_type = str(work.get("content_type") or "").strip()
    confidence = str(work.get("content_type_confidence") or "low").strip()
    evidence = _as_text_list(work.get("content_type_evidence"), 6)
    if content_type:
        return {
            "content_type": content_type,
            "confidence": confidence if confidence in {"high", "medium", "low"} else "low",
            "evidence": evidence,
        }
    materials = _ledger_materials(ledger, [], [])
    evidence_pool = materials.get("all") if isinstance(materials.get("all"), list) else []
    joined = "\n".join(evidence_pool)
    checks = [
        ("tutorial", ["教程", "教学", "步骤", "完整版教学", "手部操作", "操作近景"]),
        ("media_clip", ["影视", "影视剪辑", "剧集", "短剧", "综艺", "小品", "剧集片段", "电影片段", "人物对话", "剧情", "台词"]),
        ("performance", ["演奏", "翻唱", "表演", "伴奏", "曲谱"]),
        ("gameplay", ["游戏", "实况", "操作", "关卡", "战绩"]),
        ("product_review", ["测评", "开箱", "产品", "参数", "对比"]),
        ("knowledge", ["科普", "知识", "解释", "原理", "观点"]),
        ("vlog", ["vlog", "日常", "记录", "探店", "旅行"]),
    ]
    for kind, keywords in checks:
        hits = [item for item in evidence_pool if any(keyword.lower() in item.lower() for keyword in keywords)]
        if hits:
            return {"content_type": kind, "confidence": "medium", "evidence": hits[:6]}
    return {
        "content_type": "platform_native" if joined else "unknown",
        "confidence": "low" if not joined else "medium",
        "evidence": evidence_pool[:6],
    }


def _is_media_clip_type(content_type: str, source_type: str, ledger: dict[str, Any]) -> bool:
    text = json.dumps(ledger, ensure_ascii=False)
    return content_type == "media_clip" or source_type in {"film", "tv_drama", "tv_series", "short_drama", "variety", "anime"} or bool(re.search(r"影视|综艺|小品|剧集|短剧|电影|二创片段|搬运片段|影视剪辑", text))


def _content_type_label(content_type: str) -> str:
    labels = {
        "platform_native": "平台原生内容",
        "media_clip": "影视/综艺/剧集片段",
        "tutorial": "教程/教学内容",
        "performance": "演奏/表演内容",
        "gameplay": "游戏实况内容",
        "vlog": "生活记录/Vlog",
        "product_review": "产品测评内容",
        "knowledge": "知识/观点内容",
        "unknown": "内容类型待确认",
    }
    return labels.get(content_type, content_type or "内容类型待确认")


def _growth_reason_for_step(index: int, material: str, content_type: str) -> str:
    if content_type == "tutorial":
        reasons = [
            f"把学习痛点或结果前置，用户能在 3 秒内判断这条是否值得学；证据线索是「{material}」。",
            "用操作近景或步骤线索降低理解成本，提高收藏和反复观看概率。",
            "把可保存的信息放在中段，方便用户暂停、收藏或评论求教程/求资料。",
            "结尾引导用户反馈卡在哪一步，用评论关键词验证下一条教程选题。",
        ]
    elif content_type == "performance":
        reasons = [
            "先放最能被识别的声音/画面线索，提高完播和分享的起点。",
            "中段用表演细节维持期待，让用户判断是否要继续听完/看完。",
            "补充标题或字幕线索，方便评论点歌、求曲名或比较版本。",
            "结尾引导点歌或曲名讨论，用评论关键词验证复访潜力。",
        ]
    elif content_type == "gameplay":
        reasons = [
            "先放局势或操作结果，让同类用户快速进入共鸣场景。",
            "用具体操作/画面解释看点，提高完播率而不是只靠情绪词。",
            "保留关键反应或结果，推动评论讨论操作、队友或玩法。",
            "结尾引导同场景经验分享，用评论共鸣和主页点击验证系列潜力。",
        ]
    elif content_type in {"knowledge", "product_review"}:
        reasons = [
            "先给结论或问题，让用户快速判断信息价值。",
            "用可见证据支撑判断，提高收藏和转发理由。",
            "中段补足关键对比或解释，提升完播和信任感。",
            "结尾引导补充问题，用评论率和关注转化验证账号承接。",
        ]
    elif content_type == "media_clip":
        reasons = [
            "用片段中已验证的具体台词/动作/场景做开头，提高 3 秒停留。",
            "只解释可见片段，避免扩写完整剧情，同时维持完播期待。",
            "把评论点落在人物、台词或场景关键词上，验证讨论价值。",
            "结尾引导具体记忆点讨论，用评论关键词和收藏判断是否继续同类。",
        ]
    else:
        reasons = [
            "先放当前内容里最明确的可见线索，让新访客快速判断看点。",
            "用画面/字幕解释内容价值，提高完播而不是只复述页面元素。",
            "把可复用结构落到具体素材上，帮助用户判断是否收藏或点主页。",
            "结尾围绕具体线索提问，用评论关键词验证下一条方向。",
        ]
    return reasons[min(index, len(reasons) - 1)]


def _material_at(materials: dict[str, Any], index: int, fallback: str) -> str:
    all_items = materials.get("all") if isinstance(materials.get("all"), list) else []
    if index < len(all_items):
        return str(all_items[index])
    return fallback


def _build_dynamic_script_steps(
    ledger: dict[str, Any],
    source_info: dict[str, Any],
    link_titles: list[str],
    link_tags: list[str],
    content_type: str = "platform_native",
) -> list[dict[str, str]]:
    materials = _ledger_materials(ledger, link_titles, link_tags)
    hooks = materials["hooks"]
    if not materials["all"]:
        return [
            {
                "time": "证据补充",
                "visual": INSUFFICIENT_CONTENT_EVIDENCE,
                "caption_or_voiceover": "当前不使用用户请求、工具日志、文件名或上传状态来编脚本。",
                "purpose": "避免把运行元数据误写成视频内容证据。",
                "evidence": "content_evidence_missing",
                "growth_reason": "当前缺少可验证内容证据，任何具体增长判断都可能误导；先补证据再测试停留、收藏和评论。",
                "confidence": "low",
            }
        ]
    is_media_clip = content_type == "media_clip"
    type_label = _content_type_label(content_type)
    source_name = source_info.get("name") or ("片源待确认" if is_media_clip else type_label)
    source_confidence = source_info.get("confidence") if source_info.get("confidence") in {"high", "medium", "low"} else "low"
    first_hook = hooks[0] if hooks else {}
    first_material = first_hook.get("evidence") or _material_at(materials, 0, "当前素材线索不足，只能做低置信最小测试。")
    second_material = _material_at(materials, 1, first_material)
    third_material = _material_at(materials, 2, second_material)
    comment_focus = _material_at(materials, 3, source_name if source_name != "片源待确认" else first_material)
    low_note = "当前素材线索不足，只能做低置信最小测试。" if not materials["all"] else ""
    return [
        {
            "time": "0-3 秒",
            "visual": first_material,
            "caption_or_voiceover": f"先看这个细节：{first_hook.get('hook') or first_material}",
            "purpose": f"用当前素材中可核验的具体线索建立停留理由。{low_note}".strip(),
            "evidence": first_material,
            "growth_reason": _growth_reason_for_step(0, first_material, content_type),
            "confidence": first_hook.get("confidence") or source_confidence,
        },
        {
            "time": "4-10 秒",
            "visual": second_material,
            "caption_or_voiceover": (
                f"这段先按「{source_name}」处理，但片源置信度是{source_info.get('confidence', 'low')}，只讲已经看见的线索。"
                if is_media_clip
                else f"这条先按「{type_label}」处理，只解释当前可见证据里的内容价值。"
            ),
            "purpose": (
                "帮助用户识别片源/场景/人物，不扩写没有证据的完整剧情。"
                if is_media_clip
                else "说明这类内容为什么值得继续看、收藏、评论或点进主页，而不是只复述页面元素。"
            ),
            "evidence": "；".join(source_info.get("evidence") or [second_material])[:180],
            "growth_reason": _growth_reason_for_step(1, second_material, content_type),
            "confidence": source_confidence,
        },
        {
            "time": "11-25 秒",
            "visual": third_material,
            "caption_or_voiceover": f"把重点落在这个可见信息上：{third_material}",
            "purpose": "解释具体看点，避免使用无素材依据的空泛模板。",
            "evidence": third_material,
            "growth_reason": _growth_reason_for_step(2, third_material, content_type),
            "confidence": "medium" if materials["all"] else "low",
        },
        {
            "time": "结尾",
            "visual": comment_focus,
            "caption_or_voiceover": f"你最先记住的是「{comment_focus}」，还是片段里的另一个细节？",
            "purpose": "结尾引导评论；发布后观察评论关键词，不声称评论区已有共识。",
            "evidence": comment_focus,
            "growth_reason": _growth_reason_for_step(3, comment_focus, content_type),
            "confidence": "medium" if materials["all"] else "low",
        },
    ]


def _script_steps_to_shots(script_steps: list[dict[str, str]]) -> list[str]:
    return [
        f"{item.get('time', '')}：画面/素材用「{item.get('visual', '')}」；字幕/口播「{item.get('caption_or_voiceover', '')}」；目的：{item.get('purpose', '')}"
        for item in script_steps
        if item.get("visual") or item.get("caption_or_voiceover")
    ]


def _single_work_experiment_fields() -> dict[str, Any]:
    return {
        "growth_hypothesis": "如果下一条内容优先使用当前素材中已核验的台词、字幕、人物动作、场景符号或标题线索作为开头，3 秒留存和评论关键词会比泛化模板更可诊断。",
        "test_action": "按 script_steps 做一条基于当前证据的最小测试，发布后只观察真实指标，不提前判断长期账号方向。",
        "validation_metrics": ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"],
        "decision_rules": [
            "3 秒留存低：重做开头钩子，优先换成更具体的台词、字幕、动作或场景符号。",
            "完播低：压缩背景解释，提前放当前素材里最具体的看点。",
            "评论集中在某类关键词：只说明该类关键词值得继续测试，不直接宣布长期方向。",
            "收藏高但主页点击低：说明内容有资料价值，但主页承接不足。",
            "负反馈集中在搬运/废话多：降低原片比例，增加观点密度和评论性解释。",
        ],
        "review_template": "复盘：3 秒留存=__；平均播放时长=__；完播率=__；评论关键词=__；收藏率=__；主页点击率=__；负反馈=__；下一步调整=__。",
    }


def _single_work_metrics_for_content_type(content_type: str, is_media_clip: bool = False) -> list[str]:
    base = ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "主页点击率", "负反馈"]
    if is_media_clip or content_type == "media_clip":
        specific = ["完播率", "评论关键词", "收藏率", "关注转化"]
    elif content_type == "tutorial":
        specific = ["收藏率", "反复观看", "评论关键词：求教程/求资料/求慢速"]
    elif content_type == "performance":
        specific = ["分享率", "评论关键词：点歌/求曲名", "完播率"]
    elif content_type == "gameplay":
        specific = ["评论共鸣", "完播率", "主页点击率"]
    elif content_type in {"knowledge", "product_review"}:
        specific = ["评论率", "转发率", "关注转化", "收藏率"]
    else:
        specific = ["收藏率", "关注转化"]
    return list(dict.fromkeys([*base, *specific]))


def _copyright_boundary(source_type: str, ledger: dict[str, Any]) -> list[str]:
    text = json.dumps(ledger, ensure_ascii=False)
    risky = source_type in {"film", "tv_drama", "tv_series", "short_drama", "variety", "anime"} or re.search(r"影视|综艺|小品|春晚|老剧|名场面|电影|短剧", text)
    if not risky:
        return []
    return [
        "复用的是选题角度、解说结构、字幕解释方式和结尾提问方式，不是照搬原视频内容。",
        "不建议完整搬运原片；优先使用评论性引用、授权素材、平台可用素材、截图讲解或口播复述。",
        "“复刻”只能指结构复用，不能理解为搬运原片。",
    ]


def _usage_boundary_for_content_type(content_type: str, source_type: str, ledger: dict[str, Any]) -> list[str]:
    media_notes = _copyright_boundary(source_type, ledger)
    if content_type == "media_clip" or media_notes:
        return media_notes
    text = json.dumps(ledger, ensure_ascii=False)
    if content_type in {"performance", "tutorial"} and re.search(r"音乐|歌曲|演奏|翻唱|伴奏|曲谱|cover", text, re.I):
        return [
            "涉及已有作品的演奏或教学时，应关注平台音乐版权、曲谱/伴奏来源和二创授权边界；复用时学习选曲、镜头、标题钩子和教学结构，不直接搬运他人演奏视频。"
        ]
    return []


def _dynamic_single_work_hook(
    asset_analysis: dict[str, Any],
    scene: dict[str, Any],
    traffic: dict[str, Any],
    link_titles: list[str],
    link_tags: list[str],
    current_hook: str,
) -> str:
    current = str(current_hook or "").strip()
    generic_markers = ["立刻知道冲突", "只展示背景", "最强冲突", "情绪点"]
    if current and not any(marker in current for marker in generic_markers):
        return current

    source = asset_analysis.get("source_identification") if isinstance(asset_analysis.get("source_identification"), dict) else {}
    clip = asset_analysis.get("clip_context") if isinstance(asset_analysis.get("clip_context"), dict) else {}
    work = asset_analysis.get("work_understanding") if isinstance(asset_analysis.get("work_understanding"), dict) else {}
    video = asset_analysis.get("video_understanding") if isinstance(asset_analysis.get("video_understanding"), dict) else {}

    candidates = [
        scene.get("viewer_hook"),
        traffic.get("primary_hook") if isinstance(traffic, dict) else "",
        clip.get("visible_plot"),
        video.get("observable_facts"),
        work.get("caption_summary"),
        source.get("evidence"),
        link_titles[0] if link_titles else "",
        "、".join(link_tags[:3]) if link_tags else "",
    ]
    phrase = next((_compact_visible_phrase(item) for item in candidates if _compact_visible_phrase(item)), "")
    if phrase:
        return f"这条的看点应从可见线索切入：{phrase}。开头不要套通用冲突模板，而要直接点出这条素材独有的片源、人物动作、字幕或标题线索。"
    return "当前视觉证据不足，先把开头做成“可见事实 + 待确认片源”的低置信版本，不要把通用冲突模板当成已经验证过的看点。"


def _dynamic_single_work_steps(
    asset_analysis: dict[str, Any],
    scene: dict[str, Any],
    source_name: str,
    viewer_hook: str,
    current_steps: list[str],
    link_titles: list[str],
    link_tags: list[str],
) -> list[str]:
    strongest = _compact_visible_phrase(scene.get("segment_summary") or asset_analysis.get("asset_summary") or viewer_hook, 56)
    title = _compact_visible_phrase(link_titles[0] if link_titles else source_name, 36)
    tags = "、".join([_compact_visible_phrase(item, 12) for item in link_tags[:3] if _compact_visible_phrase(item, 12)])
    if not strongest and not title and not tags:
        return current_steps

    opening = strongest or title or tags
    context = title if title and title != "片源待确认" else "片源、人物关系或标题标签"
    discussion = tags or title or "这段内容的争议点/情绪点"
    return [
        f"0-3 秒：直接放这条素材最能说明问题的画面或字幕：{opening}。",
        f"4-12 秒：只补足用户理解所需的上下文：{context}，不要扩写看不见的剧情。",
        f"13-25 秒：围绕前面已经出现的动作、表情、字幕或标题线索做解释，保留一个可验证的情绪点。",
        f"结尾：围绕「{discussion}」提一个具体问题，引导用户评论；不要使用和素材无关的通用提问。",
    ]


def build_rule_based_advisor_bundle(profile: dict[str, Any], asset_analysis: dict[str, Any]) -> dict[str, Any]:
    profile_name = profile.get("account_name", "该账号")
    platform_name = PLATFORM_LIBRARY.get(profile.get("platform", "custom-platform"), PLATFORM_LIBRARY["custom-platform"])["name"]
    if is_profile_link_only_request(profile):
        work_links = profile.get("work_links", []) if isinstance(profile.get("work_links"), list) else []
        profile_link_items = [item for item in work_links if isinstance(item, dict) and item.get("page_kind_guess") == "profile"]
        profile_urls = [str(item.get("url", "")) for item in profile_link_items if item.get("url")]
        first_url = profile_urls[0] if profile_urls else "用户提供的主页短链"
        first_link = profile_link_items[0] if profile_link_items else {}
        final_url = str(first_link.get("final_url", ""))
        account_id = str(first_link.get("account_id", ""))
        page_title = str(first_link.get("page_title", ""))
        fetched_evidence = []
        if final_url:
            fetched_evidence.append(f"公开跳转落点：{final_url}")
        if account_id:
            fetched_evidence.append(f"主页账号标识：{account_id}")
        if page_title:
            fetched_evidence.append(f"页面标题：{page_title}")
    homepage_evidence_map = build_homepage_evidence_map(profile, asset_analysis)
    homepage_column_plan, homepage_column_plan_status = build_homepage_column_plan(homepage_evidence_map)
    homepage_patterns = [
        item
        for item in homepage_evidence_map.get("content_patterns", [])
        if isinstance(item, dict) and item.get("pattern_name") and item.get("evidence")
    ]
    direction = str(homepage_patterns[0].get("pattern_name", "")) if homepage_patterns else "strongest homepage evidence direction"
    pillar_name = direction
    first_title = ""
    first_hook = ""
    is_mixed_homepage = len(homepage_patterns) >= 2

    diagnosis = asset_analysis.get("homepage_diagnosis", [])[:3]
    opportunities = asset_analysis.get("content_opportunities", [])[:3]
    editing = asset_analysis.get("shooting_and_editing_advice", [])[:4]
    evidence = _as_text_list(asset_analysis.get("evidence"), 3)
    video_profile = infer_video_prompt_profile(profile, asset_analysis)

    request_text = str(profile.get("user_request", ""))
    work_links = profile.get("work_links", []) if isinstance(profile.get("work_links"), list) else []
    link_titles = [str(item.get("shared_title", "")) for item in work_links if isinstance(item, dict) and item.get("shared_title")]
    link_tags = [
        str(tag)
        for item in work_links
        if isinstance(item, dict)
        for tag in (item.get("shared_tags") if isinstance(item.get("shared_tags"), list) else [])
    ]
    link_source_guess = next(
        (
            str(item.get("source_guess", ""))
            for item in work_links
            if isinstance(item, dict) and item.get("source_guess")
        ),
        "",
    )
    link_content_type = next(
        (
            str(item.get("content_type_guess", "unknown"))
            for item in work_links
            if isinstance(item, dict) and item.get("content_type_guess") not in {"", "unknown"}
        ),
        "unknown",
    )
    source = asset_analysis.get("source_identification") if isinstance(asset_analysis.get("source_identification"), dict) else {}
    scene = asset_analysis.get("scene_semantics") if isinstance(asset_analysis.get("scene_semantics"), dict) else {}
    traffic = asset_analysis.get("traffic_mechanism") if isinstance(asset_analysis.get("traffic_mechanism"), dict) else {}
    remix = asset_analysis.get("remix_plan") if isinstance(asset_analysis.get("remix_plan"), dict) else {}
    fact_ledger = _fact_ledger(asset_analysis)
    video_context = " ".join(
        [
            request_text,
            profile.get("work_links_raw", ""),
            " ".join(link_titles),
            " ".join(link_tags),
            link_source_guess,
            str(asset_analysis.get("asset_summary", "")),
            " ".join(asset_analysis.get("video_observations", [])),
            json.dumps(source, ensure_ascii=False),
            json.dumps(scene, ensure_ascii=False),
            json.dumps(traffic, ensure_ascii=False),
            json.dumps(remix, ensure_ascii=False),
        ]
    )
    task_intent = normalize_task_intent(profile.get("result_mode") or profile.get("task_intent"), profile)
    is_account_diagnosis = task_intent == "account_growth_diagnosis"
    is_current_video = bool(
        not is_account_diagnosis
        and (
            re.search(r"当前视频|刷到的视频|单条视频|这条视频|视频帧|关键帧|画面采样|剪辑方法|脚本设计|动漫解说|动画解说|治愈系动画|作品链接|v\.douyin", video_context)
            or task_intent == "single_work_analysis"
            or link_content_type != "unknown"
        )
    )
    confidence_name = {"high": "高", "medium": "中", "low": "低"}.get

    if is_current_video:
        source_name = source.get("possible_title") or link_source_guess or "片源待确认"
        source_type = source.get("content_type") or "unknown"
        if source_type == "tv_drama":
            source_type = "tv_series"
        if source_type == "unknown" and link_content_type != "unknown":
            source_type = link_content_type
        if source_type == "unknown":
            source_type = video_profile.get("content_type", "unknown")
        source_confidence = source.get("confidence") or ("medium" if link_source_guess else "low")
        source_evidence = source.get("evidence") if isinstance(source.get("evidence"), list) else []
        source_evidence = _as_text_list(source_evidence, 6)
        ledger_source = _ledger_source(fact_ledger, source_name, source_confidence, source_evidence)
        if ledger_source.get("name"):
            source_name = str(ledger_source["name"])
        source_confidence = str(ledger_source.get("confidence") or source_confidence)
        if ledger_source.get("evidence"):
            source_evidence = list(ledger_source["evidence"])
        content_type_info = _single_work_content_type(asset_analysis, fact_ledger)
        content_type = str(content_type_info.get("content_type") or "unknown")
        content_type_confidence = str(content_type_info.get("confidence") or "low")
        content_type_evidence = _as_text_list(content_type_info.get("evidence"), 6)
        is_media_clip = _is_media_clip_type(content_type, source_type, fact_ledger)
        content_label = _content_type_label("media_clip" if is_media_clip else content_type)
        if link_titles:
            source_evidence = [f"分享标题：{link_titles[0]}", *source_evidence]
        if link_tags:
            source_evidence = [f"分享话题：{'、'.join(link_tags[:6])}", *source_evidence]
        source_uncertainty_raw = source.get("uncertainty") or "当前只能基于用户粘贴的分享标题、话题标签和链接文本做判断，还不能声称已经打开并看完原视频。"
        source_uncertainty_items = _as_text_list(source_uncertainty_raw, 6) if isinstance(source_uncertainty_raw, list) else [_compact_visible_phrase(source_uncertainty_raw, 180)]
        source_uncertainty = "；".join(item for item in source_uncertainty_items if item) or "当前片源和上下文仍需补证据确认。"
        is_music_work = source_type == "music" or video_profile.get("content_type") == "music" or any(tag in {"音乐推荐", "音乐合集", "粤语", "戴上耳机"} for tag in link_tags)
        if is_music_work:
            music_title = link_titles[0] if link_titles else "这条音乐推荐"
            music_tags = "、".join(link_tags[:6]) if link_tags else "音乐推荐"
            music_emotion = (
                "失去后的时间感和遗憾感"
                if any(word in music_title for word in ["失去", "拥有", "时间", "太多"])
                else "歌曲标题传递出的情绪记忆点"
            )
            music_hook = f"这条作品的核心不是剧情反转，而是用「{music_title}」这句文案先把听众带入{music_emotion}。"
            strategy = {
                "positioning": "本轮只分析当前音乐推荐作品，不把单条音乐视频直接上升为账号长期赛道。",
                "north_star_goal": "判断这条音乐视频如何用文案、听感和画面氛围制造停留与收藏，再拆出可复刻模板。",
                "kpis": ["3 秒停留", "完播率", "收藏", "转发", "评论关键词"],
                "audience_insights": [
                    "音乐推荐的停留通常来自第一句文案是否击中情绪，而不是剧情信息量。",
                    "用户收藏音乐视频，往往是因为它适合某个情绪场景，例如失恋、怀旧、夜晚独处或戴耳机沉浸。",
                ],
                "strategic_diagnosis": [
                    f"内容类型判断：音乐推荐/歌单切片，置信度为{confidence_name(source_confidence, '低')}。",
                    f"情绪钩子：{music_hook}",
                    f"标签线索：{music_tags}，说明它更适合按听感、歌词情绪和场景氛围拆解。",
                ],
                "content_pillars": [
                    {
                        "name": "情绪音乐推荐",
                        "why": "这类内容的可复刻点在于文案共鸣、歌曲进入点、画面氛围和收藏理由，而不是剧情解释。",
                        "themes": link_tags[:4] or ["粤语", "耳机沉浸", "失恋情绪", "夜晚歌单"],
                        "formats": ["一句情绪文案", "歌曲高潮进入", "氛围画面", "歌词字幕", "收藏提示"],
                    }
                ],
                "growth_phases": [
                    {
                        "phase": "第一轮验证",
                        "objective": "用 1 条同情绪音乐视频验证文案和进入点是否能带来停留与收藏。",
                        "actions": ["确定歌曲高潮进入点", "写 3 个情绪文案开头", "发布后记录收藏、转发和评论关键词"],
                        "expected_signal": "评论区出现歌名、回忆、失恋、粤语、耳机等关键词，收藏率相对普通视频更突出。",
                    }
                ],
                "message_framework": ["一句情绪文案先击中用户", "歌曲高潮或辨识度最高的一句尽早进入", "画面只服务氛围", "结尾给收藏或评论理由"],
                "risks": [source_uncertainty, "音乐素材需注意版权和平台二创规范，不建议直接搬运完整音频或完整 MV。"],
                "rationale": source_evidence or [f"分享标题：{music_title}", f"分享话题：{music_tags}"],
                "source_type": "model_inference",
                "confidence": "medium" if source_confidence in {"high", "medium"} else "low",
            }
            advisor_summary = {
                "advisor_name": "主控增长 Agent",
                "tone": "客观、具体、尊重用户创作意图",
                "one_sentence_diagnosis": f"这轮先按音乐推荐作品拆解：标题「{music_title}」的价值在于情绪共鸣，重点应拆文案、歌曲进入点、画面氛围和收藏理由。",
                "core_judgements": [
                    f"内容类型：音乐推荐/歌单切片；依据是分享话题「{music_tags}」。",
                    music_hook,
                    "复刻重点不是照搬视频，而是复刻“情绪文案、高潮进入、氛围画面、歌词字幕、收藏理由”的结构。",
                ],
                "evidence_chain": source_evidence or [f"分享标题：{music_title}", f"分享话题：{music_tags}"],
                "first_actions": [
                    "先确认歌曲名称、歌手和最适合截取的高潮段落，避免只凭一句文案做推荐。",
                    "围绕标题情绪写 3 个开头文案，分别测试遗憾、怀旧和深夜独处三种角度。",
                    "发布后重点看收藏、转发、评论中的歌名询问和情绪共鸣词，不急着判断账号长期赛道。",
                ],
                "first_content_task": {
                    "title": "复刻测试：粤语情绪音乐推荐",
                    "hook": f"开头 2 秒直接放情绪文案：{music_title}",
                    "shots": [
                        f"0-2 秒：黑底或生活氛围画面上字幕「{music_title}」。",
                        "3-8 秒：切入歌曲最有辨识度或情绪最强的一句，字幕只保留关键歌词。",
                        "9-18 秒：用 2 到 3 个慢节奏画面承接情绪，例如夜路、窗边、耳机、聊天记录留白，不要加太多剧情解释。",
                        "结尾：用一句收藏理由收束，例如“适合一个人戴耳机听完”，并引导评论“你是从哪一句开始破防的？”",
                    ],
                    "editing_notes": [
                        "字幕节奏跟随歌词重音，不要整段堆满文字。",
                        "封面突出一句最有记忆点的歌词或情绪文案。",
                        "标签围绕歌曲语种、情绪、听歌场景和耳机沉浸，不要混入影视剧情标签。",
                    ],
                },
                "why_this_path": [
                    "因为用户提供的是音乐推荐链接，核心问题应是听感与情绪传播，而不是剧情片段拆解。",
                    "音乐类视频更适合用收藏率、转发和评论共鸣判断质量。",
                ],
                "follow_up_question": "你可以补充歌名、歌手或视频画面截图，我能继续帮你判断最该截哪一句歌词做开头。",
                "source_type": "model_inference",
                "confidence": "low",
            }
            tasks = normalize_tasks(
                [
                    {"id": "advisor-music-task-1", "title": "确认歌曲信息与高潮进入点", "goal": "明确歌名、歌手和最适合剪入的 5 到 12 秒音频段落。", "priority": "high", "status": "todo", "owner": "user", "source": "advisor_summary"},
                    {"id": "advisor-music-task-2", "title": "写出三版情绪文案开头", "goal": "分别测试遗憾、怀旧和深夜独处三种表达，选最能让人停留的一版。", "priority": "high", "status": "todo", "owner": "creative", "source": "advisor_summary"},
                    {"id": "advisor-music-task-3", "title": "发布后记录收藏和评论关键词", "goal": "重点记录收藏、转发、歌名询问、情绪共鸣词和完播表现。", "priority": "medium", "status": "todo", "owner": "data", "source": "strategy"},
                ],
                profile,
            )
            return {"strategy": strategy, "advisor_summary": advisor_summary, "tasks": tasks}
        is_game_work = source_type == "game" or video_profile.get("content_type") == "game"
        if is_game_work:
            game_title = link_source_guess or source_name if source_name != "片源待确认" else "当前游戏片段"
            game_tags = "、".join(link_tags[:6]) if link_tags else "游戏片段"
            strategy = {
                "positioning": "本轮只分析当前游戏/实况片段，不把单条游戏视频直接上升为账号长期赛道。",
                "north_star_goal": "判断这条游戏片段的停留点来自操作、胜负反差、队友反应还是解说节奏，并拆出可复刻脚本。",
                "kpis": ["3 秒停留", "完播率", "评论关键词", "点赞", "同类片段复刻表现"],
                "audience_insights": [
                    "游戏片段的停留通常来自开头能不能立刻看懂局势和冲突。",
                    "评论更容易围绕操作选择、队友反应、胜负反差或梗点展开。",
                ],
                "strategic_diagnosis": [
                    f"内容类型判断：游戏/实况片段，置信度为{confidence_name(source_confidence, '低')}。",
                    f"当前片段线索：{game_title}；标签线索：{game_tags}。",
                    "复刻重点应是“局势交代-反差/失误/高光-解说吐槽-评论问题”，不要套音乐或影视剧情模板。",
                ],
                "content_pillars": [
                    {
                        "name": "游戏片段复刻",
                        "why": "这类内容的可复刻点在于局势理解、操作节点、反应和解说节奏。",
                        "themes": link_tags[:4] or ["操作高光", "反差失误", "队友反应", "游戏梗"],
                        "formats": ["局势字幕", "关键操作", "反应/吐槽", "结尾提问"],
                    }
                ],
                "growth_phases": [
                    {
                        "phase": "第一轮验证",
                        "objective": "用 1 条同类型游戏片段验证开头局势交代和吐槽节奏。",
                        "actions": ["确认游戏名和玩法场景", "剪出 20-35 秒片段", "发布后记录评论关键词"],
                        "expected_signal": "评论区围绕操作、队友、离谱、教学或梗点展开，而不是只泛泛说好笑。",
                    }
                ],
                "message_framework": ["先交代局势", "前置关键操作或反差", "用字幕/口播解释为什么离谱", "结尾问用户会怎么打"],
                "risks": [source_uncertainty, "游戏素材要注意平台版权、录屏清晰度和账号定位一致性。"],
                "rationale": source_evidence or [f"分享标题：{link_titles[0]}" if link_titles else "用户提供游戏片段线索", f"分享话题：{game_tags}"],
                "source_type": "model_inference",
                "confidence": "medium" if source_confidence in {"high", "medium"} else "low",
            }
            advisor_summary = {
                "advisor_name": "主控增长 Agent",
                "tone": "客观、具体、尊重用户创作意图",
                "one_sentence_diagnosis": f"这轮先按游戏片段拆解：重点不是剧情或歌曲，而是看清局势、操作节点和反差/吐槽点能不能让用户停留。",
                "core_judgements": [
                    f"内容类型：游戏/实况片段；依据是标题/标签「{game_tags}」。",
                    "开头必须让用户立刻知道游戏场景和冲突，否则后面的操作没有意义。",
                    "复刻重点是局势字幕、关键操作、反应吐槽和结尾提问。",
                ],
                "evidence_chain": source_evidence or [f"分享标题：{link_titles[0]}" if link_titles else "用户提供当前游戏片段线索", f"分享话题：{game_tags}"],
                "first_actions": [
                    "先确认游戏名、玩法场景和这段片段的核心冲突。",
                    "把片段拆成“局势-操作-反应-吐槽-提问”五段。",
                    "发布后重点看评论是否围绕操作选择、队友反应或梗点展开。",
                ],
                "first_content_task": {
                    "title": "复刻测试：游戏片段局势反差拆解",
                    "hook": "开头 2 秒用字幕交代局势和冲突，例如“这波明明能赢，队友一个操作全没了”。",
                    "shots": [
                        "0-2 秒：展示最有冲突的画面，并加一句局势字幕。",
                        "3-10 秒：回放关键操作或失误，只保留理解结果所需画面。",
                        "11-25 秒：用字幕/口播吐槽或解释为什么离谱。",
                        "结尾：问用户“这波你会怎么打？”或“这是操作问题还是队友问题？”",
                    ],
                    "editing_notes": ["保留关键音效", "字幕解释局势，不要堆满屏", "封面突出结果反差", "标签围绕游戏名、玩法和梗点"],
                },
                "why_this_path": ["用户当前提供的是游戏片段线索，应优先拆操作和反差，而不是套音乐/剧情模板。"],
                "follow_up_question": "你可以补充游戏名、完整录屏或这局的前后 10 秒，我能继续帮你判断最该截哪一段做开头。",
                "source_type": "model_inference",
                "confidence": "low",
            }
            tasks = normalize_tasks(
                [
                    {"id": "advisor-game-task-1", "title": "确认游戏名和冲突点", "goal": "明确游戏、玩法场景、胜负状态和关键操作节点。", "priority": "high", "status": "todo", "owner": "user", "source": "advisor_summary"},
                    {"id": "advisor-game-task-2", "title": "剪一版局势反差脚本", "goal": "按局势、操作、反应、吐槽、提问五段剪出 20-35 秒。", "priority": "high", "status": "todo", "owner": "creative", "source": "advisor_summary"},
                    {"id": "advisor-game-task-3", "title": "记录评论关键词", "goal": "看评论是否围绕操作、队友、离谱、教学或梗点展开。", "priority": "medium", "status": "todo", "owner": "data", "source": "strategy"},
                ],
                profile,
            )
            return {"strategy": strategy, "advisor_summary": advisor_summary, "tasks": tasks}
        segment_summary = scene.get("segment_summary") or (
            f"分享标题指向「{link_titles[0]}」，本轮只按标题、标签和素材事实做保守拆解。"
            if link_titles
            else "当前素材更适合先按单条视频片段拆解，暂不直接推断账号长期赛道。"
        )
        plot_function = scene.get("plot_function") or "unknown"
        viewer_hook = scene.get("viewer_hook") or (
            (_ledger_materials(fact_ledger, link_titles, link_tags).get("all") or ["当前素材线索不足，只能做低置信最小测试。"])[0]
        )
        viewer_hook = _dynamic_single_work_hook(asset_analysis, scene, traffic, link_titles, link_tags, viewer_hook)
        effective_content_type = "media_clip" if is_media_clip else (content_type or "platform_native")
        script_steps = _build_dynamic_script_steps(fact_ledger, ledger_source, link_titles, link_tags, effective_content_type)
        key_moments = scene.get("key_moments") if isinstance(scene.get("key_moments"), list) else []
        stop_reasons = traffic.get("why_viewers_stop") if isinstance(traffic.get("why_viewers_stop"), list) else []
        comment_reasons = traffic.get("why_viewers_comment") if isinstance(traffic.get("why_viewers_comment"), list) else []
        tag_keywords = traffic.get("tag_keywords") if isinstance(traffic.get("tag_keywords"), list) else []
        if not stop_reasons and link_titles:
            if any("最大的蛋" in item and "最小的恐龙" in item for item in link_titles):
                stop_reasons = ["标题把“最大”和“最小”放在同一句里，形成反差悬念，用户会想知道原因。"]
            else:
                stop_reasons = [f"标题「{link_titles[0]}」提供了明确看点，用户会先判断它是否戳中自己的兴趣或情绪。"]
        if not comment_reasons and link_tags:
            comment_reasons = [f"发布后观察评论关键词是否围绕这些标签展开：{'、'.join(link_tags[:5])}。"]
        if not tag_keywords:
            tag_keywords = link_tags[:5]
        risk_notes = traffic.get("risk_notes") if isinstance(traffic.get("risk_notes"), list) else []
        usage_boundary_notes = _usage_boundary_for_content_type(effective_content_type, source_type, fact_ledger)
        replicable_template = remix.get("replicable_template") or (
            "基于当前证据的最小测试脚本：优先使用已识别台词、字幕、人物动作、场景符号、标题标签或时间线片段；线索不足时只做低置信测试，不扩写完整剧情。"
            if is_media_clip
            else "基于当前证据的最小测试脚本：优先使用已识别画面、字幕、标题标签、操作步骤、声音或时间线片段；线索不足时只做低置信测试，不把页面元素当成内容价值。"
        )
        find_similar = remix.get("how_to_find_similar_clips") if isinstance(remix.get("how_to_find_similar_clips"), list) else []
        editing_steps = remix.get("editing_steps") if isinstance(remix.get("editing_steps"), list) else []
        title_tags = remix.get("title_and_tags") if isinstance(remix.get("title_and_tags"), list) else []
        fallback_steps = _script_steps_to_shots(script_steps)
        experiment_fields = _single_work_experiment_fields()
        experiment_fields["validation_metrics"] = _single_work_metrics_for_content_type(effective_content_type, is_media_clip)

        content_evidence_line = "；".join(content_type_evidence[:3]) if content_type_evidence else (viewer_hook or "当前内容类型证据仍需补充")
        strategic_diagnosis = (
            [
                f"片源判断：{source_name}，类型为 {source_type}，置信度为{confidence_name(source_confidence, '低')}。",
                f"片段语义：{segment_summary}",
                f"可测试看点：{viewer_hook}",
            ]
            if is_media_clip
            else [
                f"内容类型判断：{content_label}，置信度为{confidence_name(content_type_confidence, '低')}。",
                f"可能赛道/可见钩子：{viewer_hook}",
                f"增长机制：围绕当前可见证据「{content_evidence_line}」解释为什么能带来停留、收藏、评论或主页点击，而不是默认做片源拆解。",
            ]
        )
        audience_insights = (
            [
                "用户看单条影视/娱乐/游戏片段时，最先被片源熟悉感、具体台词、人物动作、场景符号和字幕提示吸引。",
                "如果片源不明确，标题和标签需要帮助用户迅速建立语境，避免只靠画面让人猜。",
            ]
            if is_media_clip
            else [
                "平台原生内容的增长点不在片源熟悉感，而在用户能否快速看懂内容价值、学习收益、情绪共鸣或实用理由。",
                "脚本需要把可见钩子解释成停留、收藏、评论或主页点击理由，不能只复述标题、标签和画面元素。",
            ]
        )
        pillar = (
            {
                "name": "可复刻片段拆解",
                "why": "这类内容的关键不是照搬画面，而是复用片源线索、具体素材看点、字幕解释和结尾提问方式。",
                "themes": tag_keywords[:4] or ["片源识别", "剧情冲突", "角色高光", "评论讨论"],
                "formats": ["片源提示", "冲突前置", "剧情解释", "结尾提问"],
            }
            if is_media_clip
            else {
                "name": f"{content_label}可复用结构",
                "why": "这类内容的关键是把当前素材证据转成清楚的内容价值：为什么值得停留、为什么值得收藏、为什么值得评论或点进主页。",
                "themes": tag_keywords[:4] or [content_label, "可见钩子", "字幕/标题策略", "发布后验证"],
                "formats": ["价值前置", "证据展示", "步骤/细节解释", "结尾反馈问题"],
            }
        )
        message_framework = (
            ["先给片源线索", "前置冲突或情绪点", "用字幕解释关键剧情", "结尾抛出讨论问题"]
            if is_media_clip
            else ["先给内容价值", "展示关键画面/步骤/声音证据", "解释为什么值得继续看或收藏", "结尾收集具体反馈"]
        )
        phase_actions = (
            ["确认片源和片段功能", "按关键镜头写 20-40 秒脚本", "发布后记录停留、完播、评论和收藏"]
            if is_media_clip
            else ["确认内容类型和可见钩子", "按当前证据写 20-40 秒小样本脚本", "发布后记录留存、收藏、评论、主页点击和负反馈"]
        )
        expected_signal = (
            "发布后观察评论关键词是否围绕片源、人物、台词、场景或观点选择展开，而不是提前声称评论区已有共识。"
            if is_media_clip
            else "发布后观察用户是否围绕学习收益、具体操作、内容价值或同类需求评论；指标成立前不判断长期账号方向。"
        )

        strategy = {
            "positioning": "本轮只分析当前视频素材，不把单条视频直接上升为账号长期赛道。",
            "north_star_goal": "先判断这条视频为什么能吸引停留，再拆出一条可复用、可验证的内容结构。",
            "kpis": experiment_fields["validation_metrics"],
            "audience_insights": audience_insights,
            "strategic_diagnosis": strategic_diagnosis,
            "script_steps": script_steps,
            **experiment_fields,
            "content_type": effective_content_type,
            "content_type_confidence": content_type_confidence,
            "content_type_evidence": content_type_evidence,
            "content_pillars": [pillar],
            "growth_phases": [
                {
                    "phase": "第一轮验证",
                    "objective": f"用 1 条同类型内容验证当前拆解出的「{content_label}」结构是否成立。",
                    "actions": phase_actions,
                    "expected_signal": expected_signal,
                }
            ],
            "message_framework": message_framework,
            "risks": list(dict.fromkeys([*(risk_notes or [source_uncertainty]), *usage_boundary_notes, *(_as_text_list(fact_ledger.get("limitations"), 6) if fact_ledger else [])])),
            "rationale": (source_evidence + key_moments + evidence)[:5] or ["基于当前视频关键帧、标题标签和用户补充信息做保守判断。"],
            "source_type": "model_inference",
            "confidence": "medium" if source_confidence in {"high", "medium"} else "low",
        }
        advisor_summary = {
            "advisor_name": "主控增长 Agent",
            "tone": "客观、具体、尊重用户创作意图",
            "one_sentence_diagnosis": (
                f"这轮先按单条视频拆解：疑似片源是「{source_name}」，核心看点是「{viewer_hook}」。"
                if is_media_clip
                else f"这轮先按「{content_label}」拆解：核心看点是「{viewer_hook}」，重点是把可见证据转成可验证的停留、收藏、评论或主页点击理由。"
            ),
            "core_judgements": (
                [
                    f"片源判断：{source_name}，置信度{confidence_name(source_confidence, '低')}；{source_uncertainty}",
                    f"片段语义：{segment_summary}",
                    "复刻重点不是照搬视频，而是复用“片源线索、具体素材看点、字幕解释、结尾提问”的结构。",
                ]
                if is_media_clip
                else [
                    f"内容类型判断：{content_label}，置信度{confidence_name(content_type_confidence, '低')}；依据是{content_evidence_line}。",
                    f"增长机制：用可见钩子「{viewer_hook}」解释为什么值得停留、收藏、评论或点主页。",
                    "复用重点不是照搬页面元素，而是复用“价值前置、证据展示、细节解释、结尾反馈问题”的结构。",
                ]
            ),
            "evidence_chain": (source_evidence + key_moments + stop_reasons + evidence)[:6]
            or [asset_analysis.get("asset_summary", "当前主要依据关键帧和用户输入进行判断。")],
            "first_actions": [
                f"先确认片源：围绕「{source_name}」补充作品链接、标题标签或更多连续画面。" if is_media_clip else f"先确认内容类型：围绕「{content_label}」补充连续画面、标题字幕、OCR/ASR 或作品链接。",
                "把这段内容拆成“片源线索、具体看点、字幕解释、结尾提问、发布后观察指标”五个部分。" if is_media_clip else "把这段内容拆成“内容价值、可见证据、增长理由、脚本步骤、发布后指标”五个部分。",
                "做一条同类片段测试，发布后只看停留、完播、评论关键词和收藏，不急着判断账号长期方向。" if is_media_clip else "做一条同类型内容小样本测试，发布后只看留存、收藏、评论、主页点击和负反馈，不急着判断账号长期方向。",
            ],
            "first_content_task": {
                "title": (
                    f"复刻测试：{source_name}同类片段拆解" if source_name != "片源待确认" else "复刻测试：当前视频同类片段拆解"
                ) if is_media_clip else f"复用结构测试：{content_label}",
                "hook": viewer_hook,
                "script_steps": script_steps,
                "shots": editing_steps[:4] or key_moments[:4] or fallback_steps,
                "editing_notes": (title_tags + find_similar + editing)[:5]
                or (
                    ["标题写清片源或具体素材线索", "字幕只解释已看到的人物、动作、场景或台词", "结尾用一个具体问题引导评论并观察关键词"]
                    if is_media_clip
                    else ["标题写清内容价值或具体素材线索", "字幕解释已看到的画面、步骤、声音或文本证据", "结尾用一个具体反馈问题验证收藏、评论或主页点击理由"]
                ),
            },
            "why_this_path": [
                "因为用户当前想解决的是这条视频为什么有吸引力以及如何复刻，不是完整账号定位重做。",
                "先从单条样本拆出可验证模板，再决定是否扩展成账号长期栏目，会更稳。",
            ],
            "follow_up_question": (
                "你可以再给我这条视频的原链接、标题标签或更完整的关键帧，我能继续帮你把片源和片段功能确认得更准。"
                if is_media_clip
                else "你可以再给我这条视频的原链接、标题标签、连续画面、OCR/ASR 或后台数据，我能继续帮你把内容机制和脚本验证点确认得更准。"
            ),
            "source_type": "model_inference",
            "confidence": "medium" if asset_analysis.get("status") == "success" else "low",
        }
        tasks = normalize_tasks(
            [
                {
                    "id": "advisor-video-task-1",
                    "title": "确认片源与片段功能" if is_media_clip else "确认内容类型与可见钩子",
                    "goal": (
                        f"补充链接、标题标签或连续画面，确认「{source_name}」是否就是这条视频的真实来源。"
                        if is_media_clip
                        else f"补充连续画面、标题字幕、OCR/ASR 或作品链接，确认「{content_label}」判断是否成立。"
                    ),
                    "priority": "high",
                    "status": "todo",
                    "owner": "advisor",
                    "source": "video_reasoning",
                },
                {
                    "id": "advisor-video-task-2",
                    "title": "拆出可复刻镜头脚本",
                    "goal": f"按「{replicable_template}」整理一版 20-40 秒镜头表。",
                    "priority": "high",
                    "status": "todo",
                    "owner": "creative",
                    "source": "video_reasoning",
                },
                {
                    "id": "advisor-video-task-3",
                    "title": "发布后验证视频模板",
                    "goal": (
                        "记录 3 秒停留、完播、评论关键词和收藏，判断这套片段结构是否值得继续做。"
                        if is_media_clip
                        else "记录留存、完播、收藏、评论关键词、主页点击和负反馈，判断这套内容结构是否值得继续做。"
                    ),
                    "priority": "medium",
                    "status": "todo",
                    "owner": "data",
                    "source": "video_reasoning",
                },
            ],
            profile,
        )
        return {"strategy": strategy, "advisor_summary": advisor_summary, "tasks": tasks}

    pattern_names = [str(item.get("pattern_name", "")) for item in homepage_patterns[:3] if item.get("pattern_name")]
    strategy = {
        "positioning": f"{platform_name} 主页诊断只基于当前可见证据生成：先围绕「{direction}」做小样本验证，不按垂类模板硬套栏目。",
        "north_star_goal": "用同证据来源的小样本内容验证一个主页可见模式是否值得连续发布。",
        "kpis": ["24/48 小时播放量", "3 秒留存", "完播率", "评论关键词", "主页点击率", "关注转化", "负反馈"],
        "audience_insights": [
            "当前缺少后台播放、完播、转粉、评论区和时间序列数据，不能证明平台推荐或账号趋势已经发生变化。",
            "具体栏目必须来自 homepage_column_plan，并且每条都要有 evidence_basis。",
        ],
        "strategic_diagnosis": diagnosis or [asset_analysis.get("asset_summary", "当前主页证据有限；需要补充作品详情、封面标题、后台数据和评论区截图。")],
        "content_pillars": [
            {
                "name": name,
                "why": "该候选方向来自 homepage_evidence_map.content_patterns，需要小样本验证。",
                "themes": [
                    str(value)
                    for value in (
                        homepage_patterns[index].get("evidence", [])
                        if index < len(homepage_patterns) and isinstance(homepage_patterns[index].get("evidence"), list)
                        else []
                    )[:3]
                ],
                "formats": ["同证据来源连续测试", "统一封面标题结构", "发布后回填真实指标"],
            }
            for index, name in enumerate(pattern_names)
        ],
        "growth_phases": [
            {
                "phase": "第一周",
                "objective": "验证一个主页可见证据模式是否值得连续发布。",
                "actions": ["选择证据最明确的一个方向", "连续发布同证据来源的小样本内容", "记录 24/48 小时数据"],
                "expected_signal": "指标只用于判断该小样本是否值得下一轮测试，不能证明长期方向或平台推荐。",
            }
        ],
        "message_framework": ["证据来源", "栏目假设", "小样本动作", "复盘指标"],
        "risks": [
            "没有后台数据时不能声称平台已经验证某方向。",
            "没有 evidence_basis 的具体栏目建议不应进入最终回复。",
        ],
        "rationale": evidence or opportunities or ["基于主页截图、用户资料和平台线索做保守判断。"],
        "source_type": "model_inference",
        "confidence": "medium" if asset_analysis.get("status") == "success" else "low",
    }

    homepage_evidence_map = build_homepage_evidence_map(profile, asset_analysis)
    homepage_column_plan, homepage_column_plan_status = build_homepage_column_plan(homepage_evidence_map)
    strategy["homepage_evidence_map"] = homepage_evidence_map
    strategy["homepage_column_plan"] = homepage_column_plan
    strategy["homepage_column_plan_status"] = homepage_column_plan_status

    advisor_summary = {
        "advisor_name": "KOC Growth Agent",
        "tone": "calm, evidence-first, action-oriented",
        "one_sentence_diagnosis": "This homepage diagnosis is based on visible evidence only; without backend data it does not claim long-term direction, recommendation status, or conversion efficiency.",
        "core_judgements": [
            "Specific column ideas must come from homepage_column_plan and each item must include evidence_basis.",
            "If upstream evidence is direction-only, run a direction-level small-sample test instead of inventing titles.",
            "Review with 24/48h views, 3s retention, completion, comment keywords, profile clicks, follow conversion, and negative feedback.",
        ],
        "evidence_chain": diagnosis + evidence if diagnosis or evidence else [asset_analysis.get("asset_summary", "Conservative judgment based on homepage screenshots, user input, and visible clues.")],
        "first_actions": [
            "Choose the strongest pattern from homepage_evidence_map.",
            "Publish controlled samples from the same evidence source and do not mix other directions yet.",
            "Backfill unified metrics after 48 hours before generating more specific plans.",
        ],
        "first_content_task": {},
        "why_this_path": [
            "This keeps homepage diagnosis separate from single-work scripts.",
            "This prevents keyword or vertical templates from generating fake column titles.",
        ],
        "follow_up_question": "Add recent work details, cover/title screenshots, backend metrics, and comment screenshots to generate a more specific evidence-based column plan.",
        "source_type": "evidence_grounded_homepage_strategy",
        "confidence": "medium" if homepage_patterns else "low",
    }

    tasks = normalize_tasks(
        [
            {"id": "advisor-task-1", "title": "Collect homepage evidence", "goal": "Add recent work details, cover/title screenshots, backend metrics, and comment screenshots.", "priority": "high", "status": "todo", "owner": "user", "source": "advisor_summary"},
            {"id": "advisor-task-2", "title": "Choose strongest evidence pattern", "goal": "Select one pattern from homepage_evidence_map.content_patterns for a small-sample test.", "priority": "high", "status": "todo", "owner": "advisor", "source": "advisor_summary"},
            {"id": "advisor-task-3", "title": "Backfill review metrics", "goal": "Record 24/48h views, 3s retention, completion, comment keywords, profile clicks, follow conversion, and negative feedback.", "priority": "medium", "status": "todo", "owner": "user", "source": "strategy"},
        ],
        profile,
    )
    return {"strategy": strategy, "advisor_summary": advisor_summary, "tasks": tasks}



