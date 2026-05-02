import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import type { AppSettings } from "./types.js";

export interface PersistedState {
  settings: AppSettings;
}

const DEFAULT_MODEL_URL = "/live2d/shizuku/shizuku.model3.json";
const CLIENTS_DIR = path.join(DATA_DIR, "clients");
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");

const DEFAULT_STATE: PersistedState = {
  settings: {
    userName: "朋友",
    petName: "DeskMate",
    newsCategory: "technology",
    newsCountry: "cn",
    tone: "gentle",
    avatarLive2DModelUrl: DEFAULT_MODEL_URL
  }
};

const allowedNewsCategories = new Set([
  "general",
  "business",
  "entertainment",
  "health",
  "science",
  "sports",
  "technology"
]);

const allowedTones = new Set(["gentle", "playful", "efficient"]);

function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  return {
    userName:
      typeof input?.userName === "string" && input.userName.trim()
        ? input.userName.trim()
        : DEFAULT_STATE.settings.userName,
    petName:
      typeof input?.petName === "string" && input.petName.trim()
        ? input.petName.trim()
        : DEFAULT_STATE.settings.petName,
    newsCategory:
      typeof input?.newsCategory === "string" &&
      allowedNewsCategories.has(input.newsCategory)
        ? input.newsCategory
        : DEFAULT_STATE.settings.newsCategory,
    newsCountry:
      typeof input?.newsCountry === "string" && input.newsCountry.trim()
        ? input.newsCountry.trim()
        : DEFAULT_STATE.settings.newsCountry,
    tone:
      typeof input?.tone === "string" && allowedTones.has(input.tone)
        ? input.tone
        : DEFAULT_STATE.settings.tone,
    avatarLive2DModelUrl:
      typeof input?.avatarLive2DModelUrl === "string" && input.avatarLive2DModelUrl.trim()
        ? input.avatarLive2DModelUrl.trim()
        : DEFAULT_STATE.settings.avatarLive2DModelUrl
  };
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
}

export function normalizeClientId(input?: string | null) {
  const raw = (input || "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return normalized || null;
}

function getStateFilePath(clientId?: string | null) {
  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) {
    return LEGACY_STATE_FILE;
  }

  return path.join(CLIENTS_DIR, normalizedClientId, "state.json");
}

function ensureStateParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function loadState(clientId?: string | null): PersistedState {
  ensureDataDir();

  const stateFile = getStateFilePath(clientId);
  if (!fs.existsSync(stateFile)) {
    const initial = { ...DEFAULT_STATE, settings: { ...DEFAULT_STATE.settings } };
    saveState(initial, clientId);
    return initial;
  }

  const raw = fs.readFileSync(stateFile, "utf-8");
  const parsed = JSON.parse(raw) as PersistedState;

  return {
    ...DEFAULT_STATE,
    ...parsed,
    settings: normalizeSettings(parsed?.settings)
  };
}

export function saveState(state: PersistedState, clientId?: string | null) {
  ensureDataDir();

  const stateFile = getStateFilePath(clientId);
  ensureStateParentDir(stateFile);

  const normalized: PersistedState = {
    ...state,
    settings: normalizeSettings(state.settings)
  };

  fs.writeFileSync(stateFile, JSON.stringify(normalized, null, 2), "utf-8");
}

export function sanitizeSettingsPatch(partial: Partial<AppSettings>) {
  return normalizeSettings({
    ...DEFAULT_STATE.settings,
    ...partial
  });
}
