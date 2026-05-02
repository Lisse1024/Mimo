from typing import Any


def profile_video_understanding(profile: dict[str, Any]) -> dict[str, Any]:
    return profile.get("video_understanding", {}) if isinstance(profile.get("video_understanding"), dict) else {}
