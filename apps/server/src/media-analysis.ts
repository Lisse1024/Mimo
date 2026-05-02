import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "./config.js";
import type { KocUploadedAsset } from "./koc-growth.js";

export type MediaProcessingStatus = "done" | "degraded" | "skipped";
export type VideoUnderstandingConfidence = "high" | "medium" | "low";
export type VideoContextRisk = "low" | "medium" | "high";

export interface SampledFrame {
  path: string;
  timestampSec: number;
  timeRange: string;
  strategy: "opening" | "middle" | "ending" | "interval";
}

export interface CachedMediaAsset {
  name: string;
  mime: string;
  size: number;
  hash: string;
  path: string;
  kind: "image" | "video" | "other";
  framePaths: string[];
  frames: SampledFrame[];
  durationSec?: number;
  samplingStrategy?: string;
  status: MediaProcessingStatus;
  note: string;
}

export interface MediaProcessingResult {
  status: MediaProcessingStatus;
  assets: CachedMediaAsset[];
  summary: string;
}

export interface VideoUnderstandingTimelineItem {
  timeRange: string;
  frameName: string;
  framePath: string;
  visualEvidence: string;
  ocrText: string;
  audioTranscript: string;
  inference: string;
  confidence: VideoUnderstandingConfidence;
}

export interface VideoUnderstandingResult {
  status: MediaProcessingStatus;
  timeline: VideoUnderstandingTimelineItem[];
  observableFacts: string[];
  uncertainPoints: string[];
  contextRisk: VideoContextRisk;
  missingEvidence: string[];
  summary: string;
}

const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const FRAME_DIR = path.join(DATA_DIR, "frames");
const MAX_VIDEO_FRAMES = Math.max(3, Number(process.env.KOC_MAX_VIDEO_FRAMES || 8));
const VISION_ASSET_LIMIT = Math.max(3, Number(process.env.KOC_VISION_ASSET_LIMIT || 8));

function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(FRAME_DIR, { recursive: true });
}

function safeFileName(input: string) {
  return (input || "asset")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

function extFromMime(mime: string) {
  if (/png/i.test(mime)) return ".png";
  if (/jpe?g/i.test(mime)) return ".jpg";
  if (/webp/i.test(mime)) return ".webp";
  if (/gif/i.test(mime)) return ".gif";
  if (/mp4/i.test(mime)) return ".mp4";
  if (/quicktime|mov/i.test(mime)) return ".mov";
  if (/webm/i.test(mime)) return ".webm";
  return "";
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const raw = match[3] || "";
  const buffer = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "utf-8");
  return { mime, buffer };
}

function kindFromMime(mime: string): CachedMediaAsset["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function probeVideoDuration(filePath: string) {
  try {
    const output = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }
    );
    const duration = Number(output.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

function formatTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const rest = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatTimeRange(startSec: number, endSec: number) {
  return `${formatTimestamp(startSec)}-${formatTimestamp(endSec)}`;
}

function samplingStrategyFor(timestampSec: number, durationSec?: number): SampledFrame["strategy"] {
  if (!durationSec || durationSec <= 0) return timestampSec <= 3 ? "opening" : "interval";
  if (timestampSec <= Math.min(3, durationSec * 0.2)) return "opening";
  if (timestampSec >= Math.max(0, durationSec - 4)) return "ending";
  if (Math.abs(timestampSec - durationSec / 2) <= Math.max(2, durationSec * 0.12)) return "middle";
  return "interval";
}

function framesFromPaths(framePaths: string[], durationSec?: number): SampledFrame[] {
  return framePaths.map((framePath, index) => {
    const startSec = index * 3;
    return {
      path: framePath,
      timestampSec: startSec,
      timeRange: formatTimeRange(startSec, startSec + 3),
      strategy: samplingStrategyFor(startSec, durationSec)
    };
  });
}

function buildSampleTimestamps(durationSec?: number, maxFrames = MAX_VIDEO_FRAMES) {
  if (!durationSec || durationSec <= 0) {
    return Array.from({ length: Math.min(maxFrames, 5) }, (_, index) => index * 3);
  }

  const safeDuration = Math.max(1, durationSec);
  const anchors = [
    0,
    Math.min(2, safeDuration * 0.1),
    safeDuration * 0.25,
    safeDuration * 0.5,
    safeDuration * 0.75,
    Math.max(0, safeDuration - 2)
  ];
  const intervalCount = Math.max(0, maxFrames - anchors.length);
  const interval = safeDuration / Math.max(1, intervalCount + 1);
  const intervals = Array.from({ length: intervalCount }, (_, index) => interval * (index + 1));
  const merged = [...anchors, ...intervals]
    .map((item) => Math.max(0, Math.min(Math.max(0, safeDuration - 0.25), item)))
    .sort((a, b) => a - b);
  const unique: number[] = [];
  for (const timestamp of merged) {
    if (!unique.some((item) => Math.abs(item - timestamp) < 1.2)) unique.push(timestamp);
  }
  return unique.slice(0, maxFrames);
}

function sampleVideoFrames(filePath: string, hash: string) {
  if (!hasFfmpeg()) {
    return {
      status: "degraded" as const,
      framePaths: [],
      frames: [],
      durationSec: undefined,
      samplingStrategy: "ffmpeg_unavailable",
      note: "ffmpeg is not available, so real video frame sampling was skipped."
    };
  }

  const outputDir = path.join(FRAME_DIR, hash);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const fileName of fs.readdirSync(outputDir).filter((name) => /^frame-\d+\.jpg$/.test(name))) {
    fs.rmSync(path.join(outputDir, fileName), { force: true });
  }

  try {
    const durationSec = probeVideoDuration(filePath);
    const timestamps = buildSampleTimestamps(durationSec);
    const frames: SampledFrame[] = [];
    for (const [index, timestampSec] of timestamps.entries()) {
      const framePath = path.join(outputDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      execFileSync(
        "ffmpeg",
        ["-y", "-ss", timestampSec.toFixed(2), "-i", filePath, "-frames:v", "1", "-vf", "scale=640:-1", framePath],
        { stdio: "ignore", timeout: 10000, windowsHide: true }
      );
      if (fs.existsSync(framePath)) {
        frames.push({
          path: framePath,
          timestampSec,
          timeRange: formatTimeRange(timestampSec, Math.min(durationSec || timestampSec + 3, timestampSec + 3)),
          strategy: samplingStrategyFor(timestampSec, durationSec)
        });
      }
    }
    const framePaths = frames.map((frame) => frame.path);
    const samplingStrategy = durationSec
      ? `smart_anchors_opening_middle_ending; duration=${durationSec.toFixed(1)}s; max_frames=${MAX_VIDEO_FRAMES}`
      : `fallback_interval_sampling; max_frames=${MAX_VIDEO_FRAMES}`;
    return {
      status: framePaths.length ? ("done" as const) : ("degraded" as const),
      framePaths,
      frames,
      durationSec,
      samplingStrategy,
      note: framePaths.length
        ? `sampled ${framePaths.length} frames with ffmpeg using ${samplingStrategy}`
        : "ffmpeg ran but no frames were generated."
    };
  } catch (error) {
    return {
      status: "degraded" as const,
      framePaths: [],
      frames: [],
      durationSec: undefined,
      samplingStrategy: "sampling_failed",
      note: `ffmpeg frame sampling failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function processUploadedMedia(assets: KocUploadedAsset[] = []): MediaProcessingResult {
  ensureDirs();
  const processed: CachedMediaAsset[] = [];

  for (const asset of assets.slice(0, 6)) {
    const parsed = parseDataUrl(asset.data_url || "");
    if (!parsed) {
      processed.push({
        name: asset.name || "invalid-asset",
        mime: asset.mime || "application/octet-stream",
        size: asset.size || 0,
        hash: "",
        path: "",
        kind: "other",
        framePaths: [],
        frames: [],
        samplingStrategy: "invalid_asset",
        status: "degraded",
        note: "invalid data URL"
      });
      continue;
    }

    const hash = crypto.createHash("sha256").update(parsed.buffer).digest("hex").slice(0, 24);
    const mime = asset.mime || parsed.mime;
    const ext = path.extname(asset.name || "") || extFromMime(mime);
    const fileName = `${hash}-${safeFileName(asset.name || "asset")}${ext && !safeFileName(asset.name || "").endsWith(ext) ? ext : ""}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, parsed.buffer);
    }

    const kind = kindFromMime(mime);
    let framePaths: string[] = [];
    let frames: SampledFrame[] = [];
    let durationSec: number | undefined;
    let samplingStrategy: string | undefined;
    let status: MediaProcessingStatus = "done";
    let note = "cached uploaded media";

    if (kind === "video") {
      const sampled = sampleVideoFrames(filePath, hash);
      framePaths = sampled.framePaths;
      frames = sampled.frames;
      durationSec = sampled.durationSec;
      samplingStrategy = sampled.samplingStrategy;
      status = sampled.status;
      note = sampled.note;
    }

    processed.push({
      name: asset.name || fileName,
      mime,
      size: parsed.buffer.length,
      hash,
      path: filePath,
      kind,
      framePaths,
      frames,
      durationSec,
      samplingStrategy,
      status,
      note
    });
  }

  const status: MediaProcessingStatus = processed.some((item) => item.status === "degraded")
    ? "degraded"
    : processed.length
      ? "done"
      : "skipped";

  return {
    status,
    assets: processed,
    summary: processed.length
      ? processed.map((item) => `${item.kind}:${item.name}:${item.status}:${item.framePaths.length}frames`).join("; ")
      : "No uploaded media to process."
  };
}

export function buildVideoUnderstanding(result: MediaProcessingResult): VideoUnderstandingResult {
  const videoAssets = result.assets.filter((asset) => asset.kind === "video");
  const frames = videoAssets.flatMap((asset) =>
    (asset.frames.length ? asset.frames : framesFromPaths(asset.framePaths, asset.durationSec)).map((frame) => ({ asset, frame }))
  );
  const missingEvidence = new Set<string>();
  const observableFacts: string[] = [];
  const uncertainPoints: string[] = [];

  if (!videoAssets.length) {
    return {
      status: "skipped",
      timeline: [],
      observableFacts: ["No uploaded video asset was available for timeline analysis."],
      uncertainPoints: ["Video-level plot, audio, subtitles, and editing rhythm cannot be verified without a video asset."],
      contextRisk: "medium",
      missingEvidence: ["video asset", "timestamped frames", "OCR text", "audio transcript", "platform metrics/comments"],
      summary: "No video timeline was built because no video asset was uploaded."
    };
  }

  observableFacts.push(`Uploaded video assets: ${videoAssets.length}.`);
  observableFacts.push(`Sampled video frames available: ${frames.length}.`);
  for (const asset of videoAssets) {
    if (asset.durationSec) observableFacts.push(`${asset.name} duration: ${asset.durationSec.toFixed(1)}s.`);
    if (asset.samplingStrategy) observableFacts.push(`${asset.name} sampling: ${asset.samplingStrategy}.`);
  }
  missingEvidence.add("OCR text is not extracted yet; visible subtitles must be read from sampled frames by the vision model.");
  missingEvidence.add("Audio/ASR transcript is not extracted yet; dialogue, music, and sound cues must not be invented.");
  missingEvidence.add("Platform comments, completion rate, retention curve, and share/save metrics are not available from the upload alone.");

  if (!frames.length) {
    uncertainPoints.push("No sampled frame is available, so visual content cannot be verified.");
    missingEvidence.add("sampled frames");
  } else if (frames.length < 3) {
    uncertainPoints.push("Only a very small number of sampled frames is available; beginning, middle, and ending may be missing.");
    missingEvidence.add("continuous scene coverage");
  } else {
    uncertainPoints.push("The timeline is sparse frame sampling, not full-frame video understanding.");
  }

  const timeline = frames.map(({ asset, frame }) => ({
    timeRange: frame.timeRange,
    frameName: `${asset.name}-${path.basename(frame.path)}`,
    framePath: frame.path,
    visualEvidence: `sampled ${frame.strategy} frame available; concrete visual facts must be extracted by the vision model from this image.`,
    ocrText: "",
    audioTranscript: "",
    inference: "pending vision analysis; do not infer plot continuity beyond this sampled time range.",
    confidence: "low" as const
  }));

  const contextRisk: VideoContextRisk = !frames.length || frames.length < 3 ? "high" : "medium";

  return {
    status: result.status === "skipped" ? "degraded" : result.status,
    timeline,
    observableFacts,
    uncertainPoints,
    contextRisk,
    missingEvidence: Array.from(missingEvidence),
    summary: `Built sparse video timeline: ${videoAssets.length} video(s), ${frames.length} sampled frame(s), context_risk=${contextRisk}.`
  };
}

function fileToDataUrl(filePath: string, fallbackMime: string) {
  const data = fs.readFileSync(filePath);
  return `data:${fallbackMime};base64,${data.toString("base64")}`;
}

export function buildVisionReadyAssets(result: MediaProcessingResult, limit = VISION_ASSET_LIMIT): KocUploadedAsset[] {
  const ready: KocUploadedAsset[] = [];

  for (const asset of result.assets) {
    if (ready.length >= limit) break;

    if (asset.kind === "image" && asset.path && fs.existsSync(asset.path)) {
      ready.push({
        name: asset.name,
        mime: asset.mime,
        size: asset.size,
        data_url: fileToDataUrl(asset.path, asset.mime || "image/png"),
        note: `cached image asset from ${asset.path}`
      });
      continue;
    }

    if (asset.kind === "video" && (asset.frames.length || asset.framePaths.length)) {
      const frames = asset.frames.length ? asset.frames : framesFromPaths(asset.framePaths, asset.durationSec);
      for (const frame of frames) {
        if (ready.length >= limit) break;
        const framePath = frame.path;
        if (!fs.existsSync(framePath)) continue;
        ready.push({
          name: `${asset.name}-${frame.timeRange}-${path.basename(framePath)}`,
          mime: "image/jpeg",
          size: fs.statSync(framePath).size,
          data_url: fileToDataUrl(framePath, "image/jpeg"),
          note: `sampled ${frame.strategy} video frame ${frame.timeRange} from ${asset.name}; analyze only visible evidence in this time range`
        });
      }
    }
  }

  return ready;
}
