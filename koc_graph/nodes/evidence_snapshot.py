from typing import Any

from koc_graph.nodes.common import add_stage_event
from koc_graph.state import KOCGraphState


def _available(value: Any) -> bool:
    if isinstance(value, dict):
        return bool(value)
    if isinstance(value, list):
        return bool(value)
    return bool(str(value or "").strip())


def _has_text_work_brief(profile: dict[str, Any]) -> bool:
    text = "\n".join(
        [
            str(profile.get("user_request", "") or ""),
            str(profile.get("goal", "") or ""),
            str(profile.get("work_links_raw", "") or ""),
            str(profile.get("asset_notes", "") or ""),
            " ".join(str(item) for item in profile.get("evidence_facts", []) if item),
        ]
    ).strip()
    if len(text) < 80:
        return False
    signals = ["标题", "前 3 秒", "前三秒", "镜头", "中段", "结尾", "脚本", "收藏", "完播", "复刻", "视频", "作品"]
    return sum(1 for signal in signals if signal in text) >= 2 or len(text) >= 120


def _direct_evidence_from_profile(profile: dict[str, Any], asset_analysis: dict[str, Any]) -> list[str]:
    evidence: list[str] = []
    if profile.get("user_request") or profile.get("goal"):
        evidence.append(f"用户输入：{str(profile.get('user_request') or profile.get('goal'))[:180]}")
    for item in profile.get("evidence_facts", []) if isinstance(profile.get("evidence_facts"), list) else []:
        if str(item).strip():
            evidence.append(str(item).strip())
    for item in asset_analysis.get("evidence", []) if isinstance(asset_analysis.get("evidence"), list) else []:
        if str(item).strip():
            evidence.append(str(item).strip())
    return list(dict.fromkeys(evidence))[:12]


def collect_evidence_snapshot_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    profile = state.get("profile", {})
    asset_analysis = state.get("asset_analysis", {})
    platform_identity = state.get("platform_identity", {})
    work_understanding = state.get("work_understanding", {})
    task_intent = state.get("task_intent", "unknown")

    work_links = profile.get("work_links") if isinstance(profile.get("work_links"), list) else []
    assets = profile.get("asset_files") if isinstance(profile.get("asset_files"), list) else []
    memory_context = str(profile.get("memory_context", "") or "")
    video_understanding = asset_analysis.get("video_understanding") if isinstance(asset_analysis.get("video_understanding"), dict) else {}
    timeline = video_understanding.get("timeline") if isinstance(video_understanding.get("timeline"), list) else []
    ocr_status = str(video_understanding.get("ocr_status") or "unknown")
    asr_status = str(video_understanding.get("asr_status") or "unknown")
    text_work_brief = _has_text_work_brief(profile)

    facts = [
        {"key": "user_request", "available": _available(profile.get("user_request") or profile.get("goal")), "summary": "用户请求已接收。"},
        {
            "key": "platform_identity",
            "available": platform_identity.get("status") != "missing_identity",
            "summary": str(platform_identity.get("message") or "平台身份待确认。"),
        },
        {"key": "links", "available": bool(work_links), "summary": f"已解析 {len(work_links)} 条主页或作品链接。"},
        {"key": "assets", "available": bool(assets), "summary": f"已接收 {len(assets)} 个截图或视频素材。"},
        {
            "key": "text_work_brief",
            "available": text_work_brief,
            "summary": "已读取到用户描述的视频结构。" if text_work_brief else "暂无足够完整的视频结构描述。",
        },
        {"key": "video_timeline", "available": bool(timeline), "summary": f"已形成 {len(timeline)} 段视频时间线证据。"},
        {"key": "ocr", "available": ocr_status == "available", "summary": f"OCR 状态：{ocr_status}。"},
        {"key": "asr", "available": asr_status == "available", "summary": f"ASR 状态：{asr_status}。"},
        {
            "key": "memory",
            "available": bool(memory_context.strip()),
            "summary": "已读取到可参考历史记忆。" if memory_context.strip() else "暂无可复用历史记忆。",
        },
        {
            "key": "work_understanding",
            "available": bool(work_understanding),
            "summary": "已生成单条作品理解对象。" if work_understanding else "暂无作品理解对象。",
        },
    ]
    missing = [item["key"] for item in facts if not item["available"]]
    available = [item["key"] for item in facts if item["available"]]

    if task_intent == "single_work_analysis":
        required = {"user_request", "platform_identity", "assets"} if assets else {"user_request", "text_work_brief"} if text_work_brief else {"user_request", "links"}
    else:
        required = {"user_request", "platform_identity"} | ({"assets"} if assets else set())
    required_missing = sorted(key for key in required if key in missing)
    evidence_level = "high" if not required_missing and len(available) >= 5 else "medium" if not required_missing or len(available) >= 3 else "low"
    missing_evidence = [item["summary"] for item in facts if not item["available"]]
    forbidden_claims = [
        "不能把疑似或低置信判断写成确定事实。",
    ]
    if task_intent == "single_work_analysis":
        forbidden_claims.append("不能把单条作品分析上升为账号长期方向已经确定。")
    if "ocr" in missing or "asr" in missing or not timeline:
        forbidden_claims.append("不能声称已经理解或确认完整剧情。")
    snapshot = {
        "task_intent": task_intent,
        "evidence_level": evidence_level,
        "available_keys": available,
        "missing_keys": missing,
        "required_missing_keys": required_missing,
        "facts": facts,
        "direct_evidence": _direct_evidence_from_profile(profile, asset_analysis),
        "inferred_claims": [],
        "low_confidence_claims": [],
        "missing_evidence": missing_evidence,
        "forbidden_claims": list(dict.fromkeys(forbidden_claims)),
        "asset_status": asset_analysis.get("status", "unknown"),
        "platform_status": platform_identity.get("status", "unknown"),
        "video_context_risk": video_understanding.get("context_risk", "unknown") if isinstance(video_understanding, dict) else "unknown",
    }
    runtime["update_async_job_stage"](
        job_id,
        "evidence_collection",
        "degraded" if required_missing else "done",
        f"证据快照已生成：可用 {len(available)} 项，缺失 {len(missing)} 项，等级 {evidence_level}。",
    )
    return {
        "evidence_snapshot": snapshot,
        "current_stage": "evidence_collection",
        "stage_events": add_stage_event(
            state,
            "collect_evidence_snapshot",
            "evidence_collection",
            "degraded" if required_missing else "done",
            f"证据快照：level={evidence_level}, missing={','.join(required_missing) or 'none'}",
        ),
    }
