STRATEGY_SCHEMA = {
    "positioning": "string",
    "north_star_goal": "string",
    "kpis": ["string"],
    "audience_insights": ["string"],
    "strategic_diagnosis": ["string"],
    "content_pillars": [
        {
            "name": "string",
            "why": "string",
            "themes": ["string"],
            "formats": ["string"],
        }
    ],
    "growth_phases": [
        {
            "phase": "string",
            "objective": "string",
            "actions": ["string"],
            "expected_signal": "string",
        }
    ],
    "message_framework": ["string"],
    "risks": ["string"],
    "rationale": ["string"],
    "source_type": "model_inference",
    "confidence": "high|medium|low",
}

INTERNAL_DIAGNOSTIC_SCHEMA = {
    "agent_name": "string",
    "professional_lens": "string",
    "key_findings": ["string"],
    "evidence": ["string"],
    "optimization_opportunities": ["string"],
    "risks": ["string"],
    "source_type": "model_inference",
    "confidence": "high|medium|low",
}

HOT_VIDEO_SCHEMA = {
    "benchmark_summary": "string",
    "hot_video_patterns": [
        {
            "pattern": "string",
            "evidence": "string",
            "why_it_works": "string",
        }
    ],
    "gap_against_user": ["string"],
    "shooting_advice": ["string"],
    "editing_tutorial": ["string"],
    "replication_template": ["string"],
    "source_type": "model_inference",
    "confidence": "high|medium|low",
}

CALENDAR_SCHEMA = {
    "week_theme": "string",
    "week_focus": ["string"],
    "posts": [
        {
            "title": "string",
            "goal": "string",
            "hook": "string",
            "format": "string",
            "cta": "string",
            "kpi_focus": "string",
            "why": "string",
        }
    ],
}

POST_PACK_SCHEMA = {
    "headline_variants": ["string"],
    "script": ["string"],
    "asset_checklist": ["string"],
    "tags": ["string"],
    "publish_window": "string",
    "reply_templates": ["string"],
    "rationale": ["string"],
}

REVIEW_SCHEMA = {
    "conclusion": "string",
    "metric_reading": ["string"],
    "issue_diagnosis": ["string"],
    "next_moves": ["string"],
    "next_topic_direction": ["string"],
    "stage_recommendation": "cold-start|growth|conversion",
    "stage_shift_reason": "string",
    "effective_patterns": ["string"],
    "ineffective_patterns": ["string"],
    "confidence": "high|medium|low",
    "source_type": "model_inference",
}

ASSET_ANALYSIS_SCHEMA = {
    "status": "string",
    "asset_summary": "string",
    "fact_ledger": {
        "visible_facts": ["string"],
        "audio_facts": ["string"],
        "text_facts": ["string"],
        "possible_source": {
            "name": "string",
            "confidence": "high|medium|low|unknown",
            "evidence": ["string"],
        },
        "characters_or_people": [
            {
                "name": "string",
                "role": "string",
                "confidence": "high|medium|low|unknown",
                "evidence": ["string"],
            }
        ],
        "timeline": [
            {
                "time_range": "string",
                "visible_facts": ["string"],
                "audio_facts": ["string"],
                "text_facts": ["string"],
                "inferred_claims": ["string"],
                "confidence": "high|medium|low|unknown",
            }
        ],
        "growth_hooks": [
            {
                "hook": "string",
                "evidence": "string",
                "confidence": "high|medium|low",
            }
        ],
        "limitations": ["string"],
    },
    "source_identification": {
        "possible_title": "string",
        "content_type": "film|tv_drama|short_drama|variety|anime|game|unknown",
        "confidence": "high|medium|low",
        "evidence": ["string"],
        "uncertainty": ["string"],
    },
    "clip_context": {
        "visible_plot": "string",
        "clip_function": "conflict|reversal|emotional_peak|relationship_tension|comedy|character_highlight|suspense|unknown",
        "characters_or_roles": ["string"],
        "missing_context": ["string"],
    },
    "video_understanding": {
        "timeline": [
            {
                "time_range": "string",
                "visual_fact": "string",
                "ocr_text": "string",
                "audio_transcript": "string",
                "inference": "string",
                "confidence": "high|medium|low",
            }
        ],
        "observable_facts": ["string"],
        "inferences": ["string"],
        "uncertain_points": ["string"],
        "context_risk": "low|medium|high",
        "missing_evidence": ["string"],
    },
    "traffic_mechanism": ["string"],
    "replication_plan": ["string"],
    "homepage_diagnosis": ["string"],
    "video_observations": ["string"],
    "visual_style": ["string"],
    "content_opportunities": ["string"],
    "shooting_and_editing_advice": ["string"],
    "evidence": ["string"],
    "limitations": ["string"],
    "source_type": "visual_observation",
    "confidence": "high|medium|low",
}

AGENT_RUN_SCHEMA = {
    "run_id": "string",
    "objective": "string",
    "mode": "string",
    "memory_written": ["string"],
    "tool_calls": [
        {
            "tool": "string",
            "owner_agent": "string",
            "input": "string",
            "output": "string",
            "status": "string",
        }
    ],
    "handoffs": [
        {
            "from_agent": "string",
            "to_agent": "string",
            "reason": "string",
        }
    ],
    "next_actions": ["string"],
}

ADVISOR_SUMMARY_SCHEMA = {
    "advisor_name": "string",
    "tone": "string",
    "one_sentence_diagnosis": "string",
    "core_judgements": ["string"],
    "evidence_chain": ["string"],
    "first_actions": ["string"],
    "first_content_task": {
        "title": "string",
        "hook": "string",
        "shots": ["string"],
        "editing_notes": ["string"],
    },
    "why_this_path": ["string"],
    "follow_up_question": "string",
    "source_type": "model_inference",
    "confidence": "high|medium|low",
}

TASK_SCHEMA = {
    "id": "string",
    "title": "string",
    "goal": "string",
    "priority": "high|medium|low",
    "status": "todo|doing|done|blocked",
    "owner": "advisor|content|data|platform|creative|viral|profile|user",
    "source": "strategy|advisor_summary|internal_diagnostic|review",
}

WORKSPACE_STRATEGY_SCHEMA = {
    "hot_video_analysis": HOT_VIDEO_SCHEMA,
    "strategy": STRATEGY_SCHEMA,
    "advisor_summary": ADVISOR_SUMMARY_SCHEMA,
    "tasks": [TASK_SCHEMA],
}

ADVISOR_FAST_BUNDLE_SCHEMA = {
    "strategy": STRATEGY_SCHEMA,
    "advisor_summary": ADVISOR_SUMMARY_SCHEMA,
    "tasks": [TASK_SCHEMA],
}

