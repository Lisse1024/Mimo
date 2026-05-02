import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from .config import ASR_PROVIDER, BASE_DIR, DATA_DIR, OCR_PROVIDER, UPLOAD_DIR
from .artifacts import annotate_workspace_artifact_source, ensure_confidence
from .homepage_signals import build_homepage_fallback_analysis
from .llm import call_kimi_vision_json
from .profile_intent import infer_video_prompt_profile, normalize_task_intent, video_prompt_capsule_text
from .schemas import ASSET_ANALYSIS_SCHEMA
from .video_understanding import profile_video_understanding

def safe_filename(name: str, fallback: str) -> str:
    stem = Path(name or fallback).stem or fallback
    suffix = Path(name or "").suffix.lower()
    stem = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", stem).strip("._-") or fallback
    suffix = re.sub(r"[^0-9A-Za-z.]+", "", suffix)[:12]
    return f"{stem[:60]}{suffix}"


def data_url_to_bytes(data_url: str) -> tuple[str, bytes]:
    if not data_url.startswith("data:") or "," not in data_url:
        raise ValueError("素材数据格式无效。")
    header, encoded = data_url.split(",", 1)
    mime = header[5:].split(";")[0] or "application/octet-stream"
    return mime, base64.b64decode(encoded, validate=True)


def persist_uploaded_assets(profile_id: str, asset_files: list[Any]) -> list[dict[str, Any]]:
    profile_dir = UPLOAD_DIR / profile_id
    profile_dir.mkdir(parents=True, exist_ok=True)
    saved_assets: list[dict[str, Any]] = []

    for index, item in enumerate(asset_files[:8], start=1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", ""))[:120] or f"asset_{index}"
        mime = str(item.get("mime", ""))[:80] or "application/octet-stream"
        size = int(item.get("size", 0) or 0)
        kind = str(item.get("kind", ""))[:40]
        note = str(item.get("note", ""))[:300]
        context = str(item.get("context", ""))[:60]
        data_url = str(item.get("data_url", ""))
        saved_path = ""

        if data_url:
            detected_mime, raw = data_url_to_bytes(data_url)
            mime = mime if mime != "application/octet-stream" else detected_mime
            suffix = Path(name).suffix or (mimetypes.guess_extension(mime) or ".bin")
            filename = safe_filename(name, f"asset_{index}{suffix}")
            target = profile_dir / f"{index:02d}_{filename}"
            target.write_bytes(raw)
            saved_path = str(target.relative_to(BASE_DIR)).replace("\\", "/")
            size = len(raw)
            note = note or "文件已保存到本地 uploads，并可用于视觉模型分析。"

        saved_assets.append(
            {
                "id": uuid.uuid4().hex[:10],
                "name": name,
                "mime": mime,
                "size": size,
                "kind": kind,
                "context": context or ("uploaded_video" if mime.startswith("video/") else "uploaded_image" if mime.startswith("image/") else "unknown"),
                "path": saved_path,
                "note": note or "仅记录素材元数据，未保存内联数据。",
            }
        )
    return saved_assets


def asset_cache_key(profile: dict[str, Any]) -> str:
    assets = profile.get("asset_files", [])
    payload = [{"analysis_prompt_version": "vision-v6-strict-visible-metrics"}]
    for item in assets:
        path = item.get("path")
        digest = ""
        if path:
            resolved = (BASE_DIR / path).resolve()
            if BASE_DIR in resolved.parents and resolved.exists() and resolved.is_file():
                digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
        payload.append(
            {
                "sha256": digest,
                "size": item.get("size"),
                "mime": item.get("mime"),
                "name": item.get("name"),
                "context": item.get("context"),
            }
        )
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def find_cached_asset_analysis_by_fingerprint(profile: dict[str, Any]) -> dict[str, Any] | None:
    from .profiles import load_store

    cache_key = asset_cache_key(profile)
    candidates: list[dict[str, Any]] = []
    try:
        store = load_store()
    except Exception:  # noqa: BLE001
        return None
    for candidate_profile in store.get("profiles", []):
        if candidate_profile.get("id") == profile.get("id"):
            continue
        analysis = candidate_profile.get("asset_analysis")
        if not isinstance(analysis, dict):
            continue
        if analysis.get("status") in {"vision_parse_failed", "vision_failed", "no_inline_assets"}:
            continue
        if analysis.get("cache_key") == cache_key:
            candidates.append(analysis)
            continue
        try:
            if asset_cache_key(candidate_profile) == cache_key:
                candidates.append(analysis)
        except Exception:  # noqa: BLE001
            continue
    if not candidates:
        return None
    candidates.sort(key=lambda item: 0 if item.get("status") == "success" else 1)
    cached = json.loads(json.dumps(candidates[0], ensure_ascii=False))
    cached["cache_key"] = cache_key
    cached.setdefault("limitations", [])
    cached["limitations"].append("已复用相同素材的视觉分析缓存。")
    return cached


def normalize_store_assets(store: dict[str, Any]) -> bool:
    changed = False
    for profile in store.get("profiles", []):
        profile_id = profile.get("id") or uuid.uuid4().hex[:8]
        profile["id"] = profile_id
        normalized_assets: list[dict[str, Any]] = []
        for item in profile.get("asset_files", []):
            if not isinstance(item, dict):
                continue
            if item.get("data_url"):
                saved = persist_uploaded_assets(profile_id, [item])
                normalized_assets.extend(saved)
                changed = True
            else:
                item.pop("data_url", None)
                normalized_assets.append(item)
        if normalized_assets != profile.get("asset_files", []):
            profile["asset_files"] = normalized_assets
            changed = True
    return changed




def resolve_safe_path(raw_path: str) -> Path | None:
    if not raw_path:
        return None
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = BASE_DIR / candidate
    try:
        resolved = candidate.resolve()
    except Exception:  # noqa: BLE001
        return None
    allowed_roots = [BASE_DIR, DATA_DIR]
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        return None
    return resolved if resolved.exists() and resolved.is_file() else None


def run_ocr_for_image(image_path: Path) -> tuple[str, str]:
    if OCR_PROVIDER in {"none", "off", "disabled"}:
        return "", "OCR disabled by KOC_OCR_PROVIDER."
    tesseract = shutil.which("tesseract")
    if not tesseract:
        return "", "OCR adapter ready, but local tesseract command is not installed."
    try:
        completed = subprocess.run(
            [tesseract, str(image_path), "stdout", "-l", os.environ.get("KOC_OCR_LANG", "chi_sim+eng")],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
        text = re.sub(r"\s+", " ", completed.stdout or "").strip()
        if completed.returncode != 0 and not text:
            return "", (completed.stderr or "tesseract returned no text").strip()[:240]
        return text[:500], "OCR extracted by local tesseract."
    except Exception as exc:  # noqa: BLE001
        return "", f"OCR failed: {exc}"


def run_asr_for_video(video_path: Path) -> tuple[str, str]:
    if ASR_PROVIDER in {"none", "off", "disabled"}:
        return "", "ASR disabled by KOC_ASR_PROVIDER."
    whisper = shutil.which("whisper")
    if not whisper:
        return "", "ASR adapter ready, but local whisper command is not installed."
    output_dir = DATA_DIR / "asr"
    output_dir.mkdir(exist_ok=True)
    try:
        completed = subprocess.run(
            [
                whisper,
                str(video_path),
                "--language",
                os.environ.get("KOC_ASR_LANGUAGE", "Chinese"),
                "--model",
                os.environ.get("KOC_ASR_MODEL", "base"),
                "--output_format",
                "txt",
                "--output_dir",
                str(output_dir),
            ],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        txt_path = output_dir / f"{video_path.stem}.txt"
        text = txt_path.read_text(encoding="utf-8", errors="ignore") if txt_path.exists() else completed.stdout
        text = re.sub(r"\s+", " ", text or "").strip()
        if completed.returncode != 0 and not text:
            return "", (completed.stderr or "whisper returned no text").strip()[:240]
        return text[:1200], "ASR extracted by local whisper CLI."
    except Exception as exc:  # noqa: BLE001
        return "", f"ASR failed: {exc}"


def enrich_video_understanding_with_ocr_asr(
    profile: dict[str, Any],
    tool_registry: Any | None = None,
    tool_runs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    vu = json.loads(json.dumps(profile_video_understanding(profile), ensure_ascii=False))
    timeline = vu.get("timeline", []) if isinstance(vu.get("timeline"), list) else []
    missing = set(vu.get("missingEvidence", []) if isinstance(vu.get("missingEvidence"), list) else [])
    missing.update(vu.get("missing_evidence", []) if isinstance(vu.get("missing_evidence"), list) else [])
    ocr_notes: list[str] = []

    for item in timeline:
        if not isinstance(item, dict):
            continue
        frame_path = resolve_safe_path(str(item.get("framePath") or item.get("frame_path") or ""))
        if not frame_path:
            continue
        if tool_registry and tool_registry.has("media.ocr_image"):
            ocr_result, tool_run = tool_registry.run("media.ocr_image", image_path=frame_path)
            if tool_runs is not None:
                tool_runs.append(tool_run)
            ocr_text, note = ocr_result if isinstance(ocr_result, tuple) else ("", tool_run.get("error") or "OCR 工具未返回结果。")
        else:
            ocr_text, note = run_ocr_for_image(frame_path)
        if ocr_text:
            item["ocrText"] = item.get("ocrText") or ocr_text
            item["ocr_text"] = item.get("ocr_text") or ocr_text
        if note:
            ocr_notes.append(note)

    video_assets = [
        resolve_safe_path(str(asset.get("path", "")))
        for asset in profile.get("asset_files", [])
        if isinstance(asset, dict) and str(asset.get("mime", "")).startswith("video/")
    ]
    video_assets = [item for item in video_assets if item]
    transcript = ""
    asr_note = ""
    if video_assets:
        if tool_registry and tool_registry.has("media.asr_video"):
            asr_result, tool_run = tool_registry.run("media.asr_video", video_path=video_assets[0])
            if tool_runs is not None:
                tool_runs.append(tool_run)
            transcript, asr_note = asr_result if isinstance(asr_result, tuple) else ("", tool_run.get("error") or "ASR 工具未返回结果。")
        else:
            transcript, asr_note = run_asr_for_video(video_assets[0])
        if transcript:
            for item in timeline:
                if isinstance(item, dict) and not (item.get("audioTranscript") or item.get("audio_transcript")):
                    item["audioTranscript"] = "ASR transcript is available at video level; align manually if exact segment timing is required."
                    item["audio_transcript"] = item["audioTranscript"]
            vu["audio_transcript"] = transcript
    if not any(str(item.get("ocrText") or item.get("ocr_text") or "").strip() for item in timeline if isinstance(item, dict)):
        missing.add("OCR text unavailable or no readable subtitles detected.")
    if video_assets and not transcript:
        missing.add("ASR transcript unavailable; audio/dialogue must not be invented.")
    vu["timeline"] = timeline
    vu["ocr_status"] = "available" if any(str(item.get("ocrText") or item.get("ocr_text") or "").strip() for item in timeline if isinstance(item, dict)) else "missing"
    vu["asr_status"] = "available" if transcript else ("missing" if video_assets else "skipped")
    vu["ocr_notes"] = sorted(set(ocr_notes))[:5]
    if asr_note:
        vu["asr_notes"] = [asr_note]
    vu["missing_evidence"] = sorted(str(item) for item in missing if str(item).strip())
    profile["video_understanding"] = vu
    return vu


def normalize_video_understanding_payload(result: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    ledger = profile_video_understanding(profile)
    raw = result.get("video_understanding")
    vu = raw if isinstance(raw, dict) else {}
    ledger_timeline = ledger.get("timeline", []) if isinstance(ledger.get("timeline"), list) else []
    timeline = vu.get("timeline", []) if isinstance(vu.get("timeline"), list) else []

    if not timeline and ledger_timeline:
        timeline = []
        for item in ledger_timeline:
            if not isinstance(item, dict):
                continue
            timeline.append(
                {
                    "time_range": item.get("timeRange") or item.get("time_range") or "",
                    "visual_fact": item.get("visualEvidence") or item.get("visual_fact") or "已提供该时间段的抽帧，需以画面可见内容为准。",
                    "ocr_text": item.get("ocrText") or item.get("ocr_text") or "",
                    "audio_transcript": item.get("audioTranscript") or item.get("audio_transcript") or "",
                    "inference": item.get("inference") or "仅能基于该抽帧做低置信推断，不能外推完整剧情。",
                    "confidence": ensure_confidence(item.get("confidence"), "low"),
                }
            )

    missing_evidence: list[str] = []
    for source in (ledger.get("missingEvidence"), ledger.get("missing_evidence"), vu.get("missing_evidence")):
        if isinstance(source, list):
            missing_evidence.extend(str(item) for item in source if str(item).strip())
    if ledger_timeline:
        missing_evidence.extend(["未接入逐字 OCR", "未接入音频 ASR", "未接入评论区、完播率和留存曲线"])

    vu["timeline"] = timeline
    vu["observable_facts"] = vu.get("observable_facts") or ledger.get("observableFacts") or ledger.get("observable_facts") or []
    vu["inferences"] = vu.get("inferences") if isinstance(vu.get("inferences"), list) else []
    vu["uncertain_points"] = vu.get("uncertain_points") or ledger.get("uncertainPoints") or ledger.get("uncertain_points") or []
    vu["context_risk"] = vu.get("context_risk") or ledger.get("contextRisk") or ledger.get("context_risk") or ("high" if ledger_timeline else "medium")
    vu["missing_evidence"] = sorted(set(missing_evidence))
    result["video_understanding"] = vu
    return result


def apply_single_work_capture_limits(result: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    task_intent = normalize_task_intent(profile.get("result_mode") or profile.get("task_intent"), profile)
    if task_intent != "single_work_analysis":
        return result

    assets = profile.get("asset_files", []) if isinstance(profile.get("asset_files"), list) else []
    has_video_asset = any(isinstance(item, dict) and str(item.get("mime", "")).startswith("video/") for item in assets)
    current_frame_count = sum(
        1
        for item in assets
        if isinstance(item, dict)
        and (
            str(item.get("context", "")) == "current_video_frame"
            or str(item.get("name", "")).startswith("current-video-frame")
        )
    )
    if has_video_asset or current_frame_count <= 0:
        return result

    result["analysis_scope"] = "keyframe_only"
    result["confidence"] = "medium" if result.get("confidence") == "high" else ensure_confidence(result.get("confidence"), "medium")
    result.setdefault("limitations", [])
    result["limitations"] = list(
        dict.fromkeys(
            [
                f"本轮只拿到 {current_frame_count} 张连续截图，不是完整视频；剧情因果、台词、BGM、真实剪辑节奏和结尾反转都只能低置信判断。",
                *[str(item) for item in result.get("limitations", []) if str(item).strip()],
            ]
        )
    )[:6]

    clip_context = result.get("clip_context") if isinstance(result.get("clip_context"), dict) else {}
    missing_context = clip_context.get("missing_context") if isinstance(clip_context.get("missing_context"), list) else []
    clip_context["missing_context"] = list(
        dict.fromkeys(
            [
                "缺少完整视频播放过程，无法确认前后剧情、台词顺序、音频和结尾结果。",
                *[str(item) for item in missing_context if str(item).strip()],
            ]
        )
    )[:6]
    result["clip_context"] = clip_context

    vu = result.get("video_understanding") if isinstance(result.get("video_understanding"), dict) else {}
    vu["context_risk"] = "high"
    missing_evidence = vu.get("missing_evidence") if isinstance(vu.get("missing_evidence"), list) else []
    vu["missing_evidence"] = list(
        dict.fromkeys(
            [
                "完整视频文件或授权录屏",
                "音频/ASR 转写",
                "评论区与标题标签",
                "完播率、留存曲线和互动数据",
                *[str(item) for item in missing_evidence if str(item).strip()],
            ]
        )
    )[:8]
    result["video_understanding"] = vu
    return result


def analyze_uploaded_assets(profile: dict[str, Any], tool_registry: Any | None = None) -> dict[str, Any]:
    from .profiles import profile_brief

    assets = profile.get("asset_files", [])
    if not assets:
        return normalize_video_understanding_payload({
            "status": "no_assets",
            "asset_summary": "用户暂未上传主页截图或视频素材，后续只能基于文字资料、作品链接和历史数据判断；链接内容不会被假定为已观看。",
            "homepage_diagnosis": [],
            "video_observations": [],
            "visual_style": [],
            "content_opportunities": [],
            "shooting_and_editing_advice": [],
            "evidence": [],
            "limitations": ["缺少可直接视觉分析的主页截图、封面或视频素材；作品链接当前仅作为待核验线索。"],
            "source_type": "visual_observation",
            "confidence": "low",
        }, profile)
    cache_key = asset_cache_key(profile)
    cached = profile.get("asset_analysis")
    if isinstance(cached, dict) and cached.get("cache_key") == cache_key and cached.get("status") not in {"vision_parse_failed", "vision_failed", "no_inline_assets"}:
        return normalize_video_understanding_payload(cached, profile)
    shared_cached = find_cached_asset_analysis_by_fingerprint(profile)
    if shared_cached:
        return normalize_video_understanding_payload(shared_cached, profile)

    task_intent = normalize_task_intent(profile.get("result_mode") or profile.get("task_intent"), profile)
    video_profile = infer_video_prompt_profile(profile)
    local_tool_runs: list[dict[str, Any]] = []
    video_understanding = enrich_video_understanding_with_ocr_asr(profile, tool_registry=tool_registry, tool_runs=local_tool_runs)
    mode_prompt = (
        "本轮是账号主页诊断。上传素材只能作为主页、作品矩阵、封面风格、可见公开指标和账号定位证据。"
        "禁止把主页里的单个作品封面当成当前视频关键帧；禁止填写片源判断、剧情片段语义、影视复刻方案或单条视频镜头脚本。"
        "重点输出 homepage_diagnosis、content_opportunities、visual_style、shooting_and_editing_advice、evidence 和 limitations。"
        if task_intent != "single_work_analysis"
        else video_prompt_capsule_text(video_profile)
    )
    prompt = (
        "你是素材理解智能体，负责客观分析 KOC 创作者上传的主页截图、封面图或视频。"
        + mode_prompt
        + "\n"
        "请不要泛泛给建议，必须基于画面可见证据说明：主页定位、视觉统一性、标题/封面表达、视频开头、字幕密度、镜头节奏和可优化点。"
        "如果素材是视频，请重点观察前几秒钩子、主体展示、剪辑节奏、字幕和画面稳定性。"
        + (
            "如果素材是影视剧、电影、短剧或剧情切片，必须先判断是否存在掐头去尾、剧情上下文不足、人物关系无法确认的问题；只能基于可见人物、场景、表情、动作、字幕和镜头变化分析，不要编造画面外剧情。"
            "如果画面、标题、标签、字幕或链接线索能帮助判断片源，请填写 source_identification：可能片名/节目名、内容类型、置信度、证据和不确定性。"
            "如果无法确定片名，possible_title 写“疑似，暂不能确认”，并说明还需要标题、标签、评论或更长片段。"
            "请填写 clip_context：这个片段可见部分讲了什么、属于冲突/反转/情绪高点/关系张力/搞笑误会/角色高光/悬念中的哪类功能、出现了哪些角色关系线索、缺少哪些上下文。"
            "请填写 traffic_mechanism：判断它为什么可能让用户停留、评论、收藏或转发，例如名场面、悬念、角色关系、情绪代入、争议站队、反差、台词爽点。"
            "请填写 replication_plan：给出可复刻方案，包括如何找同类片段、开头怎么截、字幕怎么写、标题标签怎么打、发布后看什么数据。"
            "请同时填写 fact_ledger 素材事实账本：visible_facts 只放画面直接可见信息；audio_facts 只放 ASR 或声音中直接可听信息，没有 ASR 就留空；text_facts 只放 OCR、字幕、标题、标签、页面可见文本；possible_source 必须包含 name、confidence 和 evidence，不确定时 name 留空或 unknown；characters_or_people 必须给 confidence，无法确认角色身份时 role 写 unknown 或 疑似；timeline 只能按抽帧/视频理解写稀疏时间线，不得扩写完整剧情；growth_hooks 必须具体到台词、字幕、人物动作、场景符号、标题钩子、强表情或评论性观点入口，并写 evidence，禁止只写“冲突”“反差”“情绪价值”。"
            "单条作品必须先判断 content_type：platform_native、media_clip、tutorial、performance、gameplay、vlog、product_review、knowledge 或 unknown；只有证据明显指向影视/综艺/小品/剧集/搬运/二创片段时，才把片源判断作为主框架。平台原生内容应写内容类型、可见钩子、增长机制、镜头语言、字幕/标题策略和可复用结构。"
            "证据来源必须分层：只有 visual_frame、ocr_text、asr_text、on_screen_text、title、caption、hashtag、visible_metric、visible_comment、page_visible_text、user_provided_content_description 可以进入 fact_ledger 和 growth_hooks。"
            "用户请求、任务指令、runtime context、平台连接器状态、素材处理日志、上传文件名、上传数量、工具 trace、内部错误、debug 信息只能用于 limitations/trace，不得写入 visible_facts、text_facts、growth_hooks 或脚本素材。"
            "如果画面像影视片段，不要误判成游戏、家居或其它账号赛道；请在 video_observations、limitations 和 evidence 中明确写出判断依据和不确定性。"
            if task_intent == "single_work_analysis"
            else "如果主页里出现影视、动漫、游戏、萌娃等封面，只能用于判断账号内容混杂度和作品矩阵，不得输出片源、剧情、片段功能或影视复刻方案。"
        )
        + "如果用户提供了作品链接但没有上传对应素材，只能把链接当作待核验线索，不要声称已经看过链接内容。"
        "你会收到 video_understanding ledger。请严格按时间线分析：每个 time_range 只写该时间段可见事实；把可见事实、OCR 字幕、音频转写、模型推断分开。"
        "如果 OCR/ASR 为空，不要编造台词、配乐、旁白或剧情因果；对剧情切片、影视切片和搬运片段，需要明确 context_risk，并把缺少片头片尾、前后剧情、评论区和数据指标写入 missing_evidence 或 limitations。"
        "没有评论区证据时，不得生成“评论区都在说”；没有后台数据时，不得生成“数据证明会涨粉”或“一定会爆”。"
        "对影视、综艺、小品、春晚、老剧、名场面类素材，必须在 limitations 或风险说明中写明版权/素材使用边界：只能建议结构复用、评论性引用、授权素材、平台可用素材、截图讲解或口播复述，不鼓励完整搬运原片。"
        "所有建议必须能回溯到 evidence、timeline 或用户文字，不确定就写低置信。"
        "如果看不清或素材不足，请明确说明限制。"
        "\n\nvideo_understanding ledger：\n"
        + json.dumps(video_understanding, ensure_ascii=False, indent=2)
        + "\n\n用户文字档案如下：\n"
        + profile_brief({**profile, "asset_analysis": {}})
    )
    result = call_kimi_vision_json(prompt, assets, ASSET_ANALYSIS_SCHEMA)
    result = normalize_video_understanding_payload(result, profile)
    if local_tool_runs:
        result["tool_runs"] = local_tool_runs
    result = apply_single_work_capture_limits(result, profile)
    if task_intent == "account_growth_diagnosis":
        empty_homepage = not result.get("homepage_diagnosis") and not result.get("content_opportunities")
        weak_status = result.get("status") in {"vision_disabled", "vision_failed", "no_inline_assets", "vision_parse_failed"}
        if empty_homepage or weak_status:
            fallback_reason = "\n".join(
                [
                    str(result.get("asset_summary") or "视觉模型未给出可用的主页结构化分析。"),
                    str(result.get("raw_model_text") or ""),
                ]
            ).strip()
            fallback = build_homepage_fallback_analysis(profile, fallback_reason, tool_registry=tool_registry)
            if result.get("limitations"):
                fallback["limitations"] = list(dict.fromkeys(fallback.get("limitations", []) + [str(item) for item in result.get("limitations", []) if str(item).strip()]))[:6]
            result = normalize_video_understanding_payload(fallback, profile)
    result = annotate_workspace_artifact_source(result, "visual_observation", "medium")
    result["cache_key"] = cache_key
    return result




