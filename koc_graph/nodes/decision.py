from typing import Any

from koc_graph.nodes.common import add_stage_event, append_warning
from koc_graph.state import KOCGraphState


DEGRADED_ASSET_STATUSES = {"no_assets", "vision_disabled", "no_inline_assets", "vision_timeout", "analysis_failed"}


def _profile_link_only(profile: dict[str, Any], task_intent: str) -> bool:
    work_links = profile.get("work_links", [])
    if not isinstance(work_links, list) or not work_links:
        return False
    has_profile_link = any(isinstance(item, dict) and item.get("page_kind_guess") == "profile" for item in work_links)
    has_visual_assets = bool(profile.get("asset_files"))
    return has_profile_link and not has_visual_assets and task_intent != "single_work_analysis"


def _memory_signal(profile: dict[str, Any], snapshot: dict[str, Any]) -> str:
    memory_context = str(profile.get("memory_context", "") or "")
    if "memory" in snapshot.get("available_keys", []):
        if len(memory_context) > 120 or "相似历史记忆" in memory_context or "同平台" in memory_context:
            return "strong"
        return "weak"
    return "none"


def _has_substantial_single_work_brief(profile: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    text = "\n".join(
        [
            str(profile.get("user_request", "") or ""),
            str(profile.get("desktop_context", "") or ""),
            str(profile.get("asset_notes", "") or ""),
            " ".join(str(item) for item in profile.get("evidence_facts", []) if item),
            " ".join(str(item) for item in snapshot.get("available_keys", []) if item),
        ]
    )
    text = text.strip()
    if len(text) < 80:
        return False
    signals = [
        "标题",
        "前 3 秒",
        "前三秒",
        "镜头",
        "中段",
        "结尾",
        "脚本",
        "收藏",
        "完播",
        "复刻",
        "评论",
        "播放",
        "视频结构",
        "作品标题",
    ]
    if sum(1 for signal in signals if signal in text) >= 3:
        return True
    # Some Windows console/database paths can degrade Chinese text into placeholders.
    # A long single-work request is still usable as a conservative brief, even if
    # keyword matching is weakened by encoding loss.
    return len(text) >= 120 and ("KOC" in text or "?" in text or "视频" in text or "作品" in text)


def decision_gate_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    profile = state["profile"]
    asset_analysis = state.get("asset_analysis", {})
    snapshot = state.get("evidence_snapshot", {})
    task_intent = state.get("task_intent", "unknown")
    asset_status = str(asset_analysis.get("status", snapshot.get("asset_status", "unknown")))
    evidence_level = str(snapshot.get("evidence_level") or profile.get("evidence_level") or asset_analysis.get("confidence") or "unknown")
    memory_signal = _memory_signal(profile, snapshot)
    profile_link_only = _profile_link_only(profile, task_intent)
    is_single_work = task_intent == "single_work_analysis"
    required_missing = [str(item) for item in snapshot.get("required_missing_keys", []) if str(item).strip()]
    evidence_degraded = bool(required_missing) or asset_status in DEGRADED_ASSET_STATUSES or evidence_level in {"low", "unknown", ""}

    work_links = profile.get("work_links", [])
    has_links = isinstance(work_links, list) and bool(work_links)
    has_assets = bool(profile.get("asset_files"))
    has_history = bool(str(profile.get("historical_posts", "")).strip() or profile.get("history_items"))
    has_hot_videos = bool(str(profile.get("hot_videos", "")).strip() or profile.get("hot_video_items"))
    has_work_brief = _has_substantial_single_work_brief(profile, snapshot)
    should_pause_for_evidence = (
        (is_single_work and not has_links and not has_assets and not has_work_brief)
        or (
            not is_single_work
            and not profile_link_only
            and not has_assets
            and not has_history
            and not has_hot_videos
            and memory_signal == "none"
        )
    )

    route_internal_reports = not is_single_work and not profile_link_only and not evidence_degraded
    preferred_strategy = (
        "rule_based"
        if is_single_work or profile_link_only or asset_status in {"success", "homepage_fallback"} or memory_signal == "strong"
        else "model"
    )
    needs_evidence_repair = evidence_degraded or bool(profile.get("evidence_gaps"))
    missing_actions: list[str] = []
    if is_single_work and evidence_degraded:
        missing_actions.extend(["补充完整录屏和音频", "补充标题标签", "补充评论区或互动数据"])
    elif evidence_degraded:
        missing_actions.extend(["补充主页链接或截图", "补充最近 5-10 条作品数据", "补充后台播放和互动指标"])
    if memory_signal == "none":
        missing_actions.append("当前账号或作品没有可复用历史记忆，任务完成后需要写入复盘数据")
    evidence_forbidden_claims = [str(item) for item in snapshot.get("forbidden_claims", []) if str(item).strip()]
    evidence_missing = [str(item) for item in snapshot.get("missing_evidence", []) if str(item).strip()]
    if is_single_work and not any("长期方向" in item for item in evidence_forbidden_claims):
        evidence_forbidden_claims.append("不能把单条作品分析上升为账号长期方向已经确定。")
    if is_single_work and evidence_degraded and not any("完整剧情" in item for item in evidence_forbidden_claims):
        evidence_forbidden_claims.append("不能声称已经理解或确认完整剧情。")

    decision = {
        "task_intent": task_intent,
        "asset_status": asset_status,
        "evidence_level": evidence_level,
        "evidence_degraded": evidence_degraded,
        "memory_signal": memory_signal,
        "profile_link_only": profile_link_only,
        "text_brief_available": has_work_brief,
        "route_internal_reports": route_internal_reports,
        "preferred_strategy": preferred_strategy,
        "needs_evidence_repair": needs_evidence_repair,
        "should_pause_for_evidence": should_pause_for_evidence,
        "missing_actions": missing_actions,
        "missing_evidence": list(dict.fromkeys(evidence_missing)),
        "forbidden_claims": list(dict.fromkeys(evidence_forbidden_claims)),
        "evidence_snapshot": snapshot,
    }
    message = (
        "证据不足，已先规划补证据动作，并以保守策略继续。"
        if needs_evidence_repair
        else "已根据任务类型、证据质量和历史记忆选择后续分析路径。"
    )
    runtime["update_async_job_stage"](job_id, "decision_gate", "degraded" if needs_evidence_repair else "done", message)
    return {
        "graph_decision": decision,
        "current_stage": "decision_gate",
        "stage_events": add_stage_event(
            state,
            "decision_gate",
            "decision_gate",
            "degraded" if needs_evidence_repair else "done",
            f"路由决策：strategy={preferred_strategy}, memory={memory_signal}, evidence_degraded={evidence_degraded}, pause={should_pause_for_evidence}",
        ),
    }


def plan_evidence_repair_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    decision = state.get("graph_decision", {})
    missing_actions = [str(item) for item in decision.get("missing_actions", []) if str(item).strip()]
    warnings = list(state.get("warnings", []))
    if missing_actions:
        warnings = append_warning({"warnings": warnings}, "证据不足，已生成补证据清单：" + "；".join(missing_actions[:5]))
    runtime["update_async_job"](job_id, warnings=warnings)
    runtime["update_async_job_stage"](job_id, "evidence_repair_plan", "done", "已记录补证据动作，当前任务继续输出保守可执行结论。")
    return {
        "warnings": warnings,
        "stage_events": add_stage_event(state, "plan_evidence_repair", "evidence_repair_plan", "done", "已生成补证据清单并继续执行。"),
    }


def request_user_evidence_node(state: KOCGraphState, runtime: dict[str, Any]) -> KOCGraphState:
    job_id = state["job_id"]
    decision = state.get("graph_decision", {})
    missing_actions = [str(item) for item in decision.get("missing_actions", []) if str(item).strip()] or [
        "补充作品链接、完整录屏和音频、主页截图或后台数据后再继续。"
    ]
    workspace = {
        "status": "waiting_for_evidence",
        "advisor_summary": {
            "one_sentence_diagnosis": "当前证据不足，继续生成完整诊断会变成猜测，因此已暂停等待补充资料。",
            "first_actions": missing_actions[:5],
        },
        "evidence_contract": {
            "available_count": 0,
            "degraded_count": 0,
            "missing_count": len(missing_actions),
            "missing_keys": missing_actions,
            "degraded_keys": [],
            "must_not_claim": [
                "证据不足时不得编造账号定位、剧情、台词、背景音乐、完播或转化结论。",
                *[str(item) for item in decision.get("forbidden_claims", []) if str(item).strip()],
            ],
            "direct_evidence": [],
            "inferred_claims": [],
            "low_confidence_claims": [],
            "missing_evidence": list(dict.fromkeys([*missing_actions, *[str(item) for item in decision.get("missing_evidence", []) if str(item).strip()]])),
            "forbidden_claims": list(dict.fromkeys([str(item) for item in decision.get("forbidden_claims", []) if str(item).strip()])),
        },
        "followups": [{"title": item, "status": "waiting_for_user"} for item in missing_actions[:5]],
    }
    runtime["update_async_job_stage"](job_id, "evidence_request", "degraded", "证据不足，已暂停等待用户补充资料。")
    runtime["update_async_job"](
        job_id,
        status="waiting_for_evidence",
        workspace=workspace,
        graph_state={
            "stage_events": state.get("stage_events", []),
            "warnings": state.get("warnings", []),
            "task_intent": state.get("task_intent"),
            "evidence_snapshot": state.get("evidence_snapshot"),
            "graph_decision": decision,
        },
    )
    return {
        "workspace": workspace,
        "followups": workspace["followups"],
        "evidence_contract": workspace["evidence_contract"],
        "current_stage": "evidence_request",
        "stage_events": add_stage_event(state, "request_user_evidence", "evidence_request", "degraded", "证据不足，工作流已暂停等待补充资料。"),
    }
