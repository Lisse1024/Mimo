# KOC LangGraph Agent

This directory is a standalone KOC Agent desktop app built around a LangGraph workflow. It contains the Python KOC backend, the Node desktop gateway, and the Tauri DeskMate pet UI.

## Requirements

- Python 3.10 or newer
- Node.js 20 or newer
- Rust and the Tauri desktop prerequisites
- Network access to the configured Kimi/Moonshot endpoint when model calls are needed
- Optional local commands for richer media extraction:
  - `tesseract` for image OCR
  - `whisper` for video/audio ASR

## Setup

```powershell
cd koc_langgraph_agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
npm run setup
Copy-Item .env.example .env
```

Edit `.env` and fill in `MOONSHOT_API_KEY` if you want live model calls.

## Data Collection Path

当前项目不接入平台官方接口。个人主体通常无法申请本项目需要的开放平台应用和数据权限，所以桌宠采用更适合个人开发者落地的合规链路：

1. 用户授权录屏：用于分析单条作品的画面、剪辑节奏、字幕、台词和 BGM 线索。
2. 用户授权截图：用于补充主页、评论区、标题标签、创作者后台等可见信息。
3. OCR/ASR：从截图、录屏和音频中提取字幕、台词、解说和可见文案。
4. 浏览器桥接：只读取用户当前可见页面的标题、链接、可见文本和结构化线索。
5. 人工指标回填：发布后由用户填写播放量、完播率、点赞、评论、收藏、转粉、主页点击等真实指标。
6. 复盘记忆：Agent 根据真实回填数据沉淀账号、平台、作品和实验结论，下一轮诊断优先读取同平台、同账号、同作品历史。

推荐的数据回填方式：

```text
发布 2 小时：回填初始播放、点赞、评论、收藏、转粉。
发布 24 小时：回填完播、平均播放时长、互动率、主页点击。
发布 72 小时：回填最终判断，标记实验为有效、无效或需要继续观察。
```

这条链路不绕过平台限制，也不会要求用户提供不具备权限的官方接口凭证。后续如果你有企业或个体工商户主体，再评估是否新增官方数据连接器。
## Run Full DeskMate App

```powershell
npm run dev
```

`npm run dev` uses the project-local `.venv\Scripts\python.exe`, so the backend does not accidentally start with a different Python that lacks LangGraph.

This starts three local processes:

```text
Python KOC LangGraph backend  http://127.0.0.1:8010
Node DeskMate gateway         http://127.0.0.1:8787
Tauri DeskMate desktop app    desktop pet window
```

You can also use the PowerShell helper:

```powershell
.\scripts\start_deskmate.ps1
```

## Run Backend Only

```powershell
python -m koc_backend
```

Default backend endpoint:

```text
http://127.0.0.1:8010
```

Change host or port with environment variables:

```powershell
$env:KOC_HOST = "127.0.0.1"
$env:KOC_PORT = "8011"
python -m koc_backend
```

Useful checks:

```text
GET /
GET /api/health
GET /api/bootstrap
```

Desktop gateway delivery checks:

```text
GET /api/koc/status
GET /api/koc/readiness
GET /api/koc/memory
```

`/api/koc/readiness` is the handoff check for the desktop Agent. It reports gateway health, Python backend address, foreground-window observation, long-term memory quality, pending experiment reviews, and whether user-visible output has the Chinese/hidden-internal-field guard enabled.

## Architecture

```text
koc_backend.__main__
  -> koc_backend.http_api               # HTTP handler and server lifecycle
    -> koc_backend.agent_runner          # async strategy job startup and graph runtime wiring
    -> koc_backend.config                 # paths and environment
    -> koc_backend.checkpoints            # LangGraph checkpointer lifecycle
    -> koc_backend.graph_jobs             # graph compilation and invocation boundary
    -> koc_backend.storage                # SQLite kv, async job persistence, model-call log
    -> koc_backend.async_jobs             # async job state and event timeline
    -> koc_backend.jobs_state             # strategy job facade backed by AsyncJobManager
    -> koc_backend.llm                    # Kimi text/vision client
    -> koc_backend.profiles               # profile/store loading and client projection
    -> koc_backend.profile_validation     # profile payload validation and upload normalization
    -> koc_backend.profile_intent         # public-link parsing and task-intent routing helpers
    -> koc_backend.assets                 # upload persistence, OCR/ASR enrichment, visual analysis
    -> koc_backend.artifacts              # artifact annotation, guardrails and evidence summary
    -> koc_backend.memory                 # growth memory mutation helpers
    -> koc_backend.strategy_reports       # advisor reports, summaries and fallback diagnostics
    -> koc_backend.strategy_service       # strategy bundle assembly and rule/model strategy paths
    -> koc_backend.task_service           # task normalization and follow-up generation
    -> koc_backend.workspace_service      # workspace commit, calendar, post pack and review flows
    -> koc_backend.catalog                # platform/track/stage dictionaries
    -> koc_backend.schemas                # model JSON output schemas
  -> run_strategy_graph_job()
    -> koc_graph.build_koc_graph()
      -> load_profile
      -> resolve_platform_identity
      -> analyze_assets
      -> collect_evidence_snapshot           # normalizes platform/material/memory/work evidence before routing
      -> decision_gate                       # routes by task, evidence quality and memory signal
        -> plan_evidence_repair              # records missing evidence actions when confidence is low
        -> request_user_evidence             # pauses when evidence is too thin to analyze responsibly
      -> route by task/evidence depth
        -> build_internal_reports              # account diagnosis with enough context
        -> skip internal reports               # single work or profile-link-only requests
      -> build_hot_video_analysis
      -> route by strategy path
        -> rule_based_strategy                 # single work, profile-link-only, or strong visual evidence
        -> model_strategy                      # ambiguous or evidence-light account diagnosis
      -> build_evidence_and_followups
      -> persist_workspace
      -> finalize_job
      -> fail_job                              # shared failure sink for node errors
```

`koc_graph.build_koc_graph()` imports LangGraph directly and returns a compiled `StateGraph`. If LangGraph is not installed, startup or self-checks fail instead of silently falling back to a non-LangGraph workflow.

The graph is intentionally responsible for orchestration decisions:

- Conditional edges choose whether to run internal account diagnostics or skip straight to benchmark analysis.
- `decision_gate` evaluates task type, asset status, evidence level and memory context before choosing the next path.
- Low-evidence runs go through `plan_evidence_repair`, which records what the user should provide next while allowing the Agent to continue with conservative conclusions.
- Evidence-empty runs can stop at `request_user_evidence` with `status=waiting_for_evidence`. This prevents the Agent from fabricating account positioning, story context, dialogue, BGM or growth conclusions when there is not enough material.
- Strategy generation is split into explicit rule-based and model-backed branches, so job metadata can show which path was used.
- Strong same-account or similar-memory signals can keep the graph on the rule-based strategy path; ambiguous or evidence-light account work can still route to model strategy.
- Single-work analysis now produces a normalized `WorkUnderstanding` object (`work_understanding.v1`) before strategy generation. It captures source clues, timeline, audio/caption summaries, visual observations, replication variables, evidence and limitations, so downstream nodes do not guess from raw screenshots.
- Evidence collection now has its own graph node. `collect_evidence_snapshot` summarizes user request, platform identity, links, assets, video timeline, OCR, ASR, memory and work-understanding facts before `decision_gate` chooses whether to continue, repair evidence, pause, or route to account reports.
- Tool calls run through `koc_backend.tool_registry.ToolRegistry`. Platform identity resolution, media analysis, OCR, ASR and work-understanding all emit `tool_runs` with status and latency into graph state, which gives the Agent a real execution trace instead of hidden function calls.
- Every production node is wrapped with a failure guard and routes to `fail_job`, which writes the failed node, error list, warnings and stage events back into the async job.
- Completed jobs persist `graph_state`, including stage events, warnings, task intent, platform identity, strategy path, work understanding and tool runs. This gives the desktop gateway a useful trace without coupling the UI to Python internals.
- The Python backend keeps a live `events` timeline on each async job, capped to the latest 120 stage updates, so the UI can show progress and degradation reasons while the graph is still running.
- `koc_backend.graph_jobs` builds the graph through `koc_graph.runtime.build_runtime()`, which validates required runtime dependencies before invoking the workflow.
- The Node gateway exposes `/api/koc/readiness` and `buildKocMemoryQualityReport()`, so delivery quality is checked as data instead of by manual testing alone. The self-check now fails when user-facing placeholders, raw internal field names, or missing readiness contracts reappear.
- Set `KOC_LANGGRAPH_IN_MEMORY_CHECKPOINTS=0` to disable the in-process LangGraph checkpointer. The default in-memory checkpointer gives each run a `thread_id` and prepares the code path for durable checkpointing later.

This keeps LangGraph as the control plane while `koc_backend` owns legacy business functions and local storage. The next production step is to move model calls, storage, and asset processing behind smaller service modules, then replace the in-memory checkpointer with a durable checkpoint store or external queue when jobs need to survive process restarts.

## Local State

All runtime files are stored under this directory:

```text
data/
  koc_agent.sqlite3
  async_jobs.json
  uploads/
  asr/
```

The backend resolves uploaded assets relative to this directory and rejects file paths outside the project folder.

## Production Data Layer

The recommended production storage plan is PostgreSQL with `pgvector` as the primary database. This project should not start with a standalone knowledge graph database or a separate vector database unless scale proves that PostgreSQL is no longer enough.

Why this shape:

- PostgreSQL keeps users, platforms, accounts, works, jobs, experiments, evidence and model-call logs in one transactional system.
- `pgvector` handles semantic recall for account memory, work analysis, evidence snippets and reusable growth patterns.
- A lightweight `memory_edges` table keeps graph-style relationships such as `account -> work`, `work -> experiment`, `strategy -> metric_result` without adding Neo4j too early.
- Local JSON/SQLite remains the default development fallback, so the desktop app can still run on one machine without database setup.
- Large media files should stay outside the database under local object storage during development, then move to S3/OSS/MinIO in deployment. The database stores object keys, hashes, duration and metadata.

The production schema lives in:

```text
database/schema.sql
```

It includes the core entities a real KOC Agent needs:

```text
users
platform_accounts
works
asset_objects
diagnosis_jobs
evidence_items
experiments
experiment_reviews
memory_profiles
memory_edges
agent_trace_events
model_calls
```

This makes platform isolation explicit: the same user can have Douyin, Xiaohongshu, Bilibili or other accounts, and each account can carry its own memory, works, experiments and evidence history. On the next agent run, the system should first resolve `platform_key + account_key + work_key`, then retrieve memory in this priority order:

1. Same work memory, when analyzing or following up a specific video.
2. Same platform account memory, when diagnosing an account or planning content.
3. Same platform patterns, when the account is new but platform behavior matters.
4. Global user preferences, only for durable style and workflow preferences.

Initialize a PostgreSQL database after setting `KOC_DATABASE_URL`:

```powershell
Copy-Item .env.example .env
$env:KOC_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/koc_agent"
npm run db:init
```

Or set these values in `.env`:

```text
KOC_DB_PROVIDER=postgres
KOC_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/koc_agent
KOC_VECTOR_PROVIDER=pgvector
KOC_STORAGE_DRIVER=local
```

Current implementation note: the schema and initialization path are ready, while the existing runtime still uses local JSON/SQLite for development compatibility. The next migration step is to move memory reads/writes and async job persistence behind repository interfaces, then switch those repositories to PostgreSQL when `KOC_DB_PROVIDER=postgres`.

The memory layer has already been moved behind a repository boundary in the Node gateway:

```text
apps/server/src/koc-memory.ts              # memory shape, summarization and mutation rules
apps/server/src/koc-memory-repository.ts   # local JSON or PostgreSQL repository selection
```

In default development mode, it still reads and writes `apps/server/.data/koc-memory/*.json`. When `KOC_DB_PROVIDER=postgres` and `KOC_DATABASE_URL` are configured, the gateway stores the long-term memory blob in `memory_profiles` with:

```text
scope_type=client
scope_key=<client id>
memory_kind=long_term_blob
```

This is the first production migration step. It keeps the current Agent behavior stable while making the storage backend replaceable. The next step is to split the blob into first-class rows for `platform_accounts`, `works`, `experiments` and `evidence_items`, so memory retrieval can combine exact platform/account filtering with vector recall.

The PostgreSQL repository now performs that first entity sync on every memory save:

```text
memory_profiles      keeps the compatible long-term memory blob
platform_accounts    stores per-platform account memory and constraints
works                stores per-work analysis, evidence gaps and learning packets
experiments          stores growth hypotheses, actions, target metrics and review status
evidence_items       stores reusable evidence lessons
memory_edges         links account -> work and work/account -> experiment
```

The blob is still kept intentionally. It protects the current desktop behavior while the query layer moves toward entity-first retrieval. The next production-hardening step is to make memory loading query these rows directly, then add vector embeddings for account summaries, work summaries and evidence lessons.

Memory loading now accepts the current task identity and uses it before the model prompt is built:

```text
taskType
platformKey
accountKey
workKey
```

In PostgreSQL mode, `koc-memory-repository` hydrates memory from the entity tables using those filters:

```text
same work        -> works
same account     -> platform_accounts
same platform    -> evidence_items / account rows
global fallback  -> memory_profiles long_term_blob
```

This is the retrieval path the Agent needs for multi-platform creators: a Douyin work analysis should not accidentally reuse a Xiaohongshu account diagnosis unless the memory has been promoted into a global user preference or reusable evidence lesson.

Semantic recall is also wired but disabled by default. Configure an OpenAI-compatible embeddings endpoint to enable it:

```text
KOC_EMBEDDING_PROVIDER=openai-compatible
KOC_EMBEDDING_BASE_URL=https://your-embedding-endpoint/v1
KOC_EMBEDDING_API_KEY=...
KOC_EMBEDDING_MODEL=...
KOC_EMBEDDING_DIMENSIONS=1536
```

When embeddings are enabled, the Node gateway writes vectors for:

```text
platform_accounts.embedding
works.embedding
evidence_items.embedding
```

On memory load, the current task text is embedded and compared with these tables through `pgvector`. The result is added back as reusable evidence lessons, so the Agent can recall similar hooks, similar account constraints, similar evidence gaps or similar experiments even when the exact `workKey` is different.

## Experiment Review Loop

KOC diagnosis is only useful when advice is reviewed against real post data. The Node gateway exposes:

```text
GET /api/koc/agenda
POST /api/koc/experiment/review
POST /api/koc/memory/review
```

The review payload can include `runId`, `result`, `conclusion` and metrics such as:

```json
{
  "views": 1800,
  "completionRate": 42,
  "comments": 12,
  "follows": 3,
  "homepageClicks": 8
}
```

The review endpoints validate the payload before writing memory. At least one recognized post-publish metric is required, and a single metric should be paired with either a second metric, an explicit result, or a short human conclusion. Recognized metric keys include `views`, `likes`, `saves`, `comments`, `shares`, `follows`, `homepageClicks`, `completionRate` and `avgWatchSeconds`, plus common Chinese aliases such as 鎾斁銆佺偣璧炪€佹敹钘忋€佽瘎璁恒€佸垎浜€佹定绮夈€佷富椤电偣鍑?and 瀹屾挱鐜?

If the user does not provide an explicit result, the gateway infers `positive`, `mixed` or `negative` from the metrics and writes that review back into long-term memory. Positive reviews become effective patterns, negative reviews become ineffective patterns, and mixed reviews become open questions for the next run.

`/api/koc/agenda` turns memory into an action queue. It prioritizes pending experiment reviews, evidence repair tasks and platform-account follow-ups, so the next Agent session can ask for the most useful missing result instead of starting from an empty chat.

## Self-Check

Run this from any working directory:

```powershell
python path\to\koc_langgraph_agent\scripts\self_check.py
```

The script compiles project Python files, verifies the graph is a LangGraph `CompiledStateGraph`, and checks that configured runtime paths stay inside `koc_langgraph_agent`.
It also asserts that the removed single-file backend shims (`server.py`, `koc_backend/app.py`) have not returned, checks task-intent classification for profile links vs. single-work links, and runs a lightweight graph route test to make sure single-work analysis skips account-report nodes and uses the rule-based strategy path.

For a fuller local smoke test of the "current video / single work" path:

```powershell
.\.venv\Scripts\python.exe scripts\smoke_single_work.py
```


