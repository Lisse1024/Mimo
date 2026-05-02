import type { ActiveWindowSnapshot, PlatformKind } from "./window-monitor.js";

export type PlatformConnectorStatus = "resolved" | "partial" | "unsupported";

export interface PlatformWorkHint {
  platform: PlatformKind | "shipinhao";
  url?: string;
  accountId?: string;
  workId?: string;
  pageKind: "profile" | "video" | "feed" | "search" | "unknown";
  sourceType: "user_link" | "account_id_hint" | "browser_title_inference";
  confidence: "low" | "medium" | "high";
  evidence: string[];
}

export interface PlatformConnectorResult {
  status: PlatformConnectorStatus;
  provider: "connector_v1";
  hints: PlatformWorkHint[];
  fetchedPages: PlatformFetchedPage[];
  visibleMetrics?: {
    sourceType: "browser_dom_visible_signal";
    confidence: "low" | "medium" | "high";
    counts: Record<string, number>;
    hashtags: string[];
    title?: string;
    author?: string;
  };
  summary: string;
  nextStep: string;
}

export interface PlatformFetchedPage {
  url: string;
  finalUrl?: string;
  status: "fetched" | "skipped" | "failed";
  httpStatus?: number;
  title?: string;
  description?: string;
  canonicalUrl?: string;
  reason?: string;
  sourceType: "public_page_metadata";
  confidence: "low" | "medium";
}

function unique(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function extractUrlsFromText(text: string) {
  return unique(Array.from(text.matchAll(/https?:\/\/[^\s，。；、)）]+/g)).map((match) => match[0]));
}

function inferPlatformFromUrl(url: string): PlatformWorkHint["platform"] {
  const lower = url.toLowerCase();
  if (/douyin|iesdouyin/.test(lower)) return "douyin";
  if (/xiaohongshu|xhslink|xhs/.test(lower)) return "xiaohongshu";
  if (/bilibili|b23\.tv/.test(lower)) return "bilibili";
  if (/kuaishou|gifshow/.test(lower)) return "kuaishou";
  if (/weibo/.test(lower)) return "weibo";
  if (/zhihu/.test(lower)) return "zhihu";
  if (/channels\.weixin|shipinhao/.test(lower)) return "shipinhao";
  return "unknown";
}

function inferPlatformFromText(text: string): PlatformWorkHint["platform"] {
  const lower = text.toLowerCase();
  if (/抖音/.test(lower)) return "douyin";
  if (/小红书/.test(lower)) return "xiaohongshu";
  if (/b站|哔哩哔哩/.test(lower)) return "bilibili";
  if (/快手/.test(lower)) return "kuaishou";
  if (/微博/.test(lower)) return "weibo";
  if (/知乎/.test(lower)) return "zhihu";
  if (/视频号/.test(lower)) return "shipinhao";
  if (/(^|[\s,，。:：#])(?:抖音|douyin|iesdouyin)(?=$|[\s,，。:：#])/.test(lower)) return "douyin";
  if (/(^|[\s,，。:：#])(?:小红书|xiaohongshu|xhs|rednote)(?=$|[\s,，。:：#])/.test(lower)) return "xiaohongshu";
  if (/(^|[\s,，。:：#])(?:b站|哔哩哔哩|bilibili|b23\.tv)(?=$|[\s,，。:：#])/.test(lower)) return "bilibili";
  if (/(^|[\s,，。:：#])(?:快手|kuaishou|gifshow)(?=$|[\s,，。:：#])/.test(lower)) return "kuaishou";
  if (/(^|[\s,，。:：#])(?:微博|weibo)(?=$|[\s,，。:：#])/.test(lower)) return "weibo";
  if (/(^|[\s,，。:：#])(?:知乎|zhihu)(?=$|[\s,，。:：#])/.test(lower)) return "zhihu";
  if (/(^|[\s,，。:：#])(?:视频号|shipinhao|channels\.weixin)(?=$|[\s,，。:：#])/.test(lower)) return "shipinhao";
  return "unknown";
}

function inferPageKindFromUrl(url: string): PlatformWorkHint["pageKind"] {
  const lower = url.toLowerCase();
  if (/\/user\/|\/share\/user\/|\/profile\/|author|sec_uid|user_id|uid=/.test(lower)) return "profile";
  if (/\/video\/|\/note\/|\/aweme\/|\/opus\/|\/dynamic\/|video_id|note_id|aweme_id/.test(lower)) return "video";
  if (/search|query|keyword/.test(lower)) return "search";
  return "unknown";
}

function extractIdFromText(text: string) {
  const patterns = [
    /(?:抖音号|小红书号|快手号|B站UID|UID|账号ID|账户ID|用户ID|主页ID|平台ID)\s*[:：=]\s*([a-zA-Z0-9_-]{4,})/i,
    /\b(?:id|uid)\s*[:：=]\s*([a-zA-Z0-9_-]{4,})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return "";
}

function extractWorkIdFromUrl(url: string) {
  const patterns = [
    /\/video\/([a-zA-Z0-9_-]+)/,
    /\/note\/([a-zA-Z0-9_-]+)/,
    /\/opus\/([a-zA-Z0-9_-]+)/,
    /(?:aweme_id|video_id|note_id)=([a-zA-Z0-9_-]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function extractAccountIdFromUrl(url: string) {
  const patterns = [
    /\/share\/user\/([^/?#]+)/,
    /\/user\/([^/?#]+)/,
    /(?:sec_uid|user_id|uid)=([^&#]+)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]).slice(0, 160);
  }
  return "";
}

function extractStructuredSignals(text: string): PlatformConnectorResult["visibleMetrics"] | undefined {
  const match = text.match(/structured_page_signals:\s*(\{.*?\})(?:\n-|$)/s);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const rawCounts = parsed.counts && typeof parsed.counts === "object" && !Array.isArray(parsed.counts)
      ? parsed.counts as Record<string, unknown>
      : {};
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawCounts)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
    }
    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
    if (!Object.keys(counts).length && !hashtags.length && !parsed.ogTitle) return undefined;
    return {
      sourceType: "browser_dom_visible_signal",
      confidence: Object.keys(counts).length ? "medium" : "low",
      counts,
      hashtags,
      title: typeof parsed.ogTitle === "string" ? parsed.ogTitle : undefined,
      author: typeof parsed.author === "string" ? parsed.author : undefined
    };
  } catch {
    return undefined;
  }
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || host === "0.0.0.0"
    || host === "::1"
    || host.startsWith("169.254.");
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMeta(content: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) return stripHtml(match[1]).slice(0, 240);
  }
  return "";
}

async function fetchPublicPageMetadata(url: string): Promise<PlatformFetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, status: "skipped", reason: "invalid_url", sourceType: "public_page_metadata", confidence: "low" };
  }
  if (!["http:", "https:"].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) {
    return { url, status: "skipped", reason: "non_public_url", sourceType: "public_page_metadata", confidence: "low" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 KOC-Agent/1.0 (+metadata fetch)",
        "accept": "text/html,application/xhtml+xml"
      }
    });
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      return {
        url,
        finalUrl: response.url,
        status: "skipped",
        httpStatus: response.status,
        reason: `unsupported_content_type:${contentType || "unknown"}`,
        sourceType: "public_page_metadata",
        confidence: "low"
      };
    }
    const raw = (await response.text()).slice(0, 250000);
    const title = firstMeta(raw, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i
    ]);
    const description = firstMeta(raw, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i
    ]);
    const canonicalUrl = firstMeta(raw, [
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["'][^>]*>/i
    ]);
    return {
      url,
      finalUrl: response.url,
      status: title || description || canonicalUrl ? "fetched" : "failed",
      httpStatus: response.status,
      title,
      description,
      canonicalUrl,
      reason: title || description || canonicalUrl ? undefined : "no_metadata_found",
      sourceType: "public_page_metadata",
      confidence: title || description ? "medium" : "low"
    };
  } catch (error) {
    return {
      url,
      status: "failed",
      reason: error instanceof Error ? error.message.slice(0, 160) : "fetch_failed",
      sourceType: "public_page_metadata",
      confidence: "low"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePlatformContext(input: {
  text: string;
  runtimeContext?: string;
  activeWindow?: ActiveWindowSnapshot;
}): Promise<PlatformConnectorResult> {
  const sourceText = [input.text, input.runtimeContext || ""].filter(Boolean).join("\n");
  const urls = extractUrlsFromText(sourceText);
  const hints: PlatformWorkHint[] = [];
  const textPlatform = inferPlatformFromText(sourceText);
  const visibleMetrics = extractStructuredSignals(sourceText);

  for (const url of urls) {
    const platform = inferPlatformFromUrl(url);
    const pageKind = inferPageKindFromUrl(url);
    hints.push({
      platform,
      url,
      workId: extractWorkIdFromUrl(url) || undefined,
      pageKind,
      sourceType: "user_link",
      confidence: platform !== "unknown" ? "high" : "medium",
      evidence: [`url:${url}`]
    });
  }
  const fetchedPages = await Promise.all(urls.slice(0, 4).map((url) => fetchPublicPageMetadata(url)));
  for (const page of fetchedPages) {
    const hint = hints.find((item) => item.url === page.url);
    if (!hint) continue;
    const finalUrl = page.finalUrl || page.canonicalUrl || "";
    const finalPageKind = finalUrl ? inferPageKindFromUrl(finalUrl) : "unknown";
    if (finalPageKind !== "unknown") hint.pageKind = finalPageKind;
    const finalPlatform = finalUrl ? inferPlatformFromUrl(finalUrl) : "unknown";
    if (finalPlatform !== "unknown") hint.platform = finalPlatform;
    const accountId = finalUrl ? extractAccountIdFromUrl(finalUrl) : "";
    if (accountId && !hint.accountId) hint.accountId = accountId;
    const workId = finalUrl ? extractWorkIdFromUrl(finalUrl) : "";
    if (workId && !hint.workId) hint.workId = workId;
    if (finalUrl) hint.evidence.push(`final_url:${finalUrl}`);
    if (page.title) hint.evidence.push(`page_title:${page.title}`);
    if (page.description) hint.evidence.push(`page_description:${page.description}`);
    if (page.status === "fetched" && hint.confidence !== "high") hint.confidence = "high";
  }

  const accountId = extractIdFromText(sourceText);
  if (accountId && !hints.some((item) => item.accountId === accountId)) {
    const browserPlatform = input.activeWindow?.browserContext?.platform || "unknown";
    const platform = textPlatform !== "unknown" ? textPlatform : browserPlatform;
    hints.push({
      platform,
      accountId,
      pageKind: "profile",
      sourceType: "account_id_hint",
      confidence: platform !== "unknown" ? "medium" : "low",
      evidence: [`account_id:${accountId}`]
    });
  }

  if (textPlatform !== "unknown" && !hints.some((item) => item.platform === textPlatform)) {
    hints.push({
      platform: textPlatform,
      pageKind: "unknown",
      sourceType: "account_id_hint",
      confidence: "low",
      evidence: [`platform_keyword:${textPlatform}`]
    });
  }

  const browser = input.activeWindow?.browserContext;
  if (browser?.isBrowser && browser.platform !== "unknown") {
    hints.push({
      platform: browser.platform,
      pageKind: browser.pageKind,
      sourceType: "browser_title_inference",
      confidence: browser.confidence,
      evidence: browser.evidence
    });
  }

  const status: PlatformConnectorStatus = hints.some((item) => item.confidence === "high")
    ? "resolved"
    : hints.length
      ? "partial"
      : "unsupported";

  return {
    status,
    provider: "connector_v1",
    hints,
    fetchedPages,
    visibleMetrics,
    summary: hints.length
      ? `platform_hints=${hints.length}, status=${status}${visibleMetrics ? ", visible_metrics=available" : ""}${fetchedPages.some((item) => item.status === "fetched") ? ", link_metadata=fetched" : ""}`
      : "No platform URL, account id or browser platform hint was found.",
    nextStep:
      "Public links are fetched only for page metadata. Real video frames, comments and reliable metrics require user-authorized recording, exported creator-center data, manual metric backfill, or a browser DOM bridge."
  };
}
