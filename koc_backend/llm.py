import base64
import json
import mimetypes
import re
import socket
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import (
    BASE_DIR,
    KIMI_API_TIMEOUT_SECONDS,
    KIMI_BASE_URL,
    KIMI_MAX_REQUEST_CHARS,
    KIMI_MAX_TOKENS,
    KIMI_RETRY_ATTEMPTS,
    KIMI_RETRY_BACKOFF_SECONDS,
    KIMI_TEXT_MODEL,
    KIMI_VISION_ASSET_LIMIT,
    KIMI_VISION_MODEL,
    MOONSHOT_API_KEY,
)
from .storage import record_model_call


def clamp_prompt_text(text: str, max_chars: int, label: str) -> str:
    if len(text) <= max_chars:
        return text
    keep_head = max_chars // 2
    keep_tail = max(0, max_chars - keep_head - 80)
    return text[:keep_head] + f"\n\n[{label} 已被截断以控制请求体大小]\n\n" + text[-keep_tail:]


def kimi_chat_completion(body: dict[str, Any], kind: str, prompt_chars: int) -> dict[str, Any]:
    model = str(body.get("model", "unknown"))
    last_error = ""
    for attempt in range(1, KIMI_RETRY_ATTEMPTS + 1):
        request = Request(
            f"{KIMI_BASE_URL.rstrip('/')}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {MOONSHOT_API_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=KIMI_API_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
            record_model_call(kind, model, "success", prompt_chars, payload)
            return payload
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            last_error = f"HTTP {exc.code} {detail[:300]}"
            if exc.code < 500 and exc.code not in {408, 429}:
                record_model_call(kind, model, "failed", prompt_chars, error=last_error)
                raise RuntimeError(f"Kimi API 请求失败：{last_error}") from exc
        except socket.timeout as exc:
            last_error = f"读取超时：超过 {KIMI_API_TIMEOUT_SECONDS} 秒未返回"
            if attempt >= KIMI_RETRY_ATTEMPTS:
                record_model_call(kind, model, "timeout", prompt_chars, error=last_error)
                raise RuntimeError(
                    f"Kimi API {last_error}。可以减少上传素材、缩短输入内容，或增大 KIMI_API_TIMEOUT_SECONDS。"
                ) from exc
        except URLError as exc:
            last_error = f"无法连接 Kimi API：{exc.reason}"
            if attempt >= KIMI_RETRY_ATTEMPTS:
                record_model_call(kind, model, "failed", prompt_chars, error=last_error)
                raise RuntimeError(last_error) from exc
        if attempt < KIMI_RETRY_ATTEMPTS:
            delay = KIMI_RETRY_BACKOFF_SECONDS * attempt
            if "HTTP 429" in last_error or "engine_overloaded" in last_error:
                delay = max(delay, min(30.0, 5.0 * attempt))
            time.sleep(delay)
    record_model_call(kind, model, "failed", prompt_chars, error=last_error)
    raise RuntimeError(f"Kimi API 请求失败：{last_error or '未知错误'}")


def call_kimi_json(system_prompt: str, user_prompt: str, schema_hint: dict[str, Any], max_tokens: int | None = None) -> dict[str, Any]:
    if not MOONSHOT_API_KEY:
        raise RuntimeError("缺少 MOONSHOT_API_KEY 环境变量。")

    schema_text = json.dumps(schema_hint, ensure_ascii=False, indent=2)
    user_prompt = clamp_prompt_text(user_prompt, KIMI_MAX_REQUEST_CHARS, "user_prompt")
    final_system_prompt = (
        system_prompt
        + "\n\n你必须输出合法 JSON，不要输出 Markdown，也不要输出解释文字。"
        + "\n请严格按照下面的 JSON 结构返回，字段名保持一致：\n"
        + schema_text
    )
    final_system_prompt = clamp_prompt_text(final_system_prompt, max(4000, KIMI_MAX_REQUEST_CHARS // 2), "system_prompt")

    body = {
        "model": KIMI_TEXT_MODEL,
        "messages": [
            {"role": "system", "content": final_system_prompt},
            {"role": "user", "content": user_prompt + "\n\n请只返回 JSON。"},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": max_tokens or KIMI_MAX_TOKENS,
        "temperature": 1,
        "stream": False,
    }

    payload = kimi_chat_completion(body, "text", len(final_system_prompt) + len(user_prompt))
    choices = payload.get("choices", [])
    if not choices:
        raise RuntimeError("Kimi 未返回可用结果。")

    content = choices[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("Kimi 返回了空内容，请重试一次。")

    try:
        return parse_model_json(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Kimi 返回内容不是合法 JSON：{content[:300]}") from exc


def parse_model_json(content: str) -> dict[str, Any]:
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text).strip()

    decoder = json.JSONDecoder()
    try:
        parsed, _ = decoder.raw_decode(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    extracted = extract_first_json_object(text)
    if extracted and extracted != text:
        parsed = json.loads(extracted)
        if isinstance(parsed, dict):
            return parsed
    raise json.JSONDecodeError("No valid JSON object found", text, 0)


def extract_first_json_object(text: str) -> str:
    start = text.find("{")
    if start < 0:
        return ""
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return ""


def _vision_empty_result(status: str, summary: str, limitations: list[str] | None = None) -> dict[str, Any]:
    return {
        "status": status,
        "asset_summary": summary,
        "homepage_diagnosis": [],
        "video_observations": [],
        "visual_style": [],
        "content_opportunities": [],
        "shooting_and_editing_advice": [],
        "evidence": [],
        "limitations": limitations or [],
    }


def call_kimi_vision_json(prompt: str, assets: list[dict[str, Any]], schema_hint: dict[str, Any]) -> dict[str, Any]:
    if not MOONSHOT_API_KEY:
        return _vision_empty_result(
            "vision_disabled",
            "已收到素材，但未配置 MOONSHOT_API_KEY，暂未进行 Kimi 视觉模型分析。",
            ["需要配置 MOONSHOT_API_KEY 才能启用 Kimi 视觉模型分析图片或视频。"],
        )

    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                clamp_prompt_text(prompt, KIMI_MAX_REQUEST_CHARS, "vision_prompt")
                + "\n\n请只返回合法 JSON，不要输出 Markdown。JSON 结构如下：\n"
                + json.dumps(schema_hint, ensure_ascii=False, indent=2)
            ),
        }
    ]
    skipped: list[str] = []
    for asset in assets[:KIMI_VISION_ASSET_LIMIT]:
        data_url = str(asset.get("data_url", "") or "")
        mime = str(asset.get("mime", "") or "")
        name = str(asset.get("name", "未命名素材") or "未命名素材")
        asset_path = str(asset.get("path", "") or "")
        resolved: Path | None = None
        if not data_url and asset_path:
            candidate = (BASE_DIR / asset_path).resolve()
            if (candidate == BASE_DIR or BASE_DIR in candidate.parents) and candidate.exists() and candidate.is_file():
                resolved = candidate
                mime = mime or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        try:
            if resolved:
                raw = resolved.read_bytes()
                encoded = base64.b64encode(raw).decode("ascii")
                data_url = f"data:{mime};base64,{encoded}"
            if data_url and mime.startswith("image/"):
                content.append({"type": "image_url", "image_url": {"url": data_url}})
            elif data_url and mime.startswith("video/"):
                content.append({"type": "video_url", "video_url": {"url": data_url}})
            else:
                skipped.append(f"{name} 的类型 {mime or '未知'} 暂不支持视觉分析。")
        except Exception as exc:  # noqa: BLE001
            skipped.append(f"{name} 上传到 Kimi 失败：{exc}")

    if len(content) == 1:
        return _vision_empty_result(
            "no_inline_assets",
            "已收到素材信息，但没有可直接提交给 Kimi 视觉模型的图片或视频数据。",
            skipped or ["请上传图片、视频文件，或补充主页截图说明。"],
        )

    body = {
        "model": KIMI_VISION_MODEL,
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
        "max_tokens": KIMI_MAX_TOKENS,
        "stream": False,
    }

    try:
        payload = kimi_chat_completion(body, "vision", len(prompt))
    except RuntimeError as exc:
        return _vision_empty_result(
            "vision_failed",
            "无法连接 Kimi 视觉模型，已回退到文字资料分析。",
            [str(exc)],
        )

    content_text = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
    try:
        result = parse_model_json(content_text)
    except json.JSONDecodeError:
        reason = "Kimi 视觉模型没有按结构化 JSON 返回，已改用 OCR、ASR、截图和浏览器上下文做保守判断。"
        result = _vision_empty_result(
            "vision_parse_failed",
            "Kimi 视觉模型返回内容无法解析为 JSON，已降级为保守素材判断。",
            [reason],
        )
        result["evidence"] = ["视觉模型返回了非结构化文本，不能直接作为片源或剧情判断依据。"]
        result["raw_model_text"] = content_text[:4000]
    if skipped:
        result.setdefault("limitations", [])
        result["limitations"].extend(skipped)
    return result
