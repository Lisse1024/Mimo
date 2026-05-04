import json
from datetime import datetime
from typing import Any

from .artifacts import annotate_workspace_artifact_source, annotate_workspace_bundle, build_evidence_contract, build_learning_packet
from .memory import append_unique_patterns, ensure_growth_memory, maybe_shift_profile_stage
from .llm import call_kimi_json
from .profiles import get_profile, profile_brief, profile_for_client, save_store
from .schemas import CALENDAR_SCHEMA, POST_PACK_SCHEMA, REVIEW_SCHEMA
from .strategy_service import (
    build_agent_run,
    build_evidence_summary,
    generate_workspace_strategy_bundle,
    normalize_tasks,
)
from .task_service import build_task_followups


def recommend_workspace_mode(profile: dict[str, Any], workspace: dict[str, Any] | None = None) -> str:
    return "advisor"


def workspace_payload(store: dict[str, Any], profile_id: str) -> dict[str, Any]:
    profile = profile_for_client(get_profile(store, profile_id))
    artifacts = store["workspaces"].get(profile_id, {})
    asset_analysis = annotate_workspace_artifact_source(artifacts.get("asset_analysis"), "visual_observation", "medium")
    strategy = annotate_workspace_artifact_source(artifacts.get("strategy"), "model_inference", "medium")
    advisor_summary = annotate_workspace_artifact_source(artifacts.get("advisor_summary"), "model_inference", "medium")
    hot_video_analysis = annotate_workspace_artifact_source(artifacts.get("hot_video_analysis"), "model_inference", "low")
    return {
        "profile": profile,
        "recommended_mode": artifacts.get("recommended_mode", recommend_workspace_mode(profile, artifacts)),
        "evidence_summary": artifacts.get("evidence_summary", build_evidence_summary(profile, {**artifacts, "asset_analysis": asset_analysis, "strategy": strategy, "advisor_summary": advisor_summary})),
        "advisor_summary": advisor_summary,
        "tasks": artifacts.get("tasks", []),
        "followups": artifacts.get("followups", []),
        "agent_run": artifacts.get("agent_run"),
        "hot_video_analysis": hot_video_analysis,
        "asset_analysis": asset_analysis,
        "strategy": strategy,
        "calendar": artifacts.get("calendar"),
        "post_pack": artifacts.get("post_pack"),
        "review": artifacts.get("review"),
        "evidence_contract": artifacts.get("evidence_contract"),
        "learning_packet": artifacts.get("learning_packet"),
    }


def commit_strategy_workspace(
    store: dict[str, Any],
    profile_id: str,
    asset_analysis: dict[str, Any],
    bundle: dict[str, Any],
) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    memory = ensure_growth_memory(profile)
    workspace = store["workspaces"].setdefault(profile_id, {})
    bundle = annotate_workspace_bundle(bundle, asset_analysis)
    hot_video_analysis = bundle.get("hot_video_analysis", {})
    strategy = bundle.get("strategy", {})
    advisor_summary = bundle.get("advisor_summary", {})
    agent_run = build_agent_run(profile, asset_analysis, hot_video_analysis, strategy)
    profile["asset_analysis"] = asset_analysis
    for legacy_key in ("agent" "_reports", "agent" "_meeting", "consultations"):
        workspace.pop(legacy_key, None)
    workspace["recommended_mode"] = recommend_workspace_mode(profile, workspace)
    workspace["advisor_summary"] = advisor_summary
    workspace["tasks"] = bundle.get("tasks", [])
    workspace["asset_analysis"] = asset_analysis
    workspace["hot_video_analysis"] = hot_video_analysis
    workspace["strategy"] = strategy
    workspace["agent_run"] = agent_run
    workspace["evidence_summary"] = build_evidence_summary(profile, workspace)
    workspace["evidence_contract"] = build_evidence_contract(profile, workspace)
    workspace["followups"] = build_task_followups(workspace["tasks"], workspace["evidence_summary"], profile)
    workspace["learning_packet"] = build_learning_packet(profile, workspace)
    workspace["updated_at"] = datetime.utcnow().isoformat()
    memory["last_strategy_updated_at"] = workspace["updated_at"]
    save_store(store)
    return workspace_payload(store, profile_id)


def generate_strategy(store: dict[str, Any], profile_id: str) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    asset_analysis = analyze_uploaded_assets(profile)
    bundle = generate_workspace_strategy_bundle(profile, asset_analysis)
    return commit_strategy_workspace(store, profile_id, asset_analysis, bundle)


def generate_calendar(store: dict[str, Any], profile_id: str) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    workspace = store["workspaces"].get(profile_id, {})
    strategy = workspace.get("strategy")
    if not strategy:
        raise ValueError("请先生成增长策略。")

    system_prompt = (
        "你是一名内容运营负责人。"
        "请根据用户画像和已有增长策略，生成未来 7 天执行日历。"
        "每天的任务都要解释为什么适合这个用户当前阶段。"
    )
    user_prompt = (
        "请为以下用户生成 7 天内容执行日历。\n\n"
        + profile_brief(profile)
        + "\n爆款视频分析：\n"
        + json.dumps(workspace.get("hot_video_analysis", {}), ensure_ascii=False)
        + "\n策略摘要：\n"
        + json.dumps(strategy, ensure_ascii=False)
    )
    calendar = call_kimi_json(system_prompt, user_prompt, CALENDAR_SCHEMA)
    workspace["calendar"] = calendar
    workspace["updated_at"] = datetime.utcnow().isoformat()
    save_store(store)
    return workspace_payload(store, profile_id)


def generate_post_pack(store: dict[str, Any], profile_id: str, day_index: int) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    workspace = store["workspaces"].get(profile_id, {})
    strategy = workspace.get("strategy")
    calendar = workspace.get("calendar")
    if not strategy or not calendar:
        raise ValueError("请先完成策略和 7 天执行日历。")
    if day_index < 0 or day_index >= len(calendar["posts"]):
        raise ValueError("无效的日历序号。")

    selected = calendar["posts"][day_index]
    system_prompt = (
        "你是一名内容策划师。"
        "请基于用户画像、增长策略和具体任务，生成一条完整可执行的内容包。"
        "内容包必须包含标题、脚本、素材、标签、发布时间和互动回复。"
    )
    user_prompt = (
        "请为以下任务生成单条内容包。\n\n"
        + profile_brief(profile)
        + "\n爆款视频分析：\n"
        + json.dumps(workspace.get("hot_video_analysis", {}), ensure_ascii=False)
        + "\n策略摘要：\n"
        + json.dumps(strategy, ensure_ascii=False)
        + "\n当前日历任务：\n"
        + json.dumps(selected, ensure_ascii=False)
    )
    post_pack = call_kimi_json(system_prompt, user_prompt, POST_PACK_SCHEMA)
    workspace["post_pack"] = {**post_pack, "selected_day_index": day_index, "selected_post": selected}
    workspace["updated_at"] = datetime.utcnow().isoformat()
    save_store(store)
    return workspace_payload(store, profile_id)


def metric_summary(payload: dict[str, Any]) -> dict[str, float]:
    views = max(int(payload.get("views", 0)), 0)
    likes = max(int(payload.get("likes", 0)), 0)
    saves = max(int(payload.get("saves", 0)), 0)
    comments = max(int(payload.get("comments", 0)), 0)
    return {
        "views": views,
        "likes": likes,
        "saves": saves,
        "comments": comments,
        "like_rate": round((likes / views) * 100, 1) if views else 0.0,
        "save_rate": round((saves / views) * 100, 1) if views else 0.0,
        "comment_rate": round((comments / views) * 100, 1) if views else 0.0,
    }


def generate_review(store: dict[str, Any], profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    memory = ensure_growth_memory(profile)
    workspace = store["workspaces"].get(profile_id, {})
    strategy = workspace.get("strategy")
    post_pack = workspace.get("post_pack")
    if not strategy or not post_pack:
        raise ValueError("请先生成策略和单条内容包。")

    metrics = metric_summary(payload)
    system_prompt = (
        "你是一名增长复盘顾问。"
        "请根据用户画像、既定策略、当前内容包和表现数据做复盘。"
        "必须指出问题发生在定位、选题、表达、标签还是互动设计的哪一层。"
    )
    user_prompt = (
        "请对以下内容表现做复盘。\n\n"
        + profile_brief(profile)
        + "\n爆款视频分析：\n"
        + json.dumps(workspace.get("hot_video_analysis", {}), ensure_ascii=False)
        + "\n策略摘要：\n"
        + json.dumps(strategy, ensure_ascii=False)
        + "\n当前内容包：\n"
        + json.dumps(post_pack, ensure_ascii=False)
        + "\n当前指标：\n"
        + json.dumps(metrics, ensure_ascii=False)
    )
    analysis = call_kimi_json(system_prompt, user_prompt, REVIEW_SCHEMA)
    workspace["review"] = {"metrics": metrics, "analysis": analysis}
    effective_patterns = analysis.get("effective_patterns", [])
    ineffective_patterns = analysis.get("ineffective_patterns", [])
    memory["effective_patterns"] = append_unique_patterns(memory.get("effective_patterns", []), effective_patterns)
    memory["ineffective_patterns"] = append_unique_patterns(memory.get("ineffective_patterns", []), ineffective_patterns)
    memory.setdefault("experiments", []).append(
        {
            "content_title": post_pack.get("selected_post", {}).get("title") or post_pack.get("headline_variants", ["未命名内容"])[0],
            "stage_at_publish": profile.get("stage"),
            "metrics": metrics,
            "conclusion": analysis.get("conclusion", ""),
            "effective_patterns": effective_patterns[:3],
            "ineffective_patterns": ineffective_patterns[:3],
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    memory["experiments"] = memory["experiments"][-10:]
    maybe_shift_profile_stage(
        profile,
        str(analysis.get("stage_recommendation", profile.get("stage"))),
        str(analysis.get("stage_shift_reason", "")).strip(),
    )
    workspace["updated_at"] = datetime.utcnow().isoformat()
    save_store(store)
    return workspace_payload(store, profile_id)


def record_experiment_review_memory(store: dict[str, Any], profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    profile = get_profile(store, profile_id)
    memory = ensure_growth_memory(profile)
    workspace = store["workspaces"].setdefault(profile_id, {})
    review_map = payload.get("experiment_review_map", {})
    if not isinstance(review_map, dict):
        review_map = {}
    decision = payload.get("decision", {})
    if not isinstance(decision, dict):
        decision = {}
    result = str(payload.get("result", "")).strip()
    conclusion = str(payload.get("conclusion", "")).strip()
    next_action = str(payload.get("next_action", "")).strip()
    review = {
        "source": "final_experiment_review",
        "job_id": str(payload.get("job_id", "")).strip(),
        "result": result,
        "conclusion": conclusion,
        "next_action": next_action,
        "decision": decision,
        "review_map": review_map,
        "created_at": datetime.utcnow().isoformat(),
    }
    memory.setdefault("experiment_reviews", []).append(review)
    memory["experiment_reviews"] = memory["experiment_reviews"][-20:]
    if conclusion:
        if result == "positive":
            memory["effective_patterns"] = append_unique_patterns(memory.get("effective_patterns", []), [conclusion])
        elif result == "negative":
            memory["ineffective_patterns"] = append_unique_patterns(memory.get("ineffective_patterns", []), [conclusion])
        elif result in {"mixed", "unknown"}:
            memory.setdefault("open_questions", [])
            memory["open_questions"] = append_unique_patterns(memory.get("open_questions", []), [conclusion])
    workspace["experiment_review_memory"] = review
    workspace["updated_at"] = datetime.utcnow().isoformat()
    save_store(store)
    return workspace_payload(store, profile_id)


def update_task_status(store: dict[str, Any], profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    get_profile(store, profile_id)
    workspace = store["workspaces"].get(profile_id, {})
    tasks = workspace.get("tasks", [])
    if not tasks:
        raise ValueError("当前工作空间还没有可更新的任务。")

    task_id = str(payload.get("task_id", "")).strip()
    new_status = str(payload.get("status", "")).strip().lower()
    if not task_id:
        raise ValueError("缺少 task_id。")
    if new_status not in {"todo", "doing", "done", "blocked"}:
        raise ValueError("无效的任务状态。")

    matched = None
    for task in tasks:
        if task.get("id") == task_id:
            task["status"] = new_status
            matched = task
            break
    if not matched:
        raise ValueError("未找到对应任务。")

    workspace.setdefault("task_events", []).append(
        {
            "task_id": task_id,
            "status": new_status,
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    workspace["updated_at"] = datetime.utcnow().isoformat()
    save_store(store)
    return {
        "task": matched,
        "workspace": workspace_payload(store, profile_id),
    }

