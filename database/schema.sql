CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_key TEXT UNIQUE NOT NULL,
    display_name TEXT,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_key TEXT NOT NULL,
    account_key TEXT NOT NULL,
    account_name TEXT,
    profile_url TEXT,
    positioning JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
    memory_summary TEXT NOT NULL DEFAULT '',
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, platform_key, account_key)
);

CREATE TABLE IF NOT EXISTS works (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_account_id UUID REFERENCES platform_accounts(id) ON DELETE SET NULL,
    platform_key TEXT NOT NULL,
    account_key TEXT,
    work_key TEXT NOT NULL,
    canonical_url TEXT,
    title TEXT,
    publish_time TIMESTAMPTZ,
    content_type TEXT,
    content_track TEXT,
    metrics_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    analysis_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
    learning_packet JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, platform_key, work_key)
);

CREATE TABLE IF NOT EXISTS asset_objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    work_id UUID REFERENCES works(id) ON DELETE SET NULL,
    storage_driver TEXT NOT NULL DEFAULT 'local',
    object_key TEXT NOT NULL UNIQUE,
    mime_type TEXT,
    byte_size BIGINT,
    sha256 TEXT,
    duration_seconds NUMERIC,
    width INTEGER,
    height INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diagnosis_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    platform_account_id UUID REFERENCES platform_accounts(id) ON DELETE SET NULL,
    work_id UUID REFERENCES works(id) ON DELETE SET NULL,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL,
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    graph_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key TEXT,
    job_id UUID REFERENCES diagnosis_jobs(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    platform_account_id UUID REFERENCES platform_accounts(id) ON DELETE SET NULL,
    work_id UUID REFERENCES works(id) ON DELETE SET NULL,
    asset_id UUID REFERENCES asset_objects(id) ON DELETE SET NULL,
    evidence_type TEXT NOT NULL,
    source_label TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    observation TEXT NOT NULL,
    structured_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE TABLE IF NOT EXISTS experiments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key TEXT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_account_id UUID REFERENCES platform_accounts(id) ON DELETE SET NULL,
    work_id UUID REFERENCES works(id) ON DELETE SET NULL,
    hypothesis TEXT NOT NULL,
    action_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
    target_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE TABLE IF NOT EXISTS experiment_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    observed_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    conclusion TEXT NOT NULL DEFAULT '',
    next_decision TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    memory_kind TEXT NOT NULL,
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    embedding vector(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, scope_type, scope_key, memory_kind)
);

CREATE TABLE IF NOT EXISTS memory_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_type TEXT NOT NULL,
    from_key TEXT NOT NULL,
    relation TEXT NOT NULL,
    to_type TEXT NOT NULL,
    to_key TEXT NOT NULL,
    weight NUMERIC NOT NULL DEFAULT 1,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, from_type, from_key, relation, to_type, to_key)
);

CREATE TABLE IF NOT EXISTS agent_trace_events (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID REFERENCES diagnosis_jobs(id) ON DELETE CASCADE,
    thread_id TEXT,
    node_name TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES diagnosis_jobs(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    latency_ms INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_accounts_user_platform ON platform_accounts(user_id, platform_key);
CREATE INDEX IF NOT EXISTS idx_works_user_platform_account ON works(user_id, platform_key, account_key);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON diagnosis_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_scope ON evidence_items(user_id, platform_account_id, work_id);
CREATE INDEX IF NOT EXISTS idx_experiments_scope_status ON experiments(user_id, platform_account_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_source_key ON evidence_items(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_source_key ON experiments(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_profiles_scope ON memory_profiles(user_id, scope_type, scope_key, priority DESC);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(user_id, from_type, from_key, relation);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(user_id, to_type, to_key, relation);
CREATE INDEX IF NOT EXISTS idx_trace_job_created ON agent_trace_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_accounts_embedding
    ON platform_accounts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_works_embedding
    ON works USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_embedding
    ON evidence_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_profiles_embedding
    ON memory_profiles USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    WHERE embedding IS NOT NULL;
