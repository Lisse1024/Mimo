import re
import json
from typing import Any

from .video_understanding import profile_video_understanding

def ensure_confidence(value: str | None, fallback: str = "medium") -> str:
    return value if value in {"high", "medium", "low"} else fallback


def annotate_workspace_artifact_source(artifact: dict[str, Any] | None, source_type: str, confidence: str = "medium") -> dict[str, Any]:
    artifact = artifact or {}
    artifact["source_type"] = artifact.get("source_type") or source_type
    artifact["confidence"] = ensure_confidence(artifact.get("confidence"), confidence)
    return artifact


def annotate_workspace_bundle(bundle: dict[str, Any], asset_analysis: dict[str, Any]) -> dict[str, Any]:
    bundle["strategy"] = annotate_workspace_artifact_source(bundle.get("strategy"), "model_inference", "medium")
    bundle["hot_video_analysis"] = annotate_workspace_artifact_source(bundle.get("hot_video_analysis"), "model_inference", "low")
    bundle["advisor_summary"] = annotate_workspace_artifact_source(bundle.get("advisor_summary"), "model_inference", "medium")

    bundle["asset_analysis"] = annotate_workspace_artifact_source(asset_analysis, "visual_observation", "medium")
    return bundle


def sanitize_business_claims(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_business_claims(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_business_claims(item) for item in value]
    if not isinstance(value, str):
        return value

    text = value
    replacements = [
        (r"30天粉丝突破1000|30 天粉丝突破1000|粉丝突破1000", "30 天内验证账号方向和内容模型，不承诺具体涨粉数"),
        (r"转粉率从[^，。；;]*?提升至[^，。；;]*", "转粉效率需接入后台数据后再判断"),
        (r"3秒完播率稳定在65%以上|3 秒完播率稳定在65%以上", "重点观察 3 秒停留和完播变化"),
        (r"搜索流量占比超15%|搜索流量占比超过15%", "观察搜索和推荐来源变化"),
        (r"单条平均点赞突破50|点赞突破50", "观察点赞和评论是否比随机内容更稳定"),
        (r"连续30天日更不断更|连续 30 天日更不断更", "保持可持续的稳定更新节奏"),
        (r"7天内垂直内容占比100%|7 天内垂直内容占比100%|垂直内容占比100%", "第一周尽量只测试同一主方向内容"),
        (r"将历史[^，。；;]*设为[“']?仅自己可见[”']?", "先停止继续混发，旧内容是否隐藏需结合后台数据和个人意愿再决定"),
        (r"清理历史[^，。；;]*", "先通过后续连续发布来校正账号标签"),
        (r"强制校正算法标签", "逐步校正账号内容标签"),
        (r"算法加权期", "更稳定的推荐测试阶段"),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text)
    return text


def apply_business_guardrails(bundle: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    guarded = sanitize_business_claims(bundle)
    connector_ready = profile.get("platform_snapshot", {}).get("connector_status") == "ready_for_fetch"
    if not connector_ready:
        for key in ["strategy", "advisor_summary", "hot_video_analysis"]:
            if isinstance(guarded.get(key), dict) and guarded[key].get("confidence") == "high":
                guarded[key]["confidence"] = "medium"
    return guarded


def _dedupe_strings(items: list[Any], limit: int = 12) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result


def _list_from(value: Any, limit: int = 12) -> list[str]:
    if isinstance(value, list):
        return _dedupe_strings(value, limit)
    if isinstance(value, str) and value.strip():
        return _dedupe_strings([value], limit)
    return []


def _text_blob(*values: Any) -> str:
    parts: list[str] = []
    for value in values:
        if isinstance(value, dict):
            parts.append(json.dumps(value, ensure_ascii=False))
        elif isinstance(value, list):
            parts.extend(str(item) for item in value if str(item).strip())
        elif value is not None:
            parts.append(str(value))
    return "\n".join(parts)


def _has_comment_evidence(profile: dict[str, Any], artifacts: dict[str, Any]) -> bool:
    observed = profile.get("platform_observed_metrics") if isinstance(profile.get("platform_observed_metrics"), dict) else {}
    counts = observed.get("counts") if isinstance(observed.get("counts"), dict) else {}
    if any(str(key).lower() in {"comments", "comment_count", "评论", "评论数"} and value for key, value in counts.items()):
        return True
    asset_analysis = artifacts.get("asset_analysis") if isinstance(artifacts.get("asset_analysis"), dict) else {}
    text = _text_blob(profile.get("evidence_facts", []), profile.get("asset_notes", ""), asset_analysis.get("evidence", []))
    return bool(re.search(r"评论区截图|评论关键词|评论数据|评论内容|用户评论", text))


def _has_backend_metrics(profile: dict[str, Any], artifacts: dict[str, Any]) -> bool:
    text = _text_blob(
        profile.get("backend_metrics"),
        profile.get("creator_backend_metrics"),
        profile.get("platform_backend_metrics"),
        profile.get("historical_posts"),
        artifacts.get("evidence_snapshot", {}),
    )
    return bool(re.search(r"后台|创作者中心|留存|完播率|平均播放|主页点击率|负反馈", text))


def _has_account_series_evidence(profile: dict[str, Any]) -> bool:
    history_items = profile.get("history_items")
    if isinstance(history_items, list) and len(history_items) >= 3:
        return True
    historical_posts = str(profile.get("historical_posts", "") or "").strip()
    return bool(historical_posts and len(historical_posts) >= 120)


def _has_platform_authorization(profile: dict[str, Any], artifacts: dict[str, Any]) -> bool:
    text = _text_blob(
        profile.get("authorization_evidence"),
        profile.get("platform_authorization"),
        artifacts.get("platform_identity", {}),
        profile.get("platform_snapshot", {}),
    )
    return bool(re.search(r"官方认证|授权|版权方|创作者本人|企业认证|蓝V|verified", text, re.IGNORECASE))


def _has_platform_identity(profile: dict[str, Any], artifacts: dict[str, Any]) -> bool:
    platform_identity = artifacts.get("platform_identity") if isinstance(artifacts.get("platform_identity"), dict) else {}
    platform_snapshot = profile.get("platform_snapshot") if isinstance(profile.get("platform_snapshot"), dict) else {}
    return platform_identity.get("status") not in {None, "", "missing_identity"} or platform_snapshot.get("connector_status") not in {None, "", "missing_identity"}


def _is_sparse_or_degraded_video(asset_analysis: dict[str, Any], video_understanding: dict[str, Any]) -> bool:
    status = str(asset_analysis.get("status") or "")
    if status in {"no_assets", "vision_disabled", "no_inline_assets", "vision_timeout", "analysis_failed", "vision_failed", "vision_parse_failed"}:
        return True
    if str(asset_analysis.get("analysis_scope") or "") == "keyframe_only":
        return True
    timeline = video_understanding.get("timeline") if isinstance(video_understanding.get("timeline"), list) else []
    context_risk = str(video_understanding.get("context_risk") or "")
    return context_risk == "high" or (bool(timeline) and len(timeline) < 3)


def _build_direct_evidence(profile: dict[str, Any], artifacts: dict[str, Any], evidence_summary: list[dict[str, Any]]) -> list[str]:
    asset_analysis = artifacts.get("asset_analysis") if isinstance(artifacts.get("asset_analysis"), dict) else {}
    work_understanding = artifacts.get("work_understanding") if isinstance(artifacts.get("work_understanding"), dict) else {}
    video_understanding = asset_analysis.get("video_understanding") if isinstance(asset_analysis.get("video_understanding"), dict) else profile_video_understanding(profile)
    timeline = video_understanding.get("timeline") if isinstance(video_understanding, dict) and isinstance(video_understanding.get("timeline"), list) else []
    direct: list[Any] = []
    # User requests and connector/media logs are operational metadata. They can
    # route the task or explain degraded evidence, but they are not content facts.
    direct.extend(_list_from(profile.get("content_evidence_facts"), 8))
    direct.extend(_list_from(work_understanding.get("titles"), 4))
    direct.extend(_list_from(work_understanding.get("tags"), 6))
    direct.extend(_list_from(asset_analysis.get("evidence"), 8))
    direct.extend(_list_from(asset_analysis.get("video_observations"), 5))
    for item in timeline[:6]:
        if not isinstance(item, dict):
            continue
        time_range = item.get("time_range") or item.get("timeRange") or ""
        visual = item.get("visual_fact") or item.get("visualEvidence") or ""
        ocr = item.get("ocr_text") or item.get("ocrText") or ""
        audio = item.get("audio_transcript") or item.get("audioTranscript") or ""
        if visual:
            direct.append(f"{time_range} 可见画面：{visual}")
        if ocr:
            direct.append(f"{time_range} OCR 字幕：{ocr}")
        if audio:
            direct.append(f"{time_range} ASR/音频：{audio}")
    for item in evidence_summary:
        if isinstance(item, dict) and item.get("status") == "available" and item.get("summary"):
            direct.append(str(item.get("summary")))
    return _dedupe_strings(direct, 16)


def _build_inferred_claims(artifacts: dict[str, Any]) -> list[dict[str, str]]:
    strategy = artifacts.get("strategy") if isinstance(artifacts.get("strategy"), dict) else {}
    advisor = artifacts.get("advisor_summary") if isinstance(artifacts.get("advisor_summary"), dict) else {}
    claims: list[dict[str, str]] = []
    diagnosis = str(advisor.get("one_sentence_diagnosis") or strategy.get("positioning") or "").strip()
    if diagnosis:
        claims.append({"claim": diagnosis[:240], "basis": "advisor_summary/strategy", "confidence": ensure_confidence(advisor.get("confidence") or strategy.get("confidence"), "medium")})
    for claim in _list_from(advisor.get("core_judgements"), 4):
        claims.append({"claim": claim, "basis": "advisor_summary.core_judgements", "confidence": ensure_confidence(advisor.get("confidence"), "medium")})
    return claims[:8]


def _build_low_confidence_claims(evidence_summary: list[dict[str, Any]], asset_analysis: dict[str, Any], video_understanding: dict[str, Any]) -> list[dict[str, str]]:
    claims: list[dict[str, str]] = []
    for item in evidence_summary:
        if not isinstance(item, dict):
            continue
        if item.get("status") in {"missing", "degraded"} or item.get("confidence") == "low":
            claims.append({
                "claim": str(item.get("summary") or item.get("label") or item.get("key") or "")[:240],
                "basis": str(item.get("label") or item.get("key") or "evidence_summary"),
                "confidence": "low",
            })
    for item in _list_from(asset_analysis.get("limitations"), 4):
        claims.append({"claim": item, "basis": "asset_analysis.limitations", "confidence": "low"})
    if _is_sparse_or_degraded_video(asset_analysis, video_understanding):
        claims.append({"claim": "当前视频理解存在降级或稀疏抽帧限制，剧情连续性只能低置信判断。", "basis": "video_understanding.context_risk", "confidence": "low"})
    return [item for item in claims if item.get("claim")][:8]


def _build_missing_and_forbidden(
    profile: dict[str, Any],
    artifacts: dict[str, Any],
    evidence_summary: list[dict[str, Any]],
    video_understanding: dict[str, Any],
) -> tuple[list[str], list[str]]:
    asset_analysis = artifacts.get("asset_analysis") if isinstance(artifacts.get("asset_analysis"), dict) else {}
    snapshot = artifacts.get("evidence_snapshot") if isinstance(artifacts.get("evidence_snapshot"), dict) else {}
    task_intent = str(profile.get("task_intent") or profile.get("result_mode") or snapshot.get("task_intent") or "")
    missing: list[Any] = []
    forbidden: list[Any] = []
    for item in evidence_summary:
        if isinstance(item, dict) and item.get("status") == "missing":
            missing.append(str(item.get("summary") or item.get("label") or item.get("key")))
    missing.extend(_list_from(video_understanding.get("missing_evidence") if isinstance(video_understanding, dict) else [], 12))
    missing.extend(_list_from(asset_analysis.get("limitations"), 8))

    if task_intent == "single_work_analysis":
        forbidden.append("不能把单条作品分析上升为账号长期方向已经确定。")
        if not _has_account_series_evidence(profile):
            missing.append("账号主页连续作品证据缺失，不能判断长期赛道或长期方向。")
    if not _has_comment_evidence(profile, artifacts):
        missing.append("评论区截图、评论关键词或评论数据缺失。")
        forbidden.append("不能声称“评论区都在说”。")
    if not _has_backend_metrics(profile, artifacts):
        missing.append("平台后台数据、留存曲线、完播率、平均播放时长和主页点击等指标缺失。")
        forbidden.extend(["不能声称“后台数据证明”。", "不能声称“这条一定会爆”。"])
    if _is_sparse_or_degraded_video(asset_analysis, video_understanding):
        missing.append("完整视频上下文、连续画面、OCR/ASR 或结尾信息不足。")
        forbidden.append("不能声称已经理解或确认完整剧情。")
    if not _has_platform_identity(profile, artifacts) or not _has_platform_authorization(profile, artifacts):
        missing.append("平台身份或授权信息缺失。")
        forbidden.append("不能确认当前短视频账号为官方账号或授权搬运账号。")

    forbidden.extend(["不能把疑似或低置信判断写成确定事实。", "不能把结构复用写成完整搬运原片。"])
    return _dedupe_strings(missing, 18), _dedupe_strings(forbidden, 16)


def build_evidence_summary(profile: dict[str, Any], artifacts: dict[str, Any]) -> list[dict[str, Any]]:
    platform_snapshot = profile.get("platform_snapshot", {})
    asset_analysis = artifacts.get("asset_analysis") or profile.get("asset_analysis", {})
    strategy = artifacts.get("strategy", {})
    advisor_summary = artifacts.get("advisor_summary", {})
    connector_status = platform_snapshot.get("connector_status", "missing_identity")
    visual_status = asset_analysis.get("status", "no_assets")
    video_understanding = asset_analysis.get("video_understanding") if isinstance(asset_analysis.get("video_understanding"), dict) else profile_video_understanding(profile)
    video_context_risk = video_understanding.get("context_risk", "medium") if isinstance(video_understanding, dict) else "medium"
    video_timeline = video_understanding.get("timeline", []) if isinstance(video_understanding, dict) else []
    observed_metrics = profile.get("platform_observed_metrics") if isinstance(profile.get("platform_observed_metrics"), dict) else {}
    observed_counts = observed_metrics.get("counts") if isinstance(observed_metrics.get("counts"), dict) else {}

    return [
        {
            "key": "user_input",
            "label": "用户手填信息",
            "source_type": "user_input",
            "confidence": "high",
            "status": "available",
            "summary": "昵称、平台、赛道、目标、优势、限制和当前问题由用户直接提供。",
        },
        {
            "key": "platform_hint",
            "label": "平台身份线索",
            "source_type": platform_snapshot.get("source_type", "platform_identity_hint"),
            "confidence": ensure_confidence(platform_snapshot.get("confidence"), "medium"),
            "status": "available" if connector_status != "missing_identity" else "missing",
            "summary": platform_snapshot.get("explain", "暂无平台账号 ID、主页链接或作品链接线索。"),
        },
        {
            "key": "visual_observation",
            "label": "视觉观察证据",
            "source_type": asset_analysis.get("source_type", "visual_observation"),
            "confidence": ensure_confidence(asset_analysis.get("confidence"), "medium" if visual_status not in {"no_assets", "vision_disabled", "analysis_failed"} else "low"),
            "status": "available" if visual_status not in {"no_assets", "vision_disabled", "no_inline_assets", "analysis_failed"} else "degraded",
            "summary": asset_analysis.get("asset_summary", "当前没有足够的截图或视频素材用于视觉分析。"),
        },
        {
            "key": "video_understanding",
            "label": "视频时间线证据",
            "source_type": "sampled_video_timeline",
            "confidence": "medium" if video_timeline else "low",
            "status": "available" if video_timeline else "degraded",
            "summary": f"已建立 {len(video_timeline)} 个时间段的抽帧证据；上下文风险为 {video_context_risk}。OCR/ASR 与平台互动数据缺失时，相关判断只能作为低置信推断。",
        },
        {
            "key": "fetched_platform_data",
            "label": "真实平台数据",
            "source_type": "fetched_platform_data",
            "confidence": "high" if connector_status == "ready_for_fetch" else "low",
            "status": "available" if connector_status == "ready_for_fetch" else "missing",
            "summary": "当前版本尚未接入真实平台连接器返回作品数据。" if connector_status != "ready_for_fetch" else "已接入真实平台数据，可直接作为高可信依据。",
            "next_action": "从创作者后台授权导出数据，或手动上传后台数据截图并回填指标。",
        },
        {
            "key": "browser_visible_metrics",
            "label": "页面可见指标",
            "source_type": observed_metrics.get("source_type", "browser_dom_visible_signal") if observed_metrics else "browser_dom_visible_signal",
            "confidence": ensure_confidence(observed_metrics.get("confidence") if observed_metrics else None, "medium" if observed_counts else "low"),
            "status": "available" if observed_counts else "missing",
            "summary": (
                f"浏览器桥接读取到页面可见计数：{json.dumps(observed_counts, ensure_ascii=False)}。这些是页面可见线索，仍需结合后台数据核验。"
                if observed_counts
                else "未读取到页面可见播放、点赞、评论、收藏或分享计数。"
            ),
            "next_action": "打开作品详情页并开启浏览器桥接，或上传后台数据截图。",
        },
        {
            "key": "model_inference",
            "label": "模型综合判断",
            "source_type": "model_inference",
            "confidence": ensure_confidence(advisor_summary.get("confidence") or strategy.get("confidence"), "medium"),
            "status": "available",
            "summary": "账号诊断、策略、任务与 Agent 结论属于基于上述证据层做出的模型推断，不等同于原始平台事实。",
        },
    ]


def build_evidence_contract(profile: dict[str, Any], artifacts: dict[str, Any]) -> dict[str, Any]:
    evidence_summary = artifacts.get("evidence_summary")
    if not isinstance(evidence_summary, list):
        evidence_summary = build_evidence_summary(profile, artifacts)
    available = [item for item in evidence_summary if isinstance(item, dict) and item.get("status") == "available"]
    degraded = [item for item in evidence_summary if isinstance(item, dict) and item.get("status") == "degraded"]
    missing = [item for item in evidence_summary if isinstance(item, dict) and item.get("status") == "missing"]
    asset_analysis = artifacts.get("asset_analysis") or profile.get("asset_analysis", {})
    video_understanding = asset_analysis.get("video_understanding") if isinstance(asset_analysis.get("video_understanding"), dict) else profile_video_understanding(profile)
    safe_video_understanding = video_understanding if isinstance(video_understanding, dict) else {}
    direct_evidence = _build_direct_evidence(profile, artifacts, evidence_summary)
    inferred_claims = _build_inferred_claims(artifacts)
    low_confidence_claims = _build_low_confidence_claims(evidence_summary, asset_analysis, safe_video_understanding)
    missing_evidence, forbidden_claims = _build_missing_and_forbidden(profile, artifacts, evidence_summary, safe_video_understanding)
    must_not_claim = _dedupe_strings(
        [
            "没有后台数据时不得承诺涨粉、转粉或完播提升。",
            "只有截图/少量帧时不得编造完整剧情、台词、BGM 或结尾反转。",
            "单条视频内容不得直接等同于账号长期赛道。",
            *forbidden_claims,
        ],
        20,
    )
    return {
        "user_visible_allowed": [
            "最终判断",
            "可执行建议",
            "证据不足提醒",
            "下一步任务",
            "复盘指标",
        ],
        "hidden_by_default": [
            "原始模型输出",
            "提示词/约束",
            "内部字段名",
            "调试错误堆栈",
            "过程性片源/语义推理细节",
        ],
        "available_count": len(available),
        "degraded_count": len(degraded),
        "missing_count": len(missing),
        "missing_keys": [str(item.get("key", "")) for item in missing if isinstance(item, dict)],
        "degraded_keys": [str(item.get("key", "")) for item in degraded if isinstance(item, dict)],
        "video_context_risk": video_understanding.get("context_risk", "medium") if isinstance(video_understanding, dict) else "medium",
        "must_not_claim": must_not_claim,
        "direct_evidence": direct_evidence,
        "inferred_claims": inferred_claims,
        "low_confidence_claims": low_confidence_claims,
        "missing_evidence": missing_evidence,
        "forbidden_claims": forbidden_claims,
    }


def build_learning_packet(profile: dict[str, Any], artifacts: dict[str, Any]) -> dict[str, Any]:
    strategy = artifacts.get("strategy", {}) if isinstance(artifacts.get("strategy"), dict) else {}
    advisor = artifacts.get("advisor_summary", {}) if isinstance(artifacts.get("advisor_summary"), dict) else {}
    tasks = artifacts.get("tasks", []) if isinstance(artifacts.get("tasks"), list) else []
    evidence_contract = artifacts.get("evidence_contract") if isinstance(artifacts.get("evidence_contract"), dict) else build_evidence_contract(profile, artifacts)
    task_intent = profile.get("task_intent") or profile.get("result_mode") or "unknown"
    first_actions = advisor.get("first_actions") if isinstance(advisor.get("first_actions"), list) else []
    diagnosis = advisor.get("one_sentence_diagnosis") or strategy.get("positioning") or ""
    metrics = strategy.get("kpis") if isinstance(strategy.get("kpis"), list) else []
    task_titles = [str(item.get("title", "")) for item in tasks if isinstance(item, dict) and item.get("title")]
    return {
        "memory_write_policy": {
            "write_when": "任务完成、降级完成或用户回填复盘数据后写入长期记忆；running/pending 只作为运行状态。",
            "do_not_write": ["原始提示词", "中间错误堆栈", "未完成结论", "无法核验的高置信断言"],
        },
        "decision_summary": str(diagnosis)[:240],
        "reusable_learnings": [
            item
            for item in [
                "当前任务是单条作品拆解，不能上升为账号长期赛道。" if task_intent == "single_work_analysis" else "",
                "账号诊断需要连续内容实验和发布后数据闭环。" if task_intent == "account_growth_diagnosis" else "",
                "证据不足时必须保守表达，并明确下一步补证据动作。" if evidence_contract.get("missing_count") or evidence_contract.get("degraded_count") else "",
            ]
            if item
        ],
        "experiment_template": {
            "hypothesis": "按本轮结论执行一个最小内容实验后，至少一个关键指标应出现可诊断变化。",
            "actions": first_actions[:3] or task_titles[:3],
            "metrics": metrics[:5] or ["3 秒停留", "完播率", "评论关键词", "收藏", "主页点击"],
            "review_required": True,
        },
        "evidence_contract": evidence_contract,
    }


