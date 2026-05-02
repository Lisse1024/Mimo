import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import CharacterAvatar from "./CharacterAvatar";
import {
  backend,
  chatWithPet,
  capturePrimaryScreen,
  clearKocMemory,
  createDailyBriefing,
  diagnoseKocGrowth,
  getKocJob,
  getKocMemory,
  getObserverContext,
  getSettings,
  getTodayEvents,
  reviewKocMemory,
  setObserverMode,
  showSettingsWindow,
  startCurrentVideoRecording,
  stopCurrentVideoRecording
} from "./lib/api";
import { notify } from "./lib/notifications";
import type {
  AppSettings,
  AgentFollowupItem,
  AgentTraceStep,
  CalendarEventSummary,
  ChatListItem,
  ChatMessage,
  ChatScheduleItem,
  ChatWeatherCard,
  DailyBriefing,
  EvidenceSummaryItem,
  KocDiagnosisReply,
  KocExperimentResult,
  KocMemoryReply,
  KocUploadAsset,
  ObserverContext,
  PetMood
} from "./lib/types";

const appWindow = getCurrentWindow();
const COUNTDOWN_STORAGE_KEY = "桌面助手.countdowns.v1";
const COMPLETED_EVENTS_STORAGE_KEY = "桌面助手.completed-events.v1";
const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 286;
const WINDOW_SAFE_MARGIN = 12;
const INACTIVE_SLEEPY_AFTER_MS = 35_000;
const INACTIVE_SLEEP_AFTER_MS = 75_000;

const defaultSettings: AppSettings = {
  userName: "朋友",
  petName: "桌面助手",
  newsCategory: "technology",
  newsCountry: "cn",
  tone: "gentle",
  avatarLive2DModelUrl: "/live2d/shizuku/shizuku.model3.json"
};

const emptyBriefing: DailyBriefing = {
  greeting: "",
  scheduleFocus: [],
  newsHighlights: [],
  suggestedActions: [],
  digest: ""
};

interface KocAgentPanel {
  phase: "idle" | "running" | "waiting" | "ready" | "error";
  phaseLabel: string;
  confidenceLabel: string;
  observation: string[];
  evidence: string[];
  loop: string[];
  nextActions: string[];
  memory: string;
}

interface CountdownTask {
  id: string;
  label: string;
  remindText?: string;
  totalMs: number;
  endAt: number;
  createdAt: number;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function minutesUntil(start: string) {
  const delta = new Date(start).getTime() - Date.now();
  return Math.round(delta / 60000);
}

function isSettingsCommand(input: string) {
  return /设置|外观|形象|角色/.test(input);
}

function isConnectCalendarCommand(input: string) {
  return false;
}

function isBriefingCommand(input: string) {
  return false;
}

function isKocCommand(input: string) {
  return /(KOC|涨粉|诊断|拆解|账号诊断|主页诊断|分析账号|分析主页|爆款|播放量|收藏|互动|视频分析|抖音|小红书|哔哩哔哩|快手|作品链接|主页链接|当前视频|当前页面|https?:\/\/)/i.test(
    input
  );
}

function isKocReviewCommand(input: string) {
  return /(复盘|回填|发布后|数据|效果|表现).*(播放|点赞|收藏|评论|涨粉|转粉|完播|转化)|^(复盘|回填)/.test(
    input.trim()
  );
}

function isKocMemoryCommand(input: string) {
  return /(查看|看看|读取|显示).*(KOC)?(记忆|复盘记录|长期记忆|实验记录)|^(记忆|复盘记录)$/.test(
    input.trim()
  );
}

function isKocFullMemoryCommand(input: string) {
  return /(完整|全部|详细|原始).*(记忆|复盘记录|长期记忆|实验记录)|^(完整记忆|全部记忆|详细记忆)$/.test(input.trim());
}

function isKocClearMemoryCommand(input: string) {
  return /(清空|清除|删除|重置).*(记忆|复盘记录|长期记忆|实验记录)|^(清空记忆|清除记忆|重置记忆)$/.test(input.trim());
}

function isKocJobStatusCommand(input: string) {
  return /(KOC|诊断|分析|任务|策略).*(完成|结束|好了|结果|进度|查一下|查询)|刚才那个.*(完成|结束|好了|结果|进度)/.test(
    input.trim()
  );
}

function isDemoGuideCommand(input: string) {
  return /(演示|参赛|路演|demo|Demo|DEMO|60秒|90秒|怎么展示|怎么介绍)/.test(input.trim());
}

function parseMetricValue(text: string, names: string[]) {
  for (const name of names) {
    const pattern = new RegExp(`${name}\\s*[:：]?\\s*([0-9.]+)\\s*(万|w|W|k|K)?`);
    const match = text.match(pattern);
    if (!match) continue;
    const raw = Number(match[1]);
    if (!Number.isFinite(raw)) continue;
    const unit = match[2]?.toLowerCase();
    if (unit === "万" || unit === "w") return Math.round(raw * 10000);
    if (unit === "k") return Math.round(raw * 1000);
    return Math.round(raw);
  }
  return undefined;
}

function inferReviewResult(text: string): KocExperimentResult {
  if (/(很好|不错|有效|涨了|正向|成功|明显提升|超预期)/.test(text)) return "positive";
  if (/(不好|无效|没用|失败|下降|很差|不理想|没流量)/.test(text)) return "negative";
  if (/(一般|还行|有好有坏|不确定|波动|部分有效)/.test(text)) return "mixed";
  return "unknown";
}

function parseKocReviewPayload(text: string) {
  const metrics: Record<string, number> = {};
  const views = parseMetricValue(text, ["播放", "播放量", "浏览", "浏览量", "观看"]);
  const likes = parseMetricValue(text, ["点赞", "赞"]);
  const saves = parseMetricValue(text, ["收藏", "收藏量"]);
  const comments = parseMetricValue(text, ["评论", "评论量"]);
  const follows = parseMetricValue(text, ["涨粉", "转粉", "新增粉丝", "粉丝"]);
  const completion = parseMetricValue(text, ["完播", "完播率"]);
  const shares = parseMetricValue(text, ["分享", "转发"]);
  const homepageClicks = parseMetricValue(text, ["主页点击", "主页访问", "主页浏览"]);
  const avgWatchSeconds = parseMetricValue(text, ["平均观看", "平均观看时长", "平均播放时长"]);

  if (views !== undefined) metrics.views = views;
  if (likes !== undefined) metrics.likes = likes;
  if (saves !== undefined) metrics.saves = saves;
  if (comments !== undefined) metrics.comments = comments;
  if (follows !== undefined) metrics.follows = follows;
  if (completion !== undefined) metrics.completionRate = completion;
  if (shares !== undefined) metrics.shares = shares;
  if (homepageClicks !== undefined) metrics.homepageClicks = homepageClicks;
  if (avgWatchSeconds !== undefined) metrics.avgWatchSeconds = avgWatchSeconds;

  return {
    metrics,
    result: inferReviewResult(text),
    conclusion: text.replace(/^(复盘|回填|数据)[:：\s]*/g, "").trim()
  };
}

function extractUrlsFromText(text: string) {
  return Array.from(new Set(Array.from(text.matchAll(/https?:\/\/[^\s，。)）]+/g)).map((match) => match[0])));
}

async function readClipboardText() {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return "";
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    return "";
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function translateInternalIdentifier(token: string) {
  const map: Record<string, string> = {
    account_growth_diagnosis: "账号增长诊断",
    single_work_analysis: "单条作品拆解",
    browser_title_inference: "浏览器标题推断",
    account_id_hint: "账号线索",
    platform_keyword: "平台关键词",
    browser_process: "浏览器进程",
    window_title: "窗口标题",
    foreground_window: "前台窗口",
    current_video_frame: "当前视频画面",
    uploaded_video: "上传视频",
    uploaded_image: "上传图片",
    homepage_screenshot: "主页截图",
    source_type: "来源类型",
    page_kind: "页面类型",
    context_risk: "上下文风险",
    missing_evidence: "缺失证据",
    waiting_for_evidence: "等待补充证据",
    direct_evidence: "直接证据",
    inferred_claims: "推断判断",
    low_confidence_claims: "低置信判断",
    forbidden_claims: "禁止结论",
    fact_ledger: "素材事实账本",
    work_fact_ledger: "作品事实账本",
    script_steps: "建议脚本步骤",
    caption_or_voiceover: "字幕/口播",
    growth_hypothesis: "增长假设",
    test_action: "测试动作",
    validation_metrics: "验证指标",
    decision_rules: "决策规则",
    review_template: "复盘回填模板"
  };
  Object.assign(map, {
    platform_hint: "平台身份线索",
    fetched_platform_data: "平台公开页数据",
    browser_visible_metrics: "浏览器可见互动指标",
    visual_asset_analysis: "截图/视频视觉分析",
    video_timeline: "视频抽帧时间线"
  });
  const normalized = token.toLowerCase();
  if (map[normalized]) return map[normalized];
  return token
    .split("_")
    .filter(Boolean)
    .map((part) => sanitizeVisibleText(part))
    .join(" / ");
}

function sanitizeVisibleText(value: unknown) {
  let text = typeof value === "string" ? value : value == null ? "" : String(value);
  const replacements: Array<[RegExp, string]> = [
    [/\bKOC\b/g, "达人增长"],
    [/\bAgent\b/g, "智能体"],
    [/\bLangGraph\b/g, "智能体流程"],
    [/\bDeskMate\b/g, "桌面助手"],
    [/\bLive2D\b/g, "动态形象"],
    [/\bDemo\b/g, "演示"],
    [/\bEdge\b/g, "微软浏览器"],
    [/\bChrome\b/g, "谷歌浏览器"],
    [/\bFirefox\b/g, "火狐浏览器"],
    [/\bSafari\b/g, "苹果浏览器"],
    [/\btrace\b/gi, "执行轨迹"],
    [/\bConsole\b/g, "控制台"],
    [/\bstatus\b/gi, "状态"],
    [/\bjob\b/gi, "任务"],
    [/\bprofile\b/gi, "档案"],
    [/\bplatform\b/gi, "平台"],
    [/\baccount\b/gi, "账号"],
    [/\bwork\b/gi, "作品"],
    [/\bvideo\b/gi, "视频"],
    [/\bevidence\b/gi, "证据"],
    [/\bmemory\b/gi, "记忆"],
    [/\btool\b/gi, "工具"],
    [/\binput\b/gi, "输入"],
    [/\boutput\b/gi, "输出"],
    [/\bconfidence\b/gi, "置信度"],
    [/\bsource[_\s-]?type\b/gi, "来源类型"],
    [/\bunknown\b/gi, "未知"],
    [/\bsuccess\b/gi, "成功"],
    [/\bfailed\b/gi, "失败"],
    [/\brunning\b/gi, "执行中"],
    [/\bcompleted\b/gi, "已完成"],
    [/\bdegraded\b/gi, "降级完成"],
    [/\bskipped\b/gi, "已跳过"],
    [/\bpending\b/gi, "等待中"],
    [/\bplanned\b/gi, "已计划"],
    [/\bdone\b/gi, "完成"],
    [/\blow\b/gi, "低"],
    [/\bmedium\b/gi, "中"],
    [/\bhigh\b/gi, "高"],
    [/\bJSON\b/g, "结构化数据"],
    [/\bAPI\b/g, "接口"],
    [/\bHTTP\s*\d*/gi, "网络请求"],
    [/\bURL\b/g, "链接"],
    [/\bbrowser[_\s-]?bridge\b/gi, "浏览器桥接"],
    [/\bpublic[_\s-]?page[_\s-]?metadata\b/gi, "公开页面信息"],
    [/\bmodel[_\s-]?inference\b/gi, "模型推断"],
    [/\bvisual[_\s-]?observation\b/gi, "视觉观察"],
    [/\bmedia\.analyze[_\s-]?uploaded[_\s-]?assets\b/gi, "素材分析"],
    [/\bmedia\.build[_\s-]?work[_\s-]?understanding\b/gi, "作品理解"],
    [/\bkoc\.job[_\s-]?polling\b/gi, "轮询分析结果"],
    [/\bkoc\.strategy[_\s-]?job\b/gi, "策略分析任务"],
    [/\bkoc\.profile[_\s-]?writer\b/gi, "建立账号档案"],
    [/\bdesktop\.window[_\s-]?observer\b/gi, "观察当前窗口"],
    [/No uploaded media to process\./gi, "本轮没有上传媒体文件，已改用文字和页面线索分析。"],
    [/No uploaded video asset was available for timeline analysis\./gi, "本轮没有上传完整视频，时间线判断仅基于文本或截图线索。"],
    [/Public links are fetched only for page metadata\./gi, "公开链接只用于页面线索，不替代后台数据。"],
    [/Real video frames, comments and reliable metrics still require official data, authorized export, or a browser DOM bridge\./gi, "完整画面、评论和可靠指标仍需要授权数据、导出截图或浏览器桥接。"]
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\b[a-z]+(?:_[a-z0-9]+){1,}\b/gi, (token) => translateInternalIdentifier(token));
  return text;
}

function sanitizeTraceSteps(trace: AgentTraceStep[] = []) {
  return trace.map((step) => ({
    ...step,
    tool: translateTraceTool(step.tool),
    input: sanitizeVisibleText(step.input),
    output: step.output ? sanitizeVisibleText(step.output) : undefined,
    evidence: step.evidence
      ?.map((item) => sanitizeVisibleText(item))
      .filter((item) => item && !/^20\d{2}-\d{2}-\d{2}T/.test(item) && item !== "内部字段")
      .slice(0, 4)
  }));
}

function formatKocRuntimeContext(context: ObserverContext, message = "", assets: KocUploadAsset[] = []) {
  const active = context.activeWindow;
  const urls = extractUrlsFromText(message);
  return [
    `当前窗口进程：${active.processName || "未知"}`,
    `当前窗口标题：${active.title || "未读取到标题"}`,
    `截图能力：${context.capture.available ? "可用" : "暂未启用"}`,
    urls.length ? `用户提供链接：${urls.join("、")}` : "",
    assets.length
      ? `用户已上传素材：${assets
          .map((item) => `${item.name}（${item.mime || "unknown"}，${Math.ceil(item.size / 1024)}KB）`)
          .join("、")}`
      : ""
  ].join("\n");
}

function detectKocPlatformFromWindow(context: ObserverContext | null) {
  if (!context) return "";
  const text = `${context.activeWindow.processName || ""} ${context.activeWindow.title || ""}`.toLowerCase();
  if (/douyin|抖音/.test(text)) return "抖音";
  if (/xiaohongshu|xhs|小红书|rednote/.test(text)) return "小红书";
  if (/bilibili|哔哩哔哩|哔哩/.test(text)) return "哔哩哔哩";
  if (/kuaishou|快手/.test(text)) return "快手";
  if (/weibo|微博/.test(text)) return "微博";
  return "";
}

function detectObservedScene(context: ObserverContext | null, message = "") {
  if (!context) return "unknown";
  const browserKind = context.activeWindow.browserContext?.pageKind;
  if (browserKind === "profile" || browserKind === "video" || browserKind === "feed") return browserKind;
  const text = `${context.activeWindow.processName || ""} ${context.activeWindow.title || ""} ${message}`.toLowerCase();
  if (/(主页|首页|个人主页|profile|user\/|博主|账号页)/.test(text)) return "profile";
  if (/(作品|视频|播放|reel|watch|video|post|详情|播放页|当前视频)/.test(text)) return "video";
  if (/(推荐|首页信息流|for you|feed|discover|发现)/.test(text)) return "feed";
  return "unknown";
}

function sceneLabel(scene: "video" | "profile" | "feed" | "unknown") {
  if (scene === "video") return "作品/视频页";
  if (scene === "profile") return "主页";
  if (scene === "feed") return "信息流";
  return "未识别";
}

function hasSubstantialSingleWorkBrief(message = "") {
  const text = message.trim();
  if (text.length < 40) return false;
  if (!/(KOC|抖音|小红书|哔哩哔哩|快手|视频|作品|账号|达人)/i.test(text)) return false;

  const signals = [
    /单条作品|作品拆解|分析这条|这条.*视频|这条.*作品/,
    /标题|文案|主题|选题/,
    /前\s*\d+\s*秒|开头|前三秒|前 3 秒/,
    /镜头|画面|中段|结尾|转场/,
    /收藏|完播|复刻|互动|转粉|涨粉/,
    /下一条|可直接拍|脚本|拍摄/
  ];
  return signals.filter((pattern) => pattern.test(text)).length >= 3;
}

function assessKocReadiness(context: ObserverContext | null, message = "", assets: KocUploadAsset[] = []) {
  const hasTextWorkBrief = hasSubstantialSingleWorkBrief(message);

  if (!context) {
    if (hasTextWorkBrief) {
      return {
        ready: true,
        level: "medium",
        summary: "当前已有完整的单条作品文字素材，可以先做作品拆解；如补充截图或原视频会提高置信度。"
      };
    }
    return {
      ready: false,
      level: "low",
      summary: "尚未读取到当前平台页面，请先开启观察模式、粘贴作品链接或上传素材。"
    };
  }
  const urls = extractUrlsFromText(message);
  const platform = detectKocPlatformFromWindow(context);
  const hasUsefulWindow =
    Boolean(platform) ||
    /(douyin|抖音|xiaohongshu|小红书|bilibili|哔哩哔哩|kuaishou|快手|weibo|微博)/i.test(
      `${context.activeWindow.processName || ""} ${context.activeWindow.title || ""}`
    );
  const hasVisualAsset = assets.some((item) => /^image\/|^video\//.test(item.mime || ""));
  const evidenceCount =
    Number(urls.length > 0) + Number(hasUsefulWindow) + Number(hasVisualAsset) + Number(hasTextWorkBrief);

  if (hasVisualAsset && evidenceCount >= 2) {
    return {
      ready: true,
      level: "high",
      summary: "当前已有平台上下文和视觉素材，可以做较高置信度诊断。"
    };
  }

  if (hasTextWorkBrief) {
    return {
      ready: true,
      level: evidenceCount >= 2 ? "high" : "medium",
      summary: "当前已有完整的单条作品文字素材，可以进入作品拆解；补充原视频或截图后判断会更稳。"
    };
  }

  if (urls.length || hasVisualAsset || hasUsefulWindow) {
    return {
      ready: true,
      level: "medium",
      summary: "当前已有部分线索，可以先做中等置信度判断；如补充截图或作品链接会更准。"
    };
  }

  return {
    ready: false,
    level: "low",
    summary: "当前缺少主页/作品链接、平台窗口或截图素材，不适合直接生成诊断。"
  };
}

function summarizeTraceHeadline(trace: AgentTraceStep[] = []) {
  if (!trace.length) return "";
  const running = trace.find((item) => item.status === "running");
  if (running) return `正在执行 ${translateTraceTool(running.tool)}`;
  const failed = [...trace].reverse().find((item) => item.status === "failed");
  if (failed) return `${translateTraceTool(failed.tool)}执行失败`;
  const degraded = [...trace].reverse().find((item) => item.status === "degraded");
  if (degraded) return `${translateTraceTool(degraded.tool)}已降级完成`;
  const done = trace.filter((item) => item.status === "done").length;
  return done ? `已完成 ${done} 个工具步骤` : "";
}

function buildKocAgentPanel(input: {
  context: ObserverContext | null;
  draftMessage?: string;
  assets?: KocUploadAsset[];
  memorySummary?: string;
  trace?: AgentTraceStep[];
  phase?: "idle" | "running" | "waiting" | "ready" | "error";
  note?: string;
}) {
  const { context, draftMessage = "", assets = [], memorySummary = "", trace = [], phase = "idle", note = "" } = input;
  const platform = context ? detectKocPlatformFromWindow(context) : "";
  const scene = context ? sceneLabel(detectObservedScene(context, draftMessage)) : "未识别";
  const readiness = context ? assessKocReadiness(context, draftMessage, assets) : null;
  const browser = context?.activeWindow.browserContext;

  const phaseLabelMap = {
    idle: "待命中",
    running: "正在整理证据并创建诊断任务",
    waiting: "策略任务在后台继续执行",
    ready: "已形成可执行判断",
    error: "本轮处理受阻"
  } as const;

  const confidenceLabel =
    readiness?.level === "high" ? "高可信" : readiness?.level === "medium" ? "中可信" : "低可信";

  const observation = [
    context?.activeWindow?.title ? `当前窗口：${context.activeWindow.title}` : "当前窗口：未读取到",
    `观察平台：${platform || browser?.platform || "未识别"}`,
    `页面类型：${scene}`,
    `待分析素材：${assets.length} 个`
  ];

  const evidence = [
    browser ? `浏览器线索：${browser.browser} / ${browser.platform} / ${browser.pageKind} / ${browser.confidence}` : "浏览器线索：暂无",
    readiness ? `准备度：${readiness.level}，${readiness.summary}` : "准备度：等待上下文",
    summarizeTraceHeadline(trace) || "",
    note || ""
  ].filter(Boolean);

  const loop = [
    context ? `观察：已读取前台窗口${platform ? `和 ${platform} 平台线索` : ""}` : "观察：等待前台平台页面",
    assets.length ? `取证：已收集 ${assets.length} 个截图/视频/链接素材` : "取证：等待截图、录屏、链接或上传素材",
    trace.length ? `推理：${getTraceSummary(trace)}` : "推理：准备进入证据快照、风险判断和策略生成",
    phase === "ready" ? "行动：已输出可执行建议，可进入发布/回填" : "行动：等待诊断任务完成后给出优先动作",
    memorySummary ? "复盘：会把实验结果写回长期记忆" : "复盘：发布后回填播放、互动和转粉数据，形成下一轮依据"
  ];

  const nextActions =
    phase === "running"
      ? ["等待本轮任务完成", "如有主页截图或作品链接，可以继续补充给我", "我会把新增证据并入同一次判断"]
      : phase === "waiting"
        ? ["继续等待后台策略任务", "优先补一张主页截图或一条作品链接", "完成后我会用同一条链路更新结论"]
        : phase === "error"
          ? ["先确认后端服务正常运行", "补充主页截图、作品链接或视频样本后重试", "尽量缩短单次上传视频长度"]
          : phase === "ready"
            ? ["继续追问当前最卡的问题", "选择一条建议立刻执行", "发布后把播放、点赞、收藏和涨粉数据回填给我"]
            : ["先打开目标平台主页或作品页", "补充主页截图、作品链接或短视频样本", "再发起账号诊断或当前视频拆解"];

  return {
    phase,
    phaseLabel: phaseLabelMap[phase],
    confidenceLabel,
    observation,
    evidence,
    loop,
    nextActions,
    memory:
      memorySummary ||
      "还没有长期记忆。我会从这次诊断开始记录你的问题、判断、任务和复盘结果。"
  } satisfies KocAgentPanel;
}

function getPanelPhaseLabel(phase: KocAgentPanel["phase"]) {
  if (phase === "running") return "处理中";
  if (phase === "waiting") return "后台运行";
  if (phase === "ready") return "已形成判断";
  if (phase === "error") return "需处理";
  return "待补充资料";
}

function getConfidenceLabel(level?: string) {
  if (level === "high") return "高可信";
  if (level === "medium") return "中可信";
  return "低可信";
}

function translateBrowserName(value?: string) {
  const text = (value || "").toLowerCase();
  if (text.includes("edge")) return "微软浏览器";
  if (text.includes("chrome")) return "谷歌浏览器";
  if (text.includes("firefox")) return "火狐浏览器";
  if (text.includes("safari")) return "苹果浏览器";
  if (text.includes("browser")) return "浏览器";
  return "未知浏览器";
}

function translatePlatformName(value?: string) {
  const text = (value || "").toLowerCase();
  if (text.includes("douyin")) return "抖音";
  if (text.includes("xiaohongshu") || text.includes("rednote") || text.includes("xhs")) return "小红书";
  if (text.includes("bilibili")) return "哔哩哔哩";
  if (text.includes("kuaishou")) return "快手";
  if (text.includes("weibo")) return "微博";
  if (text === "unknown" || !text) return "未识别平台";
  return value || "未识别平台";
}

function translatePageKind(value?: string) {
  if (value === "profile") return "主页";
  if (value === "video") return "作品页";
  if (value === "feed") return "推荐流";
  if (value === "search") return "搜索页";
  return "未识别页面类型";
}

function translateConfidence(value?: string) {
  if (value === "high") return "高可信";
  if (value === "medium") return "中可信";
  if (value === "low") return "低可信";
  return "未知可信度";
}

function translateTraceStatus(value: string) {
  if (value === "planned") return "计划中";
  if (value === "running") return "执行中";
  if (value === "done") return "完成";
  if (value === "failed") return "失败";
  if (value === "degraded") return "降级完成";
  if (value === "skipped") return "跳过";
  return sanitizeVisibleText(value);
}

function translateTraceTool(value: string) {
  const map: Record<string, string> = {
    "python_backend": "检查后端",
    "desktop.window_observer": "观察当前窗口",
    "koc.intake_normalizer": "整理用户资料",
    "platform.connector_v1": "解析平台线索",
    "platform.resolve_identity": "确认平台身份",
    "media.cache_and_frame_sampler": "缓存素材/抽取画面",
    "media.process_uploaded_assets": "处理上传素材",
    "media.analyze_uploaded_assets": "分析素材",
    "media.build_work_understanding": "建立作品理解",
    "media.vision_asset_adapter": "准备视觉素材",
    "memory.long_term_koc_profile": "读取长期记忆",
    "koc.profile_writer": "建立账号档案",
    "koc.strategy_job": "创建分析任务",
    "koc.job_polling": "轮询分析结果",
    "demo.entrypoint": "准备演示入口",
    "agent.observe_context": "观察页面上下文",
    "koc.diagnosis_chain": "执行诊断链路",
    "memory.review_loop": "写入复盘记忆",
    "ProfileMemory.write": "写入增长档案",
    "PlatformProfileResolver.resolve": "解析平台身份",
    "LinkIntake.parse": "解析链接",
    "VisionAnalyzer.inspect": "检查视觉素材",
    "BenchmarkReasoner.compare": "对标拆解",
    "StrategyPlanner.generate": "生成策略"
  };
  if (map[value]) return map[value];
  if (value.startsWith("langgraph.")) {
    const key = value.replace(/^langgraph\./, "");
    const langGraphMap: Record<string, string> = {
      received: "接收资料",
      load_profile: "读取账号资料",
      platform_identity: "解析平台线索",
      resolve_platform_identity: "解析平台线索",
      asset_analysis: "分析素材",
      analyze_assets: "分析素材",
      evidence_collection: "生成证据快照",
      collect_evidence_snapshot: "生成证据快照",
      decision_gate: "路由决策",
      plan_evidence_repair: "规划补证据",
      evidence_repair_plan: "规划补证据",
      evidence_request: "等待补充证据",
      build_internal_reports: "生成内部诊断",
      build_hot_video_analysis: "生成对标分析",
      strategy_bundle: "生成策略",
      generate_strategy_bundle: "生成策略",
      rule_based_strategy: "生成规则策略",
      model_strategy: "生成模型策略",
      build_evidence_and_followups: "整理证据和跟进",
      persist_workspace: "写入工作空间",
      finalize: "收拢结果",
      finalize_job: "完成任务",
      fail_job: "记录失败"
    };
    return langGraphMap[key] || sanitizeVisibleText(key.replace(/_/g, " "));
  }
  return sanitizeVisibleText(value.replace(/_/g, " "));
}

function summarizeMemoryForPanel(memorySummary = "") {
  const text = memorySummary.trim();
  if (!text || /No long-term KOC memory|暂无可复用 KOC 记忆/i.test(text)) {
    return "暂无历史复盘。本轮诊断完成后，我会记录关键判断、执行动作和复盘结果。";
  }

  const runCount = text.match(/长期记忆：\s*(\d+)/)?.[1] || text.match(/Long-term memory:\s*(\d+)/i)?.[1] || "0";
  const experimentCount = text.match(/(\d+)\s*个可复盘实验/)?.[1] || text.match(/Experiments:\s*(\d+)/i)?.[1] || "0";
  const lastStatus = text.match(/最近一轮：\s*([^；\n。]+)/)?.[1]?.trim() || text.match(/Last run status:\s*([^,。]+)/i)?.[1]?.trim();
  const openQuestion = text.match(/待验证：\s*(.+)$/m)?.[1]?.trim() || text.match(/Open questions:\s*(.+)$/i)?.[1]?.trim();
  return sanitizeVisibleText([
    `已沉淀 ${runCount} 轮诊断、${experimentCount} 个增长实验。`,
    lastStatus ? `最近一轮：${sanitizeVisibleText(lastStatus)}。` : "",
    openQuestion ? `待验证：${sanitizeVisibleText(openQuestion).slice(0, 56)}${openQuestion.length > 56 ? "..." : ""}` : ""
  ]
    .filter(Boolean)
    .join(" "));
}

function memoryPanelSummary(reply: Pick<KocMemoryReply, "summary" | "agenda" | "quality"> | null | undefined) {
  if (!reply) return "";
  const lines = [reply.summary || ""];
  if (reply.agenda?.summary) lines.push(`行动议程：${reply.agenda.summary}`);
  if (reply.quality?.risks?.length) lines.push(`需关注：${reply.quality.risks.slice(0, 2).join("；")}`);
  return lines.filter(Boolean).join("\n");
}

function getTraceSummary(trace: AgentTraceStep[] = []) {
  const running = trace.find((step) => step.status === "running");
  if (running) return `正在执行：${translateTraceTool(running.tool)}`;
  const failed = [...trace].reverse().find((step) => step.status === "failed");
  if (failed) return `执行受阻：${translateTraceTool(failed.tool)}`;
  const degraded = trace.filter((step) => step.status === "degraded").length;
  const done = trace.filter((step) => step.status === "done").length;
  if (done || degraded) return degraded ? `完成 ${done + degraded} 步，${degraded} 项需补证据` : `完成 ${done} 步`;
  return "等待任务开始";
}

function translateEvidenceStatus(status: string) {
  if (status === "available") return "可用";
  if (status === "degraded") return "降级";
  if (status === "missing") return "缺失";
  return sanitizeVisibleText(status || "未知");
}

function summarizeEvidenceRisk(items: EvidenceSummaryItem[] = []) {
  if (!items.length) return "暂无结构化证据摘要";
  const missing = items.filter((item) => item.status === "missing").length;
  const degraded = items.filter((item) => item.status === "degraded").length;
  const low = items.filter((item) => item.confidence === "low").length;
  if (missing || degraded || low) return `风险提示：${missing} 项缺失，${degraded} 项降级，${low} 项低置信`;
  return "证据状态较完整";
}

function getObservedSceneLabel(context: ObserverContext | null, draftMessage = "") {
  const scene = context ? detectObservedScene(context, draftMessage) : "unknown";
  if (scene === "video") return "作品页";
  if (scene === "profile") return "主页";
  if (scene === "feed") return "推荐流";
  return "未识别页面类型";
}

function getPanelNextActions(phase: KocAgentPanel["phase"]) {
  if (phase === "running") return ["等待本轮任务完成", "可以继续补充主页截图或作品链接", "新增资料会并入同一轮判断"];
  if (phase === "waiting") return ["等待最终结论返回", "补充截图/链接会提高可信度", "可先展开过程摘要查看进度"];
  if (phase === "error") return ["检查达人增长后端和桌宠服务是否在线", "换用较小的视频或截图重新提交", "也可以只提供作品链接先低置信分析"];
  if (phase === "ready") return ["追问最卡的问题", "选择一条建议执行", "发布后回填播放、点赞、收藏、评论和涨粉数据"];
  return ["刷到视频时点“分析当前视频”", "看账号主页时点“诊断账号”", "也可以上传视频/截图或粘贴作品链接"];
}

function formatFullKocMemory(memory: unknown) {
  if (!memory || typeof memory !== "object") return "暂无完整记忆。";
  const data = memory as {
    runs?: Array<{ at?: number; status?: string; userMessage?: string; resultSummary?: string; decisionSummary?: string; evidenceGaps?: string[]; reusableLearnings?: string[] }>;
    experiments?: Array<{ hypothesis?: string; suggestedAction?: string; expectedSignal?: string; result?: string; conclusion?: string; variables?: string[]; metrics?: string[] }>;
    userPreferences?: string[];
    creatorProfiles?: Array<{ platformKey?: string; taskTypes?: string[]; contentDirections?: string[]; knownConstraints?: string[]; evidenceLevel?: string }>;
    platformAccounts?: Array<{ accountKey?: string; platformKey?: string; contentDirections?: string[]; knownConstraints?: string[]; effectivePatterns?: string[]; openQuestions?: string[]; evidenceLevel?: string }>;
    works?: Array<{ workKey?: string; accountKey?: string; platformKey?: string; decisionSummary?: string; evidenceGaps?: string[]; experimentResult?: string }>;
    evidenceLessons?: Array<{ lesson?: string; severity?: string; taskType?: string; platformKey?: string }>;
    effectivePatterns?: string[];
    ineffectivePatterns?: string[];
    openQuestions?: string[];
  };
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const experiments = Array.isArray(data.experiments) ? data.experiments : [];
  const latestRuns = runs.slice(-5).reverse();
  const latestExperiments = experiments.slice(-5).reverse();

  const preferences = Array.isArray(data.userPreferences) ? data.userPreferences : [];
  const creatorProfiles = Array.isArray(data.creatorProfiles) ? data.creatorProfiles : [];
  const platformAccounts = Array.isArray(data.platformAccounts) ? data.platformAccounts : [];
  const works = Array.isArray(data.works) ? data.works : [];
  const evidenceLessons = Array.isArray(data.evidenceLessons) ? data.evidenceLessons : [];

  return sanitizeVisibleText([
    `长期决策档案：${runs.length} 轮有效记录，${experiments.length} 个待复盘实验。`,
    preferences.length ? `用户偏好：\n${preferences.slice(-8).map((item) => `- ${item}`).join("\n")}` : "用户偏好：暂无稳定偏好记忆。",
    creatorProfiles.length
      ? `创作者画像：\n${creatorProfiles
          .slice(-3)
          .map((item) => {
            const direction = item.contentDirections?.length ? item.contentDirections.join("、") : "待确认";
            const constraints = item.knownConstraints?.length ? `；限制：${item.knownConstraints.slice(-3).join("、")}` : "";
            return `- 平台：${item.platformKey || "未知"}；方向：${direction}；证据等级：${translateConfidence(item.evidenceLevel)}${constraints}`;
          })
          .join("\n")}`
      : "创作者画像：还没有足够完成记录沉淀画像。",
    platformAccounts.length
      ? `平台账号档案：\n${platformAccounts
          .slice(-5)
          .map((item) => `- ${item.platformKey || "未知平台"} / ${item.accountKey || "未知账号"}：方向 ${item.contentDirections?.join("、") || "待确认"}；证据 ${translateConfidence(item.evidenceLevel)}；待验证 ${item.openQuestions?.slice(-2).join("、") || "暂无"}`)
          .join("\n")}`
      : "平台账号档案：暂无。下一次完成账号/作品分析后会按平台和账号分别沉淀。",
    works.length
      ? `作品记录：\n${works
          .slice(-5)
          .map((item) => `- ${item.platformKey || "未知平台"} / ${item.workKey || "未知作品"}：${item.decisionSummary || "暂无结论"}${item.evidenceGaps?.length ? `；缺口：${item.evidenceGaps.slice(-2).join("、")}` : ""}`)
          .join("\n")}`
      : "作品记录：暂无。",
    evidenceLessons.length
      ? `证据经验：\n${evidenceLessons.slice(-6).map((item) => `- ${item.lesson || "未记录"}`).join("\n")}`
      : "证据经验：暂无。",
    latestRuns.length
      ? `最近有效诊断：\n${latestRuns
          .map((run, index) => {
            const time = run.at ? new Date(run.at).toLocaleString("zh-CN") : "未知时间";
            const gaps = run.evidenceGaps?.length ? `\n证据缺口：${run.evidenceGaps.slice(0, 3).join("；")}` : "";
            const learnings = run.reusableLearnings?.length ? `\n可复用经验：${run.reusableLearnings.slice(0, 3).join("；")}` : "";
            return `${index + 1}. ${time} / ${run.status || "未知状态"}\n问题：${run.userMessage || "未记录"}\n结论：${run.decisionSummary || run.resultSummary || "暂无结论"}${gaps}${learnings}`;
          })
          .join("\n\n")}`
      : "最近有效诊断：暂无。",
    latestExperiments.length
      ? `增长实验：\n${latestExperiments
          .map((item, index) => `${index + 1}. 假设：${item.hypothesis || "未记录"}\n动作：${item.suggestedAction || "未记录"}\n变量：${item.variables?.join("、") || "待确认"}\n指标：${item.metrics?.join("、") || item.expectedSignal || "待确认"}\n结果：${item.result || "pending"}\n复盘：${item.conclusion || "等待回填"}`)
          .join("\n\n")}`
      : "增长实验：暂无。",
    data.effectivePatterns?.length ? `有效模式：\n- ${data.effectivePatterns.slice(-5).join("\n- ")}` : "",
    data.ineffectivePatterns?.length ? `无效模式：\n- ${data.ineffectivePatterns.slice(-5).join("\n- ")}` : "",
    data.openQuestions?.length ? `待验证问题：\n- ${data.openQuestions.slice(-5).join("\n- ")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n"));
}

function isCreateCalendarCommand(input: string) {
  const text = input.replace(/\s+/g, "").replace(/：/g, ":");
  const hasCreateVerb =
    /(创建|新建|添加|新增|加入|加到|加个|加一个|写入|记到|记进|放进|安排一个)/.test(text);
  const hasCalendarWord = /(日程|日历|行程|事件|提醒)/.test(text);
  const hasTimeLike =
    /(今天|明天|后天|\d{1,2}:\d{1,2}|\d{1,2}点|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日)/.test(
      text
    );

  return hasCreateVerb && hasCalendarWord && hasTimeLike;
}

// 统计型：只回复总数/已完成/未完成，不罗列清单
function isScheduleSummaryCommand(input: string) {
  if (isCreateCalendarCommand(input)) return false;

  const text = input.trim();
  return (
    /^(今天安排|今日安排|今天什么日程|今天有什么日程|今天日程概况|今日日程概况|今天待办概况)$/.test(
      text
    ) ||
    /(今天.*(什么|有什么|哪些).*(安排|会议|日程|日历|行程|内容))/.test(text) ||
    /(今天.*(待办|日程).*(概况|统计|汇总))/.test(text)
  );
}

// 列表型：要显示具体日程，并保留已完成删除线
function isScheduleListCommand(input: string) {
  if (isCreateCalendarCommand(input)) return false;

  const text = input.trim();
  return (
    /^(今日日程|今天日程|今天日历|查看日程|看看日程|显示日程|我的日程|读取日程|列出日程|罗列日程|日程列表|查看今天日程)$/.test(
      text
    ) ||
    /((查看|看看|显示|读取|列出|罗列).*(安排|会议|日程|日历|行程))/.test(text) ||
    /((安排|会议|日程|日历|行程).*(列表|清单|详情|内容))/.test(text)
  );
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeCountdownUnit(unit: string) {
  if (unit === "秒" || unit === "秒钟") {
    return { label: "秒", ms: 1000 };
  }
  if (unit === "分钟" || unit === "分") {
    return { label: "分钟", ms: 60 * 1000 };
  }
  if (unit === "小时" || unit === "钟头") {
    return { label: "小时", ms: 60 * 60 * 1000 };
  }
  return null;
}

function cleanReminderText(text: string) {
  const normalized = text
    .trim()
    .replace(/^(要|去|帮我|让我)/, "")
    .replace(/[。！!，,]+$/g, "")
    .trim();

  return normalized || undefined;
}

function parseCountdownCommand(input: string): CountdownTask | null {
  const text = input.trim();

  const matchers: Array<RegExpMatchArray | null> = [
    text.match(
      /^(?:请)?(?:在)?(?:提醒我|告诉我|通知我|叫我)\s*(\d+)\s*(秒钟|秒|分钟|分|小时|钟头)\s*(?:后|以后)(?:\s*(.+))?$/
    ),
    text.match(
      /^(\d+)\s*(秒钟|秒|分钟|分|小时|钟头)\s*(?:后|以后)\s*(?:提醒我|告诉我|通知我|叫我)(?:\s*(.+))?$/
    ),
    text.match(/^(?:倒计时|计时)\s*(\d+)\s*(秒钟|秒|分钟|分|小时|钟头)(?:\s*(.+))?$/)
  ];

  const match = matchers.find(Boolean);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = normalizeCountdownUnit(match[2]);
  const remindText = cleanReminderText(match[3] || "");

  if (!Number.isFinite(value) || value <= 0 || !unit) return null;

  const totalMs = value * unit.ms;

  return {
    id: makeId(),
    label: `${value}${unit.label}`,
    remindText,
    totalMs,
    endAt: Date.now() + totalMs,
    createdAt: Date.now()
  };
}

function formatDuration(ms: number) {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.ceil(safeMs / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

  return parts.join("");
}

function isListCountdownCommand(input: string) {
  return /(查看|看看|列出|显示).*(倒计时|计时)|还有.*(倒计时|计时)|当前.*(倒计时|计时)/.test(input);
}

function isClearCountdownCommand(input: string) {
  return /取消全部倒计时|清空倒计时|停止全部计时|取消所有倒计时/.test(input);
}

function isTodayEvent(start: string) {
  const date = new Date(start);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function mergeCalendarEvents(
  base: CalendarEventSummary[],
  incoming: CalendarEventSummary[],
  prefer: "base" | "incoming" = "incoming"
): CalendarEventSummary[] {
  const map = new Map<string, CalendarEventSummary>();

  const write = (items: CalendarEventSummary[]) => {
    for (const item of items) {
      const key = item.id || `${item.title}-${item.start}-${item.end}`;
      map.set(key, item);
    }
  };

  if (prefer === "base") {
    write(incoming);
    write(base);
  } else {
    write(base);
    write(incoming);
  }

  return [...map.values()].sort((a, b) => {
    const ta = new Date(a.start).getTime();
    const tb = new Date(b.start).getTime();
    return ta - tb;
  });
}

function chineseNumberToInt(text: string): number | null {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };

  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);

  if (text === "十") return 10;
  if (text.length === 2 && text[0] === "十" && map[text[1]]) {
    return 10 + map[text[1]];
  }
  if (text.length === 2 && map[text[0]] && text[1] === "十") {
    return map[text[0]] * 10;
  }
  if (text.length === 3 && map[text[0]] && text[1] === "十" && map[text[2]]) {
    return map[text[0]] * 10 + map[text[2]];
  }

  return map[text] ?? null;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, "").replace(/[，。,.！!？?：:]/g, "").trim();
}

function sortEvents(events: CalendarEventSummary[]) {
  return [...events].sort((a, b) => {
    const ta = new Date(a.start).getTime();
    const tb = new Date(b.start).getTime();
    return ta - tb;
  });
}

function buildScheduleItems(
  sourceEvents: CalendarEventSummary[],
  completedEventIds: string[]
): ChatScheduleItem[] {
  const completedSet = new Set(completedEventIds);

  return sortEvents(sourceEvents).map((item, index) => ({
    id: item.id,
    index: index + 1,
    timeLabel: formatTime(item.start),
    title: item.title,
    completed: completedSet.has(item.id)
  }));
}

function isCompleteScheduleCommand(message: string) {
  return /(完成|做完|已完成|搞定|结束了|处理完了|标记完成)/.test(message);
}

function parseCompletedEventTarget(
  message: string,
  todayEvents: CalendarEventSummary[]
): CalendarEventSummary | null {
  if (!isCompleteScheduleCommand(message)) {
    return null;
  }

  const sortedEvents = sortEvents(todayEvents);
  if (!sortedEvents.length) return null;

  const ordinalMatch = message.match(/第\s*([0-9]+|[一二两三四五六七八九十]+)\s*(项|个|条)?/);
  if (ordinalMatch) {
    const value = /^\d+$/.test(ordinalMatch[1])
      ? Number(ordinalMatch[1])
      : chineseNumberToInt(ordinalMatch[1]);
    if (value && value >= 1 && value <= sortedEvents.length) {
      return sortedEvents[value - 1];
    }
  }

  const normalizedMessage = normalizeText(message);

  const matchedByTitle = sortedEvents.find((item) => {
    const title = normalizeText(item.title);
    return title && normalizedMessage.includes(title);
  });

  return matchedByTitle || null;
}

export default function PetApp() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [events, setEvents] = useState<CalendarEventSummary[]>([]);
  const [briefing, setBriefing] = useState<DailyBriefing>(emptyBriefing);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [bubbleOpen, setBubbleOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interactionMood, setInteractionMood] = useState<PetMood | null>(null);
  const [dragging, setDragging] = useState(false);
  const [petHovered, setPetHovered] = useState(false);
  const [countdowns, setCountdowns] = useState<CountdownTask[]>([]);
  const [completedEventIds, setCompletedEventIds] = useState<string[]>([]);
  const [nowTick, setNowTick] = useState(Date.now());
  const [pendingAssets, setPendingAssets] = useState<KocUploadAsset[]>([]);
  const [videoRecordingSessionId, setVideoRecordingSessionId] = useState("");
  const [observeMode, setObserveModeState] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [lastObserverContext, setLastObserverContext] = useState<ObserverContext | null>(null);
  const [kocMemorySummary, setKocMemorySummary] = useState("");
  const [agentRuntimeState, setAgentRuntimeState] = useState<{
    phase: "idle" | "running" | "waiting" | "ready" | "error";
    note: string;
    trace: AgentTraceStep[];
  }>({
    phase: "idle",
    note: "等待你提供当前平台页面、作品链接或素材。",
    trace: []
  });

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollingKocJobsRef = useRef<Set<string>>(new Set());
  const lastKocJobIdRef = useRef("");
  const lastObservedWindowRef = useRef("");
  const pointerRef = useRef<{
    x: number;
    y: number;
    screenX: number;
    screenY: number;
    startWindowX: number;
    startWindowY: number;
    dragging: boolean;
    pointerId?: number;
    frameId?: number;
    pendingX?: number;
    pendingY?: number;
  } | null>(null);
  const moodTimerRef = useRef<number | null>(null);
  const speakingTimerRef = useRef<number | null>(null);
  const countdownTimeoutsRef = useRef<Record<string, number>>({});
  const restoredCountdownsRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const syncWindowFrameRef = useRef<number | null>(null);
  const syncingWindowRef = useRef(false);
  const pendingWindowSyncRef = useRef(false);
  const lastActivityAtRef = useRef(Date.now());

  const nextEvent = useMemo<CalendarEventSummary | null>(() => null, []);

  const kocAgentPanel = useMemo(
    () =>
      buildKocAgentPanel({
        context: lastObserverContext,
        draftMessage: input,
        assets: pendingAssets,
        memorySummary: kocMemorySummary,
        phase: agentRuntimeState.phase,
        note: agentRuntimeState.note,
        trace: agentRuntimeState.trace
      }),
    [agentRuntimeState.note, agentRuntimeState.phase, agentRuntimeState.trace, input, kocMemorySummary, lastObserverContext, pendingAssets]
  );

  const getMonitorLogicalBounds = useCallback(async () => {
    try {
      const monitor = await (appWindow as any).currentMonitor();
      if (monitor) {
        const scale = monitor.scaleFactor || 1;
        return {
          x: monitor.position.x / scale,
          y: monitor.position.y / scale,
          width: monitor.size.width / scale,
          height: monitor.size.height / scale
        };
      }
    } catch (err) {
      console.warn("read current monitor failed:", err);
    }

    return {
      x: 0,
      y: 0,
      width: window.screen.availWidth || window.innerWidth || 1920,
      height: window.screen.availHeight || window.innerHeight || 1080
    };
  }, []);

  const syncWindowToContent = useCallback(async () => {
    const layout = layoutRef.current;
    if (!layout) return;

    const measuredNodes = [
      layout,
      layout.querySelector(".pet-stage"),
      layout.querySelector(".pet-avatar-wrap"),
      layout.querySelector(".avatar-live2d-shell.main"),
      layout.querySelector(".speech-bubble"),
      layout.querySelector(".pet-name-tag"),
      layout.querySelector(".pet-shadow")
    ].filter(Boolean) as HTMLElement[];

    const firstRect = measuredNodes[0].getBoundingClientRect();
    const unionRect = measuredNodes.reduce(
      (acc, node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: Math.min(acc.left, rect.left),
          top: Math.min(acc.top, rect.top),
          right: Math.max(acc.right, rect.right),
          bottom: Math.max(acc.bottom, rect.bottom)
        };
      },
      {
        left: firstRect.left,
        top: firstRect.top,
        right: firstRect.right,
        bottom: firstRect.bottom
      }
    );

    const root = layout.parentElement as HTMLElement | null;
    const rootStyle = root ? window.getComputedStyle(root) : null;
    const paddingX = rootStyle
      ? parseFloat(rootStyle.paddingLeft || "0") + parseFloat(rootStyle.paddingRight || "0")
      : 0;
    const paddingY = rootStyle
      ? parseFloat(rootStyle.paddingTop || "0") + parseFloat(rootStyle.paddingBottom || "0")
      : 0;

    const rawWidth = Math.max(
      MIN_WINDOW_WIDTH,
      Math.ceil(unionRect.right - unionRect.left + paddingX)
    );
    const rawHeight = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.ceil(unionRect.bottom - unionRect.top + paddingY)
    );

    if (!rawWidth || !rawHeight) return;

    const monitorBounds = await getMonitorLogicalBounds();
    const maxWidth = Math.max(
      MIN_WINDOW_WIDTH,
      Math.floor(monitorBounds.width - WINDOW_SAFE_MARGIN * 2)
    );
    const maxHeight = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.floor(monitorBounds.height - WINDOW_SAFE_MARGIN * 2)
    );

    const targetWidth = Math.min(rawWidth, maxWidth);
    const targetHeight = Math.min(rawHeight, maxHeight);

    if (syncingWindowRef.current) {
      pendingWindowSyncRef.current = true;
      return;
    }

    syncingWindowRef.current = true;

    try {
      const [currentPos, currentSize, scaleFactor] = await Promise.all([
        appWindow.innerPosition(),
        appWindow.innerSize(),
        appWindow.scaleFactor()
      ]);

      const currentLogicalWidth = currentSize.width / scaleFactor;
      const currentLogicalHeight = currentSize.height / scaleFactor;
      const currentLogicalX = currentPos.x / scaleFactor;
      const currentLogicalY = currentPos.y / scaleFactor;

      const deltaHeight = targetHeight - currentLogicalHeight;
      let nextX = currentLogicalX;
      let nextY = currentLogicalY - deltaHeight;

      const minX = monitorBounds.x + WINDOW_SAFE_MARGIN;
      const minY = monitorBounds.y + WINDOW_SAFE_MARGIN;
      const maxX = monitorBounds.x + monitorBounds.width - targetWidth - WINDOW_SAFE_MARGIN;
      const maxY = monitorBounds.y + monitorBounds.height - targetHeight - WINDOW_SAFE_MARGIN;

      if (Number.isFinite(maxX)) {
        nextX = Math.min(Math.max(nextX, minX), Math.max(minX, maxX));
      }
      if (Number.isFinite(maxY)) {
        nextY = Math.min(Math.max(nextY, minY), Math.max(minY, maxY));
      }

      const shouldResize =
        Math.abs(currentLogicalWidth - targetWidth) >= 1 ||
        Math.abs(currentLogicalHeight - targetHeight) >= 1;
      const shouldMove =
        Math.abs(currentLogicalX - nextX) >= 1 || Math.abs(currentLogicalY - nextY) >= 1;

      if (shouldResize) {
        await appWindow.setSize(new LogicalSize(targetWidth, targetHeight));
      }

      if (shouldMove) {
        await appWindow.setPosition(new LogicalPosition(nextX, nextY));
      }
    } catch (err) {
      console.error("sync main window size failed:", err);
    } finally {
      syncingWindowRef.current = false;

      if (pendingWindowSyncRef.current) {
        pendingWindowSyncRef.current = false;
        window.requestAnimationFrame(() => {
          void syncWindowToContent();
        });
      }
    }
  }, [getMonitorLogicalBounds]);

  const scheduleWindowSync = useCallback(() => {
    if (syncWindowFrameRef.current) {
      window.cancelAnimationFrame(syncWindowFrameRef.current);
    }

    syncWindowFrameRef.current = window.requestAnimationFrame(() => {
      syncWindowFrameRef.current = null;
      void syncWindowToContent();
    });
  }, [syncWindowToContent]);

  function scrollMessagesToBottom() {
    window.requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  function pulseMood(mood: PetMood, timeout = 1400) {
    setInteractionMood(mood);

    if (moodTimerRef.current) {
      window.clearTimeout(moodTimerRef.current);
    }

    moodTimerRef.current = window.setTimeout(() => setInteractionMood(null), timeout);
  }

  function markActivity() {
    lastActivityAtRef.current = Date.now();
    setNowTick(Date.now());
  }


  const petMood = useMemo<PetMood>(() => {
    const inactiveMs = nowTick - lastActivityAtRef.current;

    if (thinking) return "thinking";
    if (dragging) return "alert";
    if (interactionMood) return interactionMood;
    if (nextEvent && minutesUntil(nextEvent.start) <= 15 && minutesUntil(nextEvent.start) >= 0) {
      return "alert";
    }
    if (isSpeaking) return "speaking";
    if (inputFocused || petHovered) return "listening";
    if (inactiveMs >= INACTIVE_SLEEP_AFTER_MS) return "sleeping";
    if (inactiveMs >= INACTIVE_SLEEPY_AFTER_MS) return "sleepy";
    return "idle";
  }, [dragging, inputFocused, interactionMood, isSpeaking, nextEvent, nowTick, petHovered, thinking]);

  function persistCountdowns(tasks: CountdownTask[]) {
    try {
      localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(tasks));
    } catch (err) {
      console.error("persist countdowns failed:", err);
    }
  }

  function persistCompletedEventIds(ids: string[]) {
    try {
      localStorage.setItem(COMPLETED_EVENTS_STORAGE_KEY, JSON.stringify(ids));
    } catch (err) {
      console.error("persist completed events failed:", err);
    }
  }

  function setAndPersistCompletedEventIds(updater: (prev: string[]) => string[]) {
    setCompletedEventIds((prev) => {
      const next = updater(prev);
      persistCompletedEventIds(next);
      return next;
    });
  }

  async function bootstrap() {
    try {
      setLoading(true);
      const [state, memory, observer] = await Promise.all([
        getSettings(),
        getKocMemory().catch(() => null),
        getObserverContext().catch(() => null)
      ]);
      setSettings({ ...defaultSettings, ...state.settings });
      setCalendarConnected(state.calendarConnected);
      setKocMemorySummary(memoryPanelSummary(memory));
      if (observer) {
        setLastObserverContext(observer);
        setObserveModeState(observer.observer.enabled);
      }

      if (state.calendarConnected) {
        const today = await getTodayEvents();
        setEvents(today.events);
      } else {
        setEvents([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化失败");
    } finally {
      setLoading(false);
    }
  }

  async function refreshTodayEvents(preserveLocal = false) {
    const today = await getTodayEvents();

    setEvents((prev) => {
      if (!preserveLocal) return today.events;

      return mergeCalendarEvents(
        prev.filter((item) => isTodayEvent(item.start)),
        today.events,
        "base"
      );
    });

    return today.events;
  }

  function pushAssistantMessage(
    text: string,
    mood: PetMood = "speaking",
    items: ChatListItem[] = [],
    weatherCards: ChatWeatherCard[] = [],
    scheduleItems: ChatScheduleItem[] = [],
    trace: AgentTraceStep[] = [],
    evidenceSummary: EvidenceSummaryItem[] = [],
    followups: AgentFollowupItem[] = []
  ) {
    markActivity();
    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "assistant",
        text: sanitizeVisibleText(text),
        items: items.map((item) => ({ ...item, title: sanitizeVisibleText(item.title) })),
        trace: sanitizeTraceSteps(trace),
        evidenceSummary: evidenceSummary.map((item) => ({
          ...item,
          label: sanitizeVisibleText(item.label),
          summary: sanitizeVisibleText(item.summary),
          source_type: sanitizeVisibleText(item.source_type),
          next_action: item.next_action ? sanitizeVisibleText(item.next_action) : undefined
        })),
        followups: followups.map((item) => ({
          ...item,
          title: sanitizeVisibleText(item.title),
          evidence_needed: sanitizeVisibleText(item.evidence_needed),
          next_check_hint: sanitizeVisibleText(item.next_check_hint)
        })),
        weatherCards,
        scheduleItems
      }
    ]);

    setIsSpeaking(true);
    pulseMood(mood, 2200);
    setBubbleOpen(true);

    if (speakingTimerRef.current) {
      window.clearTimeout(speakingTimerRef.current);
    }

    speakingTimerRef.current = window.setTimeout(() => {
      setIsSpeaking(false);
    }, 2200);
  }

  function pushUserMessage(text: string) {
    markActivity();
    setMessages((prev) => [...prev, { id: makeId(), role: "user", text }]);
    pulseMood("listening", 800);
    setBubbleOpen(true);
  }

  function readFileAsAsset(file: File): Promise<KocUploadAsset> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl) {
          reject(new Error(`读取文件失败：${file.name}`));
          return;
        }
        resolve({
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          data_url: dataUrl,
          context: file.type?.startsWith("video/") ? "uploaded_video" : "uploaded_image",
          note: "用户通过桌宠上传的主页截图、封面图或视频样本。"
        });
      };
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function handleAssetFiles(files: FileList | null) {
    const selected = Array.from(files || []).slice(0, 6);
    if (!selected.length) return;

    try {
      const assets = await Promise.all(selected.map((file) => readFileAsAsset(file)));
      setPendingAssets((prev) => [...prev, ...assets].slice(-6));
      const summary = assets.map((item) => `${item.name}（${Math.ceil(item.size / 1024)}KB）`).join("、");
      pushAssistantMessage(
        `我已经收到了 ${assets.length} 个素材：${summary}\n\n接下来你可以直接说“诊断这个账号”或“分析这条视频”，我会把这些截图/视频一起交给 KOC 增长引擎。`,
        "happy"
      );
    } catch (err) {
      pushAssistantMessage(err instanceof Error ? err.message : "素材读取失败。", "alert");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleCaptureScreen() {
    try {
      pushAssistantMessage("我准备截取当前屏幕作为诊断素材，只会在你点击后执行，不会自动上传。", "listening");
      const asset = await capturePrimaryScreen();
      setPendingAssets((prev) => [...prev, asset].slice(-6));
      pushAssistantMessage(
        `截图已加入待分析素材：${asset.name}（${Math.ceil(asset.size / 1024)}KB）。\n你可以继续点“诊断账号”或“分析当前视频”，我会把这张截图一起交给 KOC 增长引擎。`,
        "happy"
      );
    } catch (err) {
      pushAssistantMessage(
        `这次自动截图没有成功：${err instanceof Error ? err.message : "未知错误"}\n你仍然可以用“上传素材”手动选择截图或视频。`,
        "alert"
      );
    }
  }

  async function handleCaptureAndDiagnose(kind: "account" | "video") {
    const promptMap = {
      account:
        "我正在查看一个社媒主页。请基于当前窗口、剪贴板链接和这张授权截图，判断账号定位、主页转粉问题、内容机会和最优先的下一步。",
      video:
        "我正在查看一条社媒作品。请把它当作单条推流视频分析：先看视频内容、开头钩子、脚本结构、镜头语言、剪辑节奏、字幕封面、标题标签和可复刻拍法；只有资料足够时，再补充账号定位、粉丝数和主页问题。"
    };

    const message = promptMap[kind];
    pushUserMessage(kind === "account" ? "诊断账号" : "分析当前视频");
    setError("");
    setThinking(true);
    setAgentRuntimeState({
      phase: "running",
      note: "正在截取当前页面并整理可提交给 KOC 智能体 的证据。",
      trace: []
    });
    pulseMood("thinking", 1800);

    try {
      const [context, clipboardText, screenAsset] = await Promise.all([
        getObserverContext(),
        readClipboardText(),
        capturePrimaryScreen()
      ]);
      setLastObserverContext(context);
      const clipboardUrls = extractUrlsFromText(clipboardText);
      const fullMessage = clipboardUrls.length
        ? `${message}\n\n我剪贴板里的相关链接：\n${clipboardUrls.join("\n")}`
        : message;
      const assets = [
        ...pendingAssets.map((asset) => ({
          ...asset,
          context: kind === "account" ? "homepage_screenshot" as const : asset.context
        })),
        {
          ...screenAsset,
          context: kind === "account" ? "homepage_screenshot" as const : "current_video_frame" as const
        }
      ].slice(-6);
      const readiness = assessKocReadiness(context, fullMessage, assets);
      const response = await diagnoseKocGrowth(
        fullMessage,
        `${formatKocRuntimeContext(context, fullMessage, assets)}\n诊断准备度：${readiness.level}，${readiness.summary}`,
        assets,
        kind === "account" ? "account_growth_diagnosis" : "single_work_analysis"
      );
      handleKocResponse(response);
      setPendingAssets([]);
      const memory = await getKocMemory().catch(() => null);
      if (memory?.summary) setKocMemorySummary(memoryPanelSummary(memory));
    } catch (err) {
      const text = errorMessage(err) || "未知错误";
      setError(text);
      setAgentRuntimeState({
        phase: "error",
        note: text,
        trace: []
      });
      pushAssistantMessage(
        `诊断没有完成：${text}\n你可以改用“上传素材”手动选择截图/视频，或者只发送主页/作品链接让我先低置信度判断。`,
        "alert"
      );
    } finally {
      setThinking(false);
    }
  }

  async function handleSampleCurrentVideo() {
    if (!videoRecordingSessionId) {
      pushUserMessage("开始录制当前视频");
      setError("");
      setThinking(true);
      setAgentRuntimeState({
        phase: "running",
        note: "正在录制当前视频。请播放或拖动到你希望分析的完整范围，结束时点击“停止录制并分析”。",
        trace: [
          {
            id: "record-current-video",
            tool: "media.current_video_recorder",
            status: "running",
            input: "Start user-controlled screen recording for the current video page."
          }
        ]
      });
      pulseMood("thinking", 1800);
      try {
        const context = await getObserverContext();
        setLastObserverContext(context);
        const observedScene = detectObservedScene(context);
        if (observedScene === "profile") {
          const text = "当前页面是账号主页，不是具体作品页。请先点开某一条作品再开始录制；如果你想看账号定位和主页转粉问题，请点“诊断账号”。";
          setAgentRuntimeState({ phase: "error", note: text, trace: [] });
          pushAssistantMessage(text, "alert");
          return;
        }
        try {
          await appWindow.hide();
        } catch {
          // Best effort: hiding prevents the pet window from becoming the capture target.
        }
        await wait(500);
        const sessionId = await startCurrentVideoRecording();
        try {
          await appWindow.show();
          await appWindow.setFocus();
        } catch {
          // The tray can still bring the window back if this fails.
        }
        setVideoRecordingSessionId(sessionId);
        setAgentRuntimeState({
          phase: "running",
          note: "正在录制。请让视频覆盖完整开头、主体和结尾，然后点击“停止录制并分析”。",
          trace: [
            {
              id: "record-current-video",
              tool: "media.current_video_recorder",
              status: "running",
              input: "Record until the user stops it.",
              output: `session=${sessionId}`
            }
          ]
        });
        pushAssistantMessage("已开始录制。请播放到你想分析的完整范围，完成后点“停止录制并分析”。", "speaking");
      } catch (err) {
        try {
          await appWindow.show();
          await appWindow.setFocus();
        } catch {
          // Ignore restore failures here; the tray can still show the window.
        }
        const text = errorMessage(err) || "启动录屏失败";
        setError(text);
        setAgentRuntimeState({ phase: "error", note: text, trace: [] });
        pushAssistantMessage(`录屏没有启动：${text}\n你也可以改用“上传素材”上传视频文件，或继续用截图兜底。`, "alert");
      } finally {
        setThinking(false);
      }
      return;
    }

    pushUserMessage("停止录制并分析当前视频");
    setError("");
    setThinking(true);
    setAgentRuntimeState({
      phase: "running",
      note: "正在停止录制并整理视频证据，用于分析内容类型、脚本、镜头、剪辑节奏、字幕、台词和音频线索。",
      trace: [
        {
          id: "sample-current-video",
          tool: "media.current_video_recorder",
          status: "running",
          input: "Stop user-controlled recording and submit the video for analysis."
        }
      ]
    });
    pulseMood("thinking", 1800);

    try {
      const context = await getObserverContext();
      setLastObserverContext(context);
      const observedScene = detectObservedScene(context);
      if (observedScene === "profile") {
        const text = "当前页面是账号主页，不是具体作品页。请先点开某一条作品再分析当前视频；如果你想看账号定位和主页转粉问题，请点“诊断账号”。";
        setAgentRuntimeState({
          phase: "error",
          note: text,
          trace: [
            {
              id: "sample-current-video",
              tool: "media.current_video_screen_sampler",
              status: "skipped",
              input: "Check whether the current browser page is a video page.",
              output: "Current browser page is profile, so current-video sampling was skipped."
            }
          ]
        });
        pushAssistantMessage(text, "alert");
        return;
      }
      const clipboardText = await readClipboardText();
      const clipboardUrls = extractUrlsFromText(clipboardText);
      const frames: KocUploadAsset[] = [];
      const samplingErrors: string[] = [];
      let captureMode: "recording" | "screenshots" = "screenshots";

      try {
        await appWindow.hide();
      } catch (err) {
        samplingErrors.push(`隐藏窗口失败：${errorMessage(err)}`);
      }
      await wait(450);
      try {
        try {
          const activeSessionId = videoRecordingSessionId;
          setVideoRecordingSessionId("");
          const recording = await stopCurrentVideoRecording(activeSessionId);
          frames.push({
            ...recording,
            name: recording.name || `current-video-recording-${Date.now()}.mp4`,
            context: "uploaded_video",
            note: `${recording.note || "用户授权录制的当前屏幕视频片段。"} 后端会优先基于完整片段抽帧分析，避免只靠少量截图过度猜剧情。`
          });
          try {
            const fallbackFrame = await capturePrimaryScreen();
            frames.push({
              ...fallbackFrame,
              name: `current-video-fallback-frame-${fallbackFrame.name}`,
              context: "current_video_frame",
              note: "随录屏一并采集的当前画面截图，用于录屏抽帧失败时兜底参考；正常情况下以录屏抽帧为主。"
            });
          } catch (frameErr) {
            samplingErrors.push(`兜底截图失败：${errorMessage(frameErr)}`);
          }
          captureMode = "recording";
        } catch (recordErr) {
          const text = errorMessage(recordErr) || "停止录屏失败";
          setError(text);
          setAgentRuntimeState({
            phase: "error",
            note: text,
            trace: [
              {
                id: "record-current-video",
                tool: "media.current_video_recorder",
                status: "failed",
                input: "Stop user-controlled recording and read the recorded video file.",
                output: text
              }
            ]
          });
          pushAssistantMessage(`录屏没有生成可分析的视频文件：${text}\n这次我不会自动改用截图，避免把截图分析误认为完整视频分析。你可以重新点“分析当前视频”开始录制，或用“上传素材”直接上传视频文件。`, "alert");
          return;
        }
      } finally {
        await appWindow.show();
        await appWindow.setFocus();
      }

      const message = [
        "请分析我当前刷到的这条视频。不要默认把它当成账号主页诊断，而是优先做单条推流视频分析。",
        "请从视频内容类型、可能赛道、开头钩子、脚本结构、镜头语言、剪辑节奏、字幕/封面信息、标题标签、评论区可见线索和可复刻拍法来分析。",
        "如果这是影视剧、电影解说或剧情切片，必须先判断当前帧是否存在掐头去尾、剧情上下文不足的问题；不要编造完整剧情，只能基于可见画面和字幕给低/中/高置信判断。",
        "如果只能看到截图或少量帧，请明确标注置信度；不要把单条视频内容直接当成账号长期赛道，也不要套用游戏、家居等不相关赛道。",
        "如果资料足够，再补充它可能适合怎样的账号定位和后续系列化方向。",
        clipboardUrls.length ? `剪贴板链接：\n${clipboardUrls.join("\n")}` : ""
      ].filter(Boolean).join("\n\n");

      const response = await diagnoseKocGrowth(
        message,
        `${formatKocRuntimeContext(context, message, frames)}\n分析模式：${
          captureMode === "recording"
            ? "当前刷到的视频 15 秒授权录屏；后端会抽取开头、中段、结尾关键帧，优先分析画面连续性、字幕变化和剪辑节奏。"
            : "当前刷到的视频多帧截图采样；只能作为关键帧分析，不能当作完整视频理解。"
        }采样时已临时隐藏桌宠，避免遮挡画面。目标是单条视频拆解，不是账号长期赛道定性；如为影视剧情片段，需要优先说明剧情上下文是否不足。${
          samplingErrors.length ? `\n采样说明：${samplingErrors.join("；")}` : ""
        }`,
        frames,
        "single_work_analysis"
      );
      handleKocResponse(response);
      const memory = await getKocMemory().catch(() => null);
      if (memory?.summary) setKocMemorySummary(memoryPanelSummary(memory));
    } catch (err) {
      const text = errorMessage(err) || "未知错误";
      setError(text);
      setAgentRuntimeState({
        phase: "error",
        note: text,
        trace: [
          {
            id: "sample-current-video",
            tool: "media.current_video_screen_sampler",
            status: "failed",
            input: "Capture multiple user-authorized screen frames from the current video page.",
            output: text
          }
        ]
      });
      pushAssistantMessage(
        `当前视频采样没有完成：${text}\n你也可以改用“上传素材”上传视频文件，或复制作品链接后让我分析。`,
        "alert"
      );
    } finally {
      setThinking(false);
    }
  }

  async function pollKocJob(jobId: string) {
    if (!jobId || pollingKocJobsRef.current.has(jobId)) return;
    pollingKocJobsRef.current.add(jobId);
    let latestTrace: AgentTraceStep[] = [];

    try {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 5000));
        }
        const result = await getKocJob(jobId);
        latestTrace = result.trace ?? latestTrace;
        if (result.status && !["completed", "degraded", "failed", "waiting_for_evidence"].includes(result.status)) {
          setAgentRuntimeState({
            phase: "waiting",
            note: result.reply.split("\n").find((line) => line.trim())?.trim() || `后台策略任务仍在运行，已检查 ${attempt + 1} 次。`,
            trace: latestTrace
          });
        }
        if (result.status === "completed" || result.status === "degraded" || result.status === "failed" || result.status === "waiting_for_evidence") {
          const finalNote =
            result.status === "degraded"
              ? "本轮已降级完成，结论已返回。"
              : result.status === "completed"
                ? "本轮分析已完成，结论已返回。"
                : result.status === "waiting_for_evidence"
                  ? "证据不足，已给出补充资料清单。"
                  : "任务执行失败，请查看错误信息。";
          setAgentRuntimeState({
            phase: result.ok && result.status !== "failed" ? "ready" : "error",
            note: finalNote,
            trace: latestTrace
          });
          pushAssistantMessage(
            result.reply,
            result.ok && result.status !== "failed" ? "happy" : "alert",
            result.items ?? [],
            [],
            [],
            result.trace ?? [],
            result.evidenceSummary ?? [],
            result.followups ?? []
          );
          const memory = await getKocMemory().catch(() => null);
          if (memory?.summary) setKocMemorySummary(memoryPanelSummary(memory));
          return;
        }
      }

      setAgentRuntimeState({
        phase: "waiting",
        note: "后台策略任务仍在运行，我会继续自动检查完成结果。",
        trace: latestTrace
      });
      window.setTimeout(() => {
        pollingKocJobsRef.current.delete(jobId);
        void pollKocJob(jobId);
      }, 30000);
    } catch (err) {
      setAgentRuntimeState({
        phase: "error",
        note: err instanceof Error ? err.message : "查询任务进度失败",
        trace: latestTrace
      });
      pushAssistantMessage(
        `查询 KOC 任务进度时卡住了：${err instanceof Error ? err.message : "未知错误"}`,
        "alert"
      );
    } finally {
      pollingKocJobsRef.current.delete(jobId);
    }
  }

  function handleKocResponse(response: KocDiagnosisReply) {
    if (response.jobId) {
      lastKocJobIdRef.current = response.jobId;
    }
    setAgentRuntimeState({
      phase:
        response.status && !["completed", "degraded", "failed", "waiting_for_evidence"].includes(response.status)
          ? "waiting"
          : response.ok
            ? "ready"
            : "error",
      note: response.reply.split("\n").find((line) => line.trim())?.trim() || response.reply.slice(0, 120),
      trace: response.trace ?? []
    });
    pushAssistantMessage(response.reply, response.ok ? "speaking" : "alert", response.items ?? [], [], [], response.trace ?? [], response.evidenceSummary ?? [], response.followups ?? []);
    if (response.jobId && response.status && !["completed", "degraded", "failed", "waiting_for_evidence"].includes(response.status)) {
      void pollKocJob(response.jobId);
    }
  }

  async function handleCheckLastKocJob() {
    const jobId = lastKocJobIdRef.current;
    if (!jobId) {
      pushAssistantMessage(
        "我这里还没有可查询的 KOC 后台任务。你可以先上传素材或提供作品链接，再发起一次账号诊断/视频拆解。",
        "alert"
      );
      return;
    }

    const result = await getKocJob(jobId);
    if (result.jobId) {
      lastKocJobIdRef.current = result.jobId;
    }
    setAgentRuntimeState({
      phase: result.status && !["completed", "degraded", "failed", "waiting_for_evidence"].includes(result.status)
        ? "waiting"
        : result.ok && result.status !== "failed"
          ? "ready"
          : "error",
      note: result.reply.split("\n").find((line) => line.trim())?.trim() || "已查询最近 KOC 任务。",
      trace: result.trace ?? []
    });
    pushAssistantMessage(
      result.reply || "我查了一下，最近的 KOC 任务还没有返回完整结果。",
      result.ok && result.status !== "failed" ? "speaking" : "alert",
      result.items ?? [],
      [],
      [],
      result.trace ?? [],
      result.evidenceSummary ?? [],
      result.followups ?? []
    );
    if (result.jobId && result.status && !["completed", "degraded", "failed", "waiting_for_evidence"].includes(result.status)) {
      void pollKocJob(result.jobId);
    }
  }

  async function handleReadClipboardLink() {
    const text = await readClipboardText();
    const urls = extractUrlsFromText(text);

    if (!urls.length) {
      pushAssistantMessage(
        "我没有在剪贴板里读到可用链接。你可以先复制抖音/小红书/哔哩哔哩/快手的主页或作品链接，再点一次“读取链接”。",
        "alert"
      );
      return;
    }

    const nextInput = [input.trim(), urls.join("\n")].filter(Boolean).join("\n");
    setInput(nextInput);
    pushAssistantMessage(
      `让我来看看这条链接的具体内容：${urls[0]}\n我会先在浏览器里打开它，再基于页面可见信息、截图和公开跳转结果进行分析；如果平台没有公开返回昵称、粉丝或作品列表，我会明确说明，不会用模板补空。`,
      "thinking",
      urls.map((url, index) => ({ title: `剪贴板链接 ${index + 1}`, url }))
    );
    try {
      await openUrl(urls[0]);
      await wait(3200);
      const context = await getObserverContext();
      setLastObserverContext(context);
      const screenAsset = context.capture.available ? await capturePrimaryScreen().catch(() => null) : null;
      const linkLooksLikeProfile = /更多作品|主页|个人页|share\/user|\/user\/|sec_uid/i.test(`${text}\n${urls[0]}`);
      const assets: KocUploadAsset[] = [
        ...pendingAssets,
        ...(screenAsset
          ? [
              {
                ...screenAsset,
                name: `opened-link-page-${screenAsset.name}`,
                context: linkLooksLikeProfile ? ("homepage_screenshot" as const) : ("uploaded_image" as const)
              }
            ]
          : [])
      ];
      const message = `${text}\n\n我刚刚打开了这条链接，请只基于公开跳转结果、当前页面可见内容和授权截图进行分析；看不到的信息要写“未获取到”，不要套固定模板。`;
      const response = await diagnoseKocGrowth(
        message,
        `${formatKocRuntimeContext(context, message, assets)}\n链接打开方式：用户授权后由桌面端在浏览器打开，并截取当前可见页面。`,
        assets,
        linkLooksLikeProfile ? "account_growth_diagnosis" : "single_work_analysis"
      );
      handleKocResponse(response);
      if (pendingAssets.length) setPendingAssets([]);
      return;
    } catch (err) {
      pushAssistantMessage(
        `我读到了 ${urls.length} 个链接，但自动打开或截图没有完成：${err instanceof Error ? err.message : "未知错误"}\n链接已经放进输入框，你也可以手动打开页面后点“诊断账号”或“分析当前视频”。`,
        "alert",
        urls.map((url, index) => ({ title: `剪贴板链接 ${index + 1}`, url }))
      );
      return;
    }
    pushAssistantMessage(
      `我读到了 ${urls.length} 个链接，已经放进输入框。\n如果这是你要分析的主页或作品，直接点发送；我会结合当前窗口和已上传素材一起判断。`,
      "happy",
      urls.map((url, index) => ({ title: `剪贴板链接 ${index + 1}`, url }))
    );
  }

  async function toggleObserveMode() {
    const next = !observeMode;
    try {
      const context = await setObserverMode(next);
      setObserveModeState(context.observer.enabled);
      setLastObserverContext(context);
      if (context.observer.enabled) {
        const platform = detectKocPlatformFromWindow(context);
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: "idle",
          note: platform ? `观察模式已开启，正在留意 ${platform} 页面。` : "观察模式已开启，等待你打开目标平台页面。",
          trace: prev.trace
        }));
        const platformText = platform ? `，当前像是在看${platform}` : "";
        pushAssistantMessage(
          `观察模式已开启${platformText}。\n我会留意你当前打开的平台页面；发现主页或作品页线索时，会先提醒你，再由你决定是否分析。`,
          "happy"
        );
      } else {
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: "idle",
          note: "观察模式已关闭，后续只依据你主动提交的证据分析。",
          trace: prev.trace
        }));
        pushAssistantMessage("观察模式已关闭。后续我只根据你主动上传的素材、链接和问题进行分析。", "speaking");
      }
    } catch (err) {
      pushAssistantMessage(`观察模式切换失败：${err instanceof Error ? err.message : "未知错误"}`, "alert");
    }
  }

  async function finishCountdown(task: CountdownTask, recovered = false) {
    const timerId = countdownTimeoutsRef.current[task.id];
    if (timerId) {
      window.clearTimeout(timerId);
      delete countdownTimeoutsRef.current[task.id];
    }

    setCountdowns((prev) => {
      const next = prev.filter((item) => item.id !== task.id);
      persistCountdowns(next);
      return next;
    });

    setNowTick(Date.now());

    const message = task.remindText
      ? recovered
        ? `⏰ 到时间了：${task.remindText}。\n我是重新打开后帮你补发这条提醒的。`
        : `⏰ 到时间了：${task.remindText}。`
      : recovered
      ? `⏰ ${task.label}倒计时结束了。\n我是重新打开后帮你补发这条提醒的。`
      : `⏰ ${task.label}倒计时结束了。`;

    const notifyText = task.remindText
      ? recovered
        ? `${task.remindText}（重新打开后补发提醒）`
        : task.remindText
      : recovered
      ? `${task.label}倒计时结束（重新打开后补发提醒）`
      : `${task.label}倒计时结束`;

    pushAssistantMessage(message, "alert");
    await notify("倒计时结束", notifyText);
  }

  function registerCountdownTimeout(task: CountdownTask) {
    const remain = task.endAt - Date.now();

    const oldTimerId = countdownTimeoutsRef.current[task.id];
    if (oldTimerId) {
      window.clearTimeout(oldTimerId);
    }

    if (remain <= 0) {
      void finishCountdown(task, true);
      return;
    }

    countdownTimeoutsRef.current[task.id] = window.setTimeout(() => {
      void finishCountdown(task, false);
    }, remain);
  }

  function startCountdown(task: CountdownTask) {
    setCountdowns((prev) => {
      const next = [...prev, task];
      persistCountdowns(next);
      return next;
    });

    setNowTick(Date.now());
    registerCountdownTimeout(task);
  }

  function clearAllCountdowns() {
    Object.values(countdownTimeoutsRef.current).forEach((timerId) => {
      window.clearTimeout(timerId);
    });

    countdownTimeoutsRef.current = {};
    setCountdowns([]);
    persistCountdowns([]);
  }

  function listCountdowns() {
    if (!countdowns.length) {
      pushAssistantMessage("当前没有正在进行的倒计时。", "happy");
      return;
    }

    const text = countdowns
      .map((task, index) => {
        const remain = Math.max(0, task.endAt - Date.now());
        const target = task.remindText ? `提醒：${task.remindText}` : "纯倒计时";
        return `${index + 1}. ${task.label}，${target}（剩余约 ${formatDuration(remain)}）`;
      })
      .join("\n");

    pushAssistantMessage(`当前正在进行的倒计时有：\n${text}`, "speaking");
  }

  async function handleConnectFeishu() {
    setError("");
    pushAssistantMessage(
      "飞书日历已经从当前版本里移除。现在这只桌宠会专注处理 KOC 账号诊断、作品拆解和增长建议。",
      "speaking"
    );
  }

  async function handleGenerateBriefing() {
    const response = await createDailyBriefing();
    setBriefing(response.briefing);
    setEvents(response.sources.events);

    const summaryText =
      response.briefing.digest ||
      response.briefing.newsHighlights.join("\n") ||
      "今日简报已更新。";

    const newsItems: ChatListItem[] = (response.sources?.headlines ?? [])
      .filter((item) => item?.title)
      .map((item) => ({
        title: item.title,
        url: item.url
      }));

    pushAssistantMessage(summaryText, "happy", newsItems);
    await notify("桌面助手 今日简报已更新", summaryText);
  }

  // 统计型命令：今天安排 / 今天什么日程
  async function handleShowScheduleSummary() {
    if (!calendarConnected) {
      pushAssistantMessage(
        "我这边还没连接飞书日历。\n你可以输入“连接飞书”先完成授权。",
        "alert"
      );
      return;
    }

    const localTodayEvents = events.filter((item) => isTodayEvent(item.start));
    const todayEvents = localTodayEvents.length ? localTodayEvents : await refreshTodayEvents(true);
    const scheduleItems = buildScheduleItems(todayEvents, completedEventIds);
    const total = scheduleItems.length;
    const completed = scheduleItems.filter((item) => item.completed).length;
    const pending = total - completed;

    pushAssistantMessage(
      `今天一共有 ${total} 个待办，已完成 ${completed} 个，未完成 ${pending} 个。`,
      "speaking"
    );
  }

  // 列表型命令：查看日程 / 日程列表
  async function handleShowScheduleList() {
    if (!calendarConnected) {
      pushAssistantMessage(
        "我这边还没连接飞书日历。\n你可以输入“连接飞书”先完成授权。",
        "alert"
      );
      return;
    }

    const localTodayEvents = events.filter((item) => isTodayEvent(item.start));
    const todayEvents = localTodayEvents.length ? localTodayEvents : await refreshTodayEvents(true);
    const scheduleItems = buildScheduleItems(todayEvents, completedEventIds);
    const total = scheduleItems.length;
    const completed = scheduleItems.filter((item) => item.completed).length;
    const pending = total - completed;

    if (!scheduleItems.length) {
      pushAssistantMessage("今天还没有日程安排。", "happy");
      return;
    }

    pushAssistantMessage(
      `今天一共有 ${total} 个待办，已完成 ${completed} 个，未完成 ${pending} 个。`,
      "speaking",
      [],
      [],
      scheduleItems
    );
  }

  function handleCompleteSchedule(message: string) {
    if (/(KOC|诊断|分析|账号|视频|作品|策略|任务进度|后台任务)/i.test(message)) {
      return false;
    }

    // 只有明确是“完成某项日程”时，才进入这个分支，
    // 避免误把“新建提醒 / 创建日程”之类命令吃掉。
    if (!isCompleteScheduleCommand(message)) {
      return false;
    }

    const todayEvents = events.filter((item) => isTodayEvent(item.start));

    if (!todayEvents.length) {
      pushAssistantMessage("今天还没有可以标记完成的日程。", "alert");
      return true;
    }

    const target = parseCompletedEventTarget(message, todayEvents);
    if (!target) {
      return false;
    }

    const alreadyCompleted = completedEventIds.includes(target.id);
    const nextCompletedIds = alreadyCompleted
      ? completedEventIds
      : [...completedEventIds, target.id];

    if (!alreadyCompleted) {
      setAndPersistCompletedEventIds((prev) => {
        if (prev.includes(target.id)) return prev;
        return [...prev, target.id];
      });
    }

    const scheduleItems = buildScheduleItems(todayEvents, nextCompletedIds);
    const total = scheduleItems.length;
    const completed = scheduleItems.filter((item) => item.completed).length;
    const pending = total - completed;

    pushAssistantMessage(
      alreadyCompleted
        ? `“${target.title}”之前已经标记过完成了。今天一共有 ${total} 个待办，已完成 ${completed} 个，未完成 ${pending} 个。`
        : `好的，我已经把“${target.title}”标记为已完成。今天一共有 ${total} 个待办，已完成 ${completed} 个，未完成 ${pending} 个。`,
      "happy",
      [],
      [],
      scheduleItems
    );

    return true;
  }

  async function handleKocQuickAction(kind: "page" | "account" | "video") {
    const promptMap = {
      page: "观察当前页面，如果这是抖音/小红书/哔哩哔哩/快手主页或作品页，请帮我做 KOC 账号诊断。",
      account: "我想诊断这个账号的涨粉问题，请根据当前页面上下文和我后续补充的信息给出优先动作。",
      video:
        "请把当前作品当作单条推流视频来分析，优先从视频内容、开头钩子、脚本结构、镜头语言、剪辑节奏、字幕封面、标题标签和可复刻拍法给建议。只有在资料足够时，再补充账号定位、粉丝数、主页装修等判断；不要把单条视频直接定性为账号长期赛道。"
    };
    const clipboardText = await readClipboardText();
    const clipboardUrls = extractUrlsFromText(clipboardText);
    const message = clipboardUrls.length
      ? `${promptMap[kind]}\n\n我剪贴板里的相关链接：\n${clipboardUrls.join("\n")}`
      : promptMap[kind];

    pushUserMessage(message);
    setError("");
    setThinking(true);
    setAgentRuntimeState({
      phase: "running",
      note: kind === "video" ? "正在整理当前视频上下文，准备做作品拆解。" : "正在整理账号上下文，准备发起 KOC 诊断。",
      trace: []
    });
    pulseMood("thinking", 1800);

    try {
      const context = await getObserverContext();
      setLastObserverContext(context);
      const readiness = assessKocReadiness(context, message, pendingAssets);
      if (!readiness.ready) {
        setAgentRuntimeState({
          phase: "idle",
          note: readiness.summary,
          trace: []
        });
        pushAssistantMessage(
          `${readiness.summary}\n你可以先复制主页/作品链接后点“读取链接”，也可以点“诊断账号”或“分析当前视频”让我拿到当前页面画面。`,
          "alert"
        );
        return;
      }
      const response = await diagnoseKocGrowth(
        message,
        `${formatKocRuntimeContext(context, message, pendingAssets)}\n诊断准备度：${readiness.level}，${readiness.summary}`,
        pendingAssets,
        kind === "video" ? "single_work_analysis" : "account_growth_diagnosis"
      );
      handleKocResponse(response);
      if (pendingAssets.length) {
        setPendingAssets([]);
      }
      const memory = await getKocMemory().catch(() => null);
      if (memory?.summary) setKocMemorySummary(memoryPanelSummary(memory));
    } catch (err) {
      const text = err instanceof Error ? err.message : "KOC 诊断失败";
      setError(text);
      setAgentRuntimeState({
        phase: "error",
        note: text,
        trace: []
      });
      pushAssistantMessage(`我刚才没能完成 KOC 诊断：\n${text}`, "alert");
    } finally {
      setThinking(false);
    }
  }

  function handleShowDemoGuide() {
    const guideTrace: AgentTraceStep[] = [
      {
        id: "demo-1",
        tool: "demo.entrypoint",
        status: "done",
        input: "Prepare the competition demo route.",
        output: "桌宠是唯一演示入口，旧 HTML 不参与路演。",
        evidence: ["npm run dev:desktop", "达人增长控制台"]
      },
      {
        id: "demo-2",
        tool: "agent.observe_context",
        status: "planned",
        input: "Open Douyin/Xiaohongshu/Bilibili/Kuaishou page and observe it.",
        output: "展示 智能体 能读取当前窗口、平台线索和页面类型。",
        evidence: ["观察模式", "读取链接", "诊断账号"]
      },
      {
        id: "demo-3",
        tool: "koc.diagnosis_chain",
        status: "planned",
        input: "Submit homepage screenshot, video sample or work link.",
        output: "展示账号诊断、视频拆解、后台任务、trace 和证据链。",
        evidence: ["上传素材", "诊断账号", "分析当前视频"]
      },
      {
        id: "demo-4",
        tool: "memory.review_loop",
        status: "planned",
        input: "Record post-publish metrics.",
        output: "用自然语言复盘，把结果写入长期记忆。",
        evidence: ["复盘：播放 1200，点赞 80，收藏 20，评论 6，涨粉 15"]
      }
    ];

    setAgentRuntimeState({
      phase: "ready",
      note: "参赛演示路径已准备好：观察、取证、诊断、trace、建议、复盘。",
      trace: guideTrace
    });
    pushAssistantMessage(
      [
        "可以，按这个 60-90 秒路线演示最稳：",
        "",
        "1. 打开桌宠，先展示 达人增长控制台：说明它不是聊天页，而是一个会观察、会调用工具、会记忆的桌面 智能体。",
        "2. 打开抖音/小红书/哔哩哔哩/快手主页或作品页，点“观察模式”或“读取链接”，让它判断当前平台和页面线索。",
        "3. 点“上传素材”“诊断账号”或“分析当前视频”，提交主页截图、视频样本或作品链接，发起 KOC 诊断。",
        "4. 展示 智能体 执行轨迹：平台线索解析、素材缓存、视觉资产准备、长期记忆读取、策略任务创建和轮询。",
        "5. 拿到建议后追问一个具体问题，比如“为什么收藏高但播放不高？”让它继续基于同一条证据链回答。",
        "6. 最后输入复盘数据，例如“复盘：播放 1200，点赞 80，收藏 20，评论 6，涨粉 15，效果一般”，展示长期记忆闭环。",
        "",
        "现场如果模型慢，就重点讲 Console 里的状态和 trace：它能说明自己在做什么、证据来自哪里、下一步怎么推进。"
      ].join("\n"),
      "speaking",
      [],
      [],
      [],
      guideTrace
    );
  }

  async function handleCommand(raw: string) {
    const message = raw.trim();
    if (!message) return;

    pushUserMessage(message);
    setInput("");
    setError("");
    setThinking(true);
    pulseMood("thinking", 1800);

    try {
      if (isSettingsCommand(message)) {
        await showSettingsWindow();
        pushAssistantMessage(
          "我已经把设置窗口打开了。\n你可以在那里修改称呼、语气和角色形象。",
          "happy"
        );
        return;
      }

      if (isConnectCalendarCommand(message)) {
        await handleConnectFeishu();
        return;
      }

      if (isBriefingCommand(message)) {
        await handleGenerateBriefing();
        return;
      }

      if (isDemoGuideCommand(message)) {
        handleShowDemoGuide();
        return;
      }

      if (isKocClearMemoryCommand(message)) {
        const result = await clearKocMemory();
        setKocMemorySummary(memoryPanelSummary(result));
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: "ready",
          note: "长期记忆已清空，后续会从新的诊断重新积累。",
          trace: prev.trace
        }));
        pushAssistantMessage("长期记忆已经清空。之后的账号诊断、视频拆解和复盘会重新开始记录。", "happy");
        return;
      }

      if (isKocFullMemoryCommand(message)) {
        const result = await getKocMemory();
        setKocMemorySummary(memoryPanelSummary(result));
        pushAssistantMessage(formatFullKocMemory(result.memory), "speaking");
        return;
      }

      if (isKocMemoryCommand(message)) {
        const result = await getKocMemory();
        setKocMemorySummary(memoryPanelSummary(result));
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: "ready",
          note: "已读取长期记忆摘要，可继续基于历史实验追问。",
          trace: prev.trace
        }));
        pushAssistantMessage(
          `这是我目前记住的 KOC 增长复盘：\n\n${memoryPanelSummary(result)}`,
          "speaking"
        );
        return;
      }

      if (isKocReviewCommand(message)) {
        const payload = parseKocReviewPayload(message);
        const result = await reviewKocMemory(payload);
        setKocMemorySummary(memoryPanelSummary(result));
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: "ready",
          note: "复盘结果已写入长期记忆，后续建议会引用这次结果。",
          trace: prev.trace
        }));
        const metricText = Object.keys(payload.metrics).length
          ? Object.entries(payload.metrics)
              .map(([key, value]) => `${key}: ${value}`)
              .join("，")
          : "未识别到具体指标";
        pushAssistantMessage(
          `这次复盘我已经写进长期记忆了。\n\n识别指标：${metricText}\n结果判断：${payload.result}\n\n${memoryPanelSummary(result)}`,
          "happy"
        );
        return;
      }

      if (isKocJobStatusCommand(message)) {
        await handleCheckLastKocJob();
        return;
      }

      if (pendingAssets.length || isKocCommand(message)) {
        const context = await getObserverContext();
        setLastObserverContext(context);
        const readiness = assessKocReadiness(context, message, pendingAssets);
        if (!readiness.ready) {
          setAgentRuntimeState({
            phase: "idle",
            note: readiness.summary,
            trace: []
          });
          pushAssistantMessage(
            `${readiness.summary}\n为了避免给你泛泛建议，我建议先提供一种材料：主页/作品链接、主页截图、视频样本；如果当前打开的是主页就点“诊断账号”，如果是作品页就点“分析当前视频”。`,
            "alert"
          );
          return;
        }
        setAgentRuntimeState({
          phase: "running",
          note: "正在汇总当前问题、页面线索、素材和长期记忆。",
          trace: []
        });
        const scene = detectObservedScene(context, message);
        const resultMode =
          scene === "video" || hasSubstantialSingleWorkBrief(message)
            ? "single_work_analysis"
            : "account_growth_diagnosis";
        const response = await diagnoseKocGrowth(
          message,
          `${formatKocRuntimeContext(context, message, pendingAssets)}\n诊断准备度：${readiness.level}，${readiness.summary}`,
          pendingAssets,
          resultMode
        );
        handleKocResponse(response);
        if (pendingAssets.length) {
          setPendingAssets([]);
        }
        const memory = await getKocMemory().catch(() => null);
        if (memory?.summary) setKocMemorySummary(memoryPanelSummary(memory));
        return;
      }

      const response = await chatWithPet(message);
      setCalendarConnected(response.calendarConnected);

      if (response.action === "calendar_created" && response.createdEvent) {
        if (isTodayEvent(response.createdEvent.start)) {
          setEvents((prev) => mergeCalendarEvents(prev, [response.createdEvent!], "base"));
        }
      }

      pushAssistantMessage(
        response.reply,
        response.mood,
        response.items ?? [],
        response.weatherCards ?? []
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : "处理消息失败";
      setError(text);
      pushAssistantMessage(`我刚才卡了一下：\n${text}`, "alert");
    } finally {
      setThinking(false);
    }
  }

  async function handlePetPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;

    const [currentPos, scaleFactor] = await Promise.all([
      appWindow.innerPosition(),
      appWindow.scaleFactor()
    ]);

    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      startWindowX: currentPos.x / scaleFactor,
      startWindowY: currentPos.y / scaleFactor,
      dragging: false,
      pointerId: event.pointerId
    };

    markActivity();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pulseMood("listening", 500);
  }

  async function handlePetPointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointerState = pointerRef.current;
    if (!pointerState) return;

    const dx = Math.abs(event.clientX - pointerState.x);
    const dy = Math.abs(event.clientY - pointerState.y);

    if (!pointerState.dragging && (dx > 4 || dy > 4)) {
      pointerState.dragging = true;
      setDragging(true);
      markActivity();
      pulseMood("alert", 900);
    }

    if (!pointerState.dragging) return;

    const deltaScreenX = event.screenX - pointerState.screenX;
    const deltaScreenY = event.screenY - pointerState.screenY;

    pointerState.pendingX = pointerState.startWindowX + deltaScreenX;
    pointerState.pendingY = pointerState.startWindowY + deltaScreenY;

    if (pointerState.frameId) return;

    pointerState.frameId = window.requestAnimationFrame(() => {
      const current = pointerRef.current;
      if (!current) return;

      const nextX = current.pendingX ?? current.startWindowX;
      const nextY = current.pendingY ?? current.startWindowY;
      current.frameId = undefined;

      void appWindow.setPosition(new LogicalPosition(nextX, nextY));
    });
  }

  function finishPetPointerInteraction(
    event?: PointerEvent<HTMLDivElement>,
    shouldToggleBubble = true
  ) {
    if (event && pointerRef.current?.pointerId !== undefined) {
      try {
        event.currentTarget.releasePointerCapture?.(pointerRef.current.pointerId);
      } catch {
        // 某些平台上没有 capture 也可能抛错，这里忽略即可。
      }
    }

    const wasDragging = !!pointerRef.current?.dragging;

    if (pointerRef.current?.frameId) {
      window.cancelAnimationFrame(pointerRef.current.frameId);
    }

    pointerRef.current = null;
    setDragging(false);

    if (wasDragging) {
      scheduleWindowSync();
      return;
    }

    if (shouldToggleBubble) {
      markActivity();
      setBubbleOpen((value) => !value);
      pulseMood("happy", 900);
    }
  }

  function handlePetPointerUp(event: PointerEvent<HTMLDivElement>) {
    finishPetPointerInteraction(event, true);
  }

  useEffect(() => {
    void bootstrap();

    return () => {
      if (moodTimerRef.current) {
        window.clearTimeout(moodTimerRef.current);
      }

      if (speakingTimerRef.current) {
        window.clearTimeout(speakingTimerRef.current);
      }

      Object.values(countdownTimeoutsRef.current).forEach((timerId) => {
        window.clearTimeout(timerId);
      });

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      if (syncWindowFrameRef.current) {
        window.cancelAnimationFrame(syncWindowFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (restoredCountdownsRef.current) return;
    restoredCountdownsRef.current = true;

    try {
      const rawCountdowns = localStorage.getItem(COUNTDOWN_STORAGE_KEY);
      if (rawCountdowns) {
        const parsed = JSON.parse(rawCountdowns) as CountdownTask[];
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const validFutureTasks: CountdownTask[] = [];
          const overdueTasks: CountdownTask[] = [];

          for (const item of parsed) {
            if (
              !item ||
              typeof item.id !== "string" ||
              typeof item.label !== "string" ||
              typeof item.totalMs !== "number" ||
              typeof item.endAt !== "number"
            ) {
              continue;
            }

            const normalizedTask: CountdownTask = {
              id: item.id,
              label: item.label,
              remindText:
                typeof item.remindText === "string" && item.remindText.trim()
                  ? item.remindText
                  : undefined,
              totalMs: item.totalMs,
              endAt: item.endAt,
              createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
            };

            if (normalizedTask.endAt > now) {
              validFutureTasks.push(normalizedTask);
            } else {
              overdueTasks.push(normalizedTask);
            }
          }

          if (validFutureTasks.length) {
            setCountdowns(validFutureTasks);
            persistCountdowns(validFutureTasks);

            validFutureTasks.forEach((task) => {
              registerCountdownTimeout(task);
            });
          } else {
            persistCountdowns([]);
          }

          if (overdueTasks.length) {
            persistCountdowns(validFutureTasks);

            const labels = overdueTasks
              .map((task) => (task.remindText ? task.remindText : `${task.label}倒计时`))
              .join("、");
            pushAssistantMessage(
              `⏰ 我恢复时发现这些提醒已经到时间了：${labels}。`,
              "alert"
            );
            void notify("倒计时结束", `${labels}（恢复后补发提醒）`);
          }
        }
      }

      const rawCompletedEvents = localStorage.getItem(COMPLETED_EVENTS_STORAGE_KEY);
      if (rawCompletedEvents) {
        const parsed = JSON.parse(rawCompletedEvents) as string[];
        if (Array.isArray(parsed)) {
          setCompletedEventIds(parsed.filter((item) => typeof item === "string"));
        }
      }
    } catch (err) {
      console.error("restore local state failed:", err);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void bootstrap();
    }, 60_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!observeMode) return;

    let cancelled = false;
    const checkCurrentWindow = async () => {
      try {
        const context = await getObserverContext();
        setLastObserverContext(context);
        if (cancelled || !context.observer.enabled) return;
        const platform = detectKocPlatformFromWindow(context);
        if (!platform) return;
        const scene = detectObservedScene(context);
        setAgentRuntimeState((prev) => ({
          ...prev,
          phase: prev.phase === "running" || prev.phase === "waiting" ? prev.phase : "idle",
          note: `已观察到 ${platform}${scene !== "unknown" ? sceneLabel(scene) : "相关页面"}，可以随时发起诊断或拆解。`
        }));

        const signature = `${platform}:${context.activeWindow.processName}:${context.activeWindow.title}`;
        if (lastObservedWindowRef.current === signature) return;
        lastObservedWindowRef.current = signature;
        pushAssistantMessage(
          `我注意到你正在看${platform}${scene !== "unknown" ? `的${sceneLabel(scene)}` : "相关页面"}。\n如果这是主页，可以直接点“诊断账号”；如果是作品页，可以点“分析当前视频”。这样比只看窗口标题更准。`,
          "listening"
        );
      } catch (err) {
        console.warn("observer polling failed:", err);
      }
    };

    void checkCurrentWindow();
    const timer = window.setInterval(() => {
      void checkCurrentWindow();
    }, 9000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [observeMode]);

  useEffect(() => {
    let cancelled = false;
    const seedContext = async () => {
      try {
        const context = await getObserverContext();
        if (!cancelled) {
          setLastObserverContext(context);
        }
      } catch {}
    };
    void seedContext();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bubbleOpen) return;
    scrollMessagesToBottom();
  }, [bubbleOpen, messages, countdowns, briefing, pendingAssets, observeMode]);

  useEffect(() => {
    scheduleWindowSync();
  }, [
    scheduleWindowSync,
    bubbleOpen,
    messages,
    countdowns,
    briefing,
    loading,
    error,
    input,
    pendingAssets,
    observeMode,
    lastObserverContext,
    calendarConnected,
    settings.userName,
    settings.petName,
    petHovered,
    dragging
  ]);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;

    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = new ResizeObserver(() => {
      scheduleWindowSync();
    });

    resizeObserverRef.current.observe(layout);
    scheduleWindowSync();

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [scheduleWindowSync]);

  useEffect(() => {
    return;
    if (!nextEvent) return;

    const mins = minutesUntil(nextEvent!.start);
    const key = `reminded:${nextEvent!.id}`;
    const safeNextEvent = nextEvent!;

    if (mins <= 15 && mins >= 0 && !localStorage.getItem(key)) {
      localStorage.setItem(key, "1");
      void notify("即将开始的日程", `${formatTime(safeNextEvent.start)} · ${safeNextEvent.title}`);
      pushAssistantMessage(
        `提醒一下，${formatTime(safeNextEvent.start)} 要开始“${safeNextEvent.title}”了。`,
        "alert"
      );
    }
  }, [nextEvent]);

  return (
    <div className="pet-root">
      <div
        ref={layoutRef}
        className={`pet-layout${bubbleOpen ? " bubble-open" : " bubble-closed"}`}
      >
        <div
          className="pet-stage"
          data-mood={petMood}
          onPointerDown={(event) => void handlePetPointerDown(event)}
          onPointerMove={(event) => void handlePetPointerMove(event)}
          onPointerUp={handlePetPointerUp}
          onPointerCancel={(event) => finishPetPointerInteraction(event, false)}
          onPointerLeave={() => {
            if (!dragging) pointerRef.current = null;
            setPetHovered(false);
          }}
          onMouseEnter={() => {
            setPetHovered(true);
            markActivity();
            pulseMood("listening", 600);
          }}
          onMouseLeave={() => setPetHovered(false)}
          title="按住并拖动宠物可移动窗口；轻点宠物可展开或收起气泡"
        >
          <div className="pet-drag-hitbox" />
          <div className="pet-avatar-wrap">
            <CharacterAvatar settings={settings} mood={petMood} />
          </div>
          <div className="pet-shadow" />
          <div className={`pet-name-tag${petHovered || dragging ? " visible" : ""}`}>
            {sanitizeVisibleText(settings.petName?.trim() || "桌面助手")}
          </div>
        </div>

        {bubbleOpen ? (
          <div className="speech-bubble">
            <div className="speech-messages" ref={messagesRef}>
              {loading ? <div className="tip-line">正在整理桌宠状态…</div> : null}
              {error ? <div className="tip-line error">{sanitizeVisibleText(error)}</div> : null}

              <div className={`agent-ops-card ${kocAgentPanel.phase}`}>
                <div className="agent-ops-header">
                  <div>
                    <div className="agent-ops-eyebrow">达人增长控制台</div>
                    <div className="agent-ops-title">主控增长 智能体</div>
                  </div>
                  <div className="agent-ops-badges">
                    <span className="agent-ops-badge">{getPanelPhaseLabel(kocAgentPanel.phase)}</span>
                    <span className="agent-ops-badge confidence">{getConfidenceLabel(assessKocReadiness(lastObserverContext, input, pendingAssets).level)}</span>
                  </div>
                </div>

                <div className="agent-ops-section">
                  <div className="agent-ops-section-title">当前观察</div>
                  <div className="agent-ops-line">
                    当前窗口：{sanitizeVisibleText(lastObserverContext?.activeWindow.title || "尚未读取到前台窗口")}
                  </div>
                  <div className="agent-ops-line">
                    识别平台：{detectKocPlatformFromWindow(lastObserverContext || ({ activeWindow: { title: "", processName: "", updatedAt: 0, source: "fallback" } } as ObserverContext)) || "未识别平台"}
                  </div>
                  <div className="agent-ops-line">
                    页面类型：{getObservedSceneLabel(lastObserverContext, input)}
                  </div>
                  <div className="agent-ops-line">
                    待分析素材：{pendingAssets.length} 个
                  </div>
                </div>

                <div className="agent-ops-section">
                  <div className="agent-ops-section-title">证据与进度</div>
                  <div className="agent-ops-line subtle">
                    浏览器线索：
                    {lastObserverContext?.activeWindow.browserContext
                      ? `${translateBrowserName(lastObserverContext.activeWindow.browserContext.browser)} / ${translatePlatformName(lastObserverContext.activeWindow.browserContext.platform)} / ${translatePageKind(lastObserverContext.activeWindow.browserContext.pageKind)} / ${translateConfidence(lastObserverContext.activeWindow.browserContext.confidence)}`
                      : "暂无"}
                  </div>
                  <div className="agent-ops-line subtle">任务进度：{getTraceSummary(agentRuntimeState.trace)}</div>
                  <div className="agent-ops-line subtle">
                    资料状态：{pendingAssets.length ? `已有 ${pendingAssets.length} 个素材` : "可上传截图、视频或提供作品链接"}
                  </div>
                </div>

                <div className="agent-ops-section">
                  <div className="agent-ops-section-title">Agent 闭环</div>
                  {kocAgentPanel.loop.map((line, index) => (
                    <div key={`loop-${index}`} className="agent-ops-line">
                      {index + 1}. {line}
                    </div>
                  ))}
                </div>

                <div className="agent-ops-section">
                  <div className="agent-ops-section-title">长期记忆</div>
                  <div className="agent-ops-line subtle">{summarizeMemoryForPanel(kocMemorySummary)}</div>
                </div>

                <div className="agent-ops-section">
                  <div className="agent-ops-section-title">下一步建议</div>
                  {getPanelNextActions(kocAgentPanel.phase).map((line, index) => (
                    <div key={`next-${index}`} className="agent-ops-line">
                      {index + 1}. {line}
                    </div>
                  ))}
                </div>
              </div>

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`speech-line ${message.role}${message.items?.length ? " with-items" : ""}`}
                >
                  {message.text ? <div className="speech-text">{sanitizeVisibleText(message.text)}</div> : null}

                  {message.role === "assistant" && message.trace?.length ? (
                    <details className="speech-trace-card">
                      <summary className="speech-trace-title">
                        <span>过程摘要</span>
                        <span>{getTraceSummary(message.trace)}</span>
                      </summary>
                      {message.trace.map((step) => (
                        <div key={`${message.id}-trace-${step.id}`} className={`speech-trace-step ${step.status}`}>
                          <span className="speech-trace-status">{translateTraceStatus(step.status)}</span>
                          <span className="speech-trace-tool">{translateTraceTool(step.tool)}</span>
                          {step.output ? <span className="speech-trace-output">{sanitizeVisibleText(step.output)}</span> : null}
                          {step.evidence?.length ? (
                            <div className="speech-trace-evidence">
                              {step.evidence.map((item, index) => (
                                <span key={`${message.id}-trace-${step.id}-evidence-${index}`} className="speech-trace-evidence-chip">
                                  {sanitizeVisibleText(item)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </details>
                  ) : null}

                  {message.role === "assistant" && message.evidenceSummary?.length ? (
                    <details className="speech-trace-card">
                      <summary className="speech-trace-title">
                        <span>依据与风险</span>
                        <span>{summarizeEvidenceRisk(message.evidenceSummary)}</span>
                      </summary>
                      {message.evidenceSummary.map((item) => (
                        <div key={`${message.id}-evidence-${item.key}`} className={`speech-trace-step ${item.status === "available" ? "done" : item.status === "missing" ? "failed" : "degraded"}`}>
                          <span className="speech-trace-status">{translateEvidenceStatus(item.status)}</span>
                          <span className="speech-trace-tool">{sanitizeVisibleText(item.label)}</span>
                          <span className="speech-trace-output">{sanitizeVisibleText(item.summary)}</span>
                          {item.next_action ? <span className="speech-trace-output action">补证据：{sanitizeVisibleText(item.next_action)}</span> : null}
                          <div className="speech-trace-evidence">
                            <span className="speech-trace-evidence-chip">置信度：{translateConfidence(item.confidence)}</span>
                            <span className="speech-trace-evidence-chip">来源：{sanitizeVisibleText(item.source_type)}</span>
                          </div>
                        </div>
                      ))}
                    </details>
                  ) : null}

                  {message.role === "assistant" && message.followups?.length ? (
                    <details className="speech-trace-card">
                      <summary className="speech-trace-title">
                        <span>下一步补充</span>
                        <span>{message.followups.filter((item) => item.status !== "done").length} 个开放动作</span>
                      </summary>
                      {message.followups.map((item) => (
                        <div key={`${message.id}-followup-${item.id}`} className="speech-trace-step done">
                          <span className="speech-trace-status">待跟进</span>
                          <span className="speech-trace-tool">{sanitizeVisibleText(item.title)}</span>
                          <span className="speech-trace-output">{sanitizeVisibleText(item.evidence_needed)}</span>
                          <span className="speech-trace-output action">{sanitizeVisibleText(item.next_check_hint)}</span>
                        </div>
                      ))}
                    </details>
                  ) : null}

                  {message.role === "assistant" && message.items?.length ? (
                    <div className="speech-link-list">
                      {message.items.map((item, index) => (
                        <button
                          key={`${message.id}-${index}`}
                          type="button"
                          className="speech-link-item"
                          onClick={() => {
                            if (item.url) {
                              void openUrl(item.url);
                            }
                          }}
                          disabled={!item.url}
                          title={item.url ? "点击在浏览器打开原文" : "这条没有可打开的链接"}
                        >
                          {index + 1}. {sanitizeVisibleText(item.title)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}

              {pendingAssets.length ? (
                <div className="tip-line">
                  待提交素材：{pendingAssets.map((item) => sanitizeVisibleText(item.name)).join("、")}
                </div>
              ) : null}

              {observeMode ? (
                <div className="tip-line">观察模式已开启：我会留意当前平台页面，但不会自动上传截图。</div>
              ) : null}

              {false && lastObserverContext ? (
                <div className="tip-line">
                  当前识别：{detectKocPlatformFromWindow(lastObserverContext) || "未识别平台"} /{" "}
                  {sceneLabel(detectObservedScene(lastObserverContext!, input))}
                </div>
              ) : null}

              {false && lastObserverContext ? (
                <div className="tip-line">
                  诊断准备度：
                  {
                    assessKocReadiness(lastObserverContext!, input, pendingAssets).level === "high"
                      ? "高"
                      : assessKocReadiness(lastObserverContext!, input, pendingAssets).level === "medium"
                        ? "中"
                        : "低"
                  }
                  ，{assessKocReadiness(lastObserverContext, input, pendingAssets).summary}
                </div>
              ) : null}
            </div>

            <div className="speech-action-row" aria-label="KOC 增长快捷操作">
              <button
                type="button"
                className={observeMode ? "active" : ""}
                onClick={() => void toggleObserveMode()}
              >
                {observeMode ? "停止观察" : "观察"}
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                上传素材
              </button>
              <button type="button" onClick={() => void handleSampleCurrentVideo()}>
                {videoRecordingSessionId ? "停止录制并分析" : "分析当前视频"}
              </button>
              <button type="button" onClick={() => void handleCaptureAndDiagnose("account")}>
                诊断账号
              </button>
              <button type="button" className="secondary" onClick={() => setMoreActionsOpen((value) => !value)}>
                更多
              </button>
            </div>
            {moreActionsOpen ? (
              <div className="speech-more-actions" aria-label="更多 KOC 操作">
                <button type="button" onClick={() => { setMoreActionsOpen(false); void handleReadClipboardLink(); }}>
                  读取剪贴板链接
                </button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void handleCommand("查看记忆"); }}>
                  查看记忆摘要
                </button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void handleCommand("演示路径"); }}>
                  演示路径
                </button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void handleCommand("完整记忆"); }}>
                  完整记忆
                </button>
                <button type="button" className="danger" onClick={() => { setMoreActionsOpen(false); void handleCommand("清空记忆"); }}>
                  清空记忆
                </button>
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              className="speech-file-input"
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(event) => void handleAssetFiles(event.currentTarget.files)}
            />

            <form
              className="speech-input-row"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCommand(input);
              }}
            >
              <textarea
                className="speech-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleCommand(input);
                  }
                }}
                onFocus={() => {
                  markActivity();
                  setInputFocused(true);
                  pulseMood("listening", 1200);
                }}
                onBlur={() => setInputFocused(false)}
                placeholder="发主页链接、作品链接，或直接问我怎么涨粉"
              />
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}







