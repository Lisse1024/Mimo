from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Callable[..., Any]] = {}
        self._metadata: dict[str, dict[str, Any]] = {}

    def register(
        self,
        name: str,
        fn: Callable[..., Any],
        *,
        description: str = "",
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
        timeout_seconds: int | None = None,
        retryable: bool = False,
    ) -> None:
        if not name.strip():
            raise ValueError("工具名称不能为空")
        self._tools[name] = fn
        self._metadata[name] = {
            "name": name,
            "description": description,
            "input_schema": input_schema or {},
            "output_schema": output_schema or {},
            "timeout_seconds": timeout_seconds,
            "retryable": retryable,
        }

    def has(self, name: str) -> bool:
        return name in self._tools

    def describe(self, name: str | None = None) -> dict[str, Any] | list[dict[str, Any]]:
        if name is not None:
            return dict(self._metadata.get(name, {"name": name, "available": False}))
        return [dict(item) for item in self._metadata.values()]

    def run(self, name: str, **kwargs: Any) -> tuple[Any, dict[str, Any]]:
        if name not in self._tools:
            raise KeyError(f"工具未注册：{name}")
        metadata = self._metadata.get(name, {})
        started = time.perf_counter()
        try:
            result = self._tools[name](**kwargs)
            return result, {
                "tool": name,
                "status": "success",
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "error": "",
                "input_keys": sorted(kwargs.keys()),
                "retryable": bool(metadata.get("retryable")),
            }
        except Exception as exc:  # noqa: BLE001
            return None, {
                "tool": name,
                "status": "failed",
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "error": str(exc)[:500],
                "input_keys": sorted(kwargs.keys()),
                "retryable": bool(metadata.get("retryable")),
            }


def build_default_tool_registry(
    *,
    analyze_uploaded_assets: Callable[[dict[str, Any]], dict[str, Any]],
    build_work_understanding: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
    run_ocr_for_image: Callable[[Any], tuple[str, str]] | None = None,
    run_asr_for_video: Callable[[Any], tuple[str, str]] | None = None,
    resolve_platform_identity: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> ToolRegistry:
    tools = ToolRegistry()
    tools.register(
        "media.analyze_uploaded_assets",
        lambda profile: analyze_uploaded_assets(profile, tool_registry=tools),
        description="缓存并分析用户上传的截图、视频和抽帧证据。",
        input_schema={"profile": "dict"},
        output_schema={"asset_analysis": "dict"},
        timeout_seconds=600,
        retryable=True,
    )
    tools.register(
        "media.build_work_understanding",
        lambda profile, asset_analysis: build_work_understanding(profile, asset_analysis),
        description="把单条作品素材分析整理成稳定的 WorkUnderstanding 对象。",
        input_schema={"profile": "dict", "asset_analysis": "dict"},
        output_schema={"work_understanding": "dict"},
        timeout_seconds=30,
    )
    if run_ocr_for_image:
        tools.register(
            "media.ocr_image",
            lambda image_path: run_ocr_for_image(image_path),
            description="读取截图或视频帧中的字幕/文字。",
            input_schema={"image_path": "Path"},
            output_schema={"text": "string", "note": "string"},
            timeout_seconds=15,
            retryable=True,
        )
    if run_asr_for_video:
        tools.register(
            "media.asr_video",
            lambda video_path: run_asr_for_video(video_path),
            description="转写视频音频中的台词、解说或声音线索。",
            input_schema={"video_path": "Path"},
            output_schema={"transcript": "string", "note": "string"},
            timeout_seconds=120,
            retryable=True,
        )
    if resolve_platform_identity:
        tools.register(
            "platform.resolve_identity",
            lambda profile, task_intent="": resolve_platform_identity(profile, task_intent=task_intent),
            description="解析平台、账号、主页或作品身份线索。",
            input_schema={"profile": "dict", "task_intent": "string"},
            output_schema={"platform_identity": "dict"},
            timeout_seconds=10,
        )
    return tools
