import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from koc_backend.homepage_signals import (
    build_homepage_column_plan,
    build_homepage_evidence_map,
    homepage_ocr_text,
)


def joined(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(joined(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(joined(item) for item in value)
    return str(value)


def main() -> None:
    text, notes = homepage_ocr_text(
        {
            "asset_files": [
                {"mime": "image/png", "context": "homepage_screenshot", "path": ""},
            ]
        }
    )
    assert text == "", text
    assert isinstance(notes, list), notes

    profile = {
        "nickname": "VisibleAccountA",
        "bio": "Profile promise A",
        "desktop_context": "current window process browser screen",
        "asset_notes": "upload metadata image/png file size 12345",
        "platform_observed_metrics": {"counts": {"followers": 42, "likes": 179, "works": 2}},
        "evidence_facts": [
            {"source_type": "active_window_process", "text": "msedgewebview2"},
            {"source_type": "file_name", "text": "screen-001.png"},
            {"source_type": "profile_bio", "text": "Profile promise A"},
            {"source_type": "work_title", "text": "Work title A"},
            {"source_type": "work_cover_text", "text": "Cover text A"},
            {"source_type": "work_visible_metric", "text": "Visible plays A"},
        ],
    }
    homepage_map = build_homepage_evidence_map(profile, {"limitations": ["backend metrics missing"]})
    map_text = joined(homepage_map)
    for forbidden in ["msedgewebview2", "screen-001.png", "image/png", "file size", "upload metadata"]:
        assert forbidden not in map_text, forbidden
    for allowed in ["Profile promise A", "Work title A", "Cover text A", "Visible plays A"]:
        assert allowed in map_text, allowed
    assert homepage_map.get("content_patterns"), homepage_map

    plan, status = build_homepage_column_plan(homepage_map)
    assert status in {"specific", "direction_only"}, status
    if status == "specific":
        assert plan, plan
        plan_text = joined(plan)
        assert "Work title A" in plan_text or "Cover text A" in plan_text or "Profile promise A" in plan_text, plan_text
        for forbidden in ["msedgewebview2", "screen-001.png", "image/png", "file size"]:
            assert forbidden not in plan_text, forbidden
    else:
        assert plan == [], plan

    runtime_only_map = build_homepage_evidence_map(
        {
            "nickname": "screen",
            "desktop_context": "current window process chrome screen",
            "asset_notes": "upload asset image/png file size 12345",
            "evidence_facts": [
                {"source_type": "active_window_title", "text": "screen"},
                {"source_type": "mime_type", "text": "image/png"},
                {"source_type": "file_size", "text": "file size 12345"},
            ],
        },
        {"limitations": ["backend metrics missing"]},
    )
    runtime_plan, runtime_status = build_homepage_column_plan(runtime_only_map)
    assert not runtime_only_map.get("content_patterns"), runtime_only_map
    assert runtime_status == "insufficient_evidence", runtime_status
    assert runtime_plan == [], runtime_plan

    print("koc homepage evidence pipeline regression passed")


if __name__ == "__main__":
    main()
