# Mimo Product Description

> Format: competition / demo / product review document  
> Product: Mimo, an evidence-driven KOC growth agent  
> Output loop: evidence -> judgment -> action -> validation metrics -> review

---

## Cover Page

| Field | Content |
| --- | --- |
| Product name | Mimo: Evidence-Driven KOC Growth Agent |
| Track | AI-native application / Agent application / Creator tool / Content growth tool |
| Participant | To be filled |
| Demo link | To be filled: GitHub release, demo video, or live repository |

---

## Module 1: User Insight and Problem Definition

### Target Users

Mimo is built for KOC creators, short-form video creators, content operators, and small creator teams who need to make content decisions from real material instead of generic advice.

Typical users include:

- creators who publish short videos regularly but are unsure how to improve the next post;
- operators who have screenshots, recordings, titles, tags, homepage screenshots, or visible metrics but lack a structured analysis workflow;
- creators who need to diagnose a single video or a homepage without exposing private platform credentials;
- judges or reviewers who need to inspect how an AI agent handles evidence, uncertainty, and practical growth actions.

### User Pain Points

Creators often do not need another generic copywriting assistant. They need an agent that can reason from current evidence and avoid overclaiming.

Key pain points:

- **Evidence is scattered**: screenshots, recordings, subtitles, titles, visible metrics, browser clues, and user notes are hard to separate.
- **Advice is often generic**: many tools return fixed short-video formulas that do not use the current material.
- **Claims are easily overstated**: without backend metrics or comments, tools may still imply that a direction has already been validated.
- **Homepage and single-video analysis are often mixed**: a homepage needs column-level diagnosis; a single video needs material-level script testing.
- **Content usage boundaries are unclear**: film, variety, music, performance, and derivative materials need conservative usage guidance.
- **Internal tool information may pollute strategy**: file names, upload logs, connector state, or runtime errors must not become content evidence.

### Use Cases

1. **Analyze the current video**  
   Mimo reads authorized recordings, sampled frames, OCR/ASR text, titles, tags, and visible signals, then produces evidence-grounded script steps.

2. **Diagnose an account homepage**  
   Mimo reads visible profile information, work titles, cover text, visible metrics, and content patterns, then suggests a focused column test plan.

3. **Handle degraded visual analysis**  
   When visual parsing fails, Mimo falls back to available evidence and clearly states what is missing instead of fabricating details.

4. **Guide safe reuse of content structure**  
   For derivative or copyrighted material, Mimo recommends reusable structure, commentary framing, screenshot explanation, authorized material, or platform-available assets.

---

## Module 2: Product Solution Design

### Product Overview

Mimo is a desktop AI agent for evidence-driven content growth decisions. It is not a normal chatbot and not a video narration tool.

The product turns authorized materials into a structured decision loop:

```text
evidence -> judgment -> action -> validation metrics -> review
```

### Core Features

| Feature | Description |
| --- | --- |
| Desktop material capture | Uses a Tauri + React desktop app for screenshots, recordings, uploads, and the agent panel. |
| Single-video analysis | Produces a `fact_ledger` with visible facts, audio facts, text facts, content type, hooks, and limitations. |
| Homepage diagnosis | Produces a `homepage_evidence_map` from visible profile and work-grid evidence. |
| Dynamic script steps | Uses `script_steps` tied to current evidence instead of fixed templates. |
| Evidence contract | Separates direct evidence, inferred claims, low-confidence claims, missing evidence, and forbidden claims. |
| Final reply guardrails | The Node gateway formats Chinese replies, removes internal keys, filters runtime metadata, and preserves evidence boundaries. |
| Conservative fallback | If evidence is insufficient, Mimo asks for better material instead of inventing a column plan or script. |

### Product Architecture

```text
Desktop app: apps/desktop
  Tauri + React UI
  screenshot / recording / upload / agent panel
        |
        v
Node gateway: apps/server
  API adaptation
  media preprocessing
  frame extraction
  final reply formatting
  internal-field filtering
        |
        v
Python backend: koc_backend
  model calls
  OCR/ASR/vision enrichment
  material understanding
  evidence contracts
  strategy generation
        |
        v
LangGraph workflow: koc_graph
  intake -> platform -> assets -> evidence snapshot
  -> decision -> strategy -> evidence -> persist
        |
        v
Local and production data layer
  data/
  database/schema.sql
```

### Interaction Flow

1. The user chooses current-video analysis or homepage diagnosis.
2. The desktop app collects authorized screenshots, recordings, uploads, and visible context.
3. The Node gateway preprocesses media and forwards the task to the Python backend.
4. The Python backend extracts structured evidence.
5. The LangGraph workflow routes the task and creates a strategy.
6. The Node gateway formats the final Chinese reply with evidence boundaries and guardrails.
7. The user receives an actionable output with validation metrics and a review format.

### Innovation and Differentiation

| Common tool | Mimo |
| --- | --- |
| Generates general advice | Generates evidence-grounded decisions |
| Uses fixed short-video templates | Uses current material and visible signals |
| Mixes facts and guesses | Separates evidence, inference, low confidence, and missing evidence |
| May expose internal fields | Filters internal keys, debug text, connector state, and runtime logs |
| Treats all tasks similarly | Separates single-video analysis, homepage diagnosis, and degraded-evidence fallback |
| Ignores usage boundaries | Adds conservative copyright and material-use guidance |

---

## Module 3: AI-Native Capabilities

### Core AI Capabilities

Mimo combines multimodal understanding, structured evidence extraction, workflow routing, and guarded final-response generation.

Core capabilities:

- **Multimodal understanding**: screenshots, recordings, sampled frames, OCR, ASR, titles, tags, and browser-visible text.
- **Fact ledger generation**: visible facts, audio facts, text facts, sparse timeline, growth hooks, and limitations.
- **Content-type routing**: media clip, platform-native content, tutorial, performance, gameplay, vlog, product review, knowledge content, or unknown.
- **Homepage evidence mapping**: profile signals, visible work samples, content patterns, profile problems, and missing evidence.
- **Evidence contract generation**: direct evidence, inferred claims, low-confidence claims, missing evidence, and forbidden claims.
- **Guarded final reply**: Chinese user-facing output with no internal English keys or debug leakage.

### How AI Solves the Pain Points

| Pain point | Mimo's AI approach |
| --- | --- |
| Evidence is scattered | Normalize evidence into structured ledgers and contracts. |
| Advice is generic | Require each script or column suggestion to cite evidence. |
| Claims are overstated | Block unsupported claims through forbidden-claim rules. |
| Homepage and video tasks are mixed | Route by task type and use different final reply templates. |
| Vision may fail | Use conservative degradation and state missing evidence. |
| Internal logs can leak | Strip runtime context, file names, upload metadata, stack traces, and connector state. |

### Technical Design

**Model and analysis layer**

- Python owns model calls and structured material understanding.
- Single-video analysis produces `fact_ledger`.
- Homepage diagnosis produces `homepage_evidence_map` and, when evidence is sufficient, `homepage_column_plan`.
- Operational metadata is classified separately from content evidence.

**Workflow layer**

LangGraph handles:

- task intake;
- platform context;
- asset analysis;
- evidence snapshot;
- decision routing;
- strategy generation;
- evidence contract generation;
- persistence.

**Final reply layer**

The Node gateway:

- reads Python strategy results;
- formats task-aware Chinese replies;
- filters internal errors and debug keys;
- removes unsupported generic script templates;
- preserves evidence boundaries.

---

## Module 4: Optional Bonus Content

### Implementation Feasibility

Mimo is already structured as a runnable local application:

- Tauri + React desktop shell;
- Node/Express gateway;
- Python backend;
- LangGraph workflow;
- local data directory;
- production database schema;
- regression scripts for evidence contracts, dynamic scripts, homepage evidence, and final replies.

Recommended validation commands:

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

### Commercial Potential

Mimo can be packaged for:

- individual creators who need lightweight content diagnosis;
- KOC operators who need repeatable evidence-based workflows;
- MCN teams that want shared analysis standards;
- brand content teams that need conservative material-use boundaries.

Possible business models:

- desktop pro license;
- monthly subscription for model-backed diagnosis;
- team workspace and account management;
- private deployment for agencies or brands.

### Risks and Boundaries

Mimo does not:

- guarantee virality;
- claim platform recommendation behavior without backend data;
- treat a single video as a confirmed long-term account direction;
- encourage full reuploading of copyrighted materials;
- use file names, upload logs, browser processes, or internal errors as content evidence.

---

## One-Sentence Summary

Mimo helps creators turn authorized short-form content materials into evidence-grounded growth experiments, while keeping uncertainty, missing evidence, and content-use boundaries visible.
