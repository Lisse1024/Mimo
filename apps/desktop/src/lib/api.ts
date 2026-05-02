import type {
  AppSettings,
  CalendarEventSummary,
  ChatReply,
  DailyBriefing,
  KocDiagnosisReply,
  KocResultMode,
  KocMemoryReply,
  KocMemoryReviewPayload,
  KocMemoryReviewReply,
  KocUploadAsset,
  ObserverContext
} from "./types";

const rawApiBase = (import.meta.env.VITE_API_BASE || "http://127.0.0.1:8787").trim();
const API_BASE =
  rawApiBase === "https://api.your-domain.com" ||
  rawApiBase === "https://api.your-domain.com/"
    ? "http://127.0.0.1:8787"
    : rawApiBase;
const CLIENT_ID_STORAGE_KEY = "deskmate.client-id.v1";

function makeClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `deskmate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getClientId() {
  const existed = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY)?.trim();
  if (existed) return existed;

  const clientId = makeClientId();
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

const CLIENT_ID = getClientId();

export const backend = {
  baseUrl: API_BASE,
  clientId: CLIENT_ID
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": CLIENT_ID,
      ...(init?.headers || {})
    },
    ...init
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error((data as any)?.error || `请求失败：${response.status}`);
  }

  return data as T;
}

export async function getSettings(): Promise<{
  settings: AppSettings;
  calendarConnected: boolean;
}> {
  return request("/api/settings");
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<{
  ok: true;
  settings: AppSettings;
}> {
  return request("/api/settings", {
    method: "POST",
    body: JSON.stringify(partial)
  });
}

export async function getTodayEvents(): Promise<{ events: CalendarEventSummary[] }> {
  return request("/api/calendar/today");
}

export async function createDailyBriefing(): Promise<{
  briefing: DailyBriefing;
  sources: {
    events: CalendarEventSummary[];
    headlines: Array<{ title: string; url?: string }>;
  };
}> {
  return request("/api/briefing/daily", {
    method: "POST"
  });
}

export async function chatWithPet(message: string): Promise<ChatReply> {
  return request("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message })
  });
}

export async function getObserverContext(): Promise<ObserverContext> {
  return request("/api/observer/context");
}

export async function setObserverMode(enabled: boolean): Promise<ObserverContext & { ok: true }> {
  return request("/api/observer/mode", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export async function diagnoseKocGrowth(
  message: string,
  runtimeContext = "",
  assets: KocUploadAsset[] = [],
  resultMode?: KocResultMode
): Promise<KocDiagnosisReply> {
  return request("/api/koc/diagnose", {
    method: "POST",
    body: JSON.stringify({ message, runtimeContext, assets, resultMode })
  });
}

export async function getKocJob(jobId: string): Promise<KocDiagnosisReply> {
  return request(`/api/koc/job?job_id=${encodeURIComponent(jobId)}`);
}

export async function reviewKocMemory(payload: KocMemoryReviewPayload): Promise<KocMemoryReviewReply> {
  return request("/api/koc/memory/review", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getKocMemory(): Promise<KocMemoryReply> {
  return request("/api/koc/memory");
}

export async function getKocAgenda(): Promise<Pick<KocMemoryReply, "ok" | "quality" | "agenda">> {
  return request("/api/koc/agenda");
}

export async function clearKocMemory(): Promise<KocMemoryReply> {
  return request("/api/koc/memory", {
    method: "DELETE"
  });
}

export async function showSettingsWindow() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("show_settings_window");
}

export async function capturePrimaryScreen(): Promise<KocUploadAsset> {
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<KocUploadAsset>("capture_primary_screen");
  return result;
}

export async function recordPrimaryScreen(seconds = 15): Promise<KocUploadAsset> {
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<KocUploadAsset>("record_primary_screen", { seconds });
  return result;
}

export async function startCurrentVideoRecording(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("start_current_video_recording");
}

export async function stopCurrentVideoRecording(sessionId: string): Promise<KocUploadAsset> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<KocUploadAsset>("stop_current_video_recording", { sessionId });
}
