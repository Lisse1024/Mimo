from __future__ import annotations

import re
from typing import Any

from .video_context import infer_video_prompt_profile
from .video_understanding import profile_video_understanding

CONTENT_SOURCE_TYPES = {
    "visual_frame",
    "ocr_text",
    "asr_text",
    "on_screen_text",
    "title",
    "caption",
    "hashtag",
    "visible_metric",
    "visible_comment",
    "page_visible_text",
    "user_provided_content_description",
}

OPERATIONAL_SOURCE_TYPES = {
    "user_request",
    "task_instruction",
    "runtime_context",
    "platform_connector_status",
    "media_processing_log",
    "upload_metadata",
    "file_name",
    "asset_count",
    "tool_trace",
    "internal_error",
    "backend_status",
    "debug_message",
}

OPERATIONAL_TEXT_RE = re.compile(
    r"用户请求|請分析|请分析|不要默认把它当成账号主页诊断|platform|hints\s*=|status\s*=|状态\s*=|partial|"
    r"视频[:：].*\.mp4.*完成|\.mp4[:：]?完成|Uploaded\s+assets|Uploaded video assets|asset count|"
    r"current-video-recording|fallback-frame|mediaContext|runtimeContext|runtime context|tool trace|"
    r"platform connector|media processing|素材处理|平台线索|frame-\d+\.jpg|sampling:|duration:|"
    r"sampled .* frame available|pending vision analysis|No uploaded video asset|No video timeline|"
    r"Built sparse video timeline|Sampled video frames available|ffmpeg|cached uploaded media",
    re.IGNORECASE,
)


def _source_type(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("source_type") or value.get("sourceType") or "").strip()
    return ""


def _evidence_text(value: Any) -> str:
    if isinstance(value, dict):
        if _source_type(value) in OPERATIONAL_SOURCE_TYPES:
            return ""
        value = (
            value.get("text")
            or value.get("value")
            or value.get("content")
            or value.get("title")
            or value.get("caption")
            or value.get("fact")
            or value.get("summary")
            or ""
        )
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text or OPERATIONAL_TEXT_RE.search(text):
        return ""
    return text


def _string_list(value: Any, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_evidence_text(item) for item in value if _evidence_text(item)][:limit]


def _confidence_from_evidence(asset_analysis: dict[str, Any], video_understanding: dict[str, Any]) -> str:
    confidence = str(asset_analysis.get("confidence") or "").lower()
    if confidence in {"low", "medium", "high"}:
        return confidence
    timeline = video_understanding.get("timeline")
    if isinstance(timeline, list) and len(timeline) >= 3:
        return "medium"
    if asset_analysis.get("status") == "success":
        return "medium"
    return "low"


def _ledger_confidence(value: Any, fallback: str = "unknown") -> str:
    confidence = str(value or "").lower()
    if confidence in {"high", "medium", "low", "unknown"}:
        return confidence
    return fallback


def _dedupe(items: list[Any], limit: int = 12) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = re.sub(r"\s+", " ", _evidence_text(item)).strip(" ，。；;")
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result


def _append_fact(target: list[Any], value: Any) -> None:
    text = _evidence_text(value)
    if text:
        target.append(text)


def _normalize_source(source: dict[str, Any], video_profile: dict[str, Any], fallback_confidence: str) -> dict[str, Any]:
    name = str(
        source.get("name")
        or source.get("possible_title")
        or source.get("title")
        or video_profile.get("source_guess")
        or ""
    ).strip()
    if name in {"疑似，暂不能确认", "片源待确认", "unknown"}:
        name = "" if name != "unknown" else "unknown"
    evidence = _string_list(source.get("evidence"), 8)
    uncertainty = _string_list(source.get("uncertainty"), 4)
    return {
        "name": name,
        "confidence": _ledger_confidence(source.get("confidence"), fallback_confidence if fallback_confidence in {"high", "medium", "low"} else "unknown"),
        "evidence": _dedupe([*evidence, *uncertainty], 8),
    }


def _normalize_characters(value: Any, fallback_evidence: list[str]) -> list[dict[str, Any]]:
    raw_items = value if isinstance(value, list) else []
    characters: list[dict[str, Any]] = []
    for item in raw_items[:8]:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            role = str(item.get("role") or "unknown").strip() or "unknown"
            confidence = _ledger_confidence(item.get("confidence"), "low")
            evidence = _string_list(item.get("evidence"), 4) or fallback_evidence[:2]
        else:
            text = _evidence_text(item)
            if not text:
                continue
            if re.search(r"[:：\-—]", text):
                name, role = [part.strip() for part in re.split(r"[:：\-—]", text, maxsplit=1)]
                role = role or "unknown"
            else:
                name, role = text, "unknown"
            confidence = "low"
            evidence = fallback_evidence[:2]
        if name:
            characters.append({"name": name, "role": role, "confidence": confidence, "evidence": evidence})
    return characters


def _normalize_timeline(value: Any) -> list[dict[str, Any]]:
    timeline = value if isinstance(value, list) else []
    normalized: list[dict[str, Any]] = []
    for item in timeline[:20]:
        if not isinstance(item, dict):
            continue
        visible = _dedupe([item.get("visual_fact"), item.get("visualEvidence"), *(_string_list(item.get("visible_facts"), 6))], 6)
        audio = _dedupe([item.get("audio_transcript"), item.get("audioTranscript"), *(_string_list(item.get("audio_facts"), 4))], 4)
        text = _dedupe([item.get("ocr_text"), item.get("ocrText"), *(_string_list(item.get("text_facts"), 4))], 4)
        inferred = _dedupe([item.get("inference"), *(_string_list(item.get("inferred_claims"), 4))], 4)
        if not (visible or audio or text):
            continue
        normalized.append(
            {
                "time_range": str(item.get("time_range") or item.get("timeRange") or "").strip(),
                "visible_facts": visible,
                "audio_facts": [fact for fact in audio if not fact.startswith("ASR transcript is available at video level")],
                "text_facts": text,
                "inferred_claims": inferred,
                "confidence": _ledger_confidence(item.get("confidence"), "low"),
            }
        )
    return normalized


GENERIC_HOOKS = {"冲突", "反差", "情绪价值", "情绪点", "爆点", "悬念"}


def _normalize_growth_hooks(value: Any, fallback_candidates: list[str], evidence: list[str]) -> list[dict[str, str]]:
    raw_items = value if isinstance(value, list) else []
    hooks: list[dict[str, str]] = []
    for item in raw_items[:8]:
        if isinstance(item, dict):
            hook = _evidence_text(item.get("hook"))
            hook_evidence = _evidence_text(item.get("evidence"))
            confidence = _ledger_confidence(item.get("confidence"), "low")
        else:
            hook = _evidence_text(item)
            hook_evidence = ""
            confidence = "low"
        if not hook or hook in GENERIC_HOOKS:
            continue
        hooks.append({"hook": hook, "evidence": hook_evidence or (evidence[0] if evidence else hook), "confidence": confidence if confidence != "unknown" else "low"})

    for candidate in fallback_candidates[:6]:
        text = str(candidate or "").strip()
        text = _evidence_text(text)
        if not text or text in GENERIC_HOOKS:
            continue
        hooks.append({"hook": text, "evidence": next((item for item in evidence if text[:8] in item or item[:8] in text), evidence[0] if evidence else text), "confidence": "medium" if evidence else "low"})
    unique: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in hooks:
        key = item["hook"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique[:8]


def _clean_fact_ledger(
    raw: Any,
    profile: dict[str, Any],
    asset_analysis: dict[str, Any],
    video_understanding: dict[str, Any],
    video_profile: dict[str, Any],
    link_clues: dict[str, Any],
    confidence: str,
) -> dict[str, Any]:
    ledger = raw if isinstance(raw, dict) else {}
    source = asset_analysis.get("source_identification") if isinstance(asset_analysis.get("source_identification"), dict) else {}
    clip = asset_analysis.get("clip_context") if isinstance(asset_analysis.get("clip_context"), dict) else {}
    timeline = _normalize_timeline(ledger.get("timeline") or video_understanding.get("timeline"))

    visible_facts: list[Any] = []
    audio_facts: list[Any] = []
    text_facts: list[Any] = []
    visible_facts.extend(_string_list(ledger.get("visible_facts"), 16))
    audio_facts.extend(_string_list(ledger.get("audio_facts"), 12))
    text_facts.extend(_string_list(ledger.get("text_facts"), 16))
    visible_facts.extend(_string_list(video_understanding.get("observable_facts"), 8))
    visible_facts.extend(_string_list(asset_analysis.get("video_observations"), 8))
    _append_fact(visible_facts, clip.get("visible_plot"))
    for item in timeline:
        visible_facts.extend(item.get("visible_facts", []))
        audio_facts.extend(item.get("audio_facts", []))
        text_facts.extend(item.get("text_facts", []))
    if video_understanding.get("audio_transcript"):
        audio_facts.append(video_understanding.get("audio_transcript"))
    for title in link_clues["titles"]:
        clean_title = _evidence_text(title)
        if clean_title:
            text_facts.append(f"标题：{clean_title}")
    for tag in link_clues["tags"]:
        clean_tag = _evidence_text(tag)
        if clean_tag:
            text_facts.append(f"标签：{clean_tag}")
    # profile.evidence_facts can include user requests, connector status and
    # media-processing logs. Keep those for trace/boundary, not content strategy.

    evidence = _dedupe([*_string_list(asset_analysis.get("evidence"), 12), *_string_list(ledger.get("visible_facts"), 4), *_string_list(ledger.get("text_facts"), 4)], 12)
    possible_source = _normalize_source(
        ledger.get("possible_source") if isinstance(ledger.get("possible_source"), dict) else source,
        video_profile,
        confidence,
    )
    if not possible_source["evidence"]:
        possible_source["evidence"] = evidence[:4]

    characters = _normalize_characters(ledger.get("characters_or_people"), evidence)
    if not characters:
        characters = _normalize_characters(clip.get("characters_or_roles"), evidence)

    limitations = _dedupe(
        [
            *_string_list(ledger.get("limitations"), 12),
            *_string_list(video_understanding.get("missing_evidence"), 12),
            *_string_list(asset_analysis.get("limitations"), 12),
        ],
        18,
    )
    if not timeline:
        limitations.append("缺少可核验的视频时间轴，不能把少量线索扩写成完整剧情。")
    if not audio_facts:
        limitations.append("缺少完整 ASR 或可核验音频信息。")
    if not any("评论" in item for item in limitations):
        limitations.append("评论区截图或评论数据缺失。")
    if not any("后台" in item for item in limitations):
        limitations.append("后台数据、留存曲线和互动指标缺失。")
    if not any("授权" in item for item in limitations):
        limitations.append("平台身份或素材授权信息缺失。")

    raw_hooks = ledger.get("growth_hooks")
    fallback_hooks = [
        *_string_list(video_understanding.get("hook_candidates"), 8),
        *_string_list(asset_analysis.get("traffic_mechanism"), 8),
        *_string_list(asset_analysis.get("content_opportunities"), 4),
        *link_clues["titles"][:3],
        *link_clues["tags"][:4],
    ]

    return {
        "visible_facts": _dedupe(visible_facts, 18),
        "audio_facts": _dedupe(audio_facts, 12),
        "text_facts": _dedupe(text_facts, 18),
        "possible_source": possible_source,
        "characters_or_people": characters[:8],
        "timeline": timeline,
        "growth_hooks": _normalize_growth_hooks(raw_hooks, fallback_hooks, evidence + _dedupe(text_facts + visible_facts, 12)),
        "limitations": _dedupe(limitations, 18),
        "source_policy": {
            "content_source_types": sorted(CONTENT_SOURCE_TYPES),
            "excluded_operational_source_types": sorted(OPERATIONAL_SOURCE_TYPES),
        },
    }


def _infer_content_type(fact_ledger: dict[str, Any], asset_analysis: dict[str, Any], video_profile: dict[str, Any]) -> dict[str, Any]:
    asset_evidence = asset_analysis.get("evidence") if isinstance(asset_analysis.get("evidence"), list) else []
    evidence_items = _dedupe(
        [
            *fact_ledger.get("visible_facts", []),
            *fact_ledger.get("audio_facts", []),
            *fact_ledger.get("text_facts", []),
            *[item.get("hook", "") for item in fact_ledger.get("growth_hooks", []) if isinstance(item, dict)],
            *asset_evidence,
        ],
        24,
    )
    text = "\n".join(evidence_items)
    checks: list[tuple[str, list[str]]] = [
        ("tutorial", ["教程", "教学", "步骤", "完整版教学", "手部操作", "操作近景", "第N集", "第 N 集"]),
        ("media_clip", ["影视", "影视剪辑", "剧集", "短剧", "综艺", "小品", "剧集片段", "电影片段", "人物对话", "剧情", "台词"]),
        ("performance", ["演奏", "翻唱", "表演", "伴奏", "曲谱", "唱", "弹奏"]),
        ("gameplay", ["游戏", "实况", "操作", "关卡", "战绩", "队友"]),
        ("product_review", ["测评", "开箱", "产品", "参数", "对比"]),
        ("knowledge", ["科普", "知识", "解释", "原理", "观点"]),
        ("vlog", ["vlog", "日常", "记录", "探店", "旅行"]),
    ]
    best_type = "unknown"
    best_hits: list[str] = []
    for content_type, keywords in checks:
        hits = [item for item in evidence_items if any(keyword.lower() in item.lower() for keyword in keywords)]
        if len(hits) > len(best_hits):
            best_type = content_type
            best_hits = hits
    if best_type == "unknown" and evidence_items:
        best_type = "platform_native"
        best_hits = evidence_items[:3]
    fallback_type = str(video_profile.get("content_type") or "unknown")
    if best_type == "unknown" and fallback_type not in {"", "unknown"}:
        best_type = fallback_type
    return {
        "content_type": best_type,
        "content_type_confidence": "high" if len(best_hits) >= 3 else "medium" if best_hits else "low",
        "content_type_evidence": best_hits[:6],
    }


def _extract_link_clues(profile: dict[str, Any]) -> dict[str, Any]:
    work_links = profile.get("work_links", []) if isinstance(profile.get("work_links"), list) else []
    titles: list[str] = []
    tags: list[str] = []
    urls: list[str] = []
    for item in work_links:
        if not isinstance(item, dict):
            continue
        if item.get("shared_title"):
            titles.append(str(item.get("shared_title")).strip())
        if item.get("url"):
            urls.append(str(item.get("url")).strip())
        raw_tags = item.get("shared_tags")
        if isinstance(raw_tags, list):
            tags.extend(str(tag).strip() for tag in raw_tags if str(tag).strip())
    return {
        "titles": titles[:6],
        "tags": tags[:16],
        "urls": urls[:6],
    }


def build_work_understanding(profile: dict[str, Any], asset_analysis: dict[str, Any]) -> dict[str, Any]:
    """Build a stable single-work representation for downstream Agent decisions."""
    video_understanding = (
        asset_analysis.get("video_understanding")
        if isinstance(asset_analysis.get("video_understanding"), dict)
        else profile_video_understanding(profile)
    )
    if not isinstance(video_understanding, dict):
        video_understanding = {}

    video_profile = infer_video_prompt_profile(profile, asset_analysis)
    link_clues = _extract_link_clues(profile)
    timeline = video_understanding.get("timeline") if isinstance(video_understanding.get("timeline"), list) else []
    missing_evidence = _string_list(video_understanding.get("missing_evidence"), 12)
    if not timeline:
        missing_evidence.append("缺少可核验的视频时间轴，不能判断真实剪辑节奏。")
    if not video_understanding.get("audio_summary"):
        missing_evidence.append("缺少音频/ASR 信息，不能判断台词、BGM、解说节奏。")

    source = asset_analysis.get("source_identification") if isinstance(asset_analysis.get("source_identification"), dict) else {}
    visual_observations = _string_list(asset_analysis.get("video_observations"), 12)
    evidence = _string_list(asset_analysis.get("evidence"), 12)
    limitations = _string_list(asset_analysis.get("limitations"), 12)

    content_type = str(source.get("content_type") or video_profile.get("content_type") or "unknown")
    source_title = str(source.get("possible_title") or source.get("title") or video_profile.get("source_guess") or "").strip()
    confidence = _confidence_from_evidence(asset_analysis, video_understanding)
    fact_ledger = _clean_fact_ledger(
        asset_analysis.get("fact_ledger") or asset_analysis.get("work_fact_ledger"),
        profile,
        asset_analysis,
        video_understanding,
        video_profile,
        link_clues,
        confidence,
    )
    content_type_info = _infer_content_type(fact_ledger, asset_analysis, video_profile)

    return {
        "schema_version": "work_understanding.v1",
        "task_intent": profile.get("task_intent") or profile.get("result_mode") or "unknown",
        "content_type": content_type_info["content_type"] if content_type_info["content_type"] != "unknown" else content_type,
        "content_type_confidence": content_type_info["content_type_confidence"],
        "content_type_evidence": content_type_info["content_type_evidence"],
        "content_label": video_profile.get("label", "未知单条作品"),
        "source_title": source_title,
        "source_confidence": str(source.get("confidence") or confidence),
        "titles": link_clues["titles"],
        "tags": link_clues["tags"],
        "urls": link_clues["urls"],
        "timeline": timeline[:20],
        "hook_candidates": _string_list(video_understanding.get("hook_candidates"), 8),
        "audio_summary": str(video_understanding.get("audio_summary") or ""),
        "caption_summary": str(video_understanding.get("caption_summary") or ""),
        "visual_observations": visual_observations,
        "replication_variables": [
            "开头钩子",
            "镜头顺序",
            "字幕信息密度",
            "标题标签",
            "评论触发点",
        ],
        "evidence": evidence,
        "limitations": list(dict.fromkeys([*missing_evidence, *limitations]))[:16],
        "fact_ledger": fact_ledger,
        "work_fact_ledger": fact_ledger,
        "confidence": confidence,
    }
