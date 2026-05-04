import json
import os
import re
from typing import Any

from .catalog import PLATFORM_LIBRARY
from .video_context import is_profile_share_text

HOMEPAGE_CONTENT_SOURCE_TYPES = {
    "profile_visible_name",
    "profile_bio",
    "profile_stats",
    "profile_visible_text",
    "work_title",
    "work_cover_text",
    "work_visible_metric",
    "work_grid_visual",
    "ocr_text",
    "browser_page_visible_text",
    "user_provided_homepage_description",
}

HOMEPAGE_FORBIDDEN_SOURCE_TYPES = {
    "local_user_default",
    "profile_default_value",
    "runtime_context",
    "active_window_process",
    "active_window_title",
    "browser_process",
    "file_name",
    "mime_type",
    "file_size",
    "upload_metadata",
    "asset_count",
    "screenshot_debug",
    "tool_trace",
    "internal_error",
    "platform_connector_status",
    "backend_status",
    "debug_message",
}

HOMEPAGE_FORBIDDEN_TEXT_RE = re.compile(
    r"本地用户|待确认账号|unknown\b|screen\b|image/(?:png|jpe?g|webp)|video/mp4|"
    r"\.(?:png|jpe?g|webp|mp4)\b|当前窗口|窗口标题|窗口进程|process|"
    r"msedgewebview2|chrome|electron|tauri|browser|upload|asset|mime|文件大小|"
    r"用户档案|browser hint|platform hint|runtime|debug|Traceback|ReferenceError|"
    r"TypeError|undefined|stack",
    flags=re.I,
)


def _is_homepage_content_text(text: Any) -> bool:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not (2 <= len(value) <= 220):
        return False
    if HOMEPAGE_FORBIDDEN_TEXT_RE.search(value):
        return False
    return True


def _homepage_evidence_item(source_type: str, text: Any) -> dict[str, str] | None:
    if source_type not in HOMEPAGE_CONTENT_SOURCE_TYPES:
        return None
    value = re.sub(r"\s+", " ", str(text or "")).strip(" -:\uff1a\t")
    if not _is_homepage_content_text(value):
        return None
    return {"source_type": source_type, "text": value[:220]}

def platform_identity_snapshot(platform: str, account_id: str, work_links: list[dict[str, Any]]) -> dict[str, Any]:
    account_id = account_id.strip()[:500]
    has_homepage_link = account_id.startswith(("http://", "https://"))
    inferred_platform = detect_link_platform(account_id) if has_homepage_link else PLATFORM_LIBRARY.get(platform, {}).get("name", "未知平台")
    connector_ready = bool(os.environ.get("PLATFORM_CONNECTOR_BASE_URL", ""))
    status = "ready_for_fetch" if connector_ready and account_id else "identity_saved"
    if not account_id and not work_links:
        status = "missing_identity"

    return {
        "platform": PLATFORM_LIBRARY.get(platform, PLATFORM_LIBRARY["custom-platform"])["name"],
        "account_identity": account_id,
        "identity_type": "homepage_url" if has_homepage_link else "platform_id",
        "inferred_platform": inferred_platform,
        "work_link_count": len(work_links),
        "connector_status": status,
        "fetch_capability": "external_connector_required",
        "explain": (
            "当前版本已保存平台身份线索；后续通过用户授权录屏、截图、浏览器桥接和人工指标回填补充主页、作品列表和互动数据。"
            if account_id or work_links
            else "用户暂未提供平台账号 ID、主页链接或作品链接，Agent 只能基于手填档案和上传素材分析。"
        ),
        "next_fetch_fields": ["主页昵称", "简介", "粉丝数", "作品标题", "发布时间", "播放/点赞/收藏/评论", "封面与标签"],
        "source_type": "platform_identity_hint" if account_id or work_links else "user_input",
        "confidence": "medium" if account_id or work_links else "high",
    }


def extract_browser_structured_signals(text: str) -> dict[str, Any]:
    match = re.search(r"structured_page_signals:\s*(\{.*?\})(?:\n-|\n[A-Z]|\Z)", text, flags=re.S)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    counts = parsed.get("counts") if isinstance(parsed.get("counts"), dict) else {}
    safe_counts = {
        str(key): value
        for key, value in counts.items()
        if key in {"likes", "comments", "saves", "shares", "views", "followers"} and isinstance(value, (int, float))
    }
    return {
        "canonical_url": str(parsed.get("canonicalUrl", ""))[:500],
        "title": str(parsed.get("ogTitle", ""))[:200],
        "description": str(parsed.get("ogDescription", ""))[:500],
        "author": str(parsed.get("author", ""))[:120],
        "hashtags": [str(item)[:40] for item in parsed.get("hashtags", [])[:12]] if isinstance(parsed.get("hashtags"), list) else [],
        "counts": safe_counts,
        "source_type": "browser_dom_visible_signal",
        "confidence": "medium" if safe_counts or parsed.get("ogTitle") else "low",
    }


def extract_first_int(pattern: str, text: str) -> int | None:
    match = re.search(pattern, text, flags=re.I)
    if not match:
        return None
    raw = match.group(1).replace(",", "").replace("，", "").strip()
    try:
        return int(raw)
    except ValueError:
        return None


def extract_visible_play_counts(text: str, excluded: set[int] | None = None) -> list[int]:
    excluded = excluded or set()
    counts: list[int] = []
    for match in re.finditer(r"(?:播放量|播放|▶|▷)\s*[:：]?\s*(\d{2,6})(?=\s|$|[^\d])", text):
        value = int(match.group(1))
        if 20 <= value <= 999999 and value not in excluded and value not in counts:
            counts.append(value)
    for line in text.splitlines():
        if not re.search(r"播放量|播放数据|播放分布|播放区间", line):
            continue
        for match in re.finditer(r"[\u4e00-\u9fa5A-Za-z#/_-]{1,18}\s*(\d{2,6})(?=\D|$)", line):
            value = int(match.group(1))
            if 20 <= value <= 999999 and value not in excluded and value not in counts:
                counts.append(value)
    return counts[:12]



def infer_homepage_content_categories(text: str) -> list[str]:
    """Return evidence-derived visible content signals without vertical keyword rules."""
    candidates: list[str] = []
    seen: set[str] = set()
    for raw in re.split(r"[\n\r;。！？.!?]+", str(text or "")):
        item = re.sub(r"\s+", " ", raw).strip(" -:\uff1a\t")
        if not (4 <= len(item) <= 80):
            continue
        if re.search(r"Traceback|ReferenceError|TypeError|undefined|stack", item, flags=re.I):
            continue
        if item not in seen:
            seen.add(item)
            candidates.append(item[:80])
        if len(candidates) >= 8:
            break
    return candidates

def homepage_ocr_text(profile: dict[str, Any], tool_registry: Any | None = None, tool_runs: list[dict[str, Any]] | None = None) -> tuple[str, list[str]]:
    from .assets import resolve_safe_path, run_ocr_for_image

    chunks: list[str] = []
    notes: list[str] = []
    for asset in profile.get("asset_files", []):
        if not isinstance(asset, dict):
            continue
        if not str(asset.get("mime", "")).startswith("image/"):
            continue
        if str(asset.get("context", "")) not in {"homepage_screenshot", "uploaded_image", ""}:
            continue
        path = resolve_safe_path(str(asset.get("path", "")))
        if not path:
            continue
        if tool_registry and tool_registry.has("media.ocr_image"):
            ocr_result, tool_run = tool_registry.run("media.ocr_image", image_path=path)
            if tool_runs is not None:
                tool_runs.append(tool_run)
            text, note = ocr_result if isinstance(ocr_result, tuple) else ("", tool_run.get("error") or "OCR 工具未返回结果。")
        else:
            text, note = run_ocr_for_image(path)
        if text:
            chunks.append(text)
        if note:
            notes.append(note)
    return "\n".join(chunks), sorted(set(notes))[:4]


def build_homepage_fallback_analysis(profile: dict[str, Any], reason: str = "", tool_registry: Any | None = None) -> dict[str, Any]:
    local_tool_runs: list[dict[str, Any]] = []
    ocr_text, ocr_notes = homepage_ocr_text(profile, tool_registry=tool_registry, tool_runs=local_tool_runs)
    observed = profile.get("platform_observed_metrics") if isinstance(profile.get("platform_observed_metrics"), dict) else {}
    observed_counts = observed.get("counts") if isinstance(observed.get("counts"), dict) else {}
    evidence_facts = profile.get("evidence_facts") if isinstance(profile.get("evidence_facts"), list) else []
    source_text = "\n".join(
        [
            str(profile.get("desktop_context", "")),
            str(profile.get("asset_notes", "")),
            str(profile.get("user_request", "")),
            "\n".join(str(item) for item in evidence_facts),
            json.dumps(observed, ensure_ascii=False),
            reason,
            ocr_text,
        ]
    )

    works = extract_first_int(r"作品\s*[:：]?\s*(\d+)", source_text)
    if works is None:
        works = extract_first_int(r"(\d+)\s*(?:个|条)?作品", source_text)
    followers = extract_first_int(r"粉丝\s*[:：]?\s*(\d+)", source_text)
    likes = extract_first_int(r"获赞\s*[:：]?\s*(\d+)", source_text)
    following = extract_first_int(r"关注\s*[:：]?\s*(\d+)", source_text)
    if followers is None and isinstance(observed_counts.get("followers"), (int, float)):
        followers = int(observed_counts["followers"])
    if likes is None and isinstance(observed_counts.get("likes"), (int, float)):
        likes = int(observed_counts["likes"])

    excluded_counts = {item for item in [works, followers, likes, following] if isinstance(item, int)}
    play_counts = extract_visible_play_counts(source_text, excluded_counts)
    categories = infer_homepage_content_categories(source_text)
    metrics_parts = []
    if works is not None:
        metrics_parts.append(f"作品 {works}")
    if followers is not None:
        metrics_parts.append(f"粉丝 {followers}")
    if likes is not None:
        metrics_parts.append(f"获赞 {likes}")
    if following is not None:
        metrics_parts.append(f"关注 {following}")
    if play_counts:
        metrics_parts.append(f"可见播放量约 {min(play_counts)}-{max(play_counts)}")

    if metrics_parts or categories:
        asset_summary = "已基于主页截图/OCR/浏览器上下文提取到主页公开信息："
        asset_summary += "，".join(metrics_parts) if metrics_parts else "公开指标不完整"
        if categories:
            asset_summary += f"；可见作品类型包括{'、'.join(categories)}。"
        else:
            asset_summary += "；作品类型仍需更清晰截图或链接核验。"
    else:
        asset_summary = "已收到主页截图，但视觉模型未返回结构化结果；当前只能基于窗口标题、浏览器上下文和用户请求做保守账号诊断。"

    homepage_diagnosis: list[str] = []
    if categories and len(categories) >= 3:
        homepage_diagnosis.append(f"主页首屏作品横跨{'、'.join(categories[:5])}，账号标签较分散，新访客不容易判断关注后会持续看到什么。")
    elif categories:
        homepage_diagnosis.append(f"主页当前较明显的内容方向是{'、'.join(categories)}，需要继续验证是否能稳定更新和转粉。")
    else:
        homepage_diagnosis.append("当前截图可解析信息有限，账号定位判断需要保持保守。")
    if works is not None and followers is not None:
        homepage_diagnosis.append(f"账号处于冷启动观察期：可见作品 {works} 条、粉丝 {followers}，更适合先做方向收敛测试，而不是直接追求复杂矩阵。")
    if play_counts:
        homepage_diagnosis.append(f"可见播放量有波动（约 {min(play_counts)} 到 {max(play_counts)}），但缺少完播、主页点击和涨粉来源，不能判断单一脚本结构已经有效。")
    else:
        homepage_diagnosis.append("缺少逐条作品后台数据，不能判断播放差异来自选题、封面、完播还是发布时间。")

    content_opportunities: list[str] = []
    if any("游戏" in item for item in categories):
        content_opportunities.append("可以把游戏内容作为一个测试方向，但要用连续 3 条同栏目内容验证，而不是只凭单条封面判断。")
    if any("萌娃" in item for item in categories):
        content_opportunities.append("萌娃/家庭生活也具备测试价值，尤其适合做真实反应、亲子瞬间和评论共鸣。")
    if not content_opportunities:
        content_opportunities.append("先从最容易连续生产、最能形成统一封面和标题关键词的方向开始测试。")
    content_opportunities.append("第一周不要混发过多赛道，优先用小样本验证一个主方向的播放稳定性、评论率和主页点击。")

    visual_style = []
    if categories:
        visual_style.append("封面视觉和内容主题跨度较大，主页首屏缺少统一栏目感。")
    visual_style.append("建议统一封面关键词、字幕层级和结尾提问，让主页形成可识别的系列。")

    limitations = ["缺少可核验主页链接和创作者后台数据，所有结论只基于主页截图/页面可见信息做保守判断。"]
    if reason:
        public_reason = reason.split("\n{", 1)[0].strip() or "视觉模型未返回可直接展示的结构化结果，已改用可见信息做保守分析。"
        limitations.append(public_reason[:220])
    limitations.extend(ocr_notes)

    result = {
        "status": "homepage_fallback",
        "asset_summary": asset_summary,
        "homepage_diagnosis": homepage_diagnosis[:4],
        "video_observations": [],
        "visual_style": visual_style[:3],
        "content_opportunities": content_opportunities[:4],
        "shooting_and_editing_advice": [
            "账号诊断阶段先确定栏目方向，再设计单条脚本；不要把主页截图误当成当前视频关键帧。",
            "每条测试内容保持同一封面关键词、同一字幕样式和同一结尾互动问题。",
        ],
        "evidence": [
            asset_summary,
            "证据来自主页截图/OCR、浏览器上下文、窗口标题和页面可见公开指标。",
        ],
        "limitations": limitations[:5],
        "source_type": "homepage_fallback_observation",
        "confidence": "medium" if metrics_parts or categories else "low",
    }
    homepage_evidence_map = build_homepage_evidence_map(profile, result)
    homepage_column_plan, homepage_column_plan_status = build_homepage_column_plan(homepage_evidence_map)
    result["homepage_evidence_map"] = homepage_evidence_map
    result["homepage_column_plan"] = homepage_column_plan
    result["homepage_column_plan_status"] = homepage_column_plan_status
    if local_tool_runs:
        result["tool_runs"] = local_tool_runs
    return result


def _text_list(value: Any, limit: int = 8) -> list[str]:
    if isinstance(value, list):
        raw = value
    elif value:
        raw = [value]
    else:
        raw = []
    result: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text[:220])
        if len(result) >= limit:
            break
    return result



def _homepage_source_items(profile: dict[str, Any], asset_analysis: dict[str, Any], limit: int = 24) -> list[dict[str, str]]:
    observed = profile.get("platform_observed_metrics") if isinstance(profile.get("platform_observed_metrics"), dict) else {}
    evidence_facts = profile.get("evidence_facts") if isinstance(profile.get("evidence_facts"), list) else []
    chunks: list[tuple[str, Any]] = [
        ("profile_default_value", profile.get("account_id")),
        ("profile_visible_name", profile.get("nickname")),
        ("profile_bio", profile.get("bio") or profile.get("description")),
        ("runtime_context", profile.get("desktop_context")),
        ("upload_metadata", profile.get("asset_notes")),
        ("task_instruction", profile.get("user_request")),
        ("profile_stats", json.dumps(observed, ensure_ascii=False) if observed else ""),
    ]
    for item in evidence_facts:
        if isinstance(item, dict):
            chunks.append((str(item.get("source_type") or ""), item.get("text") or item.get("value") or item.get("content") or ""))
        else:
            chunks.append(("profile_visible_text", item))
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for source_type, chunk in chunks:
        if source_type not in HOMEPAGE_CONTENT_SOURCE_TYPES:
            continue
        for item in _text_list(chunk, limit):
            for part in re.split(r"[\n\r;。！？.!?]+", item):
                evidence_item = _homepage_evidence_item(source_type, part)
                if not evidence_item:
                    continue
                text = evidence_item["text"]
                if 2 <= len(text) <= 120 and text not in seen:
                    seen.add(text)
                    items.append(evidence_item)
                if len(items) >= limit:
                    return items
    return items


def _homepage_source_lines(profile: dict[str, Any], asset_analysis: dict[str, Any], limit: int = 24) -> list[str]:
    return [item["text"] for item in _homepage_source_items(profile, asset_analysis, limit)]


def _pattern_name_from_evidence(line: str) -> str:
    quoted = re.search(r"《([^》]{2,32})》|[“\"]([^”\"]{2,32})[”\"]|(#[-_\w\u4e00-\u9fff]{2,32})", line)
    if quoted:
        return next(group for group in quoted.groups() if group)[:40]
    compact = re.sub(r"[\s,，:：]+", " ", line).strip()
    return compact[:28] or "\u53ef\u89c1\u5185\u5bb9\u6a21\u5f0f"


def build_homepage_evidence_map(profile: dict[str, Any], asset_analysis: dict[str, Any]) -> dict[str, Any]:
    observed = profile.get("platform_observed_metrics") if isinstance(profile.get("platform_observed_metrics"), dict) else {}
    counts = observed.get("counts") if isinstance(observed.get("counts"), dict) else {}
    source_items = _homepage_source_items(profile, asset_analysis)
    source_lines = [item["text"] for item in source_items]
    summary = str(asset_analysis.get("asset_summary", ""))

    visible_samples = [
        {
            "title": item,
            "cover_text": item,
            "visual_type": "visible_homepage_signal",
            "visible_metric": "",
            "evidence_strength": "medium",
        }
        for item in source_lines[:8]
    ]

    grouped: dict[str, list[dict[str, str]]] = {}
    for item in source_items:
        line = item["text"]
        name = _pattern_name_from_evidence(line)
        grouped.setdefault(name, [])
        if all(existing.get("text") != line for existing in grouped[name]):
            grouped[name].append(item)

    patterns: list[dict[str, Any]] = []
    for name, evidence_items in grouped.items():
        if not evidence_items:
            continue
        evidence_texts = [item["text"] for item in evidence_items if item.get("source_type") in HOMEPAGE_CONTENT_SOURCE_TYPES and _is_homepage_content_text(item.get("text"))]
        source_types = sorted({item["source_type"] for item in evidence_items if item.get("source_type") in HOMEPAGE_CONTENT_SOURCE_TYPES})
        if not evidence_texts or not source_types or not _is_homepage_content_text(name):
            continue
        repeat_count = len(evidence_items)
        patterns.append(
            {
                "pattern_name": name,
                "evidence": _text_list(evidence_texts, 5),
                "source_types": source_types,
                "repeat_count": repeat_count,
                "surface_strength": "high" if repeat_count >= 3 else "medium" if repeat_count == 2 else "low",
                "why_it_matters": "\u8be5\u6a21\u5f0f\u6765\u81ea\u5f53\u524d\u4e3b\u9875\u53ef\u89c1\u6587\u672c\u3001\u6807\u9898\u3001\u5c01\u9762\u3001\u7b80\u4ecb\u6216\u7528\u6237\u63cf\u8ff0\uff0c\u53ef\u4f5c\u4e3a\u680f\u76ee\u5b9e\u9a8c\u5019\u9009\uff0c\u4f46\u4e0d\u80fd\u66ff\u4ee3\u540e\u53f0\u6570\u636e\u9a8c\u8bc1\u3002",
            }
        )
        if len(patterns) >= 6:
            break

    missing = _text_list(asset_analysis.get("limitations"), 6)
    for item in ["\u540e\u53f0\u64ad\u653e\u3001\u5b8c\u64ad\u3001\u8f6c\u7c89\u6570\u636e\u7f3a\u5931", "\u8bc4\u8bba\u533a\u53cd\u9988\u7f3a\u5931", "\u6700\u8fd1\u4f5c\u54c1\u8be6\u60c5\u9875\u4fe1\u606f\u4e0d\u8db3"]:
        if item not in missing:
            missing.append(item)

    return {
        "profile_signals": {
            "account_name": str(profile.get("nickname") or "") if _is_homepage_content_text(profile.get("nickname")) else "",
            "bio": str(profile.get("bio") or profile.get("description") or "") if _is_homepage_content_text(profile.get("bio") or profile.get("description")) else "",
            "stats": counts,
            "visible_profile_promise": summary[:220] if _is_homepage_content_text(summary) else "",
        },
        "visible_work_samples": visible_samples,
        "content_patterns": [item for item in patterns if item.get("evidence")],
        "profile_problems": [item for item in _text_list(asset_analysis.get("homepage_diagnosis"), 4) if _is_homepage_content_text(item)],
        "missing_evidence": missing[:8],
    }


def build_homepage_column_plan(homepage_evidence_map: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    patterns = homepage_evidence_map.get("content_patterns") if isinstance(homepage_evidence_map.get("content_patterns"), list) else []
    valid_patterns = [
        item
        for item in patterns
        if isinstance(item, dict)
        and item.get("pattern_name")
        and _is_homepage_content_text(item.get("pattern_name"))
        and any(_is_homepage_content_text(text) for text in _text_list(item.get("evidence"), 5))
    ]
    if not valid_patterns:
        return [], "insufficient_evidence"

    specific_patterns = [item for item in valid_patterns if int(item.get("repeat_count") or 0) >= 2 or item.get("surface_strength") in {"high", "medium"}]
    if not specific_patterns:
        return [], "direction_only"

    plans: list[dict[str, Any]] = []
    for pattern in specific_patterns[:3]:
        evidence_basis = [item for item in _text_list(pattern.get("evidence"), 5) if _is_homepage_content_text(item)]
        if not evidence_basis:
            continue
        title = str(pattern.get("pattern_name", "")).strip()[:40]
        plans.append(
            {
                "title": f"{title}\uff1a\u540c\u8bc1\u636e\u5c0f\u6837\u672c",
                "why_this": str(pattern.get("why_it_matters") or "\u8be5\u5efa\u8bae\u6765\u81ea\u5f53\u524d\u4e3b\u9875\u8bc1\u636e\u56fe\uff0c\u9002\u5408\u5148\u505a\u5c0f\u6837\u672c\u9a8c\u8bc1\u3002"),
                "evidence_basis": evidence_basis,
                "episode_idea": f"\u56f4\u7ed5\u8bc1\u636e\u300c{evidence_basis[0]}\u300d\u505a\u4e00\u6761\u540c\u680f\u76ee\u5185\u5bb9\uff0c\u53ea\u66ff\u6362\u5177\u4f53\u7d20\u6750\uff0c\u4e0d\u66ff\u6362\u65b9\u5411\u3002",
                "visual_suggestion": "\u4f18\u5148\u590d\u7528\u8bc1\u636e\u4e2d\u5df2\u7ecf\u51fa\u73b0\u7684\u6807\u9898\u3001\u5c01\u9762\u6587\u5b57\u3001\u753b\u9762\u6216\u4e3b\u9875\u627f\u8bfa\u3002",
                "caption_or_voiceover": f"\u8fd9\u6761\u5148\u9a8c\u8bc1\u300c{title}\u300d\u662f\u5426\u80fd\u7a33\u5b9a\u5e26\u6765\u505c\u7559\u548c\u8bc4\u8bba\u5173\u952e\u8bcd\u3002",
                "purpose": "\u9a8c\u8bc1\u8be5\u53ef\u89c1\u5185\u5bb9\u6a21\u5f0f\u662f\u5426\u503c\u5f97\u8fde\u7eed\u53d1\u5e03\u3002",
                "test_metric": "24/48 \u5c0f\u65f6\u64ad\u653e\u91cf\u30013 \u79d2\u7559\u5b58\u3001\u5b8c\u64ad\u7387\u3001\u8bc4\u8bba\u5173\u952e\u8bcd\u3001\u4e3b\u9875\u70b9\u51fb\u7387\u3001\u5173\u6ce8\u8f6c\u5316\u3001\u8d1f\u53cd\u9988",
                "confidence": str(pattern.get("surface_strength") or "medium"),
            }
        )
    return (plans, "specific") if plans else ([], "direction_only")

def is_single_work_analysis_request(profile: dict[str, Any]) -> bool:
    work_links = profile.get("work_links", [])
    if not isinstance(work_links, list):
        work_links = []
    has_shared_work_text = any(
        isinstance(item, dict)
        and item.get("page_kind_guess") != "profile"
        and (item.get("shared_title") or item.get("shared_tags"))
        for item in work_links
    )
    raw_text = " ".join(
        [
            str(profile.get("work_links_raw", "")),
            str(profile.get("user_request", "")),
        ]
    )
    asks_single_work = bool(
        re.search(r"这条|这个视频|单条|当前视频|刷到的视频|作品链接|分析视频|为什么能火|如何复刻|怎么复刻|剪辑节奏|标题标签", raw_text)
    )
    if is_profile_share_text(raw_text):
        return False
    has_video_link = bool(re.search(r"v\.douyin|/video/|/note/|aweme|video_id|note_id|b23\.tv/video|bilibili\.com/video|xiaohongshu\.com/explore|kuaishou\.com/short-video", raw_text, re.I))
    return has_shared_work_text or (has_video_link and asks_single_work)


def is_profile_link_only_request(profile: dict[str, Any]) -> bool:
    work_links = profile.get("work_links", [])
    if not isinstance(work_links, list) or not work_links:
        return False
    has_profile_link = any(
        isinstance(item, dict) and item.get("page_kind_guess") == "profile"
        for item in work_links
    )
    has_visual_assets = bool(profile.get("asset_files"))
    return has_profile_link and not has_visual_assets and not is_single_work_analysis_request(profile)


def infer_profile_task_intent(profile: dict[str, Any]) -> str:
    return "single_work_analysis" if is_single_work_analysis_request(profile) else "account_growth_diagnosis"


def normalize_task_intent(value: Any, fallback_profile: dict[str, Any] | None = None) -> str:
    raw = str(value or "").strip()
    if raw in {"experiment_review", "growth_review", "review_backfill", "homepage_comparison_review"}:
        return "experiment_review"
    if raw in {"single_work_analysis", "current_video_analysis", "uploaded_video_analysis"}:
        return "single_work_analysis"
    if raw in {"account_growth_diagnosis", "account_diagnosis", "homepage_screenshot_analysis", "profile_review"}:
        return "account_growth_diagnosis"
    return infer_profile_task_intent(fallback_profile or {})


