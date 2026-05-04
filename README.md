# Mimo

Mimo is an evidence-driven desktop agent for KOC creators and short-form content operators. It helps creators analyze authorized screenshots, screen recordings, uploaded clips, sampled video frames, OCR/ASR text, titles, tags, and browser-visible clues, then turns them into practical content-growth decisions.

Mimo is not a generic chatbot and not a video narration template generator. Its core output loop is:

```text
evidence -> judgment -> action -> validation metrics -> review
```

## What Mimo Does

- **Current video analysis**: extracts visible facts, subtitles, audio clues, content type, hooks, limitations, and evidence-grounded script steps.
- **Homepage diagnosis**: reads visible profile signals, work samples, cover text, titles, visible metrics, and content patterns to suggest focused column experiments.
- **Evidence boundary control**: separates direct evidence, inferred claims, low-confidence claims, missing evidence, and forbidden claims.
- **Conservative degradation**: if vision, OCR, ASR, or page context is incomplete, Mimo says what is missing instead of inventing facts.
- **Copyright and usage guidance**: for film, variety, music, performance, and derivative material, Mimo recommends structure reuse, commentary-style quotation, authorized material, platform-available assets, screenshot explanation, or voiceover retelling.

## Product Principles

Mimo is designed around a simple rule: a growth recommendation must be traceable to evidence.

It avoids:

- generic short-video templates that are not tied to the current material;
- claims such as "the backend data proves it", "this will definitely go viral", or "the comments are all saying";
- turning a single video into a confirmed long-term account direction;
- treating user instructions, tool logs, file names, upload metadata, runtime context, or internal errors as content evidence;
- exposing internal English keys, stack traces, connector state, or debug fields in user-facing replies.

## User-Facing Output

For a single-work analysis, Mimo returns:

1. Effective conclusion
2. Evidence basis
3. Current issue
4. Next action
5. Suggested script
6. Validation and review
7. Evidence boundary

For a homepage diagnosis, Mimo returns:

1. Effective conclusion
2. Evidence basis
3. Current issue
4. Next action
5. Column test plan
6. Validation and review
7. Evidence boundary

## Architecture

```text
apps/desktop
  Tauri + React desktop UI
  screenshots, recordings, uploads, agent panel
        |
        v
apps/server
  Node/Express desktop gateway
  media preprocessing, frame extraction, API adaptation,
  job polling, final Chinese reply formatting and guardrails
        |
        v
koc_backend
  Python KOC backend
  model calls, OCR/ASR/vision enrichment,
  material understanding, evidence contract,
  strategy generation, persistence
        |
        v
koc_graph
  LangGraph workflow
  intake -> platform -> assets -> evidence snapshot
  -> decision -> strategy -> evidence -> persist
        |
        v
data/ and database/schema.sql
  local runtime data and production schema
```

## Key Modules

```text
apps/desktop/                  Desktop UI and Tauri shell
apps/server/                   Node gateway and final reply formatter
koc_backend/                   Python KOC backend and strategy services
koc_graph/                     LangGraph orchestration
database/schema.sql            Recommended production database schema
docs/                          Product and output contract documents
scripts/                       Local checks and regression scripts
```

## Evidence Structures

### `evidence_contract`

```json
{
  "direct_evidence": [],
  "inferred_claims": [],
  "low_confidence_claims": [],
  "missing_evidence": [],
  "forbidden_claims": []
}
```

### `fact_ledger`

```json
{
  "visible_facts": [],
  "audio_facts": [],
  "text_facts": [],
  "possible_source": {
    "name": "",
    "confidence": "high | medium | low | unknown",
    "evidence": []
  },
  "characters_or_people": [],
  "timeline": [],
  "growth_hooks": [],
  "limitations": []
}
```

### `homepage_evidence_map`

```json
{
  "profile_signals": {},
  "visible_work_samples": [],
  "content_patterns": [],
  "profile_problems": [],
  "missing_evidence": []
}
```

## Requirements

- Windows 10/11 for the packaged desktop demo
- Python 3.10+
- Node.js 20+
- Rust and Tauri desktop prerequisites
- A configured Moonshot/Kimi-compatible API endpoint for live model calls
- Optional media tools:
  - `tesseract` for OCR
  - `whisper` for ASR

## Local Setup

```powershell
git clone https://github.com/Lisse1024/Mimo.git
cd Mimo
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm install
Copy-Item .env.example .env
```

Edit `.env` and provide a model API key if live model calls are needed:

```text
MOONSHOT_API_KEY=your_key_here
```

## Run in Development

Start the full local desktop workflow:

```powershell
npm run dev
```

This starts:

```text
Python KOC backend      http://127.0.0.1:8010
Node desktop gateway    http://127.0.0.1:8787
Tauri desktop app       desktop window
```

Run individual parts:

```powershell
npm run dev:koc
npm run dev:server
npm run dev:desktop
```

## Build

```powershell
npm run build
npm run build:server
npm run build:desktop
```

The Tauri Windows installer is generated under:

```text
apps/desktop/src-tauri/target/release/bundle/
```

## Validation

Recommended checks:

```powershell
python -m compileall koc_backend koc_graph
python scripts/test_koc_evidence_contract.py
python scripts/test_koc_work_fact_ledger.py
python scripts/test_koc_dynamic_script.py
python scripts/test_koc_homepage_evidence_pipeline.py
npm.cmd --workspace apps/server run build
node --import tsx apps/server/test/test-koc-final-reply.ts
node --import tsx apps/server/test/test-koc-e2e-mock-job.ts
npm.cmd run self-check
```

## Demo Notes for Reviewers

For the quickest review path:

1. Prepare `.env` with a temporary demo model key.
2. Run `npm run dev`.
3. Open the desktop agent.
4. Use an authorized screenshot, screen recording, or uploaded clip.
5. Ask for either current-video analysis or homepage diagnosis.
6. Check whether the response cites evidence, avoids unsupported claims, and proposes a measurable next action.

The release ZIP can include a reviewer-only `.env` file for convenience, but `.env` is intentionally excluded from Git history.

## Documentation

- [KOC Agent Product Description](docs/KOC_AGENT_PRODUCT_DESCRIPTION.md)
- [KOC Agent Output Contract](docs/KOC_AGENT_OUTPUT_CONTRACT.md)
- [Project Contents](PROJECT_CONTENTS.md)

## Repository

```text
https://github.com/Lisse1024/Mimo.git
```

## License

No public license has been declared yet. Treat this repository as private evaluation material unless a license is added.
