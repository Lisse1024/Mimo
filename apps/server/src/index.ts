import express from "express";
import cors from "cors";
import { PORT, assertServerConfig } from "./config.js";
import { loadState, saveState, sanitizeSettingsPatch } from "./storage.js";
import type { AppSettings } from "./types.js";
import { createWindowContextMonitor } from "./window-monitor.js";
import {
  getKocBridgeStatus,
  getKocStrategyJobWithTrace,
  runKocGrowthDiagnosis
} from "./koc-growth.js";
import { buildKocActionAgenda, buildKocMemoryQualityReport, summarizeKocMemory } from "./koc-memory.js";
import { clearKocMemory, loadKocMemory, recordKocExperimentReview } from "./koc-memory-repository.js";
import { inferExperimentReview, validateExperimentReviewInput } from "./experiment-review.js";

assertServerConfig();

const app = express();
const windowMonitor = createWindowContextMonitor({
  workspaceRoot: process.cwd(),
  pollIntervalMs: 3000
});
const observerState = {
  enabled: false,
  updatedAt: Date.now()
};
const browserBridgeState: {
  url: string;
  title: string;
  platform: string;
  pageKind: string;
  visibleText: string;
  structured: Record<string, unknown>;
  capturedAt: number;
  source: "browser_bridge";
} = {
  url: "",
  title: "",
  platform: "unknown",
  pageKind: "unknown",
  visibleText: "",
  structured: {},
  capturedAt: 0,
  source: "browser_bridge"
};

windowMonitor.start();

app.use(cors());
app.use(express.json({ limit: "80mb" }));
app.use((req, _res, next) => {
  (req as ClientRequest).clientId = readClientId(req);
  next();
});

interface ClientRequest extends express.Request {
  clientId?: string;
}

function readClientId(req: express.Request) {
  const headerValue = typeof req.header("x-client-id") === "string" ? req.header("x-client-id") : "";
  const queryValue = typeof req.query.clientId === "string" ? req.query.clientId : "";
  const raw = (headerValue || queryValue || "").trim();

  if (!raw) return undefined;

  const normalized = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return normalized || undefined;
}

function kocRetiredPayload(feature: string) {
  return {
    error: `${feature} 已从当前产品线移除。`,
    next: "请使用诊断接口或聊天入口发起 KOC 账号诊断。"
  };
}

function sanitizeBridgeText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function buildBrowserBridgeRuntimeContext() {
  if (!browserBridgeState.url && !browserBridgeState.title && !browserBridgeState.visibleText) {
    return "";
  }

  return [
    "Browser bridge evidence:",
    `- url: ${browserBridgeState.url || "unknown"}`,
    `- title: ${browserBridgeState.title || "unknown"}`,
    `- platform: ${browserBridgeState.platform}`,
    `- page_kind: ${browserBridgeState.pageKind}`,
    `- captured_at: ${browserBridgeState.capturedAt || 0}`,
    Object.keys(browserBridgeState.structured || {}).length
      ? `- structured_page_signals: ${JSON.stringify(browserBridgeState.structured).slice(0, 1600)}`
      : "",
    browserBridgeState.visibleText ? `- visible_text: ${browserBridgeState.visibleText.slice(0, 1200)}` : ""
  ].filter(Boolean).join("\n");
}

app.get("/api/settings", (req, res) => {
  const clientId = (req as ClientRequest).clientId;
  const state = loadState(clientId);
  res.json({
    settings: state.settings,
    calendarConnected: false
  });
});

app.post("/api/settings", (req, res) => {
  const clientId = (req as ClientRequest).clientId;
  const state = loadState(clientId);
  const body = req.body as Partial<AppSettings>;
  state.settings = sanitizeSettingsPatch({
    ...state.settings,
    ...body
  });
  saveState(state, clientId);
  res.json({ ok: true, settings: state.settings });
});

app.get("/auth/feishu/start", (_req, res) => {
  res.status(410).json(kocRetiredPayload("Feishu calendar"));
});

app.get("/auth/feishu/callback", (_req, res) => {
  res.status(410).json(kocRetiredPayload("Feishu calendar"));
});

app.get("/api/calendar/status", (_req, res) => {
  res.json({ connected: false });
});

app.post("/api/calendar/disconnect", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/calendar/today", (_req, res) => {
  res.json({ events: [] });
});

app.get("/api/news/top", (_req, res) => {
  res.json({ headlines: [] });
});

app.post("/api/briefing/daily", (_req, res) => {
  res.status(410).json(kocRetiredPayload("Daily briefing"));
});

app.get("/api/weather", (_req, res) => {
  res.status(410).json(kocRetiredPayload("Weather"));
});

app.get("/api/observer/context", (_req, res) => {
  const activeWindow = windowMonitor.getActiveWindow();
  res.json({
    activeWindow,
    browserBridge: browserBridgeState,
    observer: observerState,
    capture: {
      available: true,
      nextStep:
        "Desktop observation supports active-window title, browser/page-kind inference, user input, clipboard links, manual uploads and user-authorized screenshots. Next step: real browser URL/DOM bridge and video-frame sampling."
    }
  });
});

app.post("/api/browser/context-bridge", (req, res) => {
  browserBridgeState.url = sanitizeBridgeText(req.body?.url, 1200);
  browserBridgeState.title = sanitizeBridgeText(req.body?.title, 300);
  browserBridgeState.platform = sanitizeBridgeText(req.body?.platform, 80) || "unknown";
  browserBridgeState.pageKind = sanitizeBridgeText(req.body?.pageKind, 80) || "unknown";
  browserBridgeState.visibleText = sanitizeBridgeText(req.body?.visibleText, 4000);
  browserBridgeState.structured = req.body?.structured && typeof req.body.structured === "object" && !Array.isArray(req.body.structured)
    ? req.body.structured
    : {};
  browserBridgeState.capturedAt = Date.now();
  res.json({
    ok: true,
    browserBridge: browserBridgeState
  });
});

app.post("/api/observer/mode", (req, res) => {
  observerState.enabled = Boolean(req.body?.enabled);
  observerState.updatedAt = Date.now();
  res.json({
    ok: true,
    observer: observerState,
    activeWindow: windowMonitor.getActiveWindow()
  });
});

app.get("/api/koc/status", (_req, res) => {
  res.json({
    ok: true,
    bridge: getKocBridgeStatus(),
    observer: windowMonitor.getActiveWindow()
  });
});

app.get("/api/koc/readiness", async (req, res) => {
  const memory = await loadKocMemory((req as ClientRequest).clientId);
  const bridge = getKocBridgeStatus();
  const memoryQuality = buildKocMemoryQualityReport(memory);
  const agenda = buildKocActionAgenda(memory);
  const observer = windowMonitor.getActiveWindow();
  const checks = [
    { key: "node_gateway", label: "桌宠网关", status: "ready", detail: `服务端口 ${PORT} 正常响应。` },
    { key: "python_backend", label: "KOC LangGraph 后端", status: "ready", detail: `后端地址：${bridge.apiBase}` },
    { key: "window_observer", label: "前台窗口观察", status: observer ? "ready" : "degraded", detail: observer ? "已能读取前台窗口。" : "暂未读取到前台窗口。" },
    {
      key: "memory_quality",
      label: "长期记忆质量",
      status: memoryQuality.status === "ready" ? "ready" : "degraded",
      detail: `记忆评分 ${memoryQuality.score}，待复盘实验 ${memoryQuality.counts.pendingExperiments} 个。`
    },
    {
      key: "user_visible_output",
      label: "用户可见输出",
      status: "ready",
      detail: "已启用中文化和内部字段清理，避免把提示词、调试字段和英文枚举直接展示给用户。"
    }
  ];
  res.json({
    ok: checks.every((item) => item.status !== "failed"),
    checks,
    memoryQuality,
    agenda,
    bridge,
    summary: memoryQuality.risks.length
      ? `当前还需关注：${memoryQuality.risks.slice(0, 3).join("；")}`
      : "当前核心链路已具备可交付条件，后续重点是持续回填真实发布数据。"
  });
});

app.get("/api/koc/memory", async (req, res) => {
  const memory = await loadKocMemory((req as ClientRequest).clientId);
  res.json({
    ok: true,
    summary: summarizeKocMemory(memory),
    quality: buildKocMemoryQualityReport(memory),
    agenda: buildKocActionAgenda(memory),
    memory
  });
});

app.get("/api/koc/agenda", async (req, res) => {
  const memory = await loadKocMemory((req as ClientRequest).clientId);
  res.json({
    ok: true,
    agenda: buildKocActionAgenda(memory),
    quality: buildKocMemoryQualityReport(memory)
  });
});

app.delete("/api/koc/memory", async (req, res) => {
  const memory = await clearKocMemory((req as ClientRequest).clientId);
  res.json({
    ok: true,
    summary: summarizeKocMemory(memory),
    quality: buildKocMemoryQualityReport(memory),
    agenda: buildKocActionAgenda(memory),
    memory
  });
});

app.post("/api/koc/memory/review", async (req, res) => {
  try {
    const input = {
      runId: sanitizeBridgeText(req.body?.runId, 120),
      metrics: typeof req.body?.metrics === "object" && req.body.metrics ? req.body.metrics : undefined,
      result: sanitizeBridgeText(req.body?.result, 40) as "pending" | "positive" | "negative" | "mixed" | "unknown",
      conclusion: sanitizeBridgeText(req.body?.conclusion, 800)
    };
    const validation = validateExperimentReviewInput(input);
    if (!validation.ok) {
      res.status(400).json({ ok: false, error: validation.message, missing: validation.missing, recognized: validation.recognized });
      return;
    }
    const review = inferExperimentReview(input);
    const memory = await recordKocExperimentReview((req as ClientRequest).clientId, review);
    res.json({
      ok: true,
      review,
      validation,
      summary: summarizeKocMemory(memory),
      quality: buildKocMemoryQualityReport(memory),
      agenda: buildKocActionAgenda(memory),
      memory
    });
  } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "KOC 记忆复盘失败" });
  }
});

app.post("/api/koc/experiment/review", async (req, res) => {
  try {
    const input = {
      runId: sanitizeBridgeText(req.body?.runId, 120),
      metrics: typeof req.body?.metrics === "object" && req.body.metrics ? req.body.metrics : undefined,
      result: sanitizeBridgeText(req.body?.result, 40) as "pending" | "positive" | "negative" | "mixed" | "unknown",
      conclusion: sanitizeBridgeText(req.body?.conclusion, 800)
    };
    const validation = validateExperimentReviewInput(input);
    if (!validation.ok) {
      res.status(400).json({ ok: false, error: validation.message, missing: validation.missing, recognized: validation.recognized });
      return;
    }
    const review = inferExperimentReview(input);
    const memory = await recordKocExperimentReview((req as ClientRequest).clientId, review);
    res.json({
      ok: true,
      review,
      validation,
      summary: summarizeKocMemory(memory),
      quality: buildKocMemoryQualityReport(memory),
      agenda: buildKocActionAgenda(memory),
      memory
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "KOC 实验复盘失败" });
  }
});

app.get("/api/koc/job", async (req, res) => {
  const jobId = String(req.query.job_id || "").trim();
  const result = await getKocStrategyJobWithTrace(jobId);
  res.json(result);
});

app.post("/api/koc/diagnose", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const runtimeContext = typeof req.body?.runtimeContext === "string" ? req.body.runtimeContext : "";
    const assets = Array.isArray(req.body?.assets) ? req.body.assets : [];
    const resultMode = req.body?.resultMode === "account_growth_diagnosis" || req.body?.resultMode === "single_work_analysis"
      ? req.body.resultMode
      : undefined;

    if (!message) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }

    const result = await runKocGrowthDiagnosis({
      message,
      runtimeContext: [runtimeContext, buildBrowserBridgeRuntimeContext()].filter(Boolean).join("\n"),
      activeWindow: windowMonitor.getActiveWindow(),
      assets,
      clientId: (req as ClientRequest).clientId,
      resultMode
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "KOC 诊断失败" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }

    const diagnosis = await runKocGrowthDiagnosis({
      message,
      runtimeContext: buildBrowserBridgeRuntimeContext(),
      activeWindow: windowMonitor.getActiveWindow(),
      clientId: (req as ClientRequest).clientId
    });

    res.json({
      reply: diagnosis.reply,
      mood: diagnosis.ok ? "speaking" : "alert",
      calendarConnected: false,
      items: diagnosis.items
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "KOC 智能体回复失败" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KOC DeskMate Agent API is running at http://0.0.0.0:${PORT}`);
});
