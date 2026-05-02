import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { KOC_DATABASE_URL, KOC_DB_PROVIDER } from "./config.js";
import { embedText, embeddingsEnabled, vectorLiteral } from "./embeddings.js";
import {
  appendKocRunToMemory,
  clearKocMemory as clearLocalKocMemory,
  createEmptyKocMemory,
  loadKocMemory as loadLocalKocMemory,
  normalizeKocMemory,
  recordKocExperimentReviewInMemory,
  saveKocMemory as saveLocalKocMemory,
  type KocExperimentMemory,
  type KocEvidenceLesson,
  type KocLongTermMemory,
  type KocMemoryRun,
  type KocPlatformAccountMemory,
  type KocWorkMemory
} from "./koc-memory.js";

export interface KocMemoryRepository {
  load(clientId?: string | null, filters?: KocMemoryLoadFilters): Promise<KocLongTermMemory>;
  save(memory: KocLongTermMemory): Promise<KocLongTermMemory>;
  clear(clientId?: string | null): Promise<KocLongTermMemory>;
  appendRun(clientId: string | undefined, run: Omit<KocMemoryRun, "id" | "at">): Promise<KocLongTermMemory>;
  recordExperimentReview(
    clientId: string | undefined,
    payload: {
      runId?: string;
      metrics?: Record<string, unknown>;
      result?: KocExperimentMemory["result"];
      conclusion?: string;
    }
  ): Promise<KocLongTermMemory>;
}

export interface KocMemoryLoadFilters {
  taskType?: string;
  platformKey?: string;
  accountKey?: string;
  workKey?: string;
  queryText?: string;
}

function normalizeClientId(input?: string | null) {
  const raw = (input || "default").trim();
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "default"
  );
}

function stableKey(...parts: Array<string | undefined>) {
  const raw = parts.filter(Boolean).join(":") || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function compactSummary(text: string | undefined, limit = 280) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function joinMemoryText(parts: Array<string | string[] | undefined>) {
  return parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function evidenceLevel(value: unknown): KocPlatformAccountMemory["evidenceLevel"] {
  return value === "low" || value === "medium" || value === "high" || value === "unknown" ? value : "unknown";
}

function experimentResult(value: unknown): KocExperimentMemory["result"] {
  return value === "pending" || value === "positive" || value === "negative" || value === "mixed" || value === "unknown"
    ? value
    : "unknown";
}

class LocalJsonKocMemoryRepository implements KocMemoryRepository {
  async load(clientId?: string | null) {
    return loadLocalKocMemory(clientId);
  }

  async save(memory: KocLongTermMemory) {
    return saveLocalKocMemory(memory);
  }

  async clear(clientId?: string | null) {
    return clearLocalKocMemory(clientId);
  }

  async appendRun(clientId: string | undefined, run: Omit<KocMemoryRun, "id" | "at">) {
    return saveLocalKocMemory(appendKocRunToMemory(loadLocalKocMemory(clientId), run));
  }

  async recordExperimentReview(
    clientId: string | undefined,
    payload: {
      runId?: string;
      metrics?: Record<string, unknown>;
      result?: KocExperimentMemory["result"];
      conclusion?: string;
    }
  ) {
    return saveLocalKocMemory(recordKocExperimentReviewInMemory(loadLocalKocMemory(clientId), payload));
  }
}

class PostgresKocMemoryRepository implements KocMemoryRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    if (!databaseUrl) {
      throw new Error("KOC_DATABASE_URL is required when KOC_DB_PROVIDER=postgres.");
    }
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  private async ensureUser(clientId: string) {
    const result = await this.pool.query<{ id: string }>(
      `
      INSERT INTO users(external_key, display_name)
      VALUES($1, $1)
      ON CONFLICT(external_key) DO UPDATE SET updated_at = now()
      RETURNING id
      `,
      [clientId]
    );
    return result.rows[0].id;
  }

  async load(clientId?: string | null, filters: KocMemoryLoadFilters = {}) {
    const normalized = normalizeClientId(clientId);
    const userId = await this.ensureUser(normalized);
    const blobResult = await this.pool.query<{ content: KocLongTermMemory }>(
      `
      SELECT content
      FROM memory_profiles
      WHERE user_id = $1
        AND scope_type = 'client'
        AND scope_key = $2
        AND memory_kind = 'long_term_blob'
      LIMIT 1
      `,
      [userId, normalized]
    );
    const base = blobResult.rows[0]?.content
      ? {
      ...createEmptyKocMemory(normalized),
          ...blobResult.rows[0].content,
      clientId: normalized
        }
      : createEmptyKocMemory(normalized);
    return normalizeKocMemory(await this.hydrateMemoryFromEntities(userId, base, filters));
  }

  private async hydrateMemoryFromEntities(userId: string, base: KocLongTermMemory, filters: KocMemoryLoadFilters) {
    const semanticVector = filters.queryText && embeddingsEnabled() ? await embedText(filters.queryText).catch(() => null) : null;
    const [accountResult, workResult, experimentResultSet, evidenceResult, semanticResult] = await Promise.all([
      this.pool.query<{
        account_key: string;
        platform_key: string;
        account_name: string | null;
        profile_url: string | null;
        positioning: unknown;
        evidence_summary: unknown;
        updated_at: Date;
      }>(
        `
        SELECT account_key, platform_key, account_name, profile_url, positioning, evidence_summary, updated_at
        FROM platform_accounts
        WHERE user_id = $1
          AND ($2::text IS NULL OR platform_key = $2)
          AND ($3::text IS NULL OR account_key = $3)
        ORDER BY updated_at DESC
        LIMIT 80
        `,
        [userId, filters.platformKey || null, filters.accountKey || null]
      ),
      this.pool.query<{
        work_key: string;
        account_key: string | null;
        platform_key: string;
        content_type: string | null;
        metrics_snapshot: unknown;
        analysis_summary: unknown;
        evidence_contract: unknown;
        learning_packet: unknown;
        updated_at: Date;
      }>(
        `
        SELECT work_key, account_key, platform_key, content_type, metrics_snapshot, analysis_summary, evidence_contract, learning_packet, updated_at
        FROM works
        WHERE user_id = $1
          AND ($2::text IS NULL OR platform_key = $2)
          AND ($3::text IS NULL OR account_key = $3)
          AND ($4::text IS NULL OR work_key = $4)
        ORDER BY updated_at DESC
        LIMIT 160
        `,
        [userId, filters.platformKey || null, filters.accountKey || null, filters.workKey || null]
      ),
      this.pool.query<{
        source_key: string | null;
        hypothesis: string;
        action_plan: unknown;
        target_metrics: unknown;
        status: string;
        updated_at: Date;
      }>(
        `
        SELECT source_key, hypothesis, action_plan, target_metrics, status, updated_at
        FROM experiments
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 80
        `,
        [userId]
      ),
      this.pool.query<{
        source_key: string | null;
        source_label: string;
        confidence: string;
        observation: string;
        structured_data: unknown;
        created_at: Date;
      }>(
        `
        SELECT source_key, source_label, confidence, observation, structured_data, created_at
        FROM evidence_items
        WHERE user_id = $1 AND evidence_type = 'memory_lesson'
          AND ($2::text IS NULL OR structured_data->>'platform_key' = $2)
          AND ($3::text IS NULL OR structured_data->>'task_type' = $3)
        ORDER BY created_at DESC
        LIMIT 80
        `,
        [userId, filters.platformKey || null, filters.taskType || null]
      ),
      semanticVector
        ? this.pool.query<{
            item_type: string;
            item_key: string;
            platform_key: string | null;
            summary: string;
          }>(
            `
            SELECT *
            FROM (
              SELECT 'account' AS item_type, account_key AS item_key, platform_key, memory_summary AS summary, embedding <=> $2::vector AS distance
              FROM platform_accounts
              WHERE user_id = $1 AND embedding IS NOT NULL AND ($3::text IS NULL OR platform_key = $3)
              UNION ALL
              SELECT 'work' AS item_type, work_key AS item_key, platform_key, COALESCE(analysis_summary->>'decision_summary', '') AS summary, embedding <=> $2::vector AS distance
              FROM works
              WHERE user_id = $1 AND embedding IS NOT NULL AND ($3::text IS NULL OR platform_key = $3)
              UNION ALL
              SELECT 'evidence' AS item_type, COALESCE(source_key, id::text) AS item_key, structured_data->>'platform_key' AS platform_key, observation AS summary, embedding <=> $2::vector AS distance
              FROM evidence_items
              WHERE user_id = $1 AND evidence_type = 'memory_lesson' AND embedding IS NOT NULL AND ($3::text IS NULL OR structured_data->>'platform_key' = $3)
            ) semantic_memory
            ORDER BY distance ASC
            LIMIT 8
            `,
            [userId, vectorLiteral(semanticVector), filters.platformKey || null]
          )
        : Promise.resolve({ rows: [] })
    ]);

    const entityAccounts: KocPlatformAccountMemory[] = accountResult.rows.map((row) => {
      const positioning = asRecord(row.positioning);
      const evidence = asRecord(row.evidence_summary);
      return {
        accountKey: row.account_key,
        platformKey: row.platform_key,
        displayName: row.account_name || undefined,
        profileUrl: row.profile_url || undefined,
        taskTypes: stringArray(positioning.task_types),
        contentDirections: stringArray(positioning.content_directions),
        knownConstraints: stringArray(positioning.known_constraints),
        effectivePatterns: stringArray(positioning.effective_patterns),
        ineffectivePatterns: stringArray(positioning.ineffective_patterns),
        openQuestions: stringArray(positioning.open_questions),
        evidenceLevel: evidenceLevel(evidence.evidence_level),
        lastRunAt: typeof evidence.last_run_at === "number" ? evidence.last_run_at : undefined,
        updatedAt: row.updated_at.getTime()
      };
    });

    const entityWorks: KocWorkMemory[] = workResult.rows.map((row) => {
      const analysis = asRecord(row.analysis_summary);
      const evidence = asRecord(row.evidence_contract);
      return {
        workKey: row.work_key,
        accountKey: row.account_key || `${row.platform_key}:unknown`,
        platformKey: row.platform_key,
        taskType: typeof analysis.task_type === "string" ? analysis.task_type : undefined,
        contentType: row.content_type || undefined,
        hook: typeof analysis.hook === "string" ? analysis.hook : undefined,
        decisionSummary: typeof analysis.decision_summary === "string" ? analysis.decision_summary : undefined,
        evidenceGaps: stringArray(evidence.evidence_gaps),
        metrics: asRecord(row.metrics_snapshot),
        experimentResult: experimentResult(analysis.experiment_result),
        updatedAt: row.updated_at.getTime()
      };
    });

    const entityExperiments: KocExperimentMemory[] = experimentResultSet.rows.map((row) => {
      const action = asRecord(row.action_plan);
      const target = asRecord(row.target_metrics);
      return {
        hypothesis: row.hypothesis,
        suggestedAction: typeof action.suggested_action === "string" ? action.suggested_action : "",
        expectedSignal: typeof target.expected_signal === "string" ? target.expected_signal : "",
        result: experimentResult(row.status),
        conclusion: typeof action.conclusion === "string" ? action.conclusion : "",
        variables: stringArray(action.variables),
        metrics: stringArray(target.metrics),
        createdFromRunId: row.source_key || undefined
      };
    });

    const entityEvidenceLessons: KocEvidenceLesson[] = evidenceResult.rows.map((row) => {
      const data = asRecord(row.structured_data);
      return {
        key: row.source_key || stableKey(row.source_label, row.observation),
        lesson: row.observation,
        severity: row.confidence === "high" ? "blocker" : row.confidence === "medium" ? "warning" : "info",
        taskType: typeof data.task_type === "string" ? data.task_type : row.source_label,
        platformKey: typeof data.platform_key === "string" ? data.platform_key : undefined,
        updatedAt: typeof data.updated_at === "number" ? data.updated_at : row.created_at.getTime()
      };
    });
    const semanticEvidenceLessons: KocEvidenceLesson[] = semanticResult.rows.map((row) => ({
      key: `semantic:${row.item_type}:${row.item_key}`,
      lesson: `相似历史记忆：${row.summary}`,
      severity: "info",
      taskType: filters.taskType,
      platformKey: row.platform_key || filters.platformKey,
      updatedAt: Date.now()
    }));

    return {
      ...base,
      platformAccounts: [...base.platformAccounts, ...entityAccounts],
      works: [...base.works, ...entityWorks],
      experiments: [...base.experiments, ...entityExperiments],
      evidenceLessons: [...base.evidenceLessons, ...entityEvidenceLessons, ...semanticEvidenceLessons]
    };
  }

  async save(memory: KocLongTermMemory) {
    const normalized = normalizeClientId(memory.clientId);
    const userId = await this.ensureUser(normalized);
    const nextMemory = normalizeKocMemory({ ...memory, clientId: normalized });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.saveMemoryBlob(client, userId, normalized, nextMemory);
      await this.syncPlatformAccounts(client, userId, nextMemory);
      await this.syncWorks(client, userId, nextMemory);
      await this.syncExperiments(client, userId, nextMemory);
      await this.syncEvidenceLessons(client, userId, nextMemory);
      await this.syncMemoryEdges(client, userId, nextMemory);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return nextMemory;
  }

  private async saveMemoryBlob(client: PoolClient, userId: string, clientId: string, memory: KocLongTermMemory) {
    await client.query(
      `
      INSERT INTO memory_profiles(user_id, scope_type, scope_key, memory_kind, content, summary, priority)
      VALUES($1, 'client', $2, 'long_term_blob', $3::jsonb, $4, 100)
      ON CONFLICT(user_id, scope_type, scope_key, memory_kind)
      DO UPDATE SET content = excluded.content, summary = excluded.summary, priority = excluded.priority, updated_at = now()
      `,
      [userId, clientId, JSON.stringify(memory), `runs=${memory.runs.length}; experiments=${memory.experiments.length}`]
    );
  }

  private async syncPlatformAccounts(client: PoolClient, userId: string, memory: KocLongTermMemory) {
    for (const account of memory.platformAccounts) {
      const summaryText = compactSummary(joinMemoryText([
        account.contentDirections,
        account.effectivePatterns,
        account.openQuestions
      ]));
      const embedding = await embedText(joinMemoryText([
        account.platformKey,
        account.accountKey,
        account.taskTypes,
        account.contentDirections,
        account.knownConstraints,
        account.effectivePatterns,
        account.ineffectivePatterns,
        account.openQuestions
      ])).catch(() => null);
      await client.query(
        `
        INSERT INTO platform_accounts(
          user_id, platform_key, account_key, account_name, profile_url,
          positioning, evidence_summary, memory_summary, embedding
        )
        VALUES($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::vector)
        ON CONFLICT(user_id, platform_key, account_key)
        DO UPDATE SET
          account_name = COALESCE(excluded.account_name, platform_accounts.account_name),
          profile_url = COALESCE(excluded.profile_url, platform_accounts.profile_url),
          positioning = excluded.positioning,
          evidence_summary = excluded.evidence_summary,
          memory_summary = excluded.memory_summary,
          embedding = COALESCE(excluded.embedding, platform_accounts.embedding),
          updated_at = now()
        `,
        [
          userId,
          account.platformKey || "unknown",
          account.accountKey,
          account.displayName || account.accountId || null,
          account.profileUrl || null,
          JSON.stringify({
            task_types: account.taskTypes,
            content_directions: account.contentDirections,
            known_constraints: account.knownConstraints,
            effective_patterns: account.effectivePatterns,
            ineffective_patterns: account.ineffectivePatterns,
            open_questions: account.openQuestions
          }),
          JSON.stringify({
            evidence_level: account.evidenceLevel,
            last_run_at: account.lastRunAt,
            updated_at: account.updatedAt
          }),
          summaryText,
          embedding ? vectorLiteral(embedding) : null
        ]
      );
    }
  }

  private async syncWorks(client: PoolClient, userId: string, memory: KocLongTermMemory) {
    for (const work of memory.works) {
      const accountId = await this.findPlatformAccountId(client, userId, work.platformKey, work.accountKey);
      const embedding = await embedText(joinMemoryText([
        work.platformKey,
        work.accountKey,
        work.workKey,
        work.taskType,
        work.contentType,
        work.hook,
        work.decisionSummary,
        work.evidenceGaps
      ])).catch(() => null);
      await client.query(
        `
        INSERT INTO works(
          user_id, platform_account_id, platform_key, account_key, work_key,
          content_type, metrics_snapshot, analysis_summary, evidence_contract, learning_packet, embedding
        )
        VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::vector)
        ON CONFLICT(user_id, platform_key, work_key)
        DO UPDATE SET
          platform_account_id = COALESCE(excluded.platform_account_id, works.platform_account_id),
          account_key = COALESCE(excluded.account_key, works.account_key),
          content_type = COALESCE(excluded.content_type, works.content_type),
          metrics_snapshot = excluded.metrics_snapshot,
          analysis_summary = excluded.analysis_summary,
          evidence_contract = excluded.evidence_contract,
          learning_packet = excluded.learning_packet,
          embedding = COALESCE(excluded.embedding, works.embedding),
          updated_at = now()
        `,
        [
          userId,
          accountId,
          work.platformKey || "unknown",
          work.accountKey || null,
          work.workKey,
          work.contentType || null,
          JSON.stringify(work.metrics || {}),
          JSON.stringify({
            task_type: work.taskType,
            hook: work.hook,
            decision_summary: work.decisionSummary,
            experiment_result: work.experimentResult
          }),
          JSON.stringify({ evidence_gaps: work.evidenceGaps || [] }),
          JSON.stringify({ decision_summary: work.decisionSummary || "" }),
          embedding ? vectorLiteral(embedding) : null
        ]
      );
    }
  }

  private async syncExperiments(client: PoolClient, userId: string, memory: KocLongTermMemory) {
    for (const experiment of memory.experiments) {
      const run = experiment.createdFromRunId
        ? memory.runs.find((item) => item.id === experiment.createdFromRunId)
        : undefined;
      const accountId = run?.accountKey
        ? await this.findPlatformAccountId(client, userId, run.platformKey || "unknown", run.accountKey)
        : null;
      const workId = run?.workKey
        ? await this.findWorkId(client, userId, run.platformKey || "unknown", run.workKey)
        : null;
      const sourceKey = experiment.createdFromRunId || stableKey(experiment.hypothesis, experiment.suggestedAction);
      await client.query(
        `
        INSERT INTO experiments(
          source_key, user_id, platform_account_id, work_id, hypothesis,
          action_plan, target_metrics, status
        )
        VALUES($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
        ON CONFLICT(user_id, source_key) WHERE source_key IS NOT NULL
        DO UPDATE SET
          platform_account_id = COALESCE(excluded.platform_account_id, experiments.platform_account_id),
          work_id = COALESCE(excluded.work_id, experiments.work_id),
          hypothesis = excluded.hypothesis,
          action_plan = excluded.action_plan,
          target_metrics = excluded.target_metrics,
          status = excluded.status,
          updated_at = now()
        `,
        [
          sourceKey,
          userId,
          accountId,
          workId,
          experiment.hypothesis,
          JSON.stringify({
            suggested_action: experiment.suggestedAction,
            variables: experiment.variables || [],
            conclusion: experiment.conclusion
          }),
          JSON.stringify({
            expected_signal: experiment.expectedSignal,
            metrics: experiment.metrics || []
          }),
          experiment.result || "pending"
        ]
      );
    }
  }

  private async syncEvidenceLessons(client: PoolClient, userId: string, memory: KocLongTermMemory) {
    for (const lesson of memory.evidenceLessons) {
      const sourceKey = lesson.key || stableKey(lesson.taskType, lesson.platformKey, lesson.lesson);
      const embedding = await embedText(joinMemoryText([
        lesson.taskType,
        lesson.platformKey,
        lesson.severity,
        lesson.lesson
      ])).catch(() => null);
      await client.query(
        `
        INSERT INTO evidence_items(
          source_key, user_id, evidence_type, source_label,
          confidence, observation, structured_data, embedding
        )
        VALUES($1, $2, 'memory_lesson', $3, $4, $5, $6::jsonb, $7::vector)
        ON CONFLICT(user_id, source_key) WHERE source_key IS NOT NULL
        DO UPDATE SET
          source_label = excluded.source_label,
          confidence = excluded.confidence,
          observation = excluded.observation,
          structured_data = excluded.structured_data,
          embedding = COALESCE(excluded.embedding, evidence_items.embedding)
        `,
        [
          sourceKey,
          userId,
          lesson.taskType || "memory",
          lesson.severity === "blocker" ? "high" : lesson.severity === "warning" ? "medium" : "low",
          lesson.lesson,
          JSON.stringify({
            task_type: lesson.taskType,
            platform_key: lesson.platformKey,
            updated_at: lesson.updatedAt
          }),
          embedding ? vectorLiteral(embedding) : null
        ]
      );
    }
  }

  private async syncMemoryEdges(client: PoolClient, userId: string, memory: KocLongTermMemory) {
    for (const work of memory.works) {
      if (!work.accountKey || !work.workKey) continue;
      await client.query(
        `
        INSERT INTO memory_edges(user_id, from_type, from_key, relation, to_type, to_key, weight, evidence)
        VALUES($1, 'platform_account', $2, 'owns_work', 'work', $3, 1, $4::jsonb)
        ON CONFLICT(user_id, from_type, from_key, relation, to_type, to_key)
        DO UPDATE SET weight = excluded.weight, evidence = excluded.evidence, updated_at = now()
        `,
        [userId, work.accountKey, work.workKey, JSON.stringify({ platform_key: work.platformKey, task_type: work.taskType })]
      );
    }

    for (const experiment of memory.experiments) {
      const run = experiment.createdFromRunId
        ? memory.runs.find((item) => item.id === experiment.createdFromRunId)
        : undefined;
      const sourceKey = experiment.createdFromRunId || stableKey(experiment.hypothesis, experiment.suggestedAction);
      if (run?.workKey) {
        await client.query(
          `
          INSERT INTO memory_edges(user_id, from_type, from_key, relation, to_type, to_key, weight, evidence)
          VALUES($1, 'work', $2, 'tested_by_experiment', 'experiment', $3, 1, $4::jsonb)
          ON CONFLICT(user_id, from_type, from_key, relation, to_type, to_key)
          DO UPDATE SET weight = excluded.weight, evidence = excluded.evidence, updated_at = now()
          `,
          [userId, run.workKey, sourceKey, JSON.stringify({ result: experiment.result, hypothesis: experiment.hypothesis })]
        );
      } else if (run?.accountKey) {
        await client.query(
          `
          INSERT INTO memory_edges(user_id, from_type, from_key, relation, to_type, to_key, weight, evidence)
          VALUES($1, 'platform_account', $2, 'tested_by_experiment', 'experiment', $3, 1, $4::jsonb)
          ON CONFLICT(user_id, from_type, from_key, relation, to_type, to_key)
          DO UPDATE SET weight = excluded.weight, evidence = excluded.evidence, updated_at = now()
          `,
          [userId, run.accountKey, sourceKey, JSON.stringify({ result: experiment.result, hypothesis: experiment.hypothesis })]
        );
      }
    }
  }

  private async findPlatformAccountId(client: PoolClient, userId: string, platformKey: string, accountKey?: string) {
    if (!accountKey) return null;
    const result = await client.query<{ id: string }>(
      "SELECT id FROM platform_accounts WHERE user_id = $1 AND platform_key = $2 AND account_key = $3 LIMIT 1",
      [userId, platformKey || "unknown", accountKey]
    );
    return result.rows[0]?.id || null;
  }

  private async findWorkId(client: PoolClient, userId: string, platformKey: string, workKey?: string) {
    if (!workKey) return null;
    const result = await client.query<{ id: string }>(
      "SELECT id FROM works WHERE user_id = $1 AND platform_key = $2 AND work_key = $3 LIMIT 1",
      [userId, platformKey || "unknown", workKey]
    );
    return result.rows[0]?.id || null;
  }

  async clear(clientId?: string | null) {
    const normalized = normalizeClientId(clientId);
    const userId = await this.ensureUser(normalized);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM memory_edges WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM evidence_items WHERE user_id = $1 AND evidence_type = 'memory_lesson'", [userId]);
      await client.query("DELETE FROM experiments WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM works WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM platform_accounts WHERE user_id = $1", [userId]);
      await client.query(
        `
        DELETE FROM memory_profiles
        WHERE user_id = $1
          AND scope_type = 'client'
          AND scope_key = $2
          AND memory_kind = 'long_term_blob'
        `,
        [userId, normalized]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return createEmptyKocMemory(normalized);
  }

  async appendRun(clientId: string | undefined, run: Omit<KocMemoryRun, "id" | "at">) {
    return this.save(appendKocRunToMemory(await this.load(clientId), run));
  }

  async recordExperimentReview(
    clientId: string | undefined,
    payload: {
      runId?: string;
      metrics?: Record<string, unknown>;
      result?: KocExperimentMemory["result"];
      conclusion?: string;
    }
  ) {
    return this.save(recordKocExperimentReviewInMemory(await this.load(clientId), payload));
  }
}

const repository: KocMemoryRepository =
  KOC_DB_PROVIDER === "postgres" || KOC_DB_PROVIDER === "postgresql" || KOC_DATABASE_URL
    ? new PostgresKocMemoryRepository(KOC_DATABASE_URL)
    : new LocalJsonKocMemoryRepository();

export function loadKocMemory(clientId?: string | null, filters?: KocMemoryLoadFilters) {
  return repository.load(clientId, filters);
}

export function saveKocMemory(memory: KocLongTermMemory) {
  return repository.save(memory);
}

export function clearKocMemory(clientId?: string | null) {
  return repository.clear(clientId);
}

export function appendKocRun(clientId: string | undefined, run: Omit<KocMemoryRun, "id" | "at">) {
  return repository.appendRun(clientId, run);
}

export function recordKocExperimentReview(
  clientId: string | undefined,
  payload: {
    runId?: string;
    metrics?: Record<string, unknown>;
    result?: KocExperimentMemory["result"];
    conclusion?: string;
  }
) {
  return repository.recordExperimentReview(clientId, payload);
}

export function getKocMemoryRepository() {
  return repository;
}
