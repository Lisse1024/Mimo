import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export interface KocMemoryRun {
  id: string;
  at: number;
  userMessage: string;
  platformSummary: string;
  mediaSummary: string;
  status: string;
  taskType?: string;
  platformKey?: string;
  accountKey?: string;
  workKey?: string;
  objectKind?: "account" | "work" | "unknown";
  evidenceLevel?: "low" | "medium" | "high";
  jobId?: string;
  profileId?: string;
  resultSummary: string;
  decisionSummary?: string;
  evidenceGaps?: string[];
  reusableLearnings?: string[];
  experiment?: KocExperimentMemory;
}

export interface KocExperimentMemory {
  hypothesis: string;
  suggestedAction: string;
  expectedSignal: string;
  result: "pending" | "positive" | "negative" | "mixed" | "unknown";
  conclusion: string;
  variables?: string[];
  metrics?: string[];
  reviewedAt?: number;
  reviewMetrics?: Record<string, unknown>;
  createdFromRunId?: string;
}

export interface KocCreatorProfileMemory {
  platformKey: string;
  taskTypes: string[];
  contentDirections: string[];
  knownConstraints: string[];
  evidenceLevel: "low" | "medium" | "high" | "unknown";
  updatedAt: number;
}

export interface KocPlatformAccountMemory {
  accountKey: string;
  platformKey: string;
  displayName?: string;
  accountId?: string;
  profileUrl?: string;
  taskTypes: string[];
  contentDirections: string[];
  knownConstraints: string[];
  effectivePatterns: string[];
  ineffectivePatterns: string[];
  openQuestions: string[];
  evidenceLevel: "low" | "medium" | "high" | "unknown";
  lastRunAt?: number;
  updatedAt: number;
}

export interface KocWorkMemory {
  workKey: string;
  accountKey: string;
  platformKey: string;
  taskType?: string;
  contentType?: string;
  hook?: string;
  decisionSummary?: string;
  evidenceGaps: string[];
  metrics?: Record<string, unknown>;
  lastReviewedAt?: number;
  experimentResult?: KocExperimentMemory["result"];
  updatedAt: number;
}

export interface KocEvidenceLesson {
  key: string;
  lesson: string;
  severity: "info" | "warning" | "blocker";
  taskType?: string;
  platformKey?: string;
  updatedAt: number;
}

export interface KocLongTermMemory {
  clientId: string;
  updatedAt: number;
  runs: KocMemoryRun[];
  experiments: KocExperimentMemory[];
  userPreferences: string[];
  creatorProfiles: KocCreatorProfileMemory[];
  platformAccounts: KocPlatformAccountMemory[];
  works: KocWorkMemory[];
  evidenceLessons: KocEvidenceLesson[];
  effectivePatterns: string[];
  ineffectivePatterns: string[];
  openQuestions: string[];
}

const MEMORY_DIR = path.join(DATA_DIR, "koc-memory");
const MAX_RUNS = 50;

function unique(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function dedupeEvidenceLessons(items: KocEvidenceLesson[]) {
  const seen = new Set<string>();
  const result: KocEvidenceLesson[] = [];
  for (const item of items) {
    const key = item.key || `${item.taskType || ""}:${item.platformKey || ""}:${item.lesson}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupePlatformAccounts(items: KocPlatformAccountMemory[]) {
  const map = new Map<string, KocPlatformAccountMemory>();
  for (const item of items) {
    if (!item.accountKey) continue;
    map.set(item.accountKey, item);
  }
  return [...map.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

function dedupeWorks(items: KocWorkMemory[]) {
  const map = new Map<string, KocWorkMemory>();
  for (const item of items) {
    if (!item.workKey) continue;
    map.set(item.workKey, item);
  }
  return [...map.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

function compactText(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function isTerminalRunStatus(status: string) {
  return ["completed", "degraded", "failed"].includes(status);
}

function canCreateExperiment(run: Omit<KocMemoryRun, "id" | "at">) {
  return ["completed", "degraded"].includes(run.status) && Boolean(run.resultSummary.trim()) && !/仍在处理中|完整拆解还在后台|执行中|running/i.test(run.resultSummary);
}

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function normalizeClientId(input?: string | null) {
  const raw = (input || "default").trim();
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "default"
  );
}

function getMemoryPath(clientId?: string | null) {
  return path.join(MEMORY_DIR, `${normalizeClientId(clientId)}.json`);
}

export function createEmptyKocMemory(clientId?: string | null): KocLongTermMemory {
  return {
    clientId: normalizeClientId(clientId),
    updatedAt: Date.now(),
    runs: [],
    experiments: [],
    userPreferences: [],
    creatorProfiles: [],
    platformAccounts: [],
    works: [],
    evidenceLessons: [],
    effectivePatterns: [],
    ineffectivePatterns: [],
    openQuestions: []
  };
}

export function loadKocMemory(clientId?: string | null): KocLongTermMemory {
  ensureMemoryDir();
  const normalized = normalizeClientId(clientId);
  const filePath = getMemoryPath(normalized);
  if (!fs.existsSync(filePath)) {
    return createEmptyKocMemory(normalized);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<KocLongTermMemory>;
  return {
    clientId: normalized,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-MAX_RUNS) as KocMemoryRun[] : [],
    experiments: Array.isArray(parsed.experiments) ? parsed.experiments.slice(-MAX_RUNS) as KocExperimentMemory[] : [],
    userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences.filter((item): item is string => typeof item === "string") : [],
    creatorProfiles: Array.isArray(parsed.creatorProfiles) ? parsed.creatorProfiles.filter((item): item is KocCreatorProfileMemory => Boolean(item) && typeof item === "object" && typeof (item as KocCreatorProfileMemory).platformKey === "string") : [],
    platformAccounts: Array.isArray(parsed.platformAccounts) ? parsed.platformAccounts.filter((item): item is KocPlatformAccountMemory => Boolean(item) && typeof item === "object" && typeof (item as KocPlatformAccountMemory).accountKey === "string") : [],
    works: Array.isArray(parsed.works) ? parsed.works.filter((item): item is KocWorkMemory => Boolean(item) && typeof item === "object" && typeof (item as KocWorkMemory).workKey === "string") : [],
    evidenceLessons: Array.isArray(parsed.evidenceLessons) ? parsed.evidenceLessons.filter((item): item is KocEvidenceLesson => Boolean(item) && typeof item === "object" && typeof (item as KocEvidenceLesson).lesson === "string") : [],
    effectivePatterns: Array.isArray(parsed.effectivePatterns) ? parsed.effectivePatterns.filter((item): item is string => typeof item === "string") : [],
    ineffectivePatterns: Array.isArray(parsed.ineffectivePatterns) ? parsed.ineffectivePatterns.filter((item): item is string => typeof item === "string") : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item): item is string => typeof item === "string") : []
  };
}

export function normalizeKocMemory(memory: KocLongTermMemory): KocLongTermMemory {
  return {
    ...memory,
    clientId: normalizeClientId(memory.clientId),
    updatedAt: Date.now(),
    runs: memory.runs.slice(-MAX_RUNS),
    experiments: memory.experiments.slice(-MAX_RUNS),
    userPreferences: unique(memory.userPreferences).slice(-30),
    creatorProfiles: memory.creatorProfiles.slice(-20),
    platformAccounts: dedupePlatformAccounts(memory.platformAccounts).slice(-50),
    works: dedupeWorks(memory.works).slice(-120),
    evidenceLessons: dedupeEvidenceLessons(memory.evidenceLessons).slice(-40),
    effectivePatterns: unique(memory.effectivePatterns).slice(-30),
    ineffectivePatterns: unique(memory.ineffectivePatterns).slice(-30),
    openQuestions: unique(memory.openQuestions).slice(-30)
  };
}

export function saveKocMemory(memory: KocLongTermMemory) {
  ensureMemoryDir();
  const normalized = normalizeKocMemory(memory);
  fs.writeFileSync(getMemoryPath(normalized.clientId), JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

export function clearKocMemory(clientId?: string | null) {
  ensureMemoryDir();
  const normalized = normalizeClientId(clientId);
  const filePath = getMemoryPath(normalized);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
  return loadKocMemory(normalized);
}

export function summarizeKocMemory(memory: KocLongTermMemory) {
  const recent = memory.runs.slice(-5);
  if (!recent.length) {
    return "暂无可复用 KOC 记忆。本轮会只依据当前证据判断。";
  }

  const last = recent[recent.length - 1];
  return [
    `长期记忆：${memory.runs.length} 轮已完成/已降级/失败记录，${memory.experiments.length} 个可复盘实验。`,
    `最近一轮：${last.status}；${last.decisionSummary || last.resultSummary || "暂无可复用结论"}`,
    memory.userPreferences.length ? `用户偏好：${memory.userPreferences.slice(-4).join("；")}` : "",
    memory.platformAccounts.length ? `平台账号：${memory.platformAccounts.length} 个账号档案，${memory.works.length} 条作品记录。` : "",
    memory.effectivePatterns.length ? `有效模式：${memory.effectivePatterns.slice(-3).join("；")}` : "",
    memory.ineffectivePatterns.length ? `无效模式：${memory.ineffectivePatterns.slice(-3).join("；")}` : "",
    memory.openQuestions.length ? `待验证：${memory.openQuestions.slice(-3).join("；")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildKocMemoryQualityReport(memory: KocLongTermMemory) {
  const pendingExperiments = memory.experiments.filter((item) => item.result === "pending");
  const unresolvedEvidence = memory.evidenceLessons.filter((item) => item.severity === "warning" || item.severity === "blocker");
  const recentRuns = memory.runs.slice(-8);
  const failedOrDegraded = recentRuns.filter((item) => item.status === "failed" || item.status === "degraded");
  const accountsWithMemory = memory.platformAccounts.filter((item) => item.accountKey && item.platformKey);
  const worksWithMemory = memory.works.filter((item) => item.workKey && item.platformKey);
  const hasPreferenceGuard = memory.userPreferences.some((item) => /中文|内部|提示词|完整录屏|音频|单条视频/.test(item));
  const risks: string[] = [];
  const nextActions: string[] = [];

  if (!memory.runs.length) {
    risks.push("还没有有效诊断记录，下一轮只能依赖当前证据，无法复用历史判断。");
    nextActions.push("先完成一轮账号诊断或单条作品拆解，生成第一条可复用记忆。");
  }
  if (pendingExperiments.length) {
    risks.push(`有 ${pendingExperiments.length} 个增长实验还没有回填结果，建议无法沉淀为有效或无效模式。`);
    nextActions.push("发布后回填播放、完播、点赞、收藏、评论、涨粉或主页点击数据。");
  }
  if (failedOrDegraded.length >= 3) {
    risks.push(`最近 ${recentRuns.length} 轮里有 ${failedOrDegraded.length} 轮失败或降级，说明证据采集链路需要优先修复。`);
    nextActions.push("优先补齐作品链接、完整录屏、音频、评论区和后台指标，减少低置信猜测。");
  }
  if (!accountsWithMemory.length) {
    risks.push("还没有平台账号级记忆，无法稳定区分同一用户在不同平台的账号。");
    nextActions.push("每次诊断都保存 platformKey、accountKey 和主页/作品身份，后续按平台读取历史。");
  }
  if (!worksWithMemory.length && memory.runs.some((item) => item.taskType === "single_work_analysis")) {
    risks.push("做过作品分析，但作品级记忆不足，后续很难追踪同一作品的复盘结果。");
    nextActions.push("单条视频分析完成后，按 workKey 记录片源、钩子、证据缺口和实验结果。");
  }
  if (!hasPreferenceGuard) {
    risks.push("还没有稳定写入用户展示偏好，前端仍需要持续过滤内部字段和英文枚举。");
    nextActions.push("把用户偏好写入长期记忆：前端只展示中文、隐藏内部提示词和调试字段。");
  }

  return {
    status: risks.length ? "needs_attention" : "ready",
    score: Math.max(0, 100 - risks.length * 15 - pendingExperiments.length * 3),
    counts: {
      runs: memory.runs.length,
      experiments: memory.experiments.length,
      pendingExperiments: pendingExperiments.length,
      platformAccounts: accountsWithMemory.length,
      works: worksWithMemory.length,
      evidenceLessons: memory.evidenceLessons.length,
      warningEvidenceLessons: unresolvedEvidence.length,
    },
    risks,
    nextActions: unique(nextActions).slice(0, 8),
  };
}

export function buildKocActionAgenda(memory: KocLongTermMemory) {
  const pendingExperiments = memory.runs
    .filter((run) => run.experiment?.result === "pending")
    .slice(-6)
    .reverse()
    .map((run) => ({
      type: "experiment_review",
      runId: run.id,
      platformKey: run.platformKey || "unknown",
      accountKey: run.accountKey || "",
      workKey: run.workKey || "",
      title: run.taskType === "single_work_analysis" ? "回填单条作品实验结果" : "回填账号增长实验结果",
      question: run.experiment?.expectedSignal || "请回填本次发布后的关键数据。",
      suggestedMetrics: run.experiment?.metrics || [],
      action: "补充播放、完播、点赞、收藏、评论、涨粉或主页点击数据，判断这次建议是否有效。",
      priority: "high" as const,
      createdAt: run.at,
    }));
  const evidenceRepair = memory.evidenceLessons
    .filter((lesson) => lesson.severity === "warning" || lesson.severity === "blocker")
    .slice(-6)
    .reverse()
    .map((lesson) => ({
      type: "evidence_repair",
      runId: "",
      platformKey: lesson.platformKey || "unknown",
      accountKey: "",
      workKey: "",
      title: lesson.severity === "blocker" ? "优先补齐关键证据" : "补齐证据缺口",
      question: lesson.lesson,
      suggestedMetrics: [],
      action: "下次分析前优先提供对应链接、完整录屏、音频、评论区或后台指标。",
      priority: lesson.severity === "blocker" ? "high" as const : "medium" as const,
      createdAt: lesson.updatedAt,
    }));
  const accountFollowups = memory.platformAccounts
    .filter((account) => account.openQuestions.length || account.knownConstraints.length)
    .slice(-4)
    .reverse()
    .map((account) => ({
      type: "account_followup",
      runId: "",
      platformKey: account.platformKey,
      accountKey: account.accountKey,
      workKey: "",
      title: "继续验证账号方向",
      question: account.openQuestions.slice(-1)[0] || account.knownConstraints.slice(-1)[0] || "账号方向仍有待验证问题。",
      suggestedMetrics: ["播放稳定性", "主页点击", "评论关键词", "涨粉", "转粉反馈"],
      action: "围绕同一平台账号继续做 1-3 条内容实验，并回填真实表现。",
      priority: "medium" as const,
      createdAt: account.updatedAt,
    }));
  const items = [...pendingExperiments, ...evidenceRepair, ...accountFollowups]
    .sort((a, b) => {
      const priorityScore = { high: 3, medium: 2, low: 1 };
      return priorityScore[b.priority] - priorityScore[a.priority] || b.createdAt - a.createdAt;
    })
    .slice(0, 10);
  return {
    status: items.length ? "has_actions" : "clear",
    items,
    summary: items.length
      ? `当前有 ${items.length} 个待推进事项，优先处理：${items[0].title}。`
      : "暂无待复盘事项。下一轮诊断完成后会自动生成增长实验和复盘任务。",
  };
}

export function summarizeRelevantKocMemory(
  memory: KocLongTermMemory,
  filters: {
    taskType?: string;
    platformKey?: string;
    accountKey?: string;
    workKey?: string;
  } = {}
) {
  const sameAccount = memory.runs.filter((run) => {
    const sameAccountKey = !filters.accountKey || !run.accountKey || run.accountKey === filters.accountKey;
    const samePlatform = !filters.platformKey || !run.platformKey || run.platformKey === filters.platformKey;
    return sameAccountKey && samePlatform && Boolean(filters.accountKey);
  });
  const sameContext = memory.runs.filter((run) => {
    const sameTask = !filters.taskType || !run.taskType || run.taskType === filters.taskType;
    const samePlatform = !filters.platformKey || !run.platformKey || run.platformKey === filters.platformKey;
    return sameTask && samePlatform;
  });
  const selected = sameAccount.length ? sameAccount.slice(-5) : sameContext.length ? sameContext.slice(-5) : memory.runs.slice(-3);
  const account = filters.accountKey ? memory.platformAccounts.find((item) => item.accountKey === filters.accountKey) : undefined;
  const work = filters.workKey ? memory.works.find((item) => item.workKey === filters.workKey) : undefined;

  if (!selected.length) {
    return [
      "相关记忆：没有匹配当前平台/任务的历史记录。",
      "本轮只依据当前证据判断，不借用无关账号或视频结论。"
    ].join("\n");
  }

  const last = selected[selected.length - 1];
  return [
    `相关记忆：命中 ${selected.length}/${memory.runs.length} 条记录，优先级为同账号 > 同平台同任务 > 用户全局偏好。`,
    `记忆过滤：任务=${filters.taskType || "未知"}，平台=${filters.platformKey || "未知"}，账号=${filters.accountKey || "未知"}，作品=${filters.workKey || "未知"}。`,
    account ? `当前账号记忆：方向=${account.contentDirections.slice(-4).join("、") || "待确认"}；限制=${account.knownConstraints.slice(-3).join("、") || "暂无"}。` : "",
    work ? `当前作品记忆：${work.decisionSummary || "暂无结论"}；缺口=${work.evidenceGaps.slice(-3).join("、") || "暂无"}。` : "",
    `最近同类记录：状态=${last.status}；证据=${last.evidenceLevel || "未知"}；结论=${last.decisionSummary || last.resultSummary || "暂无"}`,
    memory.userPreferences.length ? `必须遵守的用户偏好：${memory.userPreferences.slice(-5).join("；")}` : "",
    memory.evidenceLessons.length ? `证据经验：${memory.evidenceLessons.slice(-3).map((item) => item.lesson).join("；")}` : "",
    memory.effectivePatterns.length ? `仅在证据匹配时参考的有效模式：${memory.effectivePatterns.slice(-2).join("；")}` : "",
    memory.ineffectivePatterns.length ? `应避免的无效模式：${memory.ineffectivePatterns.slice(-2).join("；")}` : "",
    "记忆护栏：如果当前证据与历史记忆冲突，优先相信当前证据。"
  ].filter(Boolean).join("\n");
}

function extractUserPreferences(run: Omit<KocMemoryRun, "id" | "at">) {
  const text = `${run.userMessage}\n${run.resultSummary}`;
  const preferences: string[] = [];
  if (/不要.*英文|一律.*中文|必须.*中文|中文/.test(text)) preferences.push("用户可见内容必须使用中文，不能暴露英文内部字段。");
  if (/提示词|约束|内部|调试/.test(text)) preferences.push("不要把提示词、内部约束、调试信息或原始模型输出展示给用户。");
  if (/截图|少量帧|掐头去尾|完整视频|录屏/.test(text)) preferences.push("单条视频分析应优先使用完整录屏和音频；只有截图时必须降低置信度。");
  if (/不要.*账号主页|单条视频|当前视频/.test(text)) preferences.push("分析当前视频时不能默认当成账号主页诊断，也不能把单条内容直接等同于账号长期赛道。");
  if (/落地|实际|执行|复盘/.test(text)) preferences.push("输出要靠近真实落地：给可执行动作、验证指标和复盘口径。");
  return preferences;
}

function extractEvidenceGaps(run: Omit<KocMemoryRun, "id" | "at">) {
  const text = `${run.platformSummary}\n${run.mediaSummary}\n${run.resultSummary}`;
  const gaps: string[] = [];
  if (/缺少.*链接|主页\/作品链接|作品链接/.test(text)) gaps.push("缺少可核验主页/作品链接时，平台身份和片源判断不能高置信。");
  if (/截图|关键帧|少量帧|掐头去尾/.test(text)) gaps.push("只拿到截图或少量关键帧时，剧情因果、剪辑节奏和结尾反转必须低置信。");
  if (/音频|ASR|台词|BGM/.test(text)) gaps.push("没有音频/ASR 时，不能判断台词、BGM、解说节奏和声音钩子。");
  if (/评论|完播|播放|点赞|收藏|后台数据|真实平台数据/.test(text)) gaps.push("没有评论区、完播、互动和后台数据时，只能做内容侧建议，不能判断增长效果。");
  return gaps;
}

function deriveDecisionSummary(run: Omit<KocMemoryRun, "id" | "at">) {
  const cleanSummary = compactText(run.resultSummary, 260);
  if (!cleanSummary) return "";
  const firstUseful = cleanSummary
    .split(/\n+/)
    .map((item) => item.replace(/^[-\d.、\s]+/, "").trim())
    .find((item) => item && !/资料接收|平台线索解析|素材分析|后台|执行中/.test(item));
  return compactText(firstUseful || cleanSummary, 180);
}

function deriveReusableLearnings(run: Omit<KocMemoryRun, "id" | "at">) {
  const learnings: string[] = [];
  const text = `${run.userMessage}\n${run.resultSummary}`;
  if (/开头|前\s*3\s*秒|钩子/.test(text)) learnings.push("视频复盘时优先抽取前 3 秒钩子、冲突和停留理由。");
  if (/镜头|剪辑|字幕|封面|标题|标签/.test(text)) learnings.push("单条作品拆解要落到镜头顺序、字幕封面、标题标签和复刻拍法。");
  if (/主页|定位|赛道|账号/.test(text)) learnings.push("账号诊断要区分主页定位问题和单条作品问题。");
  return learnings;
}

function deriveExperiment(run: KocMemoryRun): KocExperimentMemory | undefined {
  if (!canCreateExperiment(run)) return undefined;
  const summary = run.decisionSummary || deriveDecisionSummary(run) || "本轮诊断建议";
  const isSingleWork = run.taskType === "single_work_analysis" || /视频|作品/.test(run.userMessage);
  return {
    hypothesis: isSingleWork
      ? `如果按本轮结论优化开头钩子、镜头顺序和标题标签，下一条同类作品应出现更清晰的停留或互动信号。`
      : `如果按本轮结论收敛账号方向并连续发布同结构内容，账号标签和互动信号应比随机混发更稳定。`,
    suggestedAction: isSingleWork
      ? `基于「${compactText(summary, 80)}」做一条同类作品复刻，固定一个变量优先测试，例如开头钩子或标题表达。`
      : `基于「${compactText(summary, 80)}」连续发布 3 条同方向内容，不同时测试多个赛道。`,
    expectedSignal: isSingleWork
      ? "至少回填 3 秒停留、完播、点赞、收藏、评论关键词中的 3 项，用来判断内容结构是否有效。"
      : "至少回填播放稳定性、主页点击、评论关键词、涨粉或转粉反馈，用来判断账号方向是否更清晰。",
    variables: isSingleWork ? ["开头钩子", "镜头顺序", "标题标签"] : ["内容方向", "栏目结构", "封面标题"],
    metrics: isSingleWork ? ["3 秒停留", "完播率", "点赞", "收藏", "评论关键词"] : ["播放稳定性", "主页点击", "评论率", "涨粉", "转粉反馈"],
    result: "pending",
    conclusion: "等待用户发布后回填数据，才能把本轮建议转成有效或无效模式。",
    createdFromRunId: run.id,
  };
}

function updateCreatorProfile(memory: KocLongTermMemory, run: KocMemoryRun) {
  const platformKey = run.platformKey || "unknown";
  const existing = memory.creatorProfiles.find((item) => item.platformKey === platformKey);
  const target = existing || {
    platformKey,
    taskTypes: [],
    contentDirections: [],
    knownConstraints: [],
    evidenceLevel: "unknown" as const,
    updatedAt: Date.now(),
  };
  target.taskTypes = unique([...target.taskTypes, run.taskType || "unknown"]).slice(-12);
  if (/单条|视频|作品|切片|影视|剧情/.test(run.userMessage + run.resultSummary)) {
    target.contentDirections = unique([...target.contentDirections, "单条视频/作品拆解"]).slice(-12);
  }
  if (/账号|主页|定位|赛道/.test(run.userMessage + run.resultSummary)) {
    target.contentDirections = unique([...target.contentDirections, "账号主页/定位诊断"]).slice(-12);
  }
  target.knownConstraints = unique([...target.knownConstraints, ...extractEvidenceGaps(run)]).slice(-12);
  target.evidenceLevel = run.evidenceLevel || target.evidenceLevel || "unknown";
  target.updatedAt = Date.now();
  if (!existing) memory.creatorProfiles.push(target);
}

function updatePlatformAccount(memory: KocLongTermMemory, run: KocMemoryRun) {
  const platformKey = run.platformKey || "unknown";
  const accountKey = run.accountKey || `${platformKey}:unknown`;
  const existing = memory.platformAccounts.find((item) => item.accountKey === accountKey);
  const target = existing || {
    accountKey,
    platformKey,
    taskTypes: [],
    contentDirections: [],
    knownConstraints: [],
    effectivePatterns: [],
    ineffectivePatterns: [],
    openQuestions: [],
    evidenceLevel: "unknown" as const,
    updatedAt: Date.now(),
  };
  target.platformKey = platformKey;
  target.taskTypes = unique([...target.taskTypes, run.taskType || "unknown"]).slice(-12);
  if (/单条|视频|作品|切片|影视|剧情/.test(run.userMessage + run.resultSummary)) {
    target.contentDirections = unique([...target.contentDirections, "单条视频/作品拆解"]).slice(-12);
  }
  if (/账号|主页|定位|赛道/.test(run.userMessage + run.resultSummary)) {
    target.contentDirections = unique([...target.contentDirections, "账号主页/定位诊断"]).slice(-12);
  }
  target.knownConstraints = unique([...target.knownConstraints, ...(run.evidenceGaps || [])]).slice(-20);
  if (run.decisionSummary && /低成本|稳定|复盘|可执行|执行|验证/.test(run.resultSummary)) {
    target.effectivePatterns = unique([...target.effectivePatterns, run.decisionSummary]).slice(-20);
  }
  if (/缺少|失败|不足|超时|低置信/i.test(run.resultSummary)) {
    target.openQuestions = unique([...target.openQuestions, ...(run.evidenceGaps || [])]).slice(-20);
  }
  target.evidenceLevel = run.evidenceLevel || target.evidenceLevel || "unknown";
  target.lastRunAt = run.at;
  target.updatedAt = Date.now();
  if (!existing) memory.platformAccounts.push(target);
}

function updateWorkMemory(memory: KocLongTermMemory, run: KocMemoryRun) {
  if (run.objectKind !== "work" && run.taskType !== "single_work_analysis") return;
  const platformKey = run.platformKey || "unknown";
  const accountKey = run.accountKey || `${platformKey}:unknown`;
  const workKey = run.workKey || `${accountKey}:work:${run.id}`;
  const existing = memory.works.find((item) => item.workKey === workKey);
  const target = existing || {
    workKey,
    accountKey,
    platformKey,
    evidenceGaps: [],
    updatedAt: Date.now(),
  };
  target.taskType = run.taskType;
  target.decisionSummary = run.decisionSummary || target.decisionSummary;
  target.evidenceGaps = unique([...(target.evidenceGaps || []), ...(run.evidenceGaps || [])]).slice(-12);
  if (run.experiment?.reviewMetrics) target.metrics = run.experiment.reviewMetrics;
  if (run.experiment?.reviewedAt) target.lastReviewedAt = run.experiment.reviewedAt;
  target.experimentResult = run.experiment?.result || target.experimentResult;
  target.updatedAt = Date.now();
  if (!existing) memory.works.push(target);
}

function updateMemoryAfterExperimentReview(memory: KocLongTermMemory, run: KocMemoryRun) {
  updatePlatformAccount(memory, run);
  updateWorkMemory(memory, run);
  const result = run.experiment?.result;
  const conclusion = compactText(run.experiment?.conclusion || "", 140);
  if (!result || !conclusion) return;
  if (result === "positive") {
    memory.effectivePatterns = unique([...memory.effectivePatterns, conclusion]).slice(-30);
  } else if (result === "negative") {
    memory.ineffectivePatterns = unique([...memory.ineffectivePatterns, conclusion]).slice(-30);
  } else if (result === "mixed") {
    memory.openQuestions = unique([...memory.openQuestions, conclusion]).slice(-30);
  }
}

export function appendKocRun(
  clientId: string | undefined,
  run: Omit<KocMemoryRun, "id" | "at">
) {
  return saveKocMemory(appendKocRunToMemory(loadKocMemory(clientId), run));
}

export function appendKocRunToMemory(
  memory: KocLongTermMemory,
  run: Omit<KocMemoryRun, "id" | "at">
) {
  if (!isTerminalRunStatus(run.status)) {
    return memory;
  }
  const nextRun: KocMemoryRun = {
    id: `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: Date.now(),
    ...run,
    decisionSummary: run.decisionSummary || deriveDecisionSummary(run),
    evidenceGaps: run.evidenceGaps || extractEvidenceGaps(run),
    reusableLearnings: run.reusableLearnings || deriveReusableLearnings(run),
  };
  const experiment = deriveExperiment(nextRun);
  if (experiment) nextRun.experiment = experiment;
  memory.runs.push(nextRun);
  if (experiment) memory.experiments.push(experiment);
  memory.userPreferences = unique([...memory.userPreferences, ...extractUserPreferences(run)]).slice(-30);
  updateCreatorProfile(memory, nextRun);
  updatePlatformAccount(memory, nextRun);
  updateWorkMemory(memory, nextRun);
  for (const gap of nextRun.evidenceGaps || []) {
    memory.evidenceLessons.push({
      key: `${nextRun.taskType || "unknown"}:${nextRun.platformKey || "unknown"}:${gap}`,
      lesson: gap,
      severity: /不能|必须|缺少/.test(gap) ? "warning" : "info",
      taskType: nextRun.taskType,
      platformKey: nextRun.platformKey,
      updatedAt: Date.now(),
    });
  }
  if (/低成本|稳定|复盘|可执行|执行|验证/.test(run.resultSummary) && nextRun.decisionSummary) {
    memory.effectivePatterns = unique([...memory.effectivePatterns, nextRun.decisionSummary]).slice(-20);
  }
  if (/缺少|失败|不足|超时|failed|degraded|低置信/i.test(run.resultSummary)) {
    memory.openQuestions = unique([...memory.openQuestions, ...(nextRun.evidenceGaps || []), compactText(run.resultSummary, 120)]).slice(-20);
  }
  return memory;
}

export function recordKocExperimentReview(
  clientId: string | undefined,
  payload: {
    runId?: string;
    metrics?: Record<string, unknown>;
    result?: KocExperimentMemory["result"];
    conclusion?: string;
  }
) {
  return saveKocMemory(recordKocExperimentReviewInMemory(loadKocMemory(clientId), payload));
}

export function recordKocExperimentReviewInMemory(
  memory: KocLongTermMemory,
  payload: {
    runId?: string;
    metrics?: Record<string, unknown>;
    result?: KocExperimentMemory["result"];
    conclusion?: string;
  }
) {
  const run = payload.runId
    ? memory.runs.find((item) => item.id === payload.runId)
    : [...memory.runs].reverse().find((item) => item.experiment);

  if (!run?.experiment) {
    throw new Error("No KOC experiment is available for review.");
  }

  const allowedResults = new Set<KocExperimentMemory["result"]>([
    "pending",
    "positive",
    "negative",
    "mixed",
    "unknown"
  ]);
  const nextResult = payload.result && allowedResults.has(payload.result) ? payload.result : "mixed";
  const metricsText = payload.metrics ? JSON.stringify(payload.metrics) : "{}";
  run.experiment.result = nextResult;
  run.experiment.reviewedAt = Date.now();
  run.experiment.reviewMetrics = payload.metrics || {};
  run.experiment.conclusion =
    (payload.conclusion || "").trim() ||
    `已根据回填指标完成复盘：${metricsText}。结果判断为 ${nextResult}。`;

  const experimentIndex = memory.experiments.findIndex(
    (item) => item.hypothesis === run.experiment?.hypothesis && item.suggestedAction === run.experiment?.suggestedAction
  );
  if (experimentIndex >= 0) {
    memory.experiments[experimentIndex] = run.experiment;
  }

  if (nextResult === "positive") {
    memory.effectivePatterns = unique([...memory.effectivePatterns, compactText(run.experiment.conclusion, 120)]).slice(-20);
  } else if (nextResult === "negative") {
    memory.ineffectivePatterns = unique([...memory.ineffectivePatterns, compactText(run.experiment.conclusion, 120)]).slice(-20);
  } else if (nextResult === "mixed") {
    memory.openQuestions = unique([...memory.openQuestions, compactText(run.experiment.conclusion, 120)]).slice(-20);
  }
  updateMemoryAfterExperimentReview(memory, run);

  return memory;
}
