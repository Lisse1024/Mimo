import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export type ActiveWindowSnapshot = {
  title: string;
  processName: string;
  pid?: number;
  updatedAt: number;
  source: "windows_api" | "fallback";
  browserContext?: BrowserPageContext;
};

export type PlatformKind =
  | "douyin"
  | "xiaohongshu"
  | "bilibili"
  | "kuaishou"
  | "weibo"
  | "zhihu"
  | "unknown";

export type BrowserPageKind = "profile" | "video" | "feed" | "search" | "unknown";

export type BrowserPageContext = {
  isBrowser: boolean;
  browser: string;
  platform: PlatformKind;
  pageKind: BrowserPageKind;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  inferredUrl?: string;
  nextStep: string;
};

export type FileChangeEntry = {
  path: string;
  event: "add" | "change" | "unlink";
  at: number;
};

type WindowMonitorOptions = {
  workspaceRoot: string;
  pollIntervalMs?: number;
  maxFileChanges?: number;
  ignoredWindowPatterns?: Array<string | RegExp>;
};

const IGNORED_SEGMENTS = ["node_modules", ".git", "dist", "target", ".data", "coverage", "exports"];
const DEFAULT_IGNORED_WINDOW_PATTERNS: RegExp[] = [
  /\bdeskmate\b/i,
  /\bkoc\s*deskmate\b/i,
  /\bdesk\s*mate\b/i,
  /桌宠/i,
  /KOC\s*增长引擎/i
];

function normalizePath(input: string) {
  return input.replace(/\\/g, "/");
}

function shouldIgnorePath(rawPath: string) {
  const normalized = normalizePath(rawPath).toLowerCase();
  return IGNORED_SEGMENTS.some((segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`));
}

function displayPath(workspaceRoot: string, fullPath: string) {
  const rel = path.relative(workspaceRoot, fullPath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return normalizePath(rel) || ".";
  }
  return normalizePath(fullPath);
}

function detectBrowserName(processName: string) {
  const name = processName.toLowerCase();
  if (/chrome|chromium|360chrome|sogouexplorer|qqbrowser/.test(name)) return "chromium";
  if (/msedge|edge/.test(name)) return "edge";
  if (/firefox/.test(name)) return "firefox";
  if (/brave/.test(name)) return "brave";
  if (/browser|iexplore/.test(name)) return "browser";
  return "";
}

function inferPlatformFromTitle(title: string): PlatformKind {
  const lower = title.toLowerCase();
  if (/抖音|douyin|iesdouyin/.test(lower)) return "douyin";
  if (/小红书|xiaohongshu|xhs|rednote/.test(lower)) return "xiaohongshu";
  if (/bilibili|b站|哔哩哔哩|b23\.tv/.test(lower)) return "bilibili";
  if (/快手|kuaishou/.test(lower)) return "kuaishou";
  if (/微博|weibo/.test(lower)) return "weibo";
  if (/知乎|zhihu/.test(lower)) return "zhihu";
  return "unknown";
}

function inferPageKindFromTitle(title: string): BrowserPageKind {
  const lower = title.toLowerCase();
  if (/搜索|search/.test(lower)) return "search";
  if (/主页|个人主页|的主页|抖音号|小红书号|空间|profile|user|author/.test(lower)) return "profile";
  if (/作品|视频|播放|笔记|动态|video|post|note/.test(lower)) return "video";
  if (/推荐|首页|发现|关注|feed|home/.test(lower)) return "feed";
  return "unknown";
}

function detectBrowserContext(title: string, processName: string): BrowserPageContext {
  const browser = detectBrowserName(processName);
  const platform = inferPlatformFromTitle(title);
  const pageKind = inferPageKindFromTitle(title);
  const evidence: string[] = [];

  if (browser) evidence.push(`browser_process:${processName}`);
  if (title) evidence.push(`window_title:${title.slice(0, 120)}`);
  if (platform !== "unknown") evidence.push(`platform_keyword:${platform}`);
  if (pageKind !== "unknown") evidence.push(`page_keyword:${pageKind}`);

  let confidence: BrowserPageContext["confidence"] = "low";
  if (browser && platform !== "unknown" && pageKind !== "unknown") confidence = "high";
  else if (browser && (platform !== "unknown" || pageKind !== "unknown")) confidence = "medium";

  return {
    isBrowser: Boolean(browser),
    browser: browser || "unknown",
    platform,
    pageKind,
    confidence,
    evidence,
    nextStep:
      "v1 uses foreground window title and process name only. Browser extension or accessibility URL bridge is needed for real URL and DOM structure."
  };
}

function cleanWindowText(value: string) {
  return value
    .replace(/\uFFFD+/g, " ")
    .replace(/Microsoft\s*\?+\s*Edge/gi, "Microsoft Edge")
    .replace(/\?{2,}/g, " ")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readActiveWindowWithPowerShell(): { title: string; processName: string; pid?: number } {
  if (process.platform !== "win32") {
    return {
      title: "",
      processName: process.platform
    };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$OutputEncoding = [Console]::OutputEncoding",
    "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class Win32Api { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'",
    "$h = [Win32Api]::GetForegroundWindow()",
    "if ($h -eq [IntPtr]::Zero) { Write-Output '{}' ; exit 0 }",
    "$sb = New-Object System.Text.StringBuilder 2048",
    "[void][Win32Api]::GetWindowText($h, $sb, $sb.Capacity)",
    "$windowPid = 0",
    "[void][Win32Api]::GetWindowThreadProcessId($h, [ref]$windowPid)",
    "$p = Get-Process -Id $windowPid -ErrorAction SilentlyContinue",
    "$obj = [PSCustomObject]@{",
    "  title = $sb.ToString()",
    "  processName = if ($p) { $p.ProcessName } else { '' }",
    "  pid = [int]$windowPid",
    "}",
    "$obj | ConvertTo-Json -Compress"
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");

  let raw = "";
  const executables = ["powershell.exe", "powershell", "pwsh"];
  let lastError: unknown = null;
  for (const executable of executables) {
    try {
      raw = execFileSync(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 4000
      }).trim();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (!raw) {
    return {
      title: "",
      processName: ""
    };
  }

  const parsed = JSON.parse(raw) as { title?: unknown; processName?: unknown; pid?: unknown };
  return {
    title: typeof parsed.title === "string" ? cleanWindowText(parsed.title) : "",
    processName: typeof parsed.processName === "string" ? cleanWindowText(parsed.processName) : "",
    pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : undefined
  };
}

export class WindowContextMonitor {
  private readonly workspaceRoot: string;
  private readonly pollIntervalMs: number;
  private readonly maxFileChanges: number;
  private readonly ignoredWindowPatterns: RegExp[];
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private activeWindow: ActiveWindowSnapshot = {
    title: "",
    processName: "",
    updatedAt: Date.now(),
    source: "fallback"
  };
  private readonly fileChanges: FileChangeEntry[] = [];

  constructor(options: WindowMonitorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.pollIntervalMs = Math.max(1000, Math.trunc(options.pollIntervalMs || 5000));
    this.maxFileChanges = Math.max(20, Math.trunc(options.maxFileChanges || 300));
    this.ignoredWindowPatterns = [
      ...DEFAULT_IGNORED_WINDOW_PATTERNS,
      ...(options.ignoredWindowPatterns || []).map((item) => typeof item === "string" ? new RegExp(item, "i") : item)
    ];
  }

  start() {
    if (this.timer) return;

    this.refreshActiveWindow();
    this.timer = setInterval(() => {
      this.refreshActiveWindow();
    }, this.pollIntervalMs);

    try {
      this.watcher = fs.watch(
        this.workspaceRoot,
        { recursive: true, encoding: "utf8" },
        (eventType: "rename" | "change", filename: string | null) => {
          const name = String(filename || "").trim();
          if (!name) return;
          const fullPath = path.resolve(this.workspaceRoot, name);
          if (shouldIgnorePath(fullPath)) return;

          const exists = fs.existsSync(fullPath);
          const event: FileChangeEntry["event"] =
            eventType === "change" ? "change" : exists ? "add" : "unlink";
          this.recordFileChange(event, fullPath);
        }
      );
    } catch {
      this.watcher = null;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getActiveWindow() {
    return this.activeWindow;
  }

  getRecentFileChanges(sinceMs: number, limit = 20) {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit || 20)));
    return this.fileChanges
      .filter((item) => item.at >= sinceMs)
      .slice(-boundedLimit)
      .reverse();
  }

  refreshActiveWindow() {
    try {
      const now = Date.now();
      const current = readActiveWindowWithPowerShell();
      if (this.shouldIgnoreWindow(current)) {
        this.activeWindow = {
          ...this.activeWindow,
          updatedAt: now,
          source: process.platform === "win32" ? "windows_api" : "fallback"
        };
        return;
      }
      this.activeWindow = {
        title: current.title,
        processName: current.processName,
        pid: current.pid,
        updatedAt: now,
        source: process.platform === "win32" ? "windows_api" : "fallback",
        browserContext: detectBrowserContext(current.title, current.processName)
      };
    } catch {
      this.activeWindow = {
        ...this.activeWindow,
        updatedAt: Date.now(),
        source: "fallback"
      };
    }
  }

  private shouldIgnoreWindow(window: { title: string; processName: string; pid?: number }) {
    const text = `${window.processName || ""} ${window.title || ""}`;
    return this.ignoredWindowPatterns.some((pattern) => pattern.test(text));
  }

  private recordFileChange(event: FileChangeEntry["event"], fullPath: string) {
    this.fileChanges.push({
      path: displayPath(this.workspaceRoot, fullPath),
      event,
      at: Date.now()
    });

    if (this.fileChanges.length > this.maxFileChanges) {
      this.fileChanges.splice(0, this.fileChanges.length - this.maxFileChanges);
    }
  }
}

export function createWindowContextMonitor(options: WindowMonitorOptions) {
  return new WindowContextMonitor(options);
}
