export interface CharacterSettings {
  // 现在仅保留 Live2D 形象配置
  avatarLive2DModelUrl: string;
}

export interface AppSettings extends CharacterSettings {
  userName: string;
  petName: string;
  newsCategory:
    | "general"
    | "business"
    | "entertainment"
    | "health"
    | "science"
    | "sports"
    | "technology";
  newsCountry: string;
  tone: "gentle" | "playful" | "efficient";
}

export interface NewsArticle {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
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

export interface CalendarEventIntent {
  intent: "create_event" | "none";
  confidence: number;
  title?: string;
  startAt?: string;
  endAt?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  missingFields: string[];
  clarification?: string;
  assumedDurationMinutes?: number;
}

export type PetChatAction = "none" | "calendar_created";

export interface PetChatReply {
  reply: string;
  mood: "idle" | "listening" | "thinking" | "speaking" | "alert" | "sleeping" | "happy";
  action?: PetChatAction;
  createdEvent?: CalendarEventSummary;
}

