from datetime import datetime
from typing import Any


def clean_user_facing_text(value: Any) -> str:
    text = str(value or "").strip()
    replacements = {
        "advisor_summary 中的 first_content_task": "首条内容任务",
        "advisor_summary里的first_content_task": "首条内容任务",
        "advisor_summary": "增长建议",
        "first_content_task": "首条内容任务",
        "video_reasoning": "视频分析",
        "model_inference": "模型判断",
        "strategy": "策略",
        "high": "高",
        "medium": "中",
        "low": "低",
        "unknown": "待确认",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text

def normalize_tasks(raw_tasks: list[dict[str, Any]], profile: dict[str, Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    allowed_priorities = {"high", "medium", "low"}
    allowed_statuses = {"todo", "doing", "done", "blocked"}
    allowed_owners = {"advisor", "content", "data", "platform", "creative", "viral", "profile", "user"}

    for index, item in enumerate(raw_tasks[:5], start=1):
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("id", "")).strip() or f"{profile['id']}-task-{index}"
        normalized.append(
            {
                "id": task_id[:40],
                "title": clean_user_facing_text(item.get("title", ""))[:80] or f"任务 {index}",
                "goal": clean_user_facing_text(item.get("goal", ""))[:240] or "推进当前增长阶段的关键动作。",
                "priority": str(item.get("priority", "medium")).strip().lower() if str(item.get("priority", "medium")).strip().lower() in allowed_priorities else "medium",
                "status": str(item.get("status", "todo")).strip().lower() if str(item.get("status", "todo")).strip().lower() in allowed_statuses else "todo",
                "owner": str(item.get("owner", "advisor")).strip().lower() if str(item.get("owner", "advisor")).strip().lower() in allowed_owners else "advisor",
                "source": str(item.get("source", "strategy")).strip()[:40] or "strategy",
            }
        )

    if not normalized:
        normalized = [
            {
                "id": f"{profile['id']}-task-1",
                "title": "确定本轮最小验证内容",
                "goal": "根据当前诊断结论，选择一条今天能完成、能验证账号方向的内容。",
                "priority": "high",
                "status": "todo",
                "owner": "user",
                "source": "strategy",
            },
            {
                "id": f"{profile['id']}-task-2",
                "title": "完成首条视频脚本与镜头表",
                "goal": "把本轮选题转成可直接拍摄的开头、镜头、字幕和剪辑节奏。",
                "priority": "high",
                "status": "todo",
                "owner": "creative",
                "source": "advisor_summary",
            },
            {
                "id": f"{profile['id']}-task-3",
                "title": "发布后记录首轮复盘数据",
                "goal": "记录播放、点赞、评论、收藏、主页点击和用户反馈，为下一轮复盘提供依据。",
                "priority": "medium",
                "status": "todo",
                "owner": "data",
                "source": "strategy",
            },
        ]
    return normalized


def build_task_followups(tasks: list[dict[str, Any]], evidence_summary: list[dict[str, Any]], profile: dict[str, Any]) -> list[dict[str, Any]]:
    missing_evidence = [
        item
        for item in evidence_summary
        if isinstance(item, dict) and item.get("status") in {"missing", "degraded"}
    ]
    followups: list[dict[str, Any]] = []
    now = datetime.utcnow().isoformat()
    for index, task in enumerate(tasks[:5], start=1):
        if not isinstance(task, dict) or task.get("status") in {"done", "blocked"}:
            continue
        evidence_need = ""
        if missing_evidence:
            source = missing_evidence[min(index - 1, len(missing_evidence) - 1)]
            evidence_need = clean_user_facing_text(source.get("next_action") or source.get("summary") or "补充关键证据。")
        elif task.get("owner") == "data":
            evidence_need = "发布后回填播放、点赞、收藏、评论、完播和涨粉数据。"
        else:
            evidence_need = "执行后回填结果，我会把它写入长期记忆并更新策略。"
        followups.append(
            {
                "id": f"{profile.get('id', 'profile')}-followup-{index}",
                "task_id": task.get("id", f"task-{index}"),
                "title": f"跟进：{clean_user_facing_text(task.get('title', '待办任务'))}",
                "trigger": "user_review_or_evidence_update",
                "evidence_needed": clean_user_facing_text(evidence_need),
                "next_check_hint": "完成后直接说“复盘：...”并附上数据或截图。",
                "created_at": now,
                "status": "open",
            }
        )
    return followups


