import type { ActiveWindowSnapshot } from "./window-monitor.js";
import { appendKocRun } from "./koc-memory-repository.js";
import { buildVideoUnderstanding, processUploadedMedia } from "./media-analysis.js";
import { extractUrlsFromText, resolvePlatformContext, type PlatformConnectorResult } from "./platform-connectors.js";
import { ToolRegistry, type ToolRunRecord } from "./tool-registry.js";

type JsonObject = Record<string, unknown>;

const KOC_API_BASE = (process.env.KOC_API_BASE || "http://127.0.0.1:8010").replace(/\/+$/, "");
const KOC_REQUEST_TIMEOUT_MS = Number(process.env.KOC_REQUEST_TIMEOUT_MS || 12000);

const tools = new ToolRegistry();

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

export type KocResultMode = "account_growth_diagnosis" | "single_work_analysis" | "general_koc_advice";

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
  /13-25\s*秒[^；。\n]*(爆点|反转)/
];

const OPERATIONAL_METADATA_PATTERN =
  /用户请求[:：]|请分析我当前刷到的这条视频|不要默认把它当成账号主页诊断|平台线索[:：]|hints\s*=|状态\s*=\s*partial|status\s*=\s*partial|素材处理[:：]|Uploaded\s+assets|Uploaded video assets|assets:|current-video-recording|fallback-frame|\.mp4[:：]?完成|media processing|runtime context|runtimeContext|mediaContext|tool trace|\btool\b|debug|frame-\d+\.jpg|sampling:|duration:|sampled .* frame available|pending vision analysis/i;

function hasOperationalMetadata(text: unknown) {
  return OPERATIONAL_METADATA_PATTERN.test(asString(text));
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
    "当前内容证据不足，无法生成具体脚本。",
    "画面/素材：请补充连续画面、标题字幕或作品链接。",
    "字幕/口播：当前不使用用户请求、工具日志、文件名或上传状态来编脚本。",
    "目的：避免把运行元数据误写成视频内容证据。"
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
  const steps = rawSteps.map((item) => asRecord(item)).filter((item) => Object.keys(item).length);
  const compactSteps = steps.slice(0, 4);
  if (compactSteps.length) {
    return compactSteps.map((step, index) => {
      const confidence = asString(step.confidence, "low");
      const lowConfidenceNote = confidence === "low" ? "（低置信小样本）" : "";
      return [
        `${index + 1}. 时间段：${asString(step.time, "当前素材线索不足")}`,
        `画面/素材：${asString(step.visual, "当前素材线索不足")}`,
        `字幕/口播：${asString(step.caption_or_voiceover, "基于当前证据做低置信最小测试。")}`,
        `目的：${asString(step.purpose, "验证当前素材线索是否能带来停留。")}${lowConfidenceNote}`,
        asString(step.growth_reason) ? `增长目的：${asString(step.growth_reason)}` : ""
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
  if (!/(影视|综艺|小品|春晚|老剧|名场面|版权|授权|搬运|电影|短剧|动漫)/.test(text)) return "";
  return "素材使用边界：这类素材建议复用选题角度、解说结构、字幕解释方式或评论问题方式；素材使用应优先选择评论性引用、授权素材、平台可用素材、截图讲解或口播复述，避免完整搬运原片。这里说的“复刻”只指结构复用。";
}

function guardFinalReply(text: string) {
  const sanitized = text
    .replace(/name\s+['"][^'"]*resolve\s*\/\s*safe\s*\/\s*path[^'"]*['"]\s+is\s+not\s+defined/gi, "素材识别链路出现降级，当前仅基于可见主页信息做保守判断")
    .replace(/Traceback[\s\S]{0,500}?(\n\n|$)/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。\n\n")
    .replace(/\b(ReferenceError|TypeError):[^\n]+/g, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/\bundefined is not[^\n]+/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/\bstack\b[:：]?[^\n]*/gi, "素材识别链路出现降级，当前仅基于可见信息做保守判断。")
    .replace(/内容混杂惩罚特征|内容混杂惩罚/g, "主页内容方向分散，可能影响平台和新访客理解账号定位")
    .replace(/粉丝40且增长停滞符合[^。\n]*/g, "粉丝数和主页内容方向只能说明当前需要做小样本验证，不能证明增长停滞或平台惩罚")
    .replace(/算法无法建立稳定用户画像/g, "当前只能判断主页方向分散，不能证明算法画像问题")
    .replace(/后台数据证明/g, "当前没有后台数据，不能证明效果")
    .replace(/这条一定会爆|一定会爆/g, "只能作为小样本测试")
    .replace(/评论区都在说/g, "当前没有评论区证据，发布后需要观察评论关键词")
    .replace(/账号长期方向已经确定/g, "单条作品不能直接判断账号长期方向")
    .replace(/官方\/授权搬运已确认|官方账号\/授权搬运已确认/g, "当前无法确认官方或授权状态")
    .replace(/完整剧情已经确认/g, "当前只能基于可见片段判断，不能确认完整剧情")
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
  return stripOperationalMetadataLines(sanitized) || "当前内容证据不足，无法生成具体脚本。请补充连续画面、标题字幕或作品链接。";
}

function stripOperationalMetadataLines(text: string) {
  return text
    .split("\n")
    .filter((line) => !OPERATIONAL_METADATA_PATTERN.test(line))
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
      return text.trim() && !hasOperationalMetadata(text);
    });
  if (steps.length) {
    return steps.slice(0, 4).map((step, index) => {
      const confidence = asString(step.confidence, "low");
      const lowConfidenceNote = confidence === "low" ? "（低置信小样本）" : "";
      return [
        `${index + 1}. 时间段：${asString(step.time, "当前素材线索不足")}`,
        `画面/素材：${asString(step.visual, "当前素材线索不足")}`,
        `字幕/口播：${asString(step.caption_or_voiceover, "基于当前证据做低置信最小测试。")}`,
        `目的：${asString(step.purpose, "验证当前素材线索是否能带来停留。")}${lowConfidenceNote}`,
        asString(step.growth_reason) ? `增长目的：${asString(step.growth_reason)}` : ""
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
  if (candidates.some((item) => /single_work|work_analysis|single_work_analysis|work|video|clip/.test(item))) return "single_work_analysis";
  if (candidates.some((item) => /account|homepage|home_page|profile|diagnosis|review/.test(item))) return "homepage_review";
  if (asArray(strategy.script_steps).length || Object.keys(asRecord(advisor.first_content_task)).length) return "single_work_analysis";
  const text = JSON.stringify({ workspace, result, profile, job });
  if (/主页|粉丝|获赞|内容分散|内容混合|homepage|profile/i.test(text)) return "homepage_review";
  return "single_work_analysis";
}

function isHomepageReviewTask(job: JsonObject, workspace: JsonObject) {
  return currentTaskType(job, workspace) === "homepage_review";
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
  if (!evidence.length) return "";
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
  const combinedEvidence = [...evidence, evidenceText].join("\n");
  if (weakHomepagePlan(plan) || !evidenceBasisMatchesMap(evidence, evidenceText) || hasUnsupportedStrongEntity(body, combinedEvidence)) return "";
  return [
    `选题：${title}`,
    asString(plan.why_this || plan.reason) ? `为什么适合：${asString(plan.why_this || plan.reason)}` : "",
    `证据依据：${evidence.join("；")}`,
    `下一条可拍：${episode}`,
    `画面建议：${visual}`,
    `字幕/口播：${caption}`,
    `目的：${purpose}`,
    metric ? `验证指标：${metric}` : "验证指标：24/48 小时播放量、3 秒留存、完播率、评论关键词、主页点击率、关注转化、负反馈",
    `\u7f6e\u4fe1\u5ea6\uff1a${translateConfidenceWord(asString(plan.confidence, "medium"))}`
  ].filter(Boolean).join("\n");
}

function homepagePatterns(map: JsonObject) {
  return asArray(map.content_patterns).map((item) => asRecord(item)).filter((item) => asString(item.pattern_name) && stringList(item.evidence, 5).length);
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
  return text
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
    ...homepagePatterns(map).slice(0, 3).map((item) => `${asString(item.pattern_name)}：${stringList(item.evidence, 3).join("；")}`)
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
}export function buildFinalReply(job: JsonObject) {
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

function inferResultMode(input: KocDiagnosisInput): KocResultMode {
  if (input.resultMode) return input.resultMode;
  const text = [input.message, input.runtimeContext || ""].join("\n");
  if (/当前视频|这条视频|单条|作品拆解|视频分析|复刻|完播|剪辑节奏/.test(text)) return "single_work_analysis";
  if (/账号|主页|粉丝|涨粉|定位|赛道|人设|主页诊断/.test(text)) return "account_growth_diagnosis";
  return "general_koc_advice";
}

function buildProfilePayload(input: KocDiagnosisInput, platformContext: PlatformConnectorResult, mediaContext: ReturnType<typeof processUploadedMedia>) {
  const resultMode = inferResultMode(input);
  const platform = inferPlatform(platformContext);
  const firstHint = platformContext.hints[0];
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
    evidence_facts: [],
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

export async function getKocStrategyJob(jobId: string): Promise<KocDiagnosisResult> {
  if (!jobId) return { ok: false, reply: "缺少任务编号。", status: "failed" };
  try {
    const job = await requestJson<JsonObject>(`/api/strategy-jobs?job_id=${encodeURIComponent(jobId)}`, undefined, 8000);
    const status = typeof job.status === "string" ? job.status : "unknown";
    if (status !== "running" && status !== "queued" && status !== "failed") {
      return { ok: true, reply: buildFinalReply(job), status, jobId };
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

export async function getKocStrategyJobWithTrace(jobId: string): Promise<KocDiagnosisResult> {
  if (!jobId) return { ok: false, reply: "缺少任务编号。", status: "failed" };
  try {
    const job = await requestJson<JsonObject>(`/api/strategy-jobs?job_id=${encodeURIComponent(jobId)}`, undefined, 8000);
    const status = asString(job.status, "unknown");
    const workspace = asRecord(job.workspace);
    const reply = status === "running" || status === "queued" ? "任务仍在后台分析中。" : buildFinalReply(job);

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
  const resultMode = inferResultMode(input);

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

    const profilePayload = buildProfilePayload(input, platformContext, mediaContext);
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









