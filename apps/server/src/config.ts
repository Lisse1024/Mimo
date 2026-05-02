import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const PROJECT_DIR = path.resolve(ROOT_DIR, "../..");
const ENV_PATH = path.resolve(ROOT_DIR, ".env");

dotenv.config({ path: path.resolve(PROJECT_DIR, ".env") });
dotenv.config({ path: ENV_PATH, override: true });

export const DATA_DIR = path.resolve(ROOT_DIR, ".data");
export const PORT = Number(process.env.PORT || 8787);
export const KOC_DB_PROVIDER = (process.env.KOC_DB_PROVIDER || "local").trim().toLowerCase();
export const KOC_DATABASE_URL = (process.env.KOC_DATABASE_URL || "").trim();
export const KOC_STORAGE_DRIVER = (process.env.KOC_STORAGE_DRIVER || "local").trim().toLowerCase();
export const KOC_EMBEDDING_PROVIDER = (process.env.KOC_EMBEDDING_PROVIDER || "off").trim().toLowerCase();
export const KOC_EMBEDDING_BASE_URL = (process.env.KOC_EMBEDDING_BASE_URL || "").trim().replace(/\/+$/, "");
export const KOC_EMBEDDING_API_KEY = (process.env.KOC_EMBEDDING_API_KEY || "").trim();
export const KOC_EMBEDDING_MODEL = (process.env.KOC_EMBEDDING_MODEL || "").trim();
export const KOC_EMBEDDING_DIMENSIONS = Number(process.env.KOC_EMBEDDING_DIMENSIONS || 1536);

export function assertServerConfig() {
  // KOC bridge reads model configuration from the Python backend.
}
