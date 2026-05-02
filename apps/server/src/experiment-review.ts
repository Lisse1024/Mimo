import type { KocExperimentMemory } from "./koc-memory.js";

export interface KocExperimentReviewInput {
  runId?: string;
  metrics?: Record<string, unknown>;
  result?: KocExperimentMemory["result"];
  conclusion?: string;
}

export interface KocExperimentReviewValidation {
  ok: boolean;
  missing: string[];
  recognized: string[];
  message: string;
}

const METRIC_ALIASES: Record<string, string[]> = {
  views: ["views", "播放", "播放量", "浏览", "浏览量", "曝光", "展现"],
  likes: ["likes", "点赞", "赞"],
  saves: ["saves", "收藏", "收藏量"],
  comments: ["comments", "评论", "评论量"],
  shares: ["shares", "分享", "转发"],
  follows: ["follows", "涨粉", "转粉", "新增粉丝"],
  homepageClicks: ["homepageClicks", "主页点击", "主页访问", "主页浏览"],
  completionRate: ["completionRate", "完播率", "完播"],
  avgWatchSeconds: ["avgWatchSeconds", "平均观看", "平均播放时长", "平均观看时长"],
};

function parseMetricNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[%+,，]/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberMetric(metrics: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const direct = parseMetricNumber(metrics[key]);
    if (typeof direct === "number") return direct;
  }
  return undefined;
}

export function normalizeReviewMetrics(metrics: Record<string, unknown> = {}) {
  const normalized: Record<string, number> = {};
  for (const [canonical, aliases] of Object.entries(METRIC_ALIASES)) {
    const value = numberMetric(metrics, aliases);
    if (typeof value === "number") normalized[canonical] = value;
  }
  return normalized;
}

export function validateExperimentReviewInput(input: KocExperimentReviewInput): KocExperimentReviewValidation {
  const metrics = normalizeReviewMetrics(input.metrics || {});
  const recognized = Object.keys(metrics);
  const providedResult = input.result && !["pending", "unknown"].includes(input.result) ? input.result : "";
  const conclusion = (input.conclusion || "").trim();
  const missing: string[] = [];
  if (!recognized.length) missing.push("至少填写一个发布后指标，例如播放、点赞、收藏、评论、完播率、涨粉或主页点击。");
  if (recognized.length < 2 && !providedResult && !conclusion) {
    missing.push("建议至少填写两个指标，或补充一句人工复盘结论。");
  }
  return {
    ok: missing.length === 0,
    missing,
    recognized,
    message: missing.length
      ? `复盘数据不足：${missing.join("；")}`
      : `已识别 ${recognized.length} 个复盘指标。`,
  };
}

export function inferExperimentReview(input: KocExperimentReviewInput): Required<KocExperimentReviewInput> {
  const metrics = normalizeReviewMetrics(input.metrics || {});
  const provided = input.result;
  if (provided && provided !== "pending" && provided !== "unknown") {
    return {
      runId: input.runId || "",
      metrics,
      result: provided,
      conclusion: (input.conclusion || "").trim() || `用户标记实验结果为${provided}。`,
    };
  }

  const views = metrics.views;
  const completion = metrics.completionRate;
  const saves = metrics.saves;
  const comments = metrics.comments;
  const follows = metrics.follows;
  const homepageClicks = metrics.homepageClicks;
  const shares = metrics.shares;

  let score = 0;
  if (typeof views === "number" && views >= 1000) score += 1;
  if (typeof completion === "number" && completion >= 35) score += 1;
  if (typeof saves === "number" && saves >= 5) score += 1;
  if (typeof comments === "number" && comments >= 5) score += 1;
  if (typeof shares === "number" && shares >= 3) score += 1;
  if (typeof follows === "number" && follows > 0) score += 1;
  if (typeof homepageClicks === "number" && homepageClicks > 0) score += 1;

  const result: KocExperimentMemory["result"] = score >= 3 ? "positive" : score >= 1 ? "mixed" : "negative";
  const conclusion = (input.conclusion || "").trim() || [
    `根据回填指标自动判断为${result}。`,
    typeof views === "number" ? `播放/曝光=${views}` : "",
    typeof completion === "number" ? `完播率=${completion}` : "",
    typeof saves === "number" ? `收藏=${saves}` : "",
    typeof comments === "number" ? `评论=${comments}` : "",
    typeof follows === "number" ? `涨粉=${follows}` : "",
    typeof homepageClicks === "number" ? `主页点击=${homepageClicks}` : "",
  ].filter(Boolean).join("；");

  return {
    runId: input.runId || "",
    metrics,
    result,
    conclusion,
  };
}
