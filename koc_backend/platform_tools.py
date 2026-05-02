from __future__ import annotations

from typing import Any


def resolve_platform_identity(profile: dict[str, Any], task_intent: str = "") -> dict[str, Any]:
    """Return a normalized platform identity summary for graph routing and traces."""
    snapshot = profile.get("platform_snapshot") if isinstance(profile.get("platform_snapshot"), dict) else {}
    work_links = profile.get("work_links") if isinstance(profile.get("work_links"), list) else []
    account_id = str(profile.get("platform_account_id") or "").strip()
    platform = str(profile.get("platform") or snapshot.get("platform") or "custom-platform").strip() or "custom-platform"
    is_single_work = task_intent == "single_work_analysis"

    if is_single_work:
        message = "已识别为单条作品分析：优先读取作品标题、话题标签、链接文本和上传素材，不上升为账号长期诊断。"
    else:
        message = str(snapshot.get("explain") or "已写入平台身份线索，等待后续连接器拉取作品与账号公开信息。")

    evidence = []
    if account_id:
        evidence.append("已提供平台账号身份")
    if work_links:
        evidence.append(f"已提供 {len(work_links)} 条作品或主页链接")
    if snapshot.get("source_type"):
        evidence.append(str(snapshot.get("source_type")))

    connector_status = str(snapshot.get("connector_status") or ("identity_saved" if account_id or work_links else "missing_identity"))
    return {
        "status": "resolved" if connector_status != "missing_identity" or is_single_work else "missing_identity",
        "platform": platform,
        "connector_status": connector_status,
        "message": message,
        "evidence": evidence,
        "confidence": str(snapshot.get("confidence") or ("medium" if account_id or work_links or is_single_work else "low")),
        "snapshot": snapshot,
    }
