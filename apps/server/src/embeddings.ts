import {
  KOC_EMBEDDING_API_KEY,
  KOC_EMBEDDING_BASE_URL,
  KOC_EMBEDDING_DIMENSIONS,
  KOC_EMBEDDING_MODEL,
  KOC_EMBEDDING_PROVIDER
} from "./config.js";

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export function embeddingsEnabled() {
  return Boolean(
    KOC_EMBEDDING_PROVIDER !== "off" &&
      KOC_EMBEDDING_BASE_URL &&
      KOC_EMBEDDING_API_KEY &&
      KOC_EMBEDDING_MODEL
  );
}

export function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function embedText(text: string): Promise<number[] | null> {
  const input = text.replace(/\s+/g, " ").trim();
  if (!input || !embeddingsEnabled()) return null;

  const response = await fetch(`${KOC_EMBEDDING_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KOC_EMBEDDING_API_KEY}`
    },
    body: JSON.stringify({
      model: KOC_EMBEDDING_MODEL,
      input
    })
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as EmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== KOC_EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding dimensions mismatch: expected ${KOC_EMBEDDING_DIMENSIONS}, got ${embedding?.length || 0}`);
  }
  return embedding;
}
