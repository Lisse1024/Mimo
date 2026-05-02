# KOC Agent Output Contract

This project is a KOC LangGraph Agent. Its user-facing output should form this loop:

```text
evidence -> judgment -> action -> validation metrics -> review backfill
```

## Evidence Contract

`evidence_contract` keeps the old compatibility fields and adds these fields:

- `direct_evidence`: facts directly visible, audible, or readable from user input, screenshots, recordings, sampled frames, OCR/ASR, titles, tags, browser-visible text, or platform clues.
- `inferred_claims`: reasonable judgments based on direct evidence. Each item should carry basis and confidence when available.
- `low_confidence_claims`: possible but weak judgments. These must not be written as confirmed conclusions.
- `missing_evidence`: evidence currently missing, such as comments, creator backend metrics, complete video context, continuous account works, platform identity, or authorization proof.
- `forbidden_claims`: conclusions the agent must not tell the user under current evidence, such as claims about comment consensus, backend proof, guaranteed virality, confirmed long-term account direction, official authorization, or complete plot certainty.

Existing fields remain supported:

- `missing_keys`
- `degraded_keys`
- `must_not_claim`

## Work Fact Ledger

Single-work analysis should produce `fact_ledger` / `work_fact_ledger`:

- `visible_facts`: directly visible people, scenes, actions, interface elements, and frame-level clues.
- `audio_facts`: ASR or directly audible facts. Leave empty when ASR/audio is unavailable.
- `text_facts`: OCR, subtitles, titles, tags, page-visible text, and user-provided readable clues.
- `possible_source`: source/theme judgment with `name`, `confidence`, and `evidence`.
- `characters_or_people`: people or character guesses with `name`, `role`, `confidence`, and `evidence`; use `unknown` or `疑似` when identity is not confirmed.
- `timeline`: sparse frame/video timeline only; do not expand sparse frames into a complete plot.
- `growth_hooks`: concrete KOC hooks tied to evidence, such as a line, subtitle, action, scene symbol, title hook, expression, or commentary angle.
- `limitations`: missing or degraded context, such as no comments, no backend metrics, no full ASR, sparse frames, vision degradation, or missing authorization.

## Strategy Fields

Single-work strategy should add:

- `script_steps`: structured dynamic script steps. Each step should include time, visual/material, caption or voiceover, purpose, evidence, and confidence.
- `growth_hypothesis`: the growth hypothesis to test from the current material.
- `test_action`: the next concrete content test.
- `validation_metrics`: metrics such as 3 秒留存, 平均播放时长, 完播率, 评论关键词, 收藏率, 主页点击率, and 负反馈.
- `decision_rules`: how to adjust based on metric outcomes.
- `review_template`: a copyable backfill template for post-publish review.

## Final Reply Sections

The user-visible final reply should consistently contain these Chinese sections:

1. 有效结论
2. 证据依据
3. 当前问题
4. 可执行动作
5. 建议脚本
6. 验证指标
7. 复盘回填
8. 证据边界

The final reply must not expose internal English keys such as `fact_ledger`, `work_fact_ledger`, `script_steps`, `direct_evidence`, `inferred_claims`, `low_confidence_claims`, `missing_evidence`, `forbidden_claims`, `caption_or_voiceover`, `growth_hypothesis`, `test_action`, `validation_metrics`, `decision_rules`, or `review_template`.

## Forbidden Overclaims

Unless explicitly supported by evidence, user-visible output must not claim:

- 后台数据证明
- 一定会爆
- 评论区都在说
- 账号长期方向已经确定
- 官方/授权搬运已确认
- 完整剧情已经确认

For film, variety, sketches, Spring Festival Gala clips, old dramas, famous scenes, and similar materials, output must include a usage boundary: reuse topic angle, commentary structure, subtitle explanation style, or comment-question format; prefer commentary quotation, authorized materials, platform-available materials, screenshot explanation, or voiceover retelling; avoid complete reuploading of original footage.

## Regression Commands

```powershell
python -m compileall koc_backend koc_graph
python scripts/test_koc_evidence_contract.py
python scripts/test_koc_work_fact_ledger.py
python scripts/test_koc_dynamic_script.py
npm.cmd --workspace apps/server run build
node --import tsx apps/server/test/test-koc-final-reply.ts
node --import tsx apps/server/test/test-koc-e2e-mock-job.ts
npm.cmd --workspace apps/desktop run build
npm.cmd run self-check
```

Optional Python-only regression bundle:

```powershell
python scripts/run_koc_regressions.py
```
