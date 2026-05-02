from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.artifacts import build_evidence_contract, build_evidence_summary


def assert_contains(items: list[object], keyword: str) -> None:
    text = "\n".join(str(item) for item in items)
    assert keyword in text, f"expected keyword {keyword!r} in:\n{text}"


def main() -> None:
    profile = {
        "id": "mock-classic-sketch",
        "task_intent": "single_work_analysis",
        "result_mode": "single_work_analysis",
        "user_request": "分析这条经典小品片段：宫廷玉液酒，一百八一杯。场景是太后大酒楼，人物线索有赵丽蓉、巩汉林、金珠。",
        "goal": "拆解当前作品并提炼可复刻动作",
        "platform": "douyin",
        "stage": "cold-start",
        "track": "custom-track",
        "account_name": "待确认账号",
        "evidence_facts": [
            "台词：宫廷玉液酒，一百八一杯",
            "场景：太后大酒楼",
            "人物线索：赵丽蓉、巩汉林、金珠",
        ],
        "asset_files": [],
        "platform_snapshot": {"connector_status": "missing_identity", "confidence": "low"},
    }
    asset_analysis = {
        "status": "no_assets",
        "asset_summary": "mock：仅有用户提供的经典小品文字线索，没有真实视频、评论区截图或后台数据。",
        "evidence": [
            "用户提供台词“宫廷玉液酒，一百八一杯”。",
            "用户提供场景“太后大酒楼”。",
            "用户提供人物线索“赵丽蓉、巩汉林、金珠”。",
        ],
        "limitations": [
            "无评论区截图。",
            "无后台数据。",
            "无账号主页连续作品数据。",
            "无平台授权信息。",
        ],
        "video_understanding": {
            "timeline": [],
            "context_risk": "high",
            "missing_evidence": [
                "评论区截图缺失。",
                "后台数据缺失。",
                "账号主页连续作品证据缺失。",
                "平台授权信息缺失。",
            ],
        },
        "confidence": "low",
        "source_type": "visual_observation",
    }
    artifacts = {
        "asset_analysis": asset_analysis,
        "platform_identity": {"status": "missing_identity", "message": "未获得平台身份或授权信息。"},
        "evidence_snapshot": {
            "task_intent": "single_work_analysis",
            "missing_keys": ["comments", "backend_metrics", "account_series", "authorization"],
        },
        "strategy": {"confidence": "low"},
        "advisor_summary": {"confidence": "low"},
        "tasks": [],
    }
    evidence_summary = build_evidence_summary(profile, artifacts)
    artifacts["evidence_summary"] = evidence_summary
    contract = build_evidence_contract(profile, artifacts)

    for key in [
        "direct_evidence",
        "inferred_claims",
        "low_confidence_claims",
        "missing_evidence",
        "forbidden_claims",
    ]:
        assert key in contract, f"missing evidence contract key: {key}"
        assert isinstance(contract[key], list), f"{key} should be a list"

    assert_contains(contract["forbidden_claims"], "评论区都在说")
    assert (
        "后台数据证明" in "\n".join(contract["forbidden_claims"])
        or "一定会爆" in "\n".join(contract["forbidden_claims"])
    ), contract["forbidden_claims"]
    assert_contains(contract["forbidden_claims"], "长期方向")

    missing_text = "\n".join(contract["missing_evidence"])
    assert "评论区" in missing_text, missing_text
    assert "后台数据" in missing_text, missing_text
    assert "账号主页连续作品" in missing_text, missing_text
    assert "授权信息" in missing_text, missing_text

    print("koc evidence contract regression passed")


if __name__ == "__main__":
    main()
