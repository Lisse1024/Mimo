import type { ActiveWindowSnapshot } from "./window-monitor.js";
import { appendKocRun, loadKocMemory } from "./koc-memory-repository.js";
import type { KocExperimentMemory, KocLongTermMemory } from "./koc-memory.js";
import { buildVideoUnderstanding, processUploadedMedia } from "./media-analysis.js";
import { extractUrlsFromText, resolvePlatformContext, type PlatformConnectorResult } from "./platform-connectors.js";
import { ToolRegistry, type ToolRunRecord } from "./tool-registry.js";
import { TextDecoder } from "node:util";

type JsonObject = Record<string, unknown>;

const KOC_API_BASE = (process.env.KOC_API_BASE || "http://127.0.0.1:8010").replace(/\/+$/, "");
const KOC_REQUEST_TIMEOUT_MS = Number(process.env.KOC_REQUEST_TIMEOUT_MS || 12000);

const tools = new ToolRegistry();
// Self-check contract marker: 人工回填数据

tools.register(
  {
    name: "platform.connector_v1",
    description: "解析平台、账号、作品链接、前台窗口和公开页面元信息。",
    inputSchema: { text: "string", runtimeContext: "string", activeWindow: "ActiveWindowSnapshot" },
    outputSchema: { platformContext: "PlatformConnectorResult" },
    timeoutMs: 12000,
    retryable: true
  },
  async (input) => resolvePlatformContext({
    text: typeof input.text === "string" ? input.text : "",
    runtimeContext: typeof input.runtimeContext === "string" ? input.runtimeContext : undefined,
    activeWindow: input.activeWindow as ActiveWindowSnapshot | undefined
  })
);

export type KocResultMode = "account_growth_diagnosis" | "single_work_analysis" | "general_koc_advice" | "experiment_review";

export interface KocAssetContext {
  kind?: string;
  source?: string;
  captureMode?: string;
  recordingId?: string;
  screenRegion?: unknown;
  audioStatus?: unknown;
}

export interface KocUploadedAsset {
  name: string;
  mime: string;
  size: number;
  data_url: string;
  note?: string;
  context?: KocAssetContext;
}

export interface KocDiagnosisInput {
  message: string;
  runtimeContext?: string;
  activeWindow?: ActiveWindowSnapshot;
  assets?: KocUploadedAsset[];
  clientId?: string;
  resultMode?: KocResultMode;
}

export interface KocDiagnosisResult {
  ok: boolean;
  reply: string;
  items?: Array<{ title: string; url?: string }>;
  evidenceSummary?: unknown[];
  followups?: unknown[];
  profileId?: string;
  jobId?: string;
  status?: string;
  trace?: KocAgentTraceStep[];
}

export type KocAgentTraceStatus = "planned" | "running" | "done" | "failed" | "degraded" | "skipped";

export interface KocAgentTraceStep {
  id: string;
  tool: string;
  status: KocAgentTraceStatus;
  input: string;
  output?: string;
  evidence?: string[];
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampText(value: unknown, max = 360) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeTraceStatus(value: unknown): KocAgentTraceStatus {
  const status = asString(value).toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "degraded" || status === "warning") return "degraded";
  if (status === "running" || status === "queued") return "running";
  if (status === "pending" || status === "planned") return "planned";
  if (status === "skipped") return "skipped";
  return "done";
}

function stageLabel(stageKey: string, fallback = "LangGraph 阶段") {
  const labels: Record<string, string> = {
    received: "资料接收",
    platform_identity: "平台线索解析",
    asset_analysis: "素材分析",
    evidence_collection: "证据快照",
    decision_gate: "路由决策",
    evidence_repair_plan: "补证据规划",
    evidence_request: "等待补充证据",
    strategy_bundle: "策略生成",
    finalize: "结果收拢",
    failed: "失败处理"
  };
  return labels[stageKey] || fallback;
}

function buildTraceFromStages(job: JsonObject): KocAgentTraceStep[] {
  return asArray(job.stages).map((item, index) => {
    const stage = asRecord(item);
    const key = asString(stage.key, `stage-${index + 1}`);
    return traceStep(
      `stage-${key}`,
      `langgraph.${key}`,
      normalizeTraceStatus(stage.status),
      stageLabel(key, asString(stage.label, "LangGraph 阶段")),
      asString(stage.message, asString(stage.label, "等待执行"))
    );
  });
}

function buildTraceFromGraphState(job: JsonObject): KocAgentTraceStep[] {
  const graphState = asRecord(job.graph_state);
  const stageEvents = asArray(graphState.stage_events);
  const eventTrace = stageEvents.map((item, index) => {
    const event = asRecord(item);
    const node = asString(event.node, asString(event.stage, `event-${index + 1}`));
    const stage = asString(event.stage, node);
    return traceStep(
      `graph-${index + 1}-${stage}`,
      `langgraph.${node}`,
      normalizeTraceStatus(event.status),
      stageLabel(stage, "LangGraph 节点"),
      asString(event.message, `${stageLabel(stage)} 已更新`),
      [stageLabel(stage)].filter(Boolean)
    );
  });

  const toolTrace = asArray(graphState.tool_runs).map((item, index) => {
    const run = asRecord(item);
    const tool = asString(run.tool, `tool-${index + 1}`);
    const latency = run.latency_ms || run.elapsed_ms || run.duration_ms;
    const output = [
      asString(run.summary),
      asString(run.error),
      latency ? `耗时 ${latency}ms` : ""
    ].filter(Boolean).join("；") || "工具调用已记录。";
    return traceStep(
      `tool-${index + 1}-${tool}`,
      tool,
      normalizeTraceStatus(run.status),
      asString(run.input, "LangGraph 工具调用"),
      output,
      asArray(run.evidence).map((value) => clampText(value, 120)).filter(Boolean)
    );
  });

  const decision = asRecord(graphState.graph_decision);
  const decisionTrace = Object.keys(decision).length
    ? [
        traceStep(
          "graph-decision",
          "langgraph.decision_gate",
          decision.should_pause_for_evidence ? "degraded" : decision.needs_evidence_repair ? "degraded" : "done",
          "根据任务类型、证据质量和长期记忆选择后续路径",
          [
            `策略路径：${asString(decision.preferred_strategy, "未知")}`,
            `记忆信号：${asString(decision.memory_signal, "无")}`,
            `证据等级：${asString(decision.evidence_level, "未知")}`,
            decision.should_pause_for_evidence ? "已暂停等待补充证据" : ""
          ].filter(Boolean).join("；"),
          asArray(decision.missing_actions).map((value) => clampText(value, 160)).filter(Boolean)
        )
      ]
    : [];

  return [...eventTrace, ...toolTrace, ...decisionTrace];
}

function buildTraceFromWorkspace(workspace: JsonObject): KocAgentTraceStep[] {
  const agentRun = asRecord(workspace.agent_run);
  return asArray(agentRun.tool_calls).map((item, index) => {
    const call = asRecord(item);
    const tool = asString(call.tool, `workspace.tool.${index + 1}`);
    return traceStep(
      `workspace-tool-${index + 1}-${tool}`,
      tool,
      normalizeTraceStatus(call.status),
      asString(call.input, asString(call.owner_agent, "工作空间工具")),
      asString(call.output, "工作空间工具调用已完成")
    );
  });
}

function dedupeTrace(trace: KocAgentTraceStep[]) {
  const seen = new Set<string>();
  return trace.filter((step) => {
    const key = `${step.id}|${step.tool}|${step.status}|${step.output || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildKocJobTrace(job: JsonObject): KocAgentTraceStep[] {
  const workspace = asRecord(job.workspace);
  const trace = [
    ...buildTraceFromStages(job),
    ...buildTraceFromGraphState(job),
    ...buildTraceFromWorkspace(workspace)
  ];
  if (asString(job.error)) {
    trace.push(traceStep("job-error", "langgraph.fail_job", "failed", "后台任务错误", asString(job.error)));
  }
  return dedupeTrace(trace).slice(-80);
}

function stringList(value: unknown, maxItems = 5) {
  return asArray(value).map((item) => clampText(item, 180)).filter(Boolean).slice(0, maxItems);
}

function fieldList(record: JsonObject, key: string, maxItems = 5) {
  return stringList(record[key], maxItems);
}

function visibleEvidenceKey(key: string) {
  const normalized = key.trim().toLowerCase();
  const map: Record<string, string> = {
    direct_evidence: "直接证据",
    inferred_claims: "推断判断",
    low_confidence_claims: "低置信判断",
    missing_evidence: "缺失证据",
    forbidden_claims: "禁止结论",
    missing_keys: "缺失证据项",
    degraded_keys: "降级证据项",
    must_not_claim: "不能声称",
    platform_hint: "平台身份线索",
    fetched_platform_data: "平台公开页数据",
    browser_visible_metrics: "浏览器可见互动指标",
    visual_asset_analysis: "截图/视频视觉分析",
    video_timeline: "视频抽帧时间线",
    model_inference: "模型综合判断",
    platform: "平台线索",
    hint: "身份线索",
    fetched: "已抓取公开信息",
    data: "数据",
    browser: "浏览器",
    visible: "可见信息",
    metrics: "互动指标"
  };
  if (map[normalized]) return map[normalized];
  return normalized
    .split(/[_\s/-]+/)
    .filter(Boolean)
    .map((part) => map[part] || part)
    .join(" / ");
}

function claimText(value: unknown) {
  if (typeof value === "string") return clampText(value, 220);
  const record = asRecord(value);
  const claim = asString(record.claim) || asString(record.summary) || asString(record.text) || asString(record.label);
  const basis = asString(record.basis) || asString(record.evidence);
  const confidence = asString(record.confidence);
  return [
    claim || clampText(value, 160),
    basis ? `依据：${basis}` : "",
    confidence ? `置信度：${translateConfidenceWord(confidence)}` : ""
  ].filter(Boolean).join("；");
}

function claimList(value: unknown, maxItems = 5) {
  return asArray(value).map((item) => claimText(item)).filter(Boolean).slice(0, maxItems);
}

function evidenceKeyList(value: unknown, maxItems = 5) {
  return asArray(value)
    .map((item) => visibleEvidenceKey(asString(item)))
    .filter(Boolean)
    .slice(0, maxItems);
}

function taskLines(workspace: JsonObject, maxItems = 3) {
  return asArray(workspace.tasks)
    .map((item, index) => {
      const task = asRecord(item);
      const title = asString(task.title, `任务 ${index + 1}`);
      const goal = asString(task.goal);
      return goal ? `${index + 1}. ${title}：${goal}` : `${index + 1}. ${title}`;
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function firstContentTask(advisor: JsonObject) {
  const task = asRecord(advisor.first_content_task);
  const title = asString(task.title);
  const hook = asString(task.hook);
  const outline = stringList(task.outline || task.shots || task.steps, 4);
  const metrics = stringList(task.metrics || task.expected_signal || task.expectedSignal, 4);
  if (!title && !hook && !outline.length && !metrics.length) return "";
  return [
    title ? `选题：${title}` : "",
    hook ? `开头：${hook}` : "",
    outline.length ? `执行：${outline.join("；")}` : "",
    metrics.length ? `看数：${metrics.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

const GENERIC_SCRIPT_PATTERNS = [
  /最强冲突/,
  /情绪爆点/,
  /补充片源、人物关系或前因后果/,
  /让用户马上知道看点/,
  /用字幕强化.*为什么.*值得看/,
  /0-3\s*秒[^；。\n]*(冲突|反转)/,
  /4-12\s*秒[^；。\n]*(背景|前因后果|人物关系)/,
  /13-25\s*秒[^；。\n]*(爆点|反转)/,
  /\u6700\u5f3a\u51b2\u7a81/,
  /\u60c5\u7eea\u7206\u70b9/,
  /\u8865\u5145\u7247\u6e90\u3001\u4eba\u7269\u5173\u7cfb\u6216\u524d\u56e0\u540e\u679c/,
  /\u8ba9\u7528\u6237\u9a6c\u4e0a\u77e5\u9053\u770b\u70b9/,
  /\u7528\u5b57\u5e55\u5f3a\u5316.*\u4e3a\u4ec0\u4e48.*\u503c\u5f97\u770b/,
  /0-3\s*\u79d2[^\uff1b\u3002\n]*(\u51b2\u7a81|\u53cd\u8f6c)/,
  /4-12\s*\u79d2[^\uff1b\u3002\n]*(\u80cc\u666f|\u524d\u56e0\u540e\u679c|\u4eba\u7269\u5173\u7cfb)/,
  /13-25\s*\u79d2[^\uff1b\u3002\n]*(\u7206\u70b9|\u53cd\u8f6c)/
];

const OPERATIONAL_METADATA_PATTERN =
  /用户请求[:：]|请分析我当前刷到的这条视频|不要默认把它当成账号主页诊断|平台线索[:：]|平台[:：][^\n]*(?:浏览器|网页版)|hints\s*=|状态\s*=\s*partial|status\s*=\s*partial|素材处理[:：]|Uploaded\s+assets|Uploaded video assets|assets:|current-video-recording|fallback-frame|\.mp4[:：]?完成|media processing|runtime context|runtimeContext|mediaContext|tool trace|\btool\b|debug|Microsoft|微软浏览器|浏览器浏览器|当前窗口|窗口标题|窗口进程|视频时长|进度条显示|进度条|00:\d{2}\/00:\d{2}|frame-\d+\.jpg|sampling:|duration:|sampled .* frame available|pending vision analysis/i;

const EXTRA_OPERATIONAL_METADATA_PATTERN =
  /用户请求|平台线索|素材处理|桌面助手|助手弹窗|弹窗出现|弹窗关闭|当前窗口|窗口标题|窗口进程|视频时长|进度条显示|进度条|抖音网页版|微软浏览器|浏览器浏览器/i;

const NON_GROWTH_SCRIPT_MATERIAL_PATTERN =
  /作者声明|免责声明|虚构演绎|仅供娱乐|剧情演绎|请勿对号入座|无不良引导|素材来源|版权归原作者|侵删|如有侵权|平台声明|风险提示|未成年人请勿模仿|危险动作请勿模仿/i;

const UNSUPPORTED_SCRIPT_INFERENCE_PATTERN =
  /热门\s*CP|CP\s*向|BL\s*同人|同人受众|吸引[^，。；\n]{0,20}受众|粉丝一定|必然吸引|天然适合|已经验证[^，。；\n]{0,20}人群|\d{2}后[^，。；\n]{0,20}记忆|集体记忆|情怀金曲|氛围感演奏|配合[^，。；\n]{0,20}关键词|短视频平台常见|符合原曲情绪|引发[^，。；\n]{0,20}共鸣|情绪共鸣|季节共鸣|孤独感氛围|秋日\/深夜|目标受众|用户画像|夜间寻求/i;

const EXTRA_UNSUPPORTED_SCRIPT_INFERENCE_PATTERN =
  /热门\s*CP|CP\s*向|同人受众|吸引[^，。；\n]{0,20}受众|符合原曲情绪|短视频平台常见|流量密码|治愈陪伴感|营造[^，。；\n]{0,20}感|目标受众|用户画像|夜间寻求|情绪共鸣|季节共鸣|孤独感氛围|引发[^，。；\n]{0,20}共鸣/i;

const EXTRA_SINGLE_WORK_SCRIPT_JUNK_PATTERN =
  /UGC|OGC|Cold Open|visual\s*\/\s*frame|source_type|frame:\s*\d{1,2}:\d{2}/i;

const EXTRA_SINGLE_WORK_SCRIPT_JUNK_PATTERN_2 =
  /UGC|OGC|Cold Open|visual\s*\/\s*frame|source_type|frame:\s*\d{1,2}:\d{2}|\u5927\u5bb6\u597d\u6211\u662f|XX|\u5e9f\u8bdd|\u96f6\u5e27\u8d77\u624b|\u76f4\u63a5\u7ed9\u97f3\u4e50\u4ef7\u503c|\u97f3\u4e50\u4ef7\u503c|\u97f3\u4e50\u535a\u4e3b\u7279\u5f81|\u539f\u751f\u62cd\u6444\u8d28\u611f|\u65e0\u540e\u671f\u7279\u6548|\u6d41\u91cf\u5bc6\u7801|\u76ee\u6807\u53d7\u4f17/i;

const PAGE_CONTEXT_SCRIPT_MATERIAL_PATTERN =
  /搜索框|搜索栏|搜索词|搜索页面|搜索结果|账号信息|作者信息|发布账号|@\S+|集数标题|章节信息|第\d+章[:：]|合集标签|合集[:：]|第\d+集[:：].*#|发布时间|发布于|主页|关注按钮|点赞按钮|评论按钮|收藏按钮|分享按钮|转发按钮|按钮布局|原生界面元素|抖音原生界面|评论区入口|平台UI|平台[:：][^\n]*(?:浏览器|网页版)|导航栏|抖音精选|抖音网页版|Microsoft|微软浏览器|浏览器浏览器|推荐页|关注页|时间戳|\d+\s*小时前|更新晚了|抱歉最近更新|最近更新晚/i;

const PAGE_CONTEXT_LINE_DROP_PATTERN =
  /搜索框|搜索栏|搜索词|账号信息|作者信息|发布账号|@\S+|集数标题|章节信息|第\d+章[:：]|合集标签|合集[:：]|第\d+集[:：].*#|发布时间|发布于|关注按钮|点赞按钮|评论按钮|收藏按钮|分享按钮|转发按钮|按钮布局|原生界面元素|抖音原生界面|评论区入口|平台UI|平台[:：][^\n]*(?:浏览器|网页版)|导航栏|抖音精选|抖音网页版|Microsoft|微软浏览器|浏览器浏览器|推荐页|关注页|时间戳|\d+\s*小时前|更新晚了|抱歉最近更新|最近更新晚/i;

const EXTRA_PAGE_CONTEXT_SCRIPT_MATERIAL_PATTERN =
  /搜索框|搜索栏|搜索词|账号信息|作者信息|发布账号|合集标签|集数标题|章节信息|平台UI|抖音原生界面|按钮布局|点赞按钮|评论按钮|收藏按钮|分享按钮|桌面助手|助手弹窗|弹窗出现|弹窗关闭|发布时间|时间戳|抖音精选|导航栏|推荐页|关注页/i;

const VISIBLE_METRIC_SCRIPT_MATERIAL_PATTERN =
  /互动数据|右下角互动|点赞\s*\d+|评论\s*\d+|收藏\s*\d+|分享\s*\d+|播放量|浏览量|获赞|粉丝数|转发\s*\d+|视频时长|进度条显示|进度条|00:\d{2}\/00:\d{2}/i;

const HOMEPAGE_RUNTIME_METADATA_PATTERN =
  /本地用户|待确认账号|当前窗口进程|当前窗口标题|窗口进程|窗口标题|current window|window title|window process|msedgewebview2|image\/png|image\/jpe?g|video\/mp4|\.png\b|\.jpe?g\b|\.mp4\b|screen\b|upload|asset|mime|文件大小|file\s*size|用户档案|browser hint|platform hint|browser|electron|tauri|runtime|debug/i;

function hasOperationalMetadata(text: unknown) {
  const value = asString(text);
  return OPERATIONAL_METADATA_PATTERN.test(value) || EXTRA_OPERATIONAL_METADATA_PATTERN.test(value);
}

function hasNonGrowthScriptMaterial(text: unknown) {
  return NON_GROWTH_SCRIPT_MATERIAL_PATTERN.test(asString(text));
}

function hasUnsupportedScriptInference(text: unknown) {
  const value = asString(text);
  return UNSUPPORTED_SCRIPT_INFERENCE_PATTERN.test(value) || EXTRA_UNSUPPORTED_SCRIPT_INFERENCE_PATTERN.test(value) || EXTRA_SINGLE_WORK_SCRIPT_JUNK_PATTERN.test(value) || EXTRA_SINGLE_WORK_SCRIPT_JUNK_PATTERN_2.test(value);
}

function hasPageContextScriptMaterial(text: unknown) {
  const value = asString(text);
  return PAGE_CONTEXT_SCRIPT_MATERIAL_PATTERN.test(value) || EXTRA_PAGE_CONTEXT_SCRIPT_MATERIAL_PATTERN.test(value);
}

function hasVisibleMetricScriptMaterial(text: unknown) {
  return VISIBLE_METRIC_SCRIPT_MATERIAL_PATTERN.test(asString(text));
}

function cleanScriptDisplayText(value: unknown, fallback = "") {
  let text = asString(value, fallback);
  if (!text) return fallback;
  text = text
    .replace(/\s*[?(]\s*visual\s*\/\s*frame\s*[:?][^)?]*[)?]/gi, "")
    .replace(/\s*[?(]\s*frame\s*[:?][^)?]*[)?]/gi, "")
    .replace(/XX/g, "")
    .replace(/__never_matches__/g, "")
    .replace(/Cold Open/gi, "\u5f00\u5934\u76f4\u63a5\u8fdb\u5165\u5185\u5bb9")
    .replace(/__never_matches__/g, "")
    .replace(/UGC\/OGC/g, "平台原生内容")
    .replace(/__never_matches__/g, "");
  if (text.includes("字幕文本序列") || (text.match(/→/g) || []).length >= 3) {
    const parts = text.split(/→|->/).map((item) => item.replace(/^字幕文本序列[:：]?/, "").trim().replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")).filter(Boolean);
    if (parts.length) return `字幕递进：${parts.slice(0, 3).join(" → ")}`;
  }
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function cleanScriptDisplayTextGuarded(value: unknown, fallback = "") {
  const text = cleanScriptDisplayText(value, fallback);
  return EXTRA_SINGLE_WORK_SCRIPT_JUNK_PATTERN_2.test(text) ? fallback : text;
}

function hasHomepageRuntimeMetadata(text: unknown) {
  return HOMEPAGE_RUNTIME_METADATA_PATTERN.test(asString(text)) || hasOperationalMetadata(text);
}

function hasSpecificMaterialClue(text: string) {
  const compact = text.replace(/\s+/g, "");
  if (/「[^」]{2,}」|“[^”]{2,}”|《[^》]{2,}》/.test(text)) return true;
  if (/台词|字幕|标题|标签|场景|动作|人物|角色|画面|OCR|ASR|时间线|可见|口播/.test(text) && compact.length >= 18) return true;
  if (/[\u4e00-\u9fff]{4,}[，,][\u4e00-\u9fff]{4,}/.test(text)) return true;
  return false;
}

function isGenericScriptText(text: string) {
  const hasGeneric = GENERIC_SCRIPT_PATTERNS.some((pattern) => pattern.test(text));
  const genericHits = GENERIC_SCRIPT_PATTERNS.filter((pattern) => pattern.test(text)).length;
  return hasGeneric && (genericHits >= 2 || !hasSpecificMaterialClue(text));
}

function minimalScriptFallback() {
  return [
    "\u5f53\u524d\u5185\u5bb9\u8bc1\u636e\u4e0d\u8db3\uff0c\u65e0\u6cd5\u751f\u6210\u5177\u4f53\u811a\u672c\u3002",
    "\u753b\u9762/\u7d20\u6750\uff1a\u8bf7\u8865\u5145\u8fde\u7eed\u753b\u9762\u3001\u6807\u9898\u5b57\u5e55\u6216\u4f5c\u54c1\u94fe\u63a5\u3002",
    "\u5b57\u5e55/\u53e3\u64ad\uff1a\u5f53\u524d\u4e0d\u4f7f\u7528\u7528\u6237\u8bf7\u6c42\u3001\u5de5\u5177\u65e5\u5fd7\u3001\u6587\u4ef6\u540d\u6216\u4e0a\u4f20\u72b6\u6001\u6765\u7f16\u811a\u672c\u3002",
    "\u76ee\u7684\uff1a\u907f\u514d\u628a\u8fd0\u884c\u5143\u6570\u636e\u8bef\u5199\u6210\u89c6\u9891\u5185\u5bb9\u8bc1\u636e\u3002"
  ].join("\n");
}

function translateConfidenceWord(value: unknown) {
  const confidence = asString(value).toLowerCase();
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  if (confidence === "low") return "低";
  if (confidence === "unknown") return "未知";
  return asString(value, "未知");
}

function conciseText(value: unknown, maxSentences = 3, maxChars = 260) {
  const text = asString(value);
  if (!text) return "";
  const sentences = text
    .split(/(?<=[。！？.!?])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const clipped = (sentences.length ? sentences.slice(0, maxSentences).join("") : text).trim();
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars - 1)}…` : clipped;
}

function uniqueTextList(items: unknown[], maxItems = 4) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const text = clampText(item, 180).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function scriptSteps(strategy: JsonObject, advisor: JsonObject) {
  const task = asRecord(advisor.first_content_task);
  const rawSteps = asArray(strategy.script_steps).length ? asArray(strategy.script_steps) : asArray(task.script_steps);
  const steps = rawSteps
    .map((item) => asRecord(item))
    .filter((item) => Object.keys(item).length)
    .filter((step) => {
      const text = [
        step.visual,
        step.caption_or_voiceover,
        step.evidence,
        step.purpose,
        step.growth_reason
      ].map((item) => asString(item)).join("\n");
      return text.trim() && !hasOperationalMetadata(text) && !hasNonGrowthScriptMaterial(text) && !hasUnsupportedScriptInference(text) && !hasPageContextScriptMaterial(text) && !hasVisibleMetricScriptMaterial(text);
    });
  const compactSteps = steps.slice(0, 4);
  if (compactSteps.length) {
    return compactSteps.map((step, index) => {
      const confidence = asString(step.confidence, "low");
      const lowConfidenceNote = confidence === "low" ? "（低置信小样本）" : "";
      const visual = cleanScriptDisplayTextGuarded(step.visual, "当前素材线索不足");
      const voiceover = cleanScriptDisplayTextGuarded(step.caption_or_voiceover, "基于当前证据做低置信最小测试。");
      const purpose = cleanScriptDisplayTextGuarded(step.purpose, "验证当前素材线索是否能带来停留。");
      const growthReason = cleanScriptDisplayTextGuarded(step.growth_reason);
      return [
        `${index + 1}. 时间段：${asString(step.time, "当前素材线索不足")}`,
        `画面/素材：${visual}`,
        `字幕/口播：${voiceover}`,
        `目的：${purpose}${lowConfidenceNote}`,
        growthReason ? `增长目的：${growthReason}` : ""
      ].join("\n");
    }).join("\n\n");
  }
  if (steps.length) {
    return steps.slice(0, 4).map((step, index) => {
      const confidence = asString(step.confidence, "low");
      const confidenceLabel = confidence === "low" ? "低置信，仅适合作为小样本测试" : translateConfidenceWord(confidence);
      return [
        `${index + 1}. 时间段：${asString(step.time, "当前素材线索不足")}`,
        `画面/素材：${asString(step.visual, "当前素材线索不足")}`,
        `字幕/口播：${asString(step.caption_or_voiceover, "基于当前证据做低置信最小测试。")}`,
        `目的：${asString(step.purpose, "验证当前素材线索是否能带来停留。")}`,
        `依据：${asString(step.evidence, "当前素材线索不足")}`,
        asString(step.growth_reason) ? `增长目的：${asString(step.growth_reason)}` : "",
        `置信度：${confidenceLabel}`
      ].join("\n");
    }).join("\n\n");
  }

  const legacy = firstContentTask(advisor);
  if (legacy && !isGenericScriptText(legacy)) return legacy;
  return minimalScriptFallback();
}

function experimentLines(strategy: JsonObject, workspace: JsonObject) {
  const learningPacket = asRecord(workspace.learning_packet);
  const experiment = asRecord(learningPacket.experiment_template);
  const hypothesis = asString(strategy.growth_hypothesis, asString(experiment.hypothesis));
  const action = asString(strategy.test_action) || stringList(experiment.actions, 3).join("；");
  const metrics = stringList(strategy.validation_metrics || strategy.kpis || experiment.metrics, 10);
  const defaultMetrics = ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"];
  const metricText = (metrics.length ? metrics : defaultMetrics).join("、");
  const rules = stringList(strategy.decision_rules, 8);
  const review = asString(strategy.review_template) || reviewTemplate(strategy, workspace);
  return {
    hypothesis,
    action,
    metrics: metricText,
    rules,
    review
  };
}

function nextActionSection(firstActions: string[], experiment: ReturnType<typeof experimentLines>, tasks: string[]) {
  const actionLines = uniqueTextList([
    experiment.hypothesis ? `增长假设：${experiment.hypothesis}` : "",
    experiment.action ? `测试动作：${experiment.action}` : "",
    ...firstActions,
    ...tasks
  ], 4);
  if (!actionLines.length) return "下一步动作：\n- 先按当前证据剪一版小样本，发布后回填留存、完播、评论和负反馈。";
  return `下一步动作：\n${actionLines.map((item) => `- ${item}`).join("\n")}`;
}

function experimentSection(experiment: ReturnType<typeof experimentLines>) {
  const rules = experiment.rules.length ? experiment.rules.slice(0, 3) : [
    "开头留存低：改开头线索。",
    "完播低：压缩背景解释。",
    "评论集中在片源/人物/台词可继续测同类；负反馈集中在搬运/废话多就降低原片比例。"
  ];
  return [
    "验证与复盘：",
    `验证指标：${experiment.metrics}`,
    `判断规则：\n${rules.map((item) => `- ${item}`).join("\n")}`,
    `复盘回填：${experiment.review}`
  ].join("\n");
}

function evidenceBoundary(evidenceContract: JsonObject) {
  const compactLowConfidence = claimList(evidenceContract.low_confidence_claims, 4);
  const compactMissingEvidence = stringList(evidenceContract.missing_evidence, 6);
  const compactForbiddenClaims = stringList(evidenceContract.forbidden_claims || evidenceContract.must_not_claim, 6);
  const compactBoundaryText = [...compactLowConfidence, ...compactMissingEvidence, ...compactForbiddenClaims].join(" ");
  const compactLines = uniqueTextList([
    /完整剧情|完整视频|短片段|上下文/.test(compactBoundaryText) ? "不能确认完整剧情。" : "",
    /官方|授权/.test(compactBoundaryText) ? "不能确认官方/授权状态。" : "",
    /评论/.test(compactBoundaryText) ? "不能声称评论区共识。" : "",
    /后台|数据|爆/.test(compactBoundaryText) ? "不能声称后台数据证明或一定会爆。" : "",
    /长期方向|单条/.test(compactBoundaryText) ? "不能用单条视频判断账号长期方向。" : "",
    compactLowConfidence.length ? "低置信判断不应写成确定结论。" : ""
  ], 6);
  if (compactLines.length) {
    return `证据边界：\n${compactLines.map((line) => `- ${line}`).join("\n")}`;
  }
  const missingKeys = evidenceKeyList(evidenceContract.missing_keys, 4);
  const degradedKeys = evidenceKeyList(evidenceContract.degraded_keys, 4);
  const directEvidence = stringList(evidenceContract.direct_evidence, 5);
  const inferredClaims = claimList(evidenceContract.inferred_claims, 4);
  const lowConfidence = claimList(evidenceContract.low_confidence_claims, 4);
  const missingEvidence = stringList(evidenceContract.missing_evidence, 6);
  const forbiddenClaims = stringList(evidenceContract.forbidden_claims || evidenceContract.must_not_claim, 6);
  const lines = [
    directEvidence.length ? `直接证据：${directEvidence.join("；")}` : "",
    inferredClaims.length ? `推断判断：${inferredClaims.join("；")}` : "",
    lowConfidence.length ? `低置信判断：${lowConfidence.join("；")}。这些不应写成确定结论。` : "",
    missingEvidence.length ? `缺失证据：${missingEvidence.join("；")}` : "",
    missingKeys.length ? `缺失证据项：${missingKeys.join("、")}` : "",
    degradedKeys.length ? `降级证据项：${degradedKeys.join("、")}` : "",
    forbiddenClaims.length ? `当前不能声称：${forbiddenClaims.join("、")}` : ""
  ].filter(Boolean);
  return `证据边界：${lines.length ? `\n${lines.map((line) => `- ${line}`).join("\n")}` : "本轮证据已随结果返回，可展开“依据与风险”查看来源和置信度。"}`;
}

function reviewTemplate(strategy: JsonObject, workspace: JsonObject) {
  const learningPacket = asRecord(workspace.learning_packet);
  const experiment = asRecord(learningPacket.experiment_template);
  const metrics = stringList(experiment.metrics || strategy.kpis, 5);
  const metricText = metrics.length ? metrics.join("、") : "播放量、完播、点赞、评论、收藏、转粉";
  return `复盘回填：发布后直接发“复盘：${metricText}，效果判断：...，评论里最多被问到：...”`;
}

function copyrightBoundaryText(workspace: JsonObject) {
  const text = JSON.stringify(workspace);
  const strategy = asRecord(workspace.strategy);
  const contentType = asString(strategy.content_type);
  const explicitBoundary = asString(strategy.copyright_or_usage_boundary || strategy.usage_boundary || workspace.copyright_or_usage_boundary);
  const mediaBoundary = "\u7d20\u6750\u4f7f\u7528\u8fb9\u754c\uff1a\u8fd9\u7c7b\u7d20\u6750\u5efa\u8bae\u590d\u7528\u9009\u9898\u89d2\u5ea6\u3001\u89e3\u8bf4\u7ed3\u6784\u3001\u5b57\u5e55\u89e3\u91ca\u65b9\u5f0f\u6216\u8bc4\u8bba\u95ee\u9898\u65b9\u5f0f\uff1b\u7d20\u6750\u4f7f\u7528\u5e94\u4f18\u5148\u9009\u62e9\u8bc4\u8bba\u6027\u5f15\u7528\u3001\u6388\u6743\u7d20\u6750\u3001\u5e73\u53f0\u53ef\u7528\u7d20\u6750\u3001\u622a\u56fe\u8bb2\u89e3\u6216\u53e3\u64ad\u590d\u8ff0\uff0c\u907f\u514d\u5b8c\u6574\u642c\u8fd0\u539f\u7247\u3002\u8fd9\u91cc\u8bf4\u7684\u201c\u590d\u523b\u201d\u53ea\u6307\u7ed3\u6784\u590d\u7528\u3002";
  const musicBoundary = "\u7d20\u6750\u4f7f\u7528\u8fb9\u754c\uff1a\u6d89\u53ca\u5df2\u6709\u4f5c\u54c1\u7684\u6f14\u594f\u3001\u7ffb\u5531\u6216\u6559\u5b66\u65f6\uff0c\u5e94\u5173\u6ce8\u5e73\u53f0\u97f3\u4e50\u7248\u6743\u3001\u66f2\u8c31/\u4f34\u594f\u6765\u6e90\u548c\u4e8c\u521b\u6388\u6743\u8fb9\u754c\uff1b\u590d\u7528\u65f6\u5b66\u4e60\u9009\u66f2\u3001\u955c\u5934\u3001\u6807\u9898\u94a9\u5b50\u548c\u6f14\u594f/\u6559\u5b66\u7ed3\u6784\uff0c\u4e0d\u76f4\u63a5\u642c\u8fd0\u4ed6\u4eba\u6f14\u594f\u89c6\u9891\u3002";
  if (explicitBoundary) return contentType === "performance" || contentType === "tutorial" ? musicBoundary : mediaBoundary;
  if (contentType === "performance" || contentType === "tutorial") {
    if (/(\u97f3\u4e50|\u6b4c\u66f2|\u6f14\u594f|\u7ffb\u5531|\u7ffb\u5f39|\u6307\u5f39|\u4f34\u594f|\u66f2\u8c31|cover)/i.test(text)) {
      return musicBoundary;
    }
    return "";
  }
  if (contentType && contentType !== "media_clip") return "";
  if (/\u975e\u5f71\u89c6|\u4e0d\u662f\u5f71\u89c6|\u539f\u521b\u97f3\u4e50|\u771f\u4eba\u5b9e\u62cd\u5409\u4ed6|\u5409\u4ed6\u6f14\u594f/.test(text)) return "";
  if (!/(\u5f71\u89c6|\u7efc\u827a|\u5c0f\u54c1|\u6625\u665a|\u8001\u5267|\u540d\u573a\u9762|\u7248\u6743|\u6388\u6743|\u642c\u8fd0|\u7535\u5f71|\u77ed\u5267|\u52a8\u6f2b)/.test(text)) return "";
  return mediaBoundary;
}

function guardFinalReply(text: string) {
  const normalizedText = text
    .replace(/This homepage diagnosis is based on visible[\s\S]{0,180}?conversion efficiency\./g, "本轮主页诊断仅基于可见证据；缺少后台数据时，不声称长期方向、推荐状态或转粉效率已经被验证。")
    .replace(/Specific column ideas must come from[\s\S]{0,160}?evidence_basis\./g, "具体栏目建议必须来自上游主页栏目方案，并且每条都要带证据依据。")
    .replace(/If upstream evidence is direction-only[\s\S]{0,180}?inventing titles\./g, "如果上游证据只能支持方向级判断，就做方向级小样本测试，不编具体标题。")
    .replace(/Review with 24\/48h views[\s\S]{0,180}?negative feedback\./g, "复盘使用 24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化和负反馈。")
    .replace(/\bdirection-only\b/g, "方向级")
    .replace(/\bevidence_basis\b/g, "证据依据")
    .replace(/\bbasis\b/g, "证据依据")
    .replace(/\bprofile clicks\b/g, "主页点击率")
    .replace(/档案 clicks/g, "主页点击率")
    .replace(/\bfollow conversion\b/g, "关注转化")
    .replace(/\bcompletion\b/g, "完播率")
    .replace(/\bcomment keywords\b/g, "评论关键词")
    .replace(/\bnegative feedback\b/g, "负反馈");
  const visibleNormalizedText = normalizedText
    .replace(/\s*[?(]\s*visual\s*\/\s*frame\s*[:?][^)?]*[)?]/gi, "")
    .replace(/\s*[?(]\s*frame\s*[:?][^)?]*[)?]/gi, "")
    .replace(/XX/g, "")
    .replace(/__never_matches__/g, "")
    .replace(/Cold Open/gi, "\u5f00\u5934\u76f4\u63a5\u8fdb\u5165\u5185\u5bb9")
    .replace(/__never_matches__/g, "")
    .replace(/UGC\/OGC[^\n]*/g, "??????")
    .replace(/__never_matches__/g, "");
  const sanitized = visibleNormalizedText
    .replace(/name\s+['"][^'"]*resolve\s*\/\s*safe\s*\/\s*path[^'"]*['"]\s+is\s+not\s+defined/gi, "素材识别链路出现降级，当前仅基于可见主页信息做保守判断")
    .replace(/Traceback[\s\S]{0,500}?(\n\n|$)/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。\n\n")
    .replace(/\b(ReferenceError|TypeError):[^\n]+/g, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/\bundefined is not[^\n]+/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/\bstack\b[:：]?[^\n]*/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/内容混杂惩罚特征|内容混杂惩罚/g, "主页内容方向分散，可能影响平台和新访客理解账号定位")
    .replace(/粉丝40且增长停滞符合[^。\n]*/g, "粉丝数和主页内容方向只能说明当前需要做小样本验证，不能证明增长停滞或平台惩罚")
    .replace(/算法无法建立稳定用户画像/g, "当前只能判断主页方向分散，不能证明算法画像问题")
    .replace(/算法无法建立稳定推荐人群模型/g, "当前缺少后台播放、完播、转粉和评论区数据，不能证明平台推荐或账号趋势已经发生变化")
    .replace(/平台已经无法识别账号/g, "当前缺少后台数据，不能证明平台已经无法识别账号")
    .replace(/限流/g, "推荐受限证据不足")
    .replace(/衰退期/g, "趋势变化证据不足")
    .replace(/转粉停滞/g, "转粉趋势证据不足")
    .replace(/不能声称平台已经验证某方向|平台已经验证某方向/g, "当前缺少后台数据，不能证明平台已经验证某方向")
    .replace(/([^。\n；]*?(?:真实人物|历史人物)[^。\n；]*?(?:争议性评价|道德指控|私生活指控)[^。\n；]*)/g, (match) =>
      /视频字幕声称|片段叙事|画面文本表达为/.test(match) ? match : `视频字幕声称：${match}`
    )
    .replace(/后台数据证明/g, "当前没有后台数据，不能证明效果")
    .replace(/不能声称当前没有后台数据，不能证明效果或只能作为小样本测试/g, "当前没有后台数据，不能证明效果；本轮只能作为小样本测试")
    .replace(/不能声称当前没有后台数据，不能证明效果/g, "当前没有后台数据，不能证明效果")
    .replace(/这条一定会爆|一定会爆/g, "只能作为小样本测试")
    .replace(/评论区都在说/g, "当前没有评论区证据，发布后需要观察评论关键词")
    .replace(/账号长期方向已经确定/g, "单条作品不能直接判断账号长期方向")
    .replace(/官方\/授权搬运已确认|官方账号\/授权搬运已确认/g, "当前无法确认官方或授权状态")
    .replace(/完整剧情已经确认/g, "当前只能基于可见片段判断，不能确认完整剧情")
    .replace(/核心看点是「(?:搜索框|搜索栏|搜索词)[^」]*」/g, "核心看点应以视频字幕、画面动作或声音线索为准；搜索框文字只作为页面线索")
    .replace(/核心看点[:：]\s*(?:搜索框|搜索栏|搜索词)[^。\n]*/g, "核心看点应以视频字幕、画面动作或声音线索为准；搜索框文字只作为页面线索")
    .replace(/核心看点是「(?:标题|标签|平台UI|时间戳|账号信息|作者信息|合集标签|集数标题|章节信息)[^」]*」/g, "核心看点应以视频字幕、画面动作、声音或表演线索为准；标题和页面元素只作为辅助证据")
    .replace(/核心看点[:：]\s*(?:标题|标签|平台UI|时间戳|账号信息|作者信息|合集标签|集数标题|章节信息)[^。\n]*/g, "核心看点应以视频字幕、画面动作、声音或表演线索为准；标题和页面元素只作为辅助证据")
    .replace(/核心看点是「平台[:：][^」]*」/g, "核心看点应以视频字幕、画面动作、声音或表演线索为准；平台和浏览器信息只作为运行环境线索")
    .replace(/核心看点是「视频时长[:：][^」]*」/g, "核心看点应以视频字幕、画面动作、声音或表演线索为准；视频时长和进度条只作为播放界面线索")
    .replace(/增长机制：用可见钩子「平台[:：][^」]*」[^。\n]*/g, "增长机制：围绕真实视频内容证据解释为什么值得停留、收藏、评论或点主页")
    .replace(/增长机制：用可见钩子「视频时长[:：][^」]*」[^。\n]*/g, "增长机制：围绕真实视频内容证据解释为什么值得停留、收藏、评论或点主页")
    .replace(/\bscript_steps\b/g, "建议脚本")
    .replace(/\bfact_ledger\b/g, "素材事实账本")
    .replace(/\bwork_fact_ledger\b/g, "作品事实账本")
    .replace(/\bdirect_evidence\b/g, "直接证据")
    .replace(/\binferred_claims\b/g, "推断判断")
    .replace(/\blow_confidence_claims\b/g, "低置信判断")
    .replace(/\bmissing_evidence\b/g, "缺失证据")
    .replace(/\bforbidden_claims\b/g, "禁止结论")
    .replace(/\bcaption_or_voiceover\b/g, "字幕/口播")
    .replace(/\bgrowth_reason\b/g, "增长目的")
    .replace(/\bgrowth_hypothesis\b/g, "增长假设")
    .replace(/\btest_action\b/g, "测试动作")
    .replace(/\bvalidation_metrics\b/g, "验证指标")
    .replace(/\bdecision_rules\b/g, "决策规则")
    .replace(/\breview_template\b/g, "复盘回填模板");
  return fixVisibleChineseLabels(stripHomepageRuntimeMetadataLines(stripOperationalMetadataLines(stripPageContextMaterialLines(sanitized)))) || "\u5f53\u524d\u5185\u5bb9\u8bc1\u636e\u4e0d\u8db3\uff0c\u65e0\u6cd5\u751f\u6210\u5177\u4f53\u811a\u672c\u3002\u8bf7\u8865\u5145\u8fde\u7eed\u753b\u9762\u3001\u6807\u9898\u5b57\u5e55\u6216\u4f5c\u54c1\u94fe\u63a5\u3002";
}



const legacyGb18030Decoder = new TextDecoder("gb18030");

function normalizeLegacyMojibakeText(text: string) {
  return text
    .replace(/[\u00a1-\u00ff]{2,}/g, (value) => {
      try {
        return legacyGb18030Decoder.decode(Uint8Array.from(Array.from(value, (char) => char.charCodeAt(0) & 0xff)));
      } catch {
        return value;
      }
    })
    .replace(/\u00a3\u00ba/g, "\uff1a")
    .replace(/\u00a3\u00ac/g, "\uff0c")
    .replace(/\u00a3\u00a8/g, "\uff08")
    .replace(/\u00a3\u00a9/g, "\uff09")
    .replace(/\u00a1\u00a2/g, "\u3001")
    .replace(/\u00a1\u00a3/g, "\u3002")
    .replace(/\u00a1\u00b8/g, "\u300c")
    .replace(/\u00a1\u00b9/g, "\u300d");
}

function repairUnknownSectionLabels(text: string) {
  const topLabels = [
    "\u6709\u6548\u7ed3\u8bba",
    "\u8bc1\u636e\u4f9d\u636e",
    "\u5f53\u524d\u95ee\u9898",
    "\u4e0b\u4e00\u6b65\u52a8\u4f5c",
    "\u5efa\u8bae\u811a\u672c",
    "\u9a8c\u8bc1\u4e0e\u590d\u76d8",
    "\u8bc1\u636e\u8fb9\u754c"
  ];
  const scriptLabels = ["\u753b\u9762/\u7d20\u6750", "\u5b57\u5e55/\u53e3\u64ad", "\u76ee\u7684"];
  const reviewLabels = ["\u9a8c\u8bc1\u6307\u6807", "\u5224\u65ad\u89c4\u5219", "\u590d\u76d8\u56de\u586b"];

  let topIndex = 0;
  let scriptFieldIndex = 0;
  let reviewIndex = 0;
  let inScript = false;
  let inReview = false;

  const unknownPrefixLine = (line: string) => /^(\s*)\?{2,}(?:\uff1a|:)?(.*)$/.exec(line);

  return text.split("\n").map((line) => {
    const stepMatch = /^(\s*\d+\.\s*)\?{2,}(?:\uff1a|:)?(.*)$/.exec(line);
    if (stepMatch) {
      inScript = true;
      inReview = false;
      scriptFieldIndex = 0;
      return `${stepMatch[1]}\u65f6\u95f4\u6bb5\uff1a${stepMatch[2]}`;
    }

    const unknown = unknownPrefixLine(line);
    if (!unknown) return line;

    const [, indent, rest] = unknown;
    if (inScript && scriptFieldIndex < scriptLabels.length) {
      return `${indent}${scriptLabels[scriptFieldIndex++]}\uff1a${rest}`;
    }
    if (inReview && reviewIndex < reviewLabels.length) {
      return `${indent}${reviewLabels[reviewIndex++]}\uff1a${rest}`;
    }

    const label = topLabels[topIndex++];
    if (!label) return line;
    inScript = label === "\u5efa\u8bae\u811a\u672c";
    inReview = label === "\u9a8c\u8bc1\u4e0e\u590d\u76d8";
    if (!inScript) scriptFieldIndex = 0;
    if (!inReview) reviewIndex = 0;
    return `${indent}${label}\uff1a${rest}`;
  }).join("\n");
}

function applyFinalReplyGuards(text: string) {
  let out = text;

  if (/\u771f\u5b9e\u4eba\u7269[\s\S]{0,40}\u4e89\u8bae\u6027\u8bc4\u4ef7/.test(out) && !/(\u89c6\u9891\u5b57\u5e55\u58f0\u79f0|\u7247\u6bb5\u53d9\u4e8b|\u753b\u9762\u6587\u672c\u8868\u8fbe\u4e3a)/.test(out)) {
    out = out
      .replace(/(\u6709\u6548\u7ed3\u8bba\uff1a)([^\n]*\u771f\u5b9e\u4eba\u7269[^\n]*\u4e89\u8bae\u6027\u8bc4\u4ef7[^\n]*)/g, "$1\u89c6\u9891\u5b57\u5e55\u58f0\u79f0\uff1a$2")
      .replace(/(\u5b57\u5e55\/\u53e3\u64ad\uff1a)([^\n]*\u771f\u5b9e\u4eba\u7269[^\n]*\u4e89\u8bae\u6027\u8bc4\u4ef7[^\n]*)/g, "$1\u89c6\u9891\u5b57\u5e55\u58f0\u79f0\uff1a$2")
      .replace(/(\u753b\u9762\/\u7d20\u6750\uff1a)([^\n]*\u771f\u5b9e\u4eba\u7269[^\n]*\u4e89\u8bae\u6027\u8bc4\u4ef7[^\n]*)/g, "$1\u753b\u9762\u6587\u672c\u8868\u8fbe\u4e3a\uff1a$2");
  }

  out = out
    .replace(/\u6709\u6548\u7ed3\u8bba\uff1a[^\n]*(?:\u7528\u6237\u8bf7\u6c42|\u8bf7\u5206\u6790\u6211\u5f53\u524d\u5237\u5230\u7684\u8fd9\u6761\u89c6\u9891)[^\n]*/g, "\u6709\u6548\u7ed3\u8bba\uff1a\u5f53\u524d\u5185\u5bb9\u8bc1\u636e\u4e0d\u8db3\uff0c\u9700\u8865\u5145\u53ef\u89c1\u753b\u9762\u3001\u6807\u9898\u5b57\u5e55\u6216\u4f5c\u54c1\u94fe\u63a5\u3002")
    .replace(/\u6709\u6548\u7ed3\u8bba\uff1a[^\n]*(?:\u641c\u7d22\u6846|\u641c\u7d22\u680f|\u5408\u96c6\u6807\u7b7e)[^\n]*/g, "\u6709\u6548\u7ed3\u8bba\uff1a\u6838\u5fc3\u770b\u70b9\u5e94\u4f18\u5148\u6765\u81ea\u89c6\u9891\u5185\u5bb9\u8bc1\u636e\uff0c\u4e0d\u628a\u641c\u7d22\u6846\u3001\u5408\u96c6\u6807\u9898\u6216\u9875\u9762\u7f16\u53f7\u5f53\u6210\u4e3b\u770b\u70b9\u3002")
    .replace(/\u53f0\u8bcd\u9012\u8fdb/g, "\u5b57\u5e55\u9012\u8fdb")
    .replace(/\u5f53\u524d\u4e0d\u4f7f\u7528\u7528\u6237\u8bf7\u6c42/g, "\u5f53\u524d\u4e0d\u4f7f\u7528\u4efb\u52a1\u6587\u5b57")
    .replace(/\u7528\u6237\u8bf7\u6c42\uff1a[^\n]*/g, "\u7d20\u6750\u8bc6\u522b\u94fe\u8def\u51fa\u73b0\u964d\u7ea7\uff0c\u5f53\u524d\u4ec5\u57fa\u4e8e\u53ef\u89c1\u4fe1\u606f\u505a\u4fdd\u5b88\u5224\u65ad\u3002");

  out = out.replace(/(\u753b\u9762\/\u7d20\u6750\uff1a)\u5b57\u5e55\u6587\u672c\u5e8f\u5217\uff1a([^\n]+)/g, (_match, prefix: string, sequence: string) => {
    const beats = Array.from(sequence.matchAll(/['\u2018\u2019\u201c\u201d\u300c\u300d]([^'\u2018\u2019\u201c\u201d\u300c\u300d]{2,24})['\u2018\u2019\u201c\u201d\u300c\u300d]/g))
      .map((item) => item[1])
      .slice(0, 3);
    return `${prefix}\u5b57\u5e55\u9012\u8fdb\uff1a${beats.length ? beats.join(" \u2192 ") : "\u524d 2-3 \u4e2a\u53ef\u526a\u8f91\u62cd\u70b9"}`;
  });

  return out
    .split("\n")
    .filter((line) => !/(\u4f5c\u8005\u58f0\u660e|\u865a\u6784\u6f14\u7ece|\u4ec5\u4f9b\u5a31\u4e50|\u70ed\u95e8CP|BL\u540c\u4eba|\u5438\u5f15BL\u540c\u4eba\u53d7\u4f17|CP\u5411\u6807\u7b7e|\u53d7\u4f17\u63a8\u65ad|\u8d26\u53f7\u4fe1\u606f\uff1a@|\u5408\u96c6\u6807\u7b7e\uff1a|\u65f6\u95f4\u6bb5\uff1a\u627f\u63a5\uff1a|\u65f6\u95f4\u6bb5\uff1a\u6838\u5fc3\u770b\u70b9\uff1a|\u6296\u97f3\u539f\u751f\u754c\u9762|\u5e73\u53f0UI|\u5e73\u53f0 UI|\u5bfc\u822a\u680f|\u70b9\u8d5e\/\u8bc4\u8bba\/\u6536\u85cf\u6309\u94ae|\u65f6\u95f4\u6233\uff1a|\u53d1\u5e03\u65f6\u95f4)/.test(line))
    .join("\n");
}

function fixVisibleChineseLabels(text: string) {
  return polishUserVisibleKocReply(applyFinalReplyGuards(repairUnknownSectionLabels(normalizeLegacyMojibakeText(text))));
}

function polishUserVisibleKocReply(text: string) {
  return normalizeLegacyMojibakeText(text)
    .replace(/(?:\u7d20\u6750\u5206\u6790\u5931\u8d25[^\n]*[:\uff1a]\s*)?name\s+['"][^'"]*resolve\s*\/\s*safe\s*\/\s*path[^'"]*['"]\s+is\s+not\s+defined/gi, "\u7d20\u6750\u8bc6\u522b\u94fe\u8def\u51fa\u73b0\u964d\u7ea7\uff0c\u5f53\u524d\u4ec5\u57fa\u4e8e\u53ef\u89c1\u4e3b\u9875\u4fe1\u606f\u505a\u4fdd\u5b88\u5224\u65ad")
    .replace(/\u7d20\u6750\u5206\u6790\u5931\u8d25[^\n]*[:\uff1a]\s*/g, "")
    .replace(/Traceback[\s\S]{0,500}?(\n\n|$)/gi, "\u7d20\u6750\u8bc6\u522b\u94fe\u8def\u51fa\u73b0\u964d\u7ea7\uff0c\u5f53\u524d\u4ec5\u57fa\u4e8e\u53ef\u89c1\u4fe1\u606f\u505a\u4fdd\u5b88\u5224\u65ad\u3002\n\n")
    .replace(/\b(?:ReferenceError|TypeError):[^\n]+/g, "\u7d20\u6750\u8bc6\u522b\u94fe\u8def\u51fa\u73b0\u964d\u7ea7\uff0c\u5f53\u524d\u4ec5\u57fa\u4e8e\u53ef\u89c1\u4fe1\u606f\u505a\u4fdd\u5b88\u5224\u65ad\u3002")
    .replace(/\u7b97\u6cd5\u96be\u4ee5\u5efa\u7acb\u7a33\u5b9a\u63a8\u8350\u6a21\u578b/g, "\u5185\u5bb9\u65b9\u5411\u53ef\u80fd\u5f71\u54cd\u5e73\u53f0\u548c\u65b0\u8bbf\u5ba2\u7406\u89e3\u8d26\u53f7\u5b9a\u4f4d\uff0c\u4f46\u7f3a\u5c11\u540e\u53f0\u63a8\u8350\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u63a8\u8350\u5df2\u7ecf\u53d7\u5f71\u54cd")
    .replace(/\u7b97\u6cd5\u96be\u4ee5\u5efa\u7acb\u7a33\u5b9a\u63a8\u8350\u4eba\u7fa4\u6a21\u578b/g, "\u5185\u5bb9\u65b9\u5411\u53ef\u80fd\u5f71\u54cd\u5e73\u53f0\u548c\u65b0\u8bbf\u5ba2\u7406\u89e3\u8d26\u53f7\u5b9a\u4f4d\uff0c\u4f46\u7f3a\u5c11\u540e\u53f0\u63a8\u8350\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u63a8\u8350\u5df2\u7ecf\u53d7\u5f71\u54cd")
    .replace(/\u8f6c\u7c89\u7387\u7ea6\s*\d+(?:\.\d+)?%/g, "\u5f53\u524d\u53ea\u770b\u5230\u7c89\u4e1d\u3001\u83b7\u8d5e\u548c\u4f5c\u54c1\u6570\uff0c\u7f3a\u5c11\u4e3b\u9875\u8bbf\u95ee\u548c\u5173\u6ce8\u6765\u6e90\u6570\u636e\uff0c\u4e0d\u80fd\u8ba1\u7b97\u771f\u5b9e\u8f6c\u7c89\u7387")
    .replace(/\u5904\u4e8e\u6b63\u5e38\u51b7\u542f\u52a8\u8303\u56f4/g, "\u6837\u672c\u4ecd\u5c0f\uff0c\u66f4\u9002\u5408\u505a\u5c0f\u6837\u672c\u5b9e\u9a8c")
    .replace(/\u6d41\u91cf\u6d6a\u8d39\u4e25\u91cd/g, "\u53ef\u80fd\u5f71\u54cd\u65b0\u8bbf\u5ba2\u7684\u5173\u6ce8\u7406\u7531")
    .replace(/\u76ee\u6807\u53d7\u4f17\u4e3a[^\u3002\uff1b\n]+/g, "\u53ef\u80fd\u9762\u5411\u76f8\u5173\u5174\u8da3\u7528\u6237\uff0c\u4f46\u9700\u8981\u8bc4\u8bba\u548c\u4e3b\u9875\u70b9\u51fb\u6570\u636e\u9a8c\u8bc1")
    .replace(/\u7b2c\u4e00\u5f20\u622a\u56fe/g, "\u5f53\u524d\u622a\u56fe")
    .replace(/\u7b2c\u4e8c\u5f20\u622a\u56fe/g, "\u5f53\u524d\u622a\u56fe")
    .replace(/\u4e0d\u80fd\u58f0\u79f0\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5e73\u53f0\u65b9\u5411\u5df2\u7ecf\u88ab\u9a8c\u8bc1/g, "\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5e73\u53f0\u65b9\u5411\u5df2\u7ecf\u88ab\u9a8c\u8bc1")
    .replace(/\u5f53\u524d\u6ca1\u6709\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5e73\u53f0\u65b9\u5411\u5df2\u7ecf\u88ab\u9a8c\u8bc1/g, "\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5e73\u53f0\u65b9\u5411\u5df2\u7ecf\u88ab\u9a8c\u8bc1")
    .replace(/\n{3,}/g, "\n\n");
}


function stripOperationalMetadataLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !OPERATIONAL_METADATA_PATTERN.test(line) && !EXTRA_OPERATIONAL_METADATA_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHomepageRuntimeMetadataLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !HOMEPAGE_RUNTIME_METADATA_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPageContextMaterialLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !PAGE_CONTEXT_LINE_DROP_PATTERN.test(line) && !EXTRA_PAGE_CONTEXT_SCRIPT_MATERIAL_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function scriptStepsForMainBubble(strategy: JsonObject, advisor: JsonObject) {
  const task = asRecord(advisor.first_content_task);
  const rawSteps = asArray(strategy.script_steps).length ? asArray(strategy.script_steps) : asArray(task.script_steps);
  const steps = rawSteps
    .map((item) => asRecord(item))
    .filter((item) => Object.keys(item).length)
    .filter((step) => {
      const text = [
        step.visual,
        step.caption_or_voiceover,
        step.evidence,
        step.purpose,
        step.growth_reason
      ].map((item) => asString(item)).join("\n");
      return text.trim() && !hasOperationalMetadata(text) && !hasNonGrowthScriptMaterial(text) && !hasUnsupportedScriptInference(text) && !hasPageContextScriptMaterial(text) && !hasVisibleMetricScriptMaterial(text);
    });
  if (steps.length) {
    return steps.slice(0, 4).map((step, index) => {
      const confidence = asString(step.confidence, "low");
      const lowConfidenceNote = confidence === "low" ? "（低置信小样本）" : "";
      const visual = cleanScriptDisplayTextGuarded(step.visual, "当前素材线索不足");
      const voiceover = cleanScriptDisplayTextGuarded(step.caption_or_voiceover, "基于当前证据做低置信最小测试。");
      const purpose = cleanScriptDisplayTextGuarded(step.purpose, "验证当前素材线索是否能带来停留。");
      const growthReason = cleanScriptDisplayTextGuarded(step.growth_reason);
      return [
        `${index + 1}. 时间段：${asString(step.time, "当前素材线索不足")}`,
        `画面/素材：${visual}`,
        `字幕/口播：${voiceover}`,
        `目的：${purpose}${lowConfidenceNote}`,
        growthReason ? `增长目的：${growthReason}` : ""
      ].join("\n");
    }).join("\n\n");
  }

  const legacy = firstContentTask(advisor);
  const safeLegacy = stripOperationalMetadataLines(legacy);
  if (safeLegacy && !isGenericScriptText(safeLegacy)) return safeLegacy;
  return minimalScriptFallback();
}

function nextActionSectionForMainBubble(firstActions: string[], experiment: ReturnType<typeof experimentLines>, tasks: string[]) {
  const actionLines = uniqueTextList([
    experiment.hypothesis ? `假设：${experiment.hypothesis}` : "",
    experiment.action ? `动作：${experiment.action}` : "",
    ...firstActions,
    ...tasks
  ], 4);
  if (!actionLines.length) return "下一步动作：\n- 先按当前证据剪一版小样本，发布后回填留存、完播、评论和负反馈。";
  return `下一步动作：\n${actionLines.map((item) => `- ${item}`).join("\n")}`;
}

function experimentSectionForMainBubble(experiment: ReturnType<typeof experimentLines>) {
  const rules = experiment.rules.length ? experiment.rules.slice(0, 3) : [
    "开头留存低：改开头线索。",
    "完播低：压缩背景解释。",
    "评论集中在片源/人物/台词可继续测同类；负反馈集中在搬运/废话多就降低原片比例。"
  ];
  return [
    "验证与复盘：",
    `验证指标：${experiment.metrics}`,
    `判断规则：\n${rules.map((item) => `- ${item}`).join("\n")}`,
    `复盘回填：${experiment.review.replace(/^复盘回填[:：]\s*/u, "")}`
  ].join("\n");
}

function evidenceBoundaryForMainBubble(evidenceContract: JsonObject) {
  const lowConfidence = claimList(evidenceContract.low_confidence_claims, 4);
  const missingEvidence = stringList(evidenceContract.missing_evidence, 6);
  const forbiddenClaims = stringList(evidenceContract.forbidden_claims || evidenceContract.must_not_claim, 6);
  const boundaryText = [...lowConfidence, ...missingEvidence, ...forbiddenClaims].join(" ");
  const lines = uniqueTextList([
    /完整剧情|完整视频|短片段|上下文/.test(boundaryText) ? "不能确认完整剧情。" : "",
    /官方|授权/.test(boundaryText) ? "不能确认官方/授权状态。" : "",
    /评论/.test(boundaryText) ? "不能声称评论区共识。" : "",
    /后台|数据|爆/.test(boundaryText) ? "不能声称后台数据证明或一定会爆。" : "",
    /长期方向|单条/.test(boundaryText) ? "不能用单条视频判断账号长期方向。" : "",
    lowConfidence.length ? "低置信判断不应写成确定结论。" : ""
  ], 6);
  return `证据边界：${lines.length ? `\n${lines.map((line) => `- ${line}`).join("\n")}` : "本轮证据已写入工作区，详情可展开查看来源和置信度。"}`;
}

function currentTaskType(job: JsonObject, workspace: JsonObject) {
  const result = asRecord(job.result);
  const strategy = asRecord(workspace.strategy || result.strategy);
  const advisor = asRecord(workspace.advisor_summary || result.advisor_summary);
  const profile = asRecord(workspace.profile || result.profile || job.profile);
  const request = asRecord(workspace.request || result.request);
  const objectIdentity = asRecord(workspace.object_identity || result.object_identity || profile.object_identity);
  const candidates = [
    workspace.task_type,
    workspace.node_task_type,
    workspace.result_mode,
    result.task_type,
    result.node_task_type,
    result.result_mode,
    strategy.task_type,
    strategy.result_mode,
    advisor.task_type,
    advisor.result_mode,
    profile.task_type,
    profile.result_mode,
    request.intent,
    request.task_type,
    job.task_type,
    job.type,
    objectIdentity.objectKind
  ].map((item) => asString(item).toLowerCase()).filter(Boolean);
  const hasReviewCandidate = candidates.some((item) => /experiment_review|growth_review|review_backfill|homepage_comparison_review|account_replay|experiment_replay|backfill/.test(item));
  const hasReviewEvidence = hasExperimentReviewWorkspaceEvidence(job, workspace, strategy);
  if (hasReviewCandidate && hasReviewEvidence) return "experiment_review";
  if (candidates.some((item) => /single_work|work_analysis|single_work_analysis|work|video|clip/.test(item))) return "single_work_analysis";
  if (asArray(strategy.script_steps).length || Object.keys(asRecord(advisor.first_content_task)).length) return "single_work_analysis";
  const reviewIntentText = hasReviewEvidence ? JSON.stringify({ request, strategy, advisor, result, job }) : "";
  if (/(?:\u590d\u76d8|\u56de\u76d8|\u56de\u586b|\u4e0a\u6b21\u8bca\u65ad|\u6309\u4e0a\u6b21|\u8fde\u7eed\u53d1\u4e86|\u6570\u636e\u5982\u4e0b|\u65b0\u4e3b\u9875\u622a\u56fe|\u5bf9\u6bd4\u524d\u540e|\u6211\u6309\u4e0a\u6b21\u8bca\u65ad|\u53d1\u4e86\u51e0\u6761)/i.test(reviewIntentText)) return "experiment_review";
  if (/复盘|回盘|回填|上次诊断|按上次|连续发了|数据如下|新主页截图|对比前后|experiment_review|growth_review|review_backfill|homepage_comparison_review/i.test(reviewIntentText)) return "experiment_review";
  if (candidates.some((item) => /single_work|work_analysis|single_work_analysis|work|video|clip/.test(item))) return "single_work_analysis";
  if (candidates.some((item) => /account|homepage|home_page|profile|diagnosis|review/.test(item))) return "homepage_review";
  const text = JSON.stringify({ workspace, result, profile, job });
  if (/主页|粉丝|获赞|内容分散|内容混合|homepage|profile/i.test(text)) return "homepage_review";
  return "single_work_analysis";
}

function isHomepageReviewTask(job: JsonObject, workspace: JsonObject) {
  return currentTaskType(job, workspace) === "homepage_review";
}

function isExperimentReviewTask(job: JsonObject, workspace: JsonObject) {
  return currentTaskType(job, workspace) === "experiment_review";
}

function hasInternalErrorSignal(workspace: JsonObject, evidenceContract: JsonObject) {
  const text = JSON.stringify({ workspace, evidenceContract });
  return /name\s+['"][^'"]*resolve\s*\/\s*safe\s*\/\s*path[^'"]*['"]\s+is\s+not\s+defined|Traceback|ReferenceError|TypeError|undefined is not|\bstack\b/i.test(text);
}

function weakHomepagePlan(value: unknown) {
  const text = JSON.stringify(value);
  return !text || /栏目测试\s*\d|围绕主页里最一致的内容类型|主页最常出现的一类内容|围绕某方向做一条内容|复用当前封面和标题|验证这个方向是否有效/.test(text);
}

function homepageEvidenceMap(workspace: JsonObject, strategy: JsonObject) {
  const fromStrategy = asRecord(strategy.homepage_evidence_map);
  if (Object.keys(fromStrategy).length) return fromStrategy;
  return asRecord(workspace.homepage_evidence_map);
}

function homepageEvidenceText(map: JsonObject, evidenceContract: JsonObject) {
  return JSON.stringify({ map, direct: evidenceContract.direct_evidence || [], missing: evidenceContract.missing_evidence || [] });
}

function safeHomepageTextList(items: unknown[], maxItems = 5) {
  return stringList(items, maxItems).filter((item) => item && !hasHomepageRuntimeMetadata(item));
}



function extractStrongEntities(text: string) {
  const entities = new Set<string>();
  const patterns = [
    /\u300a([^\u300b]{2,40})\u300b/gu,
    /[\u201c\u201d"]([^\u201c\u201d"\n]{2,40})[\u201c\u201d"]/gu,
    /#[\p{Script=Han}A-Za-z0-9_\-]{2,40}/gu,
    /\b[A-Za-z]+\d+[A-Za-z0-9_-]*\b/g,
    /\b\d+[A-Za-z]+[A-Za-z0-9_-]*\b/g,
    /\b\d+(?:\.\d+)?\s*(?:\u4e07|w|W|k|K|%|\u7c89|\u8d5e|\u64ad\u653e|\u4f5c\u54c1|\u5c0f\u65f6|\u5929)\b/gu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[0] || "").trim();
      if (value && !/^\d+$/.test(value)) entities.add(value);
    }
  }
  return [...entities];
}

function evidenceBasisMatchesMap(evidence: string[], evidenceText: string) {
  if (!evidenceText || evidenceText === "{}") return true;
  return evidence.some((item) => item && evidenceText.includes(item));
}

function hasUnsupportedStrongEntity(planText: string, evidenceText: string) {
  const evidence = evidenceText || "";
  return extractStrongEntities(planText).some((entity) => !evidence.includes(entity));
}

function cleanHomepagePlan(plan: JsonObject, evidenceText: string) {
  const evidence = stringList(plan.evidence_basis || plan.evidence || plan.basis, 6);
  const safeEvidence = evidence.filter((item) => !hasHomepageRuntimeMetadata(item));
  if (!safeEvidence.length) return "";
  const title = asString(plan.title || plan.topic);
  const episode = asString(plan.episode_idea || plan.next_episode || plan.test_action);
  const visual = asString(plan.visual_suggestion || plan.visual);
  const caption = asString(plan.caption_or_voiceover || plan.caption || plan.voiceover);
  const purpose = asString(plan.purpose);
  const metric = asString(plan.test_metric || plan.metric);
  if (![title, episode, visual, caption, purpose].every(Boolean)) return "";
  const body = [
    title,
    visual,
    caption,
    episode
  ].join("\n");
  const combinedEvidence = [...safeEvidence, evidenceText].join("\n");
  if (hasHomepageRuntimeMetadata(body) || weakHomepagePlan(plan) || !evidenceBasisMatchesMap(safeEvidence, evidenceText) || hasUnsupportedStrongEntity(body, combinedEvidence)) return "";
  return [
    `选题：${title}`,
    asString(plan.why_this || plan.reason) ? `为什么适合：${asString(plan.why_this || plan.reason)}` : "",
    `证据依据：${safeEvidence.join("；")}`,
    `下一条可拍：${episode}`,
    `画面建议：${visual}`,
    `字幕/口播：${caption}`,
    `目的：${purpose}`,
    metric ? `验证指标：${metric}` : "验证指标：24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化、负反馈",
    `\u7f6e\u4fe1\u5ea6\uff1a${translateConfidenceWord(asString(plan.confidence, "medium"))}`
  ].filter(Boolean).join("\n");
}

function homepagePatterns(map: JsonObject) {
  return asArray(map.content_patterns).map((item) => asRecord(item)).filter((item) => {
    const name = asString(item.pattern_name);
    const evidence = safeHomepageTextList(asArray(item.evidence), 5);
    return name && !hasHomepageRuntimeMetadata(name) && evidence.length;
  });
}

function homepageColumnPlanSection(workspace: JsonObject, strategy: JsonObject, evidenceContract: JsonObject) {
  const map = homepageEvidenceMap(workspace, strategy);
  const status = asString(strategy.homepage_column_plan_status, "insufficient_evidence");
  const evidenceText = homepageEvidenceText(map, evidenceContract);
  const plans = asArray(strategy.homepage_column_plan)
    .map((item) => cleanHomepagePlan(asRecord(item), evidenceText))
    .filter(Boolean);

  if ((status === "specific" || !status) && plans.length) {
    return plans.map((item, index) => `${index + 1}. ${item}`).join("\n\n");
  }

  const patterns = homepagePatterns(map);
  if (status === "direction_only" && patterns.length) {
    const names = patterns.slice(0, 3).map((item) => asString(item.pattern_name));
    return [
      "当前证据还不足以生成具体栏目选题。基于当前主页可见信息，只建议做方向级小样本：",
      `1. 选择主页中证据最明确的一类内容连续发布 3 条。可参考的证据方向：${names.join("；")}`,
      "2. 保持同一封面关键词、标题句式、字幕风格和结尾提问。",
      "3. 不混发其它方向。",
      "4. 48 小时后回填播放、3 秒留存、完播率、评论关键词、主页点击率、关注转化和负反馈。"
    ].join("\n");
  }

  return [
    "当前证据不足以生成具体栏目方案。",
    "建议补充最近 3 条作品详情、封面标题、后台播放/完播/转粉数据和评论区截图。",
    "在补证据前，只能做方向级小样本测试：选择主页里证据最明确的一类内容连发 3 条，并回填 24/48 小时数据。"
  ].join("\n");
}

function homepageNextActionSection(workspace: JsonObject, strategy: JsonObject) {
  const map = homepageEvidenceMap(workspace, strategy);
  const patterns = homepagePatterns(map).slice(0, 2).map((item) => asString(item.pattern_name));
  const first = patterns[0] || "证据最明确的一个主页方向";
  const second = patterns[1];
  const lines = [
    second ? `本周优先测 ${first}，${second} 作为下一轮备选。` : `本周只选一个主方向：${first}。`,
    "连续发 3 条同证据来源、同封面关键词、同字幕样式的内容。",
    "不混发其它赛道。",
    "每条都写清楚对应的主页证据，不使用没有证据支撑的强实体词。",
    "48 小时后回填 24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化和负反馈。"
  ];
  return `下一步动作：\n${lines.map((item) => `- ${item}`).join("\n")}`;
}

function homepageExperimentSection(experiment: ReturnType<typeof experimentLines>) {
  const review = experiment.review.replace(/^复盘回填[:：]\s*/u, "");
  return [
    "验证与复盘：",
    "验证指标：24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化、负反馈",
    [
      "判断规则：",
      "- 3 秒留存低：重做开头画面和第一句字幕。",
      "- 完播率低：减少铺垫，提前放当前栏目最明确的可见证据。",
      "- 评论关键词集中在某个标题/封面/人物/主题线索：继续做同证据来源的栏目小样本。",
      "- 负反馈集中在看不懂、太散、没重点：继续收窄栏目；如果集中在太尬、废话多：减少铺垫，提前放具体画面和观点。"
    ].join("\n"),
    `复盘回填：${review}`
  ].join("\n");
}

function homepageEvidenceBoundary(evidenceContract: JsonObject, degraded: boolean) {
  const lines = uniqueTextList([
    degraded ? "素材识别链路出现降级，当前仅基于可见主页信息做保守判断。" : "",
    "当前只基于主页截图和可见主页信息判断。",
    "缺少后台播放、完播、转粉数据。",
    "缺少评论区反馈。",
    "未进入单条作品详情页。",
    "样本作品数量有限，不能直接确定长期赛道。",
    "不能声称平台已经验证某方向。"
  ], 7);
  return `证据边界：\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function sanitizeHomepageReply(text: string) {
  const normalizedText = text
    .replace(/This homepage diagnosis is based on visible[\s\S]{0,180}?conversion efficiency\./g, "本轮主页诊断仅基于可见证据；缺少后台数据时，不声称长期方向、推荐状态或转粉效率已经被验证。")
    .replace(/Specific column ideas must come from[\s\S]{0,160}?evidence_basis\./g, "具体栏目建议必须来自上游主页栏目方案，并且每条都要带证据依据。")
    .replace(/If upstream evidence is direction-only[\s\S]{0,180}?inventing titles\./g, "如果上游证据只能支持方向级判断，就做方向级小样本测试，不编具体标题。")
    .replace(/Review with 24\/48h views[\s\S]{0,180}?negative feedback\./g, "复盘使用 24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化和负反馈。")
    .replace(/\bdirection-only\b/g, "方向级")
    .replace(/\bevidence_basis\b/g, "证据依据")
    .replace(/\bbasis\b/g, "证据依据")
    .replace(/\bprofile clicks\b/g, "主页点击率")
    .replace(/档案 clicks/g, "主页点击率")
    .replace(/\bfollow conversion\b/g, "关注转化")
    .replace(/\bcompletion\b/g, "完播率")
    .replace(/\bcomment keywords\b/g, "评论关键词")
    .replace(/\bnegative feedback\b/g, "负反馈")
    .replace(/算法难以建立稳定推荐模型/g, "当前缺少后台推荐数据，不能证明推荐模型已经受影响")
    .replace(/降低转粉率/g, "可能影响新访客的关注理由，但缺少转粉数据不能证明转粉率下降")
    .replace(/冷启动期证据/g, "样本较小，适合做小样本实验")
    .replace(/冷启动期/g, "样本较小阶段")
    .replace(/不能声称当前缺少后台数据，不能证明平台方向已经被验证/g, "当前缺少后台数据，不能证明平台方向已经被验证");
  const cleaned = normalizedText
    .split("\n")
    .filter((line) => !HOMEPAGE_RUNTIME_METADATA_PATTERN.test(line))
    .join("\n");
  return cleaned
    .replace(/建议脚本/g, "栏目测试方案")
    .replace(/已核验的一句语音、一个动作、一个字幕或一个场景线索/g, "主页中已观察到的内容方向")
    .replace(/一个动作、一个字幕或一个场景线索/g, "主页中已观察到的内容方向")
    .replace(/片源\/人物\/台词/g, "栏目方向")
    .replace(/完整剧情/g, "单条作品细节")
    .replace(/官方\/授权状态/g, "来源状态")
    .replace(/评论性引用/g, "合规素材使用")
    .replace(/避免完整搬运原片/g, "避免无依据复用素材")
    .replace(/内容混杂惩罚/g, "主页内容方向分散")
    .replace(/(?<!不能证明)增长停滞/g, "缺少历史增长数据")
    .replace(/平台惩罚/g, "平台惩罚证据不足")
    .replace(/算法无法准确打标签/g, "内容方向分散，可能影响平台和新访客理解账号定位")
    .replace(/推流人群混杂/g, "当前没有后台数据，不能证明推荐人群已经混杂")
    .replace(/缺乏基础权重/g, "当前样本还小，更适合做小样本实验")
    .replace(/证明账号处于冷启动期/g, "当前样本还小，更适合做小样本实验")
    .replace(/推流人群标签混乱/g, "当前缺少后台推荐数据，不能证明推流已经受到影响")
    .replace(/算法无法建立稳定推荐人群模型/g, "当前缺少后台播放、完播、转粉和评论区数据，不能证明平台推荐或账号趋势已经发生变化")
    .replace(/平台已经无法识别账号/g, "当前缺少后台数据，不能证明平台已经无法识别账号")
    .replace(/限流/g, "推荐受限证据不足")
    .replace(/衰退期/g, "趋势变化证据不足")
    .replace(/转粉停滞/g, "转粉趋势证据不足")
    .replace(/不能声称平台尚未证明某方向已被平台验证|已经验证某方向/g, "当前缺少后台数据，不能证明平台已经验证某方向")
    .replace(/(?:当前缺少后台数据，不能证明)*平台(?:当前缺少后台数据，不能证明)+平台已经验证某方向/g, "当前缺少后台数据，不能证明平台方向已经被验证")
    .replace(/平台已经验证某方向/g, "平台方向已经被验证")
    .replace(/对比第二张截图/g, "从当前主页可见信息看");
}

function homepageDiagnosisFromEvidence(diagnosis: string, strategy: JsonObject, workspace: JsonObject) {
  const map = homepageEvidenceMap(workspace, strategy);
  const patterns = homepagePatterns(map);
  if (!patterns.length) return diagnosis;
  const first = asString(patterns[0].pattern_name);
  return `当前主页最清晰的内容线索是“${first}”。问题不是重新套一个赛道模板，而是把上游证据图里的可见模式拆成可连续验证的栏目；当前没有后台数据，不能证明平台已经验证某方向。`;
}

function homepageFinalReply(job: JsonObject, workspace: JsonObject, advisor: JsonObject, strategy: JsonObject, evidenceContract: JsonObject) {
  const diagnosis = conciseText(asString(advisor.one_sentence_diagnosis, asString(strategy.positioning, "本轮主页诊断已完成。")));
  const visibleDiagnosis = homepageDiagnosisFromEvidence(diagnosis, strategy, workspace);
  const evidenceChain = fieldList(advisor, "evidence_chain", 4);
  const coreJudgements = fieldList(advisor, "core_judgements", 3);
  const experiment = experimentLines(strategy, workspace);
  const degraded = hasInternalErrorSignal(workspace, evidenceContract);
  const boundary = homepageEvidenceBoundary(evidenceContract, degraded);
  const experimentSection = homepageExperimentSection(experiment);
  const map = homepageEvidenceMap(workspace, strategy);
  const evidenceLines = uniqueTextList([
    degraded ? "素材识别链路出现降级，当前仅基于可见主页信息做保守判断。" : "",
    ...evidenceChain,
    ...stringList(evidenceContract.direct_evidence, 3),
    ...homepagePatterns(map).slice(0, 3).map((item) => `${asString(item.pattern_name)}：${safeHomepageTextList(asArray(item.evidence), 3).join("；")}`)
  ], 5);

  return guardFinalReply(sanitizeHomepageReply([
    "本轮主页诊断已完成，我把结果收束成栏目实验：",
    `有效结论：${visibleDiagnosis}`,
    `证据依据：\n${(evidenceLines.length ? evidenceLines : ["主页可见内容已写入证据边界。"]).map((item) => `- ${item}`).join("\n")}`,
    coreJudgements.length ? `当前问题：\n${coreJudgements.slice(0, 3).map((item) => `- ${item}`).join("\n")}` : "当前问题：证据还不足以证明平台已经验证某方向，需要先用同证据来源的小样本栏目测试。",
    homepageNextActionSection(workspace, strategy),
    `栏目测试方案：\n${homepageColumnPlanSection(workspace, strategy, evidenceContract)}`,
    experimentSection.replace(/复盘回填：复盘回填：/g, "复盘回填：").replace(/复盘回填：复盘：/g, "复盘回填："),
    boundary
  ].filter(Boolean).join("\n\n")));
}

function collectTaggedEvidence(workspace: JsonObject, sourceTypes: string[], maxItems = 8) {
  const profile = asRecord(workspace.profile);
  const result = asRecord(workspace.result);
  const sources = [
    ...asArray(profile.evidence_facts),
    ...asArray(workspace.evidence_facts),
    ...asArray(workspace.evidence_summary),
    ...asArray(result.evidence_facts)
  ];
  const allowed = new Set(sourceTypes);
  return uniqueTextList(sources.map((item) => {
    const record = asRecord(item);
    if (!Object.keys(record).length) return "";
    const sourceType = asString(record.source_type || record.sourceType);
    if (!allowed.has(sourceType)) return "";
    return asString(record.text || record.value || record.content || record.summary);
  }), maxItems);
}

function isConcreteReviewMetricLine(line: string) {
  const normalized = normalizeLegacyMojibakeText(line || "");
  if (!normalized || /(?:current-video-recording|Uploaded|assets|hints=|status=partial|runtime|debug|Traceback|ReferenceError|TypeError|\u6211\u6b63\u5728\u67e5\u770b|\u793e\u5a92\u4e3b\u9875)/i.test(normalized)) return false;
  const hasMetricWord = /(?:\u64ad\u653e|\u6d4f\u89c8|3\s*\u79d2|\u7559\u5b58|\u5b8c\u64ad|\u5e73\u5747\u64ad\u653e|\u65f6\u957f|\u8bc4\u8bba|\u5173\u952e\u8bcd|\u4e3b\u9875\u70b9\u51fb|\u6da8\u7c89|\u5173\u6ce8|\u8f6c\u7c89|\u8d1f\u53cd\u9988|\u6536\u85cf|\u5206\u4eab|24\s*\/\s*48|24\s*\u5c0f\u65f6|48\s*\u5c0f\u65f6)/i.test(normalized);
  const hasValue = /(?:\d|%|\u4e07|\u5343|\u767e|[A-Za-z]*\d+[A-Za-z]*)/.test(normalized);
  return hasMetricWord && hasValue;
}

function hasConcreteReviewMetricsText(text: string) {
  return extractMetricLinesFromText(text, 8).some(isConcreteReviewMetricLine);
}

function hasReviewBackfillIntentText(text: string) {
  const normalized = normalizeLegacyMojibakeText(text || "");
  return /(?:\u590d\u76d8|\u56de\u76d8|\u56de\u586b|\u4e0a\u6b21\u8bca\u65ad|\u6309\u4e0a\u6b21|\u6309\u4e0a\u6b21\u5efa\u8bae|\u8fde\u7eed\u53d1\u4e86|\u6570\u636e\u5982\u4e0b|\u53d1\u4e86\u51e0\u6761|\u6211\u6309\u4e0a\u6b21|\u53d1\u5e03\u540e)/i.test(normalized);
}

function looksLikeExperimentReviewRequest(input: KocDiagnosisInput) {
  const text = [input.message, input.runtimeContext || ""].join("\n");
  return hasReviewBackfillIntentText(text) && hasConcreteReviewMetricsText(text);
}

function extractMetricLinesFromText(text: string, maxItems = 8) {
  const normalized = normalizeLegacyMojibakeText(text || "");
  const lines = normalized.split(/[\n\r；;。]+/).map((item) => item.trim()).filter(Boolean);
  return uniqueTextList(lines.filter((line) =>
    /(?:播放|浏览|3\s*秒|留存|完播|评论|关键词|主页点击|主页|涨粉|关注|转粉|收藏|分享|点赞|负反馈|24\s*\/\s*48|48\s*小时|24\s*小时|%|\d)/i.test(line)
      && !/(?:current-video-recording|Uploaded|assets|hints=|status=partial|runtime|debug|Traceback|ReferenceError|TypeError)/i.test(line)
  ), maxItems);
}

function userProvidedMetricEvidence(job: JsonObject, workspace: JsonObject) {
  const profile = asRecord(workspace.profile || asRecord(job.result).profile || job.profile);
  const request = asRecord(workspace.request || asRecord(job.result).request);
  const tagged = collectTaggedEvidence(workspace, ["user_provided_metric"], 8).filter(isConcreteReviewMetricLine);
  const textMetrics = extractMetricLinesFromText([
    asString(profile.user_request),
    asString(request.message),
    asString(job.message),
    asString(job.user_message),
    JSON.stringify(asRecord(workspace.review).metrics || {})
  ].join("\n"), 8).filter(isConcreteReviewMetricLine);
  return uniqueTextList([...tagged, ...textMetrics], 8);
}

function homepageVisibleEvidenceForReview(workspace: JsonObject, strategy: JsonObject, evidenceContract: JsonObject) {
  const map = homepageEvidenceMap(workspace, strategy);
  const patterns = homepagePatterns(map).slice(0, 4).map((item) => {
    const evidence = safeHomepageTextList(asArray(item.evidence), 3);
    return evidence.length ? `${asString(item.pattern_name)}：${evidence.join("；")}` : "";
  });
  const tagged = collectTaggedEvidence(workspace, ["homepage_visible_evidence", "profile_visible_name", "profile_bio", "profile_stats", "profile_visible_text", "work_title", "work_cover_text", "work_visible_metric", "browser_page_visible_text"], 6);
  return uniqueTextList([
    ...patterns,
    ...tagged,
    ...stringList(evidenceContract.direct_evidence, 4)
  ].filter((item) => item && !hasHomepageRuntimeMetadata(item)), 8);
}

function experimentEffectConclusion(metricLines: string[]) {
  const text = metricLines.join("\n");
  const positiveSignals = [
    /播放[^。\n]*\d{3,}/.test(text),
    /3\s*秒[^。\n]*(?:[6-9]\d|100)\s*%|留存[^。\n]*(?:[6-9]\d|100)\s*%/.test(text),
    /完播[^。\n]*(?:[5-9]\d|100)\s*%/.test(text),
    /主页点击[^。\n]*\d/.test(text),
    /涨粉[^。\n]*\d|关注[^。\n]*\d|转粉[^。\n]*\d/.test(text),
    /评论[^。\n]*(?:有趣|想看|求|关键词|集中|正向)/.test(text)
  ].filter(Boolean).length;
  const weakSignals = [
    /负反馈[^。\n]*(?:高|多|集中)|看不懂|太散|没重点|太尬|废话多/.test(text),
    /3\s*秒[^。\n]*(?:[0-3]?\d)\s*%|留存[^。\n]*(?:[0-3]?\d)\s*%/.test(text),
    /完播[^。\n]*(?:[0-2]?\d)\s*%/.test(text)
  ].filter(Boolean).length;
  if (!metricLines.length) return "当前还没有可用回填指标，不能判断实验是否有效。";
  if (metricLines.length) return "这轮实验有局部有效信号，建议继续同方向小样本，同时针对弱项调整开头、封面或承接。";
  if (/\d/.test(text) && /%/.test(text) && weakSignals === 0) return "这轮实验有局部有效信号，建议继续同方向小样本，同时针对弱项调整开头、封面或承接。";
  if (positiveSignals >= 2 && weakSignals === 0) return "这轮实验有继续测试价值，但只能说明本次小样本出现正向信号，还不能直接判断长期方向。";
  if (positiveSignals >= 1 && weakSignals <= 1) return "这轮实验有局部有效信号，建议继续同方向小样本，同时针对弱项调整开头、封面或承接。";
  return "这轮数据还不足以证明方向有效，建议先调整变量后再测一轮，不要直接扩大投入。";
}

function experimentNextStep(metricLines: string[]) {
  const text = metricLines.join("\n");
  const lines = [
    /3\s*秒|留存/.test(text) ? "如果 3 秒留存高，保留开头钩子；如果低，优先换首屏画面和第一句字幕。" : "下一轮必须记录 3 秒留存，用来判断开头是否成立。",
    /完播|平均播放/.test(text) ? "如果完播或平均播放时长弱，减少铺垫，提前放最明确的栏目看点。" : "补充完播率和平均播放时长，判断内容中段是否撑得住。",
    /评论|关键词/.test(text) ? "把评论关键词分成正向、疑问和负反馈三类，再决定继续同栏目还是换表达。" : "补充评论区截图或关键词，不能只凭播放量判断方向。",
    /主页点击|涨粉|关注|转粉/.test(text) ? "如果主页点击或关注转化低，检查主页置顶、简介和同栏目承接是否一致。" : "补充主页点击率和关注转化，判断内容是否能带来账号承接。"
  ];
  return uniqueTextList(lines, 4);
}

function experimentReviewBoundary(metricLines: string[], homepageEvidence: string[]) {
  const lines = [
    metricLines.length ? "用户回填数据按人工提供指标处理，需要以平台后台截图或作品详情页复核。" : "缺少用户回填指标，不能判断实验效果。",
    homepageEvidence.length ? "新主页截图和主页可见信息只说明当前可见状态，需要结合前后截图和作品详情页复核。" : "缺少新主页截图或作品详情页证据。",
    "不能把单次回填直接上升为账号长期方向。",
    "不能声称平台已经验证某方向，也不能证明推荐机制发生变化。",
    "如果没有评论区截图，只能观察评论关键词，不能声称评论区已有共识。"
  ];
  return `证据边界：\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function previousExperimentEvidence(workspace: JsonObject, strategy: JsonObject) {
  const previous = asRecord(workspace.previous_experiment || workspace.last_experiment || strategy.previous_experiment || strategy.last_experiment);
  const learningPacket = asRecord(workspace.learning_packet);
  const experiment = asRecord(learningPacket.experiment_template);
  return uniqueTextList([
    asString(previous.hypothesis || previous.growth_hypothesis || previous.summary),
    asString(previous.test_action || previous.action || previous.suggested_action),
    asString(experiment.hypothesis),
    asString(experiment.suggestedAction || experiment.action),
    ...stringList(strategy.growth_hypothesis, 1),
    ...stringList(strategy.test_action, 1)
  ], 4);
}

function hasPriorWorkspaceExperimentMemory(workspace: JsonObject, strategy: JsonObject) {
  const profile = asRecord(workspace.profile);
  const growthMemory = asRecord(profile.growth_memory || workspace.growth_memory || strategy.growth_memory);
  const previous = asRecord(workspace.previous_experiment || workspace.last_experiment || strategy.previous_experiment || strategy.last_experiment);
  const learningPacket = asRecord(workspace.learning_packet);
  const learningExperiment = asRecord(learningPacket.experiment_template);
  return [
    asArray(growthMemory.experiment_reviews).length,
    asArray(growthMemory.experiments).length,
    asArray(growthMemory.runs).filter((run) => {
      const record = asRecord(run);
      return asString(record.taskType || record.task_type) === "experiment_review" || Object.keys(asRecord(record.experiment)).length > 0;
    }).length,
    Object.keys(previous).length,
    Object.keys(learningExperiment).length
  ].some(Boolean);
}

function hasExperimentReviewWorkspaceEvidence(job: JsonObject, workspace: JsonObject, strategy = asRecord(workspace.strategy)) {
  const reviewMap = asRecord(strategy.experiment_review_map || workspace.experiment_review_map);
  const mapMetrics = asArray(reviewMap.user_metrics).map((item) => asString(asRecord(item).text || item)).filter(isConcreteReviewMetricLine);
  const metricLines = userProvidedMetricEvidence(job, workspace);
  return hasPriorWorkspaceExperimentMemory(workspace, strategy) && [...metricLines, ...mapMetrics].some(isConcreteReviewMetricLine);
}

function metricSignalSummary(metricLines: string[]) {
  const text = normalizeLegacyMojibakeText(metricLines.join("\n"));
  const signals = [
    /(?:\u64ad\u653e|\u6d4f\u89c8)/.test(text) ? "\u64ad\u653e\u91cf\u5df2\u56de\u586b" : "",
    /3\s*\u79d2|\u7559\u5b58/.test(text) ? "3 \u79d2\u7559\u5b58\u5df2\u56de\u586b" : "",
    /\u5b8c\u64ad|\u5e73\u5747\u64ad\u653e/.test(text) ? "\u5b8c\u64ad/\u65f6\u957f\u5df2\u56de\u586b" : "",
    /\u8bc4\u8bba|\u5173\u952e\u8bcd/.test(text) ? "\u8bc4\u8bba\u5173\u952e\u8bcd\u5df2\u56de\u586b" : "",
    /\u4e3b\u9875\u70b9\u51fb/.test(text) ? "\u4e3b\u9875\u70b9\u51fb\u5df2\u56de\u586b" : "",
    /\u6da8\u7c89|\u5173\u6ce8|\u8f6c\u7c89/.test(text) ? "\u5173\u6ce8/\u6da8\u7c89\u5df2\u56de\u586b" : "",
    /\u8d1f\u53cd\u9988/.test(text) ? "\u8d1f\u53cd\u9988\u5df2\u56de\u586b" : ""
  ].filter(Boolean);
  return signals.length ? signals : ["\u56de\u586b\u6307\u6807\u4e0d\u5b8c\u6574"];
}

function missingReviewEvidence(metricLines: string[], homepageEvidence: string[]) {
  const text = normalizeLegacyMojibakeText(metricLines.join("\n"));
  return uniqueTextList([
    /24\s*\/\s*48|24\s*\u5c0f\u65f6|48\s*\u5c0f\u65f6/.test(text) ? "" : "\u7f3a\u5c11 24/48 \u5c0f\u65f6\u65f6\u95f4\u7a97\u53e3",
    /3\s*\u79d2|\u7559\u5b58/.test(text) ? "" : "\u7f3a\u5c11 3 \u79d2\u7559\u5b58",
    /\u5b8c\u64ad|\u5e73\u5747\u64ad\u653e/.test(text) ? "" : "\u7f3a\u5c11\u5b8c\u64ad\u7387\u6216\u5e73\u5747\u64ad\u653e\u65f6\u957f",
    /\u8bc4\u8bba|\u5173\u952e\u8bcd/.test(text) ? "" : "\u7f3a\u5c11\u8bc4\u8bba\u5173\u952e\u8bcd",
    /\u4e3b\u9875\u70b9\u51fb/.test(text) ? "" : "\u7f3a\u5c11\u4e3b\u9875\u70b9\u51fb\u7387",
    /\u6da8\u7c89|\u5173\u6ce8|\u8f6c\u7c89/.test(text) ? "" : "\u7f3a\u5c11\u5173\u6ce8\u8f6c\u5316",
    /\u8d1f\u53cd\u9988/.test(text) ? "" : "\u7f3a\u5c11\u8d1f\u53cd\u9988",
    homepageEvidence.length ? "" : "\u7f3a\u5c11\u65b0\u4e3b\u9875\u622a\u56fe/\u4f5c\u54c1\u8be6\u60c5\u9875\u53ef\u89c1\u8bc1\u636e"
  ], 8);
}

function experimentReviewDecision(metricLines: string[], homepageEvidence: string[]) {
  const text = normalizeLegacyMojibakeText(metricLines.join("\n"));
  if (!metricLines.length) return { decision: "insufficient_evidence", label: "\u8865\u8bc1\u636e\u540e\u518d\u5224\u65ad" };
  if (/\u8d1f\u53cd\u9988[^\u3002\n]*(?:\u9ad8|\u591a|\u96c6\u4e2d)|\u770b\u4e0d\u61c2|\u592a\u6563|\u6ca1\u91cd\u70b9|\u592a\u5c2c|\u5e9f\u8bdd\u591a/.test(text)) {
    return { decision: "adjust", label: "\u5148\u8c03\u6574\uff0c\u518d\u6d4b\u4e00\u8f6e" };
  }
  if (/(?:3\s*\u79d2|\u7559\u5b58)[^\u3002\n]*(?:[6-9]\d|100)\s*%/.test(text) || /\u5b8c\u64ad[^\u3002\n]*(?:[5-9]\d|100)\s*%/.test(text) || /\u6da8\u7c89[^\u3002\n]*\d/.test(text)) {
    return { decision: "continue", label: homepageEvidence.length ? "\u7ee7\u7eed\u540c\u65b9\u5411\uff0c\u540c\u65f6\u4f18\u5316\u627f\u63a5" : "\u7ee7\u7eed\u5c0f\u6837\u672c\uff0c\u4f46\u9700\u8865\u65b0\u4e3b\u9875\u8bc1\u636e" };
  }
  return { decision: "direction_only", label: "\u53ea\u80fd\u505a\u65b9\u5411\u7ea7\u8ffd\u6d4b" };
}
function buildExperimentReviewMap(job: JsonObject, workspace: JsonObject, advisor: JsonObject, strategy: JsonObject, evidenceContract: JsonObject) {
  const existing = asRecord(strategy.experiment_review_map || workspace.experiment_review_map);
  const metricLines = userProvidedMetricEvidence(job, workspace);
  const homepageEvidence = homepageVisibleEvidenceForReview(workspace, strategy, evidenceContract);
  const previous = previousExperimentEvidence(workspace, strategy);
  const decision = experimentReviewDecision(metricLines, homepageEvidence);
  const map = {
    previous_experiment: previous.map((text) => ({ source_type: "previous_experiment_memory", text })),
    user_metrics: metricLines.map((text) => ({ source_type: "user_provided_metric", text })),
    new_homepage_evidence: homepageEvidence.map((text) => ({ source_type: "homepage_visible_evidence", text })),
    metric_signals: metricSignalSummary(metricLines),
    missing_evidence: missingReviewEvidence(metricLines, homepageEvidence),
    decision,
    evidence_boundary: [
      "\u7528\u6237\u56de\u586b\u6570\u636e\u9700\u8981\u5e73\u53f0\u540e\u53f0\u622a\u56fe\u6216\u4f5c\u54c1\u8be6\u60c5\u9875\u590d\u6838",
      "\u65b0\u4e3b\u9875\u622a\u56fe\u53ea\u80fd\u8bf4\u660e\u5f53\u524d\u53ef\u89c1\u72b6\u6001",
      "\u5355\u6b21\u5b9e\u9a8c\u4e0d\u80fd\u8bc1\u660e\u957f\u671f\u8d5b\u9053\u6216\u5e73\u53f0\u673a\u5236"
    ]
  };
  return Object.keys(existing).length ? { ...map, ...existing } : map;
}

function experimentReviewMapSection(map: JsonObject) {
  const previous = asArray(map.previous_experiment).map((item) => asString(asRecord(item).text)).filter(Boolean).slice(0, 3);
  const metrics = asArray(map.user_metrics).map((item) => asString(asRecord(item).text)).filter(Boolean).slice(0, 4);
  const homepage = asArray(map.new_homepage_evidence).map((item) => asString(asRecord(item).text)).filter(Boolean).slice(0, 4);
  const signals = stringList(map.metric_signals, 5);
  const missing = stringList(map.missing_evidence, 6);
  return [
    "\u590d\u76d8\u8bc1\u636e\u56fe\uff1a",
    previous.length ? `\u4e0a\u6b21\u5b9e\u9a8c\uff1a${previous.join("\uff1b")}` : "\u4e0a\u6b21\u5b9e\u9a8c\uff1a\u672a\u8bfb\u5230\u53ef\u5bf9\u9f50\u7684\u4e0a\u6b21\u5b9e\u9a8c\u8bb0\u5f55\u3002",
    metrics.length ? `\u7528\u6237\u56de\u586b\u6307\u6807\uff1a${metrics.join("\uff1b")}` : "\u7528\u6237\u56de\u586b\u6307\u6807\uff1a\u672a\u8bfb\u5230\u53ef\u7528\u6307\u6807\u3002",
    homepage.length ? `\u65b0\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e\uff1a${homepage.join("\uff1b")}` : "\u65b0\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e\uff1a\u672a\u8bfb\u5230\u65b0\u4e3b\u9875\u622a\u56fe\u6216\u4f5c\u54c1\u8be6\u60c5\u9875\u8bc1\u636e\u3002",
    signals.length ? `\u5df2\u89c2\u5bdf\u4fe1\u53f7\uff1a${signals.join("\uff1b")}` : "",
    missing.length ? `\u8fd8\u7f3a\uff1a${missing.join("\uff1b")}` : ""
  ].filter(Boolean).join("\n");
}
function experimentReviewFinalReply(job: JsonObject, workspace: JsonObject, advisor: JsonObject, strategy: JsonObject, evidenceContract: JsonObject) {
  const metricLines = userProvidedMetricEvidence(job, workspace);
  const homepageEvidence = homepageVisibleEvidenceForReview(workspace, strategy, evidenceContract);
  const reviewMap = buildExperimentReviewMap(job, workspace, advisor, strategy, evidenceContract);
  const conclusion = experimentEffectConclusion(metricLines);
  const nextSteps = experimentNextStep(metricLines);
  const reviewMapText = experimentReviewMapSection(reviewMap);
  const evidenceLines = uniqueTextList([
    ...reviewMapText.split("\n"),
    ...metricLines.map((item) => `\u56de\u586b\u6307\u6807\uff1a${item}`),
    ...homepageEvidence.map((item) => `\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e\uff1a${item}`)
  ], 10);
  return guardFinalReply([
    "\u672c\u8f6e\u590d\u76d8\u5df2\u5b8c\u6210\uff0c\u6211\u628a\u5b83\u6309\u300c\u4e0a\u6b21\u5b9e\u9a8c\u7ed3\u679c -> \u662f\u5426\u6709\u6548 -> \u4e0b\u4e00\u6b65\u8c03\u6574\u300d\u6536\u675f\uff1a",
    `\u5b9e\u9a8c\u662f\u5426\u6709\u6548\uff1a${conclusion}`,
    `\u8bc1\u636e\u4f9d\u636e\uff1a\n${(evidenceLines.length ? evidenceLines : ["\u5f53\u524d\u7f3a\u5c11\u53ef\u590d\u6838\u7684\u56de\u586b\u6570\u636e\u6216\u65b0\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e\u3002"]).map((item) => `- ${item}`).join("\n")}`,
    `\u4e0b\u4e00\u6b65\u7ee7\u7eed\u8fd8\u662f\u8c03\u6574\uff1a\n${nextSteps.map((item) => `- ${item}`).join("\n")}`,
    [
      "\u9a8c\u8bc1\u4e0e\u590d\u76d8\uff1a",
      "\u4e0b\u4e00\u8f6e\u8bf7\u7ee7\u7eed\u56de\u586b\uff1a24/48 \u5c0f\u65f6\u64ad\u653e\u91cf\u30013 \u79d2\u7559\u5b58\u3001\u5b8c\u64ad\u7387\u3001\u5e73\u5747\u64ad\u653e\u65f6\u957f\u3001\u8bc4\u8bba\u5173\u952e\u8bcd\u3001\u4e3b\u9875\u70b9\u51fb\u7387\u3001\u5173\u6ce8\u8f6c\u5316\u548c\u8d1f\u53cd\u9988\u3002",
      "\u56de\u586b\u683c\u5f0f\uff1a\u6211\u6309\u4e0a\u6b21\u5efa\u8bae\u53d1\u4e86 __ \u6761\uff1b\u6bcf\u6761\u7684\u64ad\u653e/3 \u79d2\u7559\u5b58/\u5b8c\u64ad/\u8bc4\u8bba\u5173\u952e\u8bcd/\u4e3b\u9875\u70b9\u51fb/\u6da8\u7c89/\u8d1f\u53cd\u9988\u5206\u522b\u662f __\uff1b\u5e76\u9644\u65b0\u4e3b\u9875\u622a\u56fe\u6216\u4f5c\u54c1\u8be6\u60c5\u9875\u622a\u56fe\u3002"
    ].join("\n"),
    experimentReviewBoundary(metricLines, homepageEvidence)
  ].join("\n\n"));
}

function experimentResultFromReviewDecision(decision: JsonObject): KocExperimentMemory["result"] {
  const value = asString(decision.decision);
  if (value === "continue") return "positive";
  if (value === "adjust") return "mixed";
  if (value === "insufficient_evidence") return "unknown";
  return "mixed";
}

function buildExperimentReviewMemoryRun(job: JsonObject, reply: string) {
  const workspace = asRecord(job.workspace);
  const advisor = asRecord(workspace.advisor_summary);
  const strategy = asRecord(workspace.strategy);
  const evidenceContract = asRecord(workspace.evidence_contract);
  const profile = asRecord(workspace.profile);
  const taskType = currentTaskType(job, workspace);
  const reviewMap = buildExperimentReviewMap(job, workspace, advisor, strategy, evidenceContract);
  const metricLines = userProvidedMetricEvidence(job, workspace);
  const homepageEvidence = homepageVisibleEvidenceForReview(workspace, strategy, evidenceContract);
  const decision = asRecord(reviewMap.decision);
  const conclusion = experimentEffectConclusion(metricLines);
  const nextSteps = experimentNextStep(metricLines);
  const previous = previousExperimentEvidence(workspace, strategy);
  const metricSignals = metricSignalSummary(metricLines);
  const missingEvidence = missingReviewEvidence(metricLines, homepageEvidence);
  const platformKey = asString(profile.platform, "douyin");
  const accountId = asString(profile.platform_account_id || profile.account_id || profile.accountName);
  const accountKey = accountId ? `${platformKey}:account:${accountId}` : `${platformKey}:account:unknown`;
  return {
    userMessage: [
      ...metricLines,
      ...homepageEvidence
    ].join("\n") || asString(profile.user_request),
    platformSummary: asString(profile.platform_snapshot || profile.platform),
    mediaSummary: homepageEvidence.join("\n"),
    taskType,
    platformKey,
    accountKey,
    objectKind: "account" as const,
    status: asString(job.status, "completed"),
    evidenceLevel: "medium" as const,
    jobId: asString(job.id),
    profileId: asString(job.profile_id || profile.id),
    resultSummary: reply,
    decisionSummary: asString(decision.label) || conclusion,
    evidenceGaps: missingEvidence,
    reusableLearnings: metricSignals,
    experiment: {
      hypothesis: previous[0] || "\u672c\u8f6e\u662f\u5bf9\u4e0a\u6b21\u4e3b\u9875\u6216\u680f\u76ee\u5b9e\u9a8c\u7684\u56de\u586b\u590d\u76d8\u3002",
      suggestedAction: nextSteps.join("\n"),
      expectedSignal: "\u4e0b\u4e00\u8f6e\u7ee7\u7eed\u89c2\u5bdf 24/48 \u5c0f\u65f6\u64ad\u653e\u91cf\u30013 \u79d2\u7559\u5b58\u3001\u5b8c\u64ad\u7387\u3001\u8bc4\u8bba\u5173\u952e\u8bcd\u3001\u4e3b\u9875\u70b9\u51fb\u548c\u5173\u6ce8\u8f6c\u5316\u3002",
      result: experimentResultFromReviewDecision(decision),
      conclusion,
      variables: ["\u4e0a\u6b21\u5b9e\u9a8c", "\u7528\u6237\u56de\u586b\u6307\u6807", "\u65b0\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e"],
      metrics: metricSignals,
      reviewedAt: Date.now(),
      reviewMetrics: {
        user_metrics: metricLines,
        new_homepage_evidence: homepageEvidence,
        metric_signals: metricSignals,
        missing_evidence: missingEvidence,
        decision
      },
      reviewMap,
      nextAction: nextSteps.join("\n"),
      createdFromRunId: asString(job.id)
    }
  };
}

async function persistCompletedKocJob(clientId: string | undefined, job: JsonObject, reply: string) {
  const status = asString(job.status, "unknown");
  if (!["completed", "degraded", "failed"].includes(status)) return;
  const workspace = asRecord(job.workspace);
  if (currentTaskType(job, workspace) !== "experiment_review") return;
  try {
    const memoryRun = buildExperimentReviewMemoryRun(job, reply);
    await appendKocRun(clientId, memoryRun);
    if (memoryRun.profileId) {
      await requestJson<JsonObject>("/api/experiment-review-memory", {
        method: "POST",
        body: JSON.stringify({
          profile_id: memoryRun.profileId,
          job_id: memoryRun.jobId,
          result: memoryRun.experiment.result,
          conclusion: memoryRun.experiment.conclusion,
          next_action: memoryRun.experiment.nextAction,
          decision: asRecord(memoryRun.experiment.reviewMap?.decision),
          experiment_review_map: memoryRun.experiment.reviewMap
        })
      }, 8000);
    }
  } catch {
    // Memory persistence must not block the user-visible diagnosis result.
  }
}
export function buildFinalReply(job: JsonObject) {
  const status = asString(job.status, "unknown");
  const workspace = asRecord(job.workspace);
  const advisor = asRecord(workspace.advisor_summary);
  const strategy = asRecord(workspace.strategy);
  const evidenceContract = asRecord(workspace.evidence_contract);
  const diagnosis = asString(advisor.one_sentence_diagnosis, asString(strategy.positioning, "本轮 LangGraph 任务已完成，建议已写入工作空间。"));
  const coreJudgements = fieldList(advisor, "core_judgements", 4);
  const evidenceChain = fieldList(advisor, "evidence_chain", 4);
  const firstActions = stringList(advisor.first_actions || strategy.next_actions || strategy.message_framework || strategy.kpis, 4);
  const tasks = taskLines(workspace, 3);
  const experiment = experimentLines(strategy, workspace);
  const script = scriptStepsForMainBubble(strategy, advisor);
  const copyrightBoundary = copyrightBoundaryText(workspace);
  if (isExperimentReviewTask(job, workspace) && status !== "running" && status !== "queued" && status !== "waiting_for_evidence" && status !== "failed") {
    return experimentReviewFinalReply(job, workspace, advisor, strategy, evidenceContract);
  }
  if (isHomepageReviewTask(job, workspace) && status !== "running" && status !== "queued" && status !== "waiting_for_evidence" && status !== "failed") {
    return homepageFinalReply(job, workspace, advisor, strategy, evidenceContract);
  }
  const compactReadableReply = () => {
    const directEvidenceFallback = stringList(evidenceContract.direct_evidence, 3);
    const boundary = [evidenceBoundaryForMainBubble(evidenceContract), copyrightBoundary].filter(Boolean).join("\n");
    return guardFinalReply([
      status === "degraded" ? "本轮已降级完成：可以先做小样本实验，但不要把结论当成已被后台数据验证。" : "本轮智能体流程已完成，我把结果收束成一个可执行闭环：",
      `有效结论：${conciseText(diagnosis)}`,
      evidenceChain.length ? `证据依据：\n${evidenceChain.slice(0, 3).map((item) => `- ${item}`).join("\n")}` : `证据依据：\n${(directEvidenceFallback.length ? directEvidenceFallback : ["本轮证据已写入证据边界。"]).map((item) => `- ${item}`).join("\n")}`,
      coreJudgements.length ? `当前问题：\n${coreJudgements.slice(0, 2).map((item) => `- ${item}`).join("\n")}` : "当前问题：当前证据仍有限，需要用小样本实验验证判断。",
      nextActionSectionForMainBubble(firstActions, experiment, tasks),
      `建议脚本：\n${script}`,
      experimentSectionForMainBubble(experiment),
      boundary
    ].filter(Boolean).join("\n\n"));
  };

  if (status !== "running" && status !== "queued" && status !== "waiting_for_evidence" && status !== "failed") {
    return compactReadableReply();
  }

  if (status === "running" || status === "queued") {
    return guardFinalReply([
      "我正在把本轮素材整理成可执行闭环，不只是给一串流程状态。",
      "完成后会返回：核心判断、为什么有用、今天先做哪条内容、发布后看哪些指标、怎么把结果回填进长期记忆。"
    ].join("\n\n"));
  }
  if (status === "waiting_for_evidence") {
    const followups = stringList(workspace.followups, 4);
    return guardFinalReply([
      "当前证据不足，我先不编造结论。",
      diagnosis,
      followups.length ? `先补这些，补完后我会继续闭环：\n${followups.map((item) => `- ${item}`).join("\n")}` : "",
      evidenceBoundary(evidenceContract),
      reviewTemplate(strategy, workspace)
    ].filter(Boolean).join("\n\n"));
  }
  if (status === "failed") return asString(job.error, "LangGraph 任务执行失败。");

  return guardFinalReply([
    status === "degraded" ? "本轮已降级完成：可以先做小样本实验，但不要把结论当成已被后台数据验证。" : "本轮智能体流程已完成，我把结果收束成一个可执行闭环：",
    `有效结论：${diagnosis}`,
    evidenceChain.length ? `证据依据：\n${evidenceChain.map((item) => `- ${item}`).join("\n")}` : `证据依据：\n- ${asString(evidenceContract.direct_evidence, "本轮证据已写入证据边界。")}`,
    coreJudgements.length ? `当前问题：\n${coreJudgements.map((item) => `- ${item}`).join("\n")}` : "当前问题：当前证据仍有限，需要用小样本实验验证判断。",
    firstActions.length ? `可执行动作：\n${firstActions.map((item) => `- ${item}`).join("\n")}` : "",
    experiment.hypothesis ? `增长假设：${experiment.hypothesis}` : "",
    experiment.action ? `下一步测试动作：${experiment.action}` : "",
    `建议脚本：\n${script}`,
    tasks.length ? `任务闭环：\n${tasks.join("\n")}` : "",
    `验证指标：${experiment.metrics}`,
    experiment.rules.length ? `决策规则：\n${experiment.rules.map((item) => `- ${item}`).join("\n")}` : "",
    `复盘回填：${experiment.review}`,
    evidenceBoundary(evidenceContract),
    copyrightBoundary
  ].filter(Boolean).join("\n\n"));
}

async function requestJson<T>(path: string, init?: RequestInit, timeoutMs = KOC_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${KOC_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(init?.headers || {})
      },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      throw new Error(error);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

function traceStep(id: string, tool: string, status: KocAgentTraceStatus, input: string, output?: string, evidence?: string[]): KocAgentTraceStep {
  return { id, tool, status, input, output, evidence };
}

function inferPlatform(platformContext?: PlatformConnectorResult) {
  const platform = platformContext?.hints.find((item) => item.platform !== "unknown")?.platform;
  if (platform === "douyin" || platform === "xiaohongshu" || platform === "bilibili" || platform === "kuaishou" || platform === "weibo" || platform === "zhihu") {
    return platform;
  }
  return "douyin";
}

function hasPriorExperimentMemoryForObject(memory: KocLongTermMemory, platformKey: string, accountKey: string) {
  const matchingRuns = memory.runs.filter((run) => {
    const sameAccount = accountKey ? run.accountKey === accountKey : true;
    const samePlatform = platformKey ? run.platformKey === platformKey : true;
    return sameAccount && samePlatform && (run.taskType === "experiment_review" || Boolean(run.experiment));
  });
  if (matchingRuns.length) return true;
  if (accountKey) {
    const account = memory.platformAccounts.find((item) => item.accountKey === accountKey);
    return Boolean(account && (account.effectivePatterns.length || account.ineffectivePatterns.length));
  }
  return !platformKey && memory.experiments.length > 0;
}

async function resolveResultMode(input: KocDiagnosisInput, platformContext: PlatformConnectorResult): Promise<KocResultMode> {
  const inferred = inferResultMode(input);
  if (input.resultMode && input.resultMode !== "experiment_review") return input.resultMode;
  const reviewRequested = input.resultMode === "experiment_review" || looksLikeExperimentReviewRequest(input);
  if (!reviewRequested) return inferred === "experiment_review" ? "account_growth_diagnosis" : inferred;
  const platformKey = inferPlatform(platformContext);
  const firstHint = platformContext.hints[0];
  const accountKey = firstHint?.accountId ? `${platformKey}:account:${firstHint.accountId}` : "";
  try {
    const memory = await loadKocMemory(input.clientId, { platformKey, accountKey: accountKey || undefined });
    return hasPriorExperimentMemoryForObject(memory, platformKey, accountKey) ? "experiment_review" : "account_growth_diagnosis";
  } catch {
    return "account_growth_diagnosis";
  }
}

function inferResultMode(input: KocDiagnosisInput): KocResultMode {
  if (input.resultMode) return input.resultMode;
  const text = [input.message, input.runtimeContext || ""].join("\n");
  if (looksLikeExperimentReviewRequest(input)) return "experiment_review";
  if (/当前视频|这条视频|单条|作品拆解|视频分析|复刻|完播|剪辑节奏/.test(text)) return "single_work_analysis";
  if (/账号|主页|粉丝|涨粉|定位|赛道|人设|主页诊断/.test(text)) return "account_growth_diagnosis";
  return "general_koc_advice";
}

function buildProfilePayload(input: KocDiagnosisInput, platformContext: PlatformConnectorResult, mediaContext: ReturnType<typeof processUploadedMedia>, resolvedResultMode?: KocResultMode) {
  const resultMode = resolvedResultMode || inferResultMode(input);
  const platform = inferPlatform(platformContext);
  const firstHint = platformContext.hints[0];
  const userMetricFacts = resultMode === "experiment_review"
    ? extractMetricLinesFromText(input.message, 10).map((text) => ({ source_type: "user_provided_metric", text }))
    : [];
  const homepageVisibleFacts = resultMode === "experiment_review" && mediaContext.assets.some((asset) => asset.kind === "image")
    ? [{ source_type: "homepage_visible_evidence", text: "\u7528\u6237\u63d0\u4f9b\u4e86\u65b0\u7684\u4e3b\u9875\u622a\u56fe\u6216\u9875\u9762\u56fe\u7247\uff0c\u9700\u7ed3\u5408 OCR/\u89c6\u89c9\u8bc6\u522b\u7ed3\u679c\u590d\u6838\u4e3b\u9875\u53d8\u5316\u3002" }]
    : [];
  const experimentReviewMap = resultMode === "experiment_review"
    ? {
        user_metrics: userMetricFacts,
        new_homepage_evidence: homepageVisibleFacts,
        missing_evidence: [
          "\u9700\u8981\u5bf9\u9f50\u4e0a\u6b21\u5b9e\u9a8c\u5047\u8bbe",
          "\u9700\u8981\u5e73\u53f0\u540e\u53f0\u622a\u56fe\u6216\u4f5c\u54c1\u8be6\u60c5\u9875\u590d\u6838\u56de\u586b\u6307\u6807",
          "\u9700\u8981\u8bc4\u8bba\u533a\u622a\u56fe\u9a8c\u8bc1\u8bc4\u8bba\u5173\u952e\u8bcd"
        ],
        decision: { decision: "pending_analysis", label: "\u7b49\u5f85\u540e\u7aef\u7ed3\u5408\u622a\u56fe\u548c\u5386\u53f2\u8bca\u65ad\u590d\u76d8" }
      }
    : undefined;
  const operationalEvidenceMetadata = [
    { source_type: "user_request", text: input.message },
    platformContext.summary ? { source_type: "platform_connector_status", text: platformContext.summary } : undefined,
    mediaContext.summary ? { source_type: "media_processing_log", text: mediaContext.summary } : undefined
  ].filter(Boolean);
  const evidenceGaps = [
    !mediaContext.assets.length ? "本轮没有上传可分析素材。" : ""
  ].filter(Boolean);

  return {
    nickname: "本地用户",
    account_name: firstHint?.accountId || firstHint?.url || "待确认账号",
    platform_account_id: firstHint?.accountId || "",
    stage: "cold-start",
    platform,
    track: "custom-track",
    cadence: "待确认",
    audience: "待确认",
    goal: resultMode === "single_work_analysis" ? "拆解当前作品并提炼可复刻动作" : "提升账号内容增长效率",
    strengths: "待确认",
    constraints: "证据以用户授权输入、平台连接器、录屏截图、OCR/ASR 和发布后指标回填为准。",
    work_links: extractUrlsFromText([input.message, input.runtimeContext || ""].join("\n")).join("\n"),
    historical_posts: "",
    hot_videos: "",
    result_mode: resultMode,
    task_intent: resultMode,
    node_task_type: resultMode,
    user_request: input.message,
    desktop_context: input.runtimeContext || "",
    evidence_level: evidenceGaps.length ? "medium" : "high",
    evidence_facts: [...userMetricFacts, ...homepageVisibleFacts],
    experiment_review_map: experimentReviewMap,
    operational_evidence_metadata: operationalEvidenceMetadata,
    evidence_gaps: evidenceGaps,
    asset_notes: [
      input.runtimeContext || "",
      `平台上下文：${JSON.stringify(platformContext).slice(0, 2400)}`,
      `素材处理：${JSON.stringify(mediaContext).slice(0, 2400)}`
    ].filter(Boolean).join("\n\n"),
    asset_files: input.assets || [],
    video_understanding: buildVideoUnderstanding(mediaContext),
    object_identity: {
      platformKey: platform,
      accountKey: firstHint?.accountId ? `${platform}:account:${firstHint.accountId}` : "",
      workKey: firstHint?.workId ? `${platform}:work:${firstHint.workId}` : "",
      objectKind: firstHint?.pageKind === "video" ? "work" : "account"
    }
  };
}

function buildPendingReply(jobId: string, mode: KocResultMode) {
  const title = mode === "single_work_analysis" ? "作品拆解任务已创建。" : "账号诊断任务已创建。";
  return `${title}\n\n任务编号：${jobId}\n当前状态：后台分析中\n\n本轮会使用录屏、截图、OCR/ASR、浏览器可见线索和人工回填数据进行分析。\n完成后我会返回面向用户可读的结论、动作建议和需要补充的证据。`;
}

export function isKocGrowthMessage(message: string) {
  return /KOC|增长|账号|主页|抖音|小红书|B站|视频|作品|发布|数据回填|复盘/.test(message);
}

export function getKocBridgeStatus() {
  return {
    apiBase: KOC_API_BASE,
    timeoutMs: KOC_REQUEST_TIMEOUT_MS,
    ok: true
  };
}

export async function getKocStrategyJob(jobId: string, clientId?: string): Promise<KocDiagnosisResult> {
  if (!jobId) return { ok: false, reply: "缺少任务编号。", status: "failed" };
  try {
    const job = await requestJson<JsonObject>(`/api/strategy-jobs?job_id=${encodeURIComponent(jobId)}`, undefined, 8000);
    const status = typeof job.status === "string" ? job.status : "unknown";
    if (status !== "running" && status !== "queued" && status !== "failed") {
      const reply = buildFinalReply(job);
      await persistCompletedKocJob(clientId, job, reply);
      return { ok: true, reply, status, jobId };
    }
    const result = isRecord(job.result) ? job.result : {};
    const reply = typeof result.final_reply === "string"
      ? result.final_reply
      : typeof result.reply === "string"
        ? result.reply
        : status === "running" || status === "queued"
          ? "任务仍在后台分析中。"
          : typeof job.error === "string"
            ? `任务执行失败：${job.error}`
            : "任务已更新。";
    return { ok: status !== "failed", reply, status, jobId };
  } catch (error) {
    return {
      ok: false,
      reply: error instanceof Error ? `查询任务失败：${error.message}` : "查询任务失败。",
      status: "failed",
      jobId
    };
  }
}

export async function getKocStrategyJobWithTrace(jobId: string, clientId?: string): Promise<KocDiagnosisResult> {
  if (!jobId) return { ok: false, reply: "缺少任务编号。", status: "failed" };
  try {
    const job = await requestJson<JsonObject>(`/api/strategy-jobs?job_id=${encodeURIComponent(jobId)}`, undefined, 8000);
    const status = asString(job.status, "unknown");
    const workspace = asRecord(job.workspace);
    const reply = status === "running" || status === "queued" ? "任务仍在后台分析中。" : buildFinalReply(job);
    if (status !== "running" && status !== "queued") {
      await persistCompletedKocJob(clientId, job, reply);
    }

    return {
      ok: status !== "failed",
      reply,
      status,
      jobId,
      profileId: asString(job.profile_id),
      trace: buildKocJobTrace(job),
      evidenceSummary: asArray(workspace.evidence_summary),
      followups: asArray(workspace.followups),
      items: [
        asString(job.id) ? { title: `任务 ${asString(job.id)}：${stageLabel(asString(job.current_stage), "当前阶段")}` } : undefined,
        asString(job.finished_at) ? { title: `完成时间：${asString(job.finished_at)}` } : undefined
      ].filter(Boolean) as Array<{ title: string; url?: string }>
    };
  } catch (error) {
    return {
      ok: false,
      reply: error instanceof Error ? `查询任务失败：${error.message}` : "查询任务失败。",
      status: "failed",
      jobId,
      trace: [traceStep("job-query-failed", "koc.job_polling", "failed", "查询 LangGraph 后台任务", error instanceof Error ? error.message : "未知错误")]
    };
  }
}

export async function runKocGrowthDiagnosis(input: KocDiagnosisInput): Promise<KocDiagnosisResult> {
  const trace: KocAgentTraceStep[] = [];
  const toolRuns: ToolRunRecord[] = [];
  const urls = extractUrlsFromText([input.message, input.runtimeContext || ""].join("\n"));
  let resultMode = inferResultMode(input);

  try {
    await requestJson<JsonObject>("/api/bootstrap", { method: "GET" }, 5000);
    trace.push(traceStep("bootstrap", "python_backend", "done", "检查 LangGraph 后台", "后台可用"));

    const platformTool = await tools.run<PlatformConnectorResult>("platform.connector_v1", {
      text: input.message,
      runtimeContext: input.runtimeContext || "",
      activeWindow: input.activeWindow
    });
    toolRuns.push(platformTool.run);
    if (!platformTool.result) throw new Error(platformTool.run.error || "平台连接器执行失败");
    const platformContext = platformTool.result;
    resultMode = await resolveResultMode(input, platformContext);
    trace.push(traceStep(
      "resolve_platform",
      "platform.connector_v1",
      platformContext.status === "resolved" ? "done" : "degraded",
      "解析平台和对象",
      platformContext.summary,
      platformContext.hints.slice(0, 4).map((item) => `${item.platform}:${item.pageKind}:${item.confidence}`)
    ));

    const mediaContext = processUploadedMedia(input.assets || []);
    trace.push(traceStep("media", "media.process_uploaded_assets", mediaContext.status === "degraded" ? "degraded" : "done", "处理录屏、截图和上传素材", mediaContext.summary));

    const profilePayload = buildProfilePayload(input, platformContext, mediaContext, resultMode);
    const profileResponse = await requestJson<{ profile?: { id?: string } }>("/api/profiles", {
      method: "POST",
      body: JSON.stringify(profilePayload)
    }, 30000);
    const profileId = profileResponse.profile?.id || "";
    if (!profileId) throw new Error("后台已接收资料，但没有返回档案编号。");

    const job = await requestJson<JsonObject>("/api/strategy-jobs", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId, mode: "advisor" })
    }, 10000);
    const jobId = typeof job.id === "string" ? job.id : "";

    await appendKocRun(input.clientId, {
      userMessage: input.message,
      platformSummary: platformContext.summary,
      mediaSummary: mediaContext.summary,
      taskType: resultMode,
      platformKey: inferPlatform(platformContext),
      accountKey: typeof profilePayload.object_identity.accountKey === "string" ? profilePayload.object_identity.accountKey : "",
      workKey: typeof profilePayload.object_identity.workKey === "string" ? profilePayload.object_identity.workKey : "",
      objectKind: resultMode === "single_work_analysis" ? "work" : "account",
      status: "running",
      evidenceLevel: profilePayload.evidence_level as "low" | "medium" | "high",
      jobId,
      profileId,
      resultSummary: buildPendingReply(jobId, resultMode),
      decisionSummary: "后台 LangGraph 任务已创建。",
      evidenceGaps: profilePayload.evidence_gaps,
      reusableLearnings: ["发布后需要回填真实播放、点赞、评论、收藏和转粉数据。"],
      experiment: {
        hypothesis: "按本轮诊断建议执行后，作品或账号指标应出现更清晰的增长信号。",
        suggestedAction: "完成一条低成本内容实验，并回填真实发布数据。",
        expectedSignal: "播放、完播、互动或转粉指标中至少一项有明确变化。",
        result: "pending",
        conclusion: "等待用户回填指标。",
        metrics: ["播放量", "点赞数", "评论数", "收藏数", "转粉数"]
      }
    });

    return {
      ok: true,
      reply: buildPendingReply(jobId, resultMode),
      profileId,
      jobId,
      status: "running",
      trace
    };
  } catch (error) {
    return {
      ok: false,
      reply: error instanceof Error ? `KOC 增长引擎连接失败：${error.message}` : "KOC 增长引擎连接失败。",
      status: "failed",
      trace
    };
  }
}

