import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.memory import ensure_growth_memory
from koc_backend.profile_validation import validate_profile
import koc_backend.workspace_service as workspace_service
from koc_backend.workspace_service import record_experiment_review_memory


def test_experiment_review_map_is_seeded_into_python_growth_memory() -> None:
    profile = validate_profile(
        {
            "nickname": "tester",
            "account_name": "review account",
            "stage": "cold-start",
            "platform": "douyin",
            "track": "custom-track",
            "cadence": "unknown",
            "audience": "unknown",
            "goal": "review experiment",
            "strengths": "unknown",
            "constraints": "unknown",
            "result_mode": "experiment_review",
            "task_intent": "experiment_review",
            "user_request": "\u6211\u6309\u4e0a\u6b21\u8bca\u65ad\u53d1\u4e86 1 \u6761\uff0c\u6570\u636e\u5982\u4e0b\u3002",
            "experiment_review_map": {
                "user_metrics": [{"source_type": "user_provided_metric", "text": "\u64ad\u653e8600"}],
                "new_homepage_evidence": [{"source_type": "homepage_visible_evidence", "text": "\u65b0\u4e3b\u9875\u622a\u56fe"}],
                "decision": {"decision": "continue"},
            },
        }
    )

    memory = ensure_growth_memory(profile)

    assert profile["task_intent"] == "experiment_review"
    assert memory["experiment_reviews"], memory
    review = memory["experiment_reviews"][-1]
    assert review["source"] == "user_backfill"
    assert review["review_map"]["user_metrics"][0]["source_type"] == "user_provided_metric"
    assert review["review_map"]["new_homepage_evidence"][0]["source_type"] == "homepage_visible_evidence"

    store = {"profiles": [profile], "workspaces": {profile["id"]: {}}}
    workspace_service.save_store = lambda _store: None
    workspace = record_experiment_review_memory(
        store,
        profile["id"],
        {
            "job_id": "review-job-1",
            "result": "positive",
            "conclusion": "\u56de\u586b\u6307\u6807\u663e\u793a\u5c40\u90e8\u6709\u6548\u4fe1\u53f7",
            "next_action": "\u7ee7\u7eed\u540c\u65b9\u5411\u5c0f\u6837\u672c",
            "decision": {"decision": "continue"},
            "experiment_review_map": {
                "user_metrics": [{"source_type": "user_provided_metric", "text": "\u64ad\u653e8600"}],
                "new_homepage_evidence": [{"source_type": "homepage_visible_evidence", "text": "\u65b0\u4e3b\u9875\u622a\u56fe"}],
            },
        },
    )

    memory = ensure_growth_memory(store["profiles"][0])
    assert workspace["review"]["metrics"] if workspace.get("review") else True
    assert memory["experiment_reviews"][-1]["source"] == "final_experiment_review"
    assert memory["experiment_reviews"][-1]["next_action"] == "\u7ee7\u7eed\u540c\u65b9\u5411\u5c0f\u6837\u672c"
    assert "\u56de\u586b\u6307\u6807\u663e\u793a\u5c40\u90e8\u6709\u6548\u4fe1\u53f7" in memory["effective_patterns"]


if __name__ == "__main__":
    test_experiment_review_map_is_seeded_into_python_growth_memory()
    print("koc experiment review memory regression passed")
