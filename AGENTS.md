# KOC LangGraph Agent Project Rules

## Project Positioning

This repository is a KOC LangGraph Agent project, not a generic chatbot and not a standalone video narration tool.

The target user-visible loop is:

```text
evidence -> judgment -> action -> validation metrics -> review backfill
```

Every KOC answer should help a creator make a growth decision from authorized screenshots, recordings, sampled video frames, OCR/ASR, titles, tags, browser-visible clues, user input, and historical growth memory.

## Run Commands

```powershell
npm run dev
npm run dev:koc
npm run dev:server
npm run dev:desktop
npm run build
npm run self-check
python -m compileall koc_backend koc_graph
npm.cmd --workspace apps/server run build
npm.cmd --workspace apps/desktop run build
```

## KOC Output Principles

- Always distinguish direct evidence, reasonable inference, low-confidence guesses, and missing evidence.
- Do not turn a single-work analysis into a confirmed long-term account direction.
- Without comment screenshots or comment data, do not claim "the comments are all saying..." or equivalent.
- Without backend metrics, do not claim "backend data proves..." or "this will definitely go viral."
- If vision analysis fails or is degraded, handle it conservatively; do not pretend the full video was understood.
- For film, variety shows, sketches, Spring Festival Gala clips, classic scenes, and similar materials, only recommend structure reuse, commentary-style quotation, authorized materials, platform-available materials, screenshot explanation, or voiceover retelling. Do not encourage full reuploading of original footage.

## Engineering Constraints

- Do not perform broad rewrites.
- Each task should change only files related to the stated goal.
- Keep user-visible output in Chinese.
- When adding backend evidence keys, later check Node and frontend Chinese display mappings before exposing them to users.
- Do not hard-code a specific sketch, film, or case as business logic.
- Do not remove existing degraded-mode or fallback logic.
- Do not modify screenshot, recording, desktop pet, weather, calendar, or other non-KOC features unless the user explicitly asks.

## Completion Standard

A change is complete only when the workspace can still preserve evidence boundaries, conservative degradation, and the KOC growth loop. Prefer small compatible fields and focused tests over large refactors.
