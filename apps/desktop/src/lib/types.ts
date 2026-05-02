export type PetMood =
  | "idle"
  | "thinking"
  | "alert"
  | "happy"
  | "listening"
  | "sleepy"
  | "sleeping"
  | "speaking";

export interface AppSettings {
  userName: string;
  petName: string;
  newsCategory:
    | "general"
    | "business"
    | "technology"
    | "science"
    | "health"
    | "sports"
    | "entertainment";
  newsCountry: string;
  tone: "gentle" | "playful" | "efficient";
  // 目前只保留动态形象模型配置。
  avatarLive2DModelUrl: string;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
}

export interface DailyBriefing {
  greeting: string;
  scheduleFocus: string[];
  newsHighlights: string[];
  suggestedActions: string[];
  digest: string;
}

export interface ChatListItem {
  title: string;
  url?: string;
}

export type AgentTraceStatus = "planned" | "running" | "done" | "failed" | "degraded" | "skipped";

export interface AgentTraceStep {
  id: string;
  tool: string;
  status: AgentTraceStatus;
  input: string;
  output?: string;
  evidence?: string[];
}

export interface EvidenceSummaryItem {
  key: string;
  label: string;
  source_type: string;
  confidence: "low" | "medium" | "high";
  status: "available" | "degraded" | "missing" | string;
  summary: string;
  next_action?: string;
}

export interface AgentFollowupItem {
  id: string;
  task_id?: string;
  title: string;
  trigger: string;
  evidence_needed: string;
  next_check_hint: string;
  status: "open" | "done" | string;
}

export interface ChatWeatherCard {
  title: string;
  lines: string[];
}

export interface ChatScheduleItem {
  id: string;
  index: number;
  timeLabel: string;
  title: string;
  completed: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  items?: ChatListItem[];
  trace?: AgentTraceStep[];
  evidenceSummary?: EvidenceSummaryItem[];
  followups?: AgentFollowupItem[];
  weatherCards?: ChatWeatherCard[];
  scheduleItems?: ChatScheduleItem[];
}

export interface ChatReply {
  reply: string;
  mood: PetMood;
  calendarConnected: boolean;
  items?: ChatListItem[];
  weatherCards?: ChatWeatherCard[];
  action?: "none" | "calendar_created";
  createdEvent?: CalendarEventSummary;
}

export interface ObserverContext {
  activeWindow: {
    title: string;
    processName: string;
    pid?: number;
    updatedAt: number;
    source: "windows_api" | "fallback";
    browserContext?: {
      isBrowser: boolean;
      browser: string;
      platform: string;
      pageKind: string;
      confidence: "low" | "medium" | "high";
      evidence: string[];
      inferredUrl?: string;
      nextStep: string;
    };
  };
  observer: {
    enabled: boolean;
    updatedAt: number;
  };
  capture: {
    available: boolean;
    nextStep: string;
  };
}

export interface KocDiagnosisReply {
  ok: boolean;
  reply: string;
  items?: ChatListItem[];
  trace?: AgentTraceStep[];
  evidenceSummary?: EvidenceSummaryItem[];
  followups?: AgentFollowupItem[];
  profileId?: string;
  jobId?: string;
  status?: string;
}

export interface KocUploadAsset {
  name: string;
  mime: string;
  size: number;
  data_url: string;
  note?: string;
  context?: "homepage_screenshot" | "current_video_frame" | "uploaded_video" | "uploaded_image" | "unknown";
}

export type KocResultMode = "account_growth_diagnosis" | "single_work_analysis" | "general_koc_advice";

export type KocExperimentResult = "pending" | "positive" | "negative" | "mixed" | "unknown";

export interface KocMemoryReviewPayload {
  runId?: string;
  metrics?: Record<string, number | string>;
  result?: KocExperimentResult;
  conclusion?: string;
}

export interface KocMemoryReviewReply {
  ok: boolean;
  summary: string;
  quality?: KocMemoryReply["quality"];
  agenda?: KocActionAgenda;
  memory?: unknown;
}

export interface KocMemoryReply {
  ok: boolean;
  summary: string;
  quality?: {
    status: string;
    score: number;
    counts: Record<string, number>;
    risks: string[];
    nextActions: string[];
  };
  agenda?: KocActionAgenda;
  memory?: unknown;
}

export interface KocActionAgendaItem {
  type: "experiment_review" | "evidence_repair" | "account_followup";
  runId?: string;
  platformKey?: string;
  accountKey?: string;
  workKey?: string;
  title: string;
  question: string;
  suggestedMetrics?: string[];
  action: string;
  priority: "high" | "medium" | "low";
  createdAt: number;
}

export interface KocActionAgenda {
  status: "has_actions" | "clear";
  items: KocActionAgendaItem[];
  summary: string;
}
