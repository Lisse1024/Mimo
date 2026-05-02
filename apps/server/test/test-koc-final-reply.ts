import assert from "node:assert/strict";
import { buildFinalReply } from "../src/koc-growth.js";

const job = {
  status: "completed",
  workspace: {
    strategy: {
      growth_hypothesis: "用经典台词和明确场景符号做开头，比泛化模板更容易验证 3 秒留存。",
      test_action: "下一条按当前 script_steps 做一条低成本小样本测试。",
      validation_metrics: ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"],
      decision_rules: [
        "3 秒留存低：重做开头钩子",
        "完播低：压缩背景解释，提前放具体看点",
        "评论集中在某类关键词：判断系列方向",
        "收藏高但主页点击低：说明内容有资料价值但主页承接不足",
        "负反馈集中在搬运/废话多：降低原片比例，增加观点密度"
      ],
      review_template: "复盘：3 秒留存=__；平均播放时长=__；完播率=__；评论关键词=__；收藏率=__；主页点击率=__；负反馈=__。",
      script_steps: [
        {
          time: "0-3 秒",
          visual: "宫廷玉液酒，一百八一杯",
          caption_or_voiceover: "先看这句台词为什么一出来就能被记住。",
          purpose: "用具体台词建立停留理由。",
          evidence: "直接证据：OCR 字幕",
          confidence: "medium"
        },
        {
          time: "4-10 秒",
          visual: "太后大酒楼",
          caption_or_voiceover: "场景先交代到这里，不扩写完整剧情。",
          purpose: "识别场景并避免过度剧情推断。",
          evidence: "直接证据：画面/文字线索",
          confidence: "medium"
        },
        {
          time: "11-25 秒",
          visual: "经理夸张推销动作",
          caption_or_voiceover: "把动作和台词放在一起解释笑点。",
          purpose: "解释具体看点并引导发布后观察评论关键词。",
          evidence: "直接证据：可见动作",
          confidence: "low"
        }
      ],
      risks: ["素材涉及小品/春晚/版权/授权边界，不建议完整搬运原片。"],
      kpis: ["3 秒留存", "平均播放时长"]
    },
    advisor_summary: {
      one_sentence_diagnosis: "这条内容最值得测试的是具体台词和场景符号，而不是套固定短视频模板。",
      core_judgements: ["当前问题是证据只支持单条作品小样本测试，不能直接扩展为账号长期方向。"],
      evidence_chain: ["OCR 字幕：宫廷玉液酒，一百八一杯", "可见场景：太后大酒楼", "可见动作：经理夸张推销动作"],
      first_actions: ["按建议脚本剪一条最小测试", "发布后回填真实指标"]
    },
    evidence_contract: {
      direct_evidence: ["宫廷玉液酒，一百八一杯", "太后大酒楼", "经理夸张推销动作"],
      inferred_claims: [{ claim: "疑似经典小品片段", basis: "台词和场景线索", confidence: "medium" }],
      low_confidence_claims: [{ claim: "角色身份仍需更多上下文确认", basis: "只有短片段", confidence: "low" }],
      missing_evidence: ["评论区截图缺失", "后台数据缺失", "授权信息缺失", "完整视频上下文缺失"],
      forbidden_claims: ["不能声称评论区都在说", "不能声称后台数据证明", "不能声称账号长期方向已经确定"],
      missing_keys: ["browser_visible_metrics"],
      degraded_keys: ["video_timeline"],
      must_not_claim: ["不能确认完整剧情已经确认"]
    },
    tasks: []
  }
};

const reply = buildFinalReply(job);

for (const section of ["有效结论", "证据依据", "当前问题", "下一步动作", "建议脚本", "验证与复盘", "验证指标", "证据边界"]) {
  assert.match(reply, new RegExp(section), `missing section ${section}`);
}
const duplicateHeadings = ["可执行动作：", "下一步测试动作：", "任务闭环："].filter((heading) => reply.includes(heading));
assert.ok(duplicateHeadings.length < 3, `duplicated action headings: ${duplicateHeadings.join(", ")}`);
assert.match(reply, /宫廷玉液酒|太后大酒楼|夸张推销动作/);
for (const key of ["script_steps", "direct_evidence", "inferred_claims", "low_confidence_claims", "missing_evidence", "forbidden_claims", "caption_or_voiceover", "growth_reason"]) {
  assert.doesNotMatch(reply, new RegExp(key), `leaked key ${key}`);
}
for (const forbidden of ["后台数据证明", "一定会爆", "评论区都在说", "账号长期方向已经确定"]) {
  assert.doesNotMatch(reply, new RegExp(forbidden), `forbidden phrase ${forbidden}`);
}
assert.match(reply, /素材使用边界/);
assert.match(reply, /避免完整搬运原片/);

const genericShots = [
  "0-3 秒：先放片段最强冲突、反转、表情或台词，让用户马上知道看点。",
  "4-12 秒：补充片源、人物关系或前因后果，只保留理解剧情必需的信息。",
  "13-25 秒：保留情绪爆点或一次反转，用字幕强化为什么值得看。"
];

const scriptBeatsGenericShots = buildFinalReply({
  status: "completed",
  workspace: {
    strategy: {
      script_steps: [
        {
          time: "0-3 秒",
          visual: "宫廷玉液酒，一百八一杯",
          caption_or_voiceover: "先用这句台词做记忆点。",
          purpose: "验证具体台词能否提高 3 秒留存。",
          evidence: "OCR 字幕：宫廷玉液酒，一百八一杯",
          confidence: "medium"
        },
        {
          time: "4-10 秒",
          visual: "太后大酒楼",
          caption_or_voiceover: "只交代这个场景符号。",
          purpose: "让用户识别场景。",
          evidence: "可见文字：太后大酒楼",
          confidence: "medium"
        },
        {
          time: "11-25 秒",
          visual: "经理夸张推销动作",
          caption_or_voiceover: "把动作和台词连起来解释。",
          purpose: "解释具体看点。",
          evidence: "可见动作：经理夸张推销动作",
          confidence: "low"
        }
      ],
      validation_metrics: ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"]
    },
    advisor_summary: {
      one_sentence_diagnosis: "优先测试具体素材线索。",
      first_content_task: {
        shots: genericShots
      }
    },
    evidence_contract: {}
  }
});
assert.match(scriptBeatsGenericShots, /宫廷玉液酒/);
assert.doesNotMatch(scriptBeatsGenericShots, /最强冲突|情绪爆点|补充片源、人物关系或前因后果/);

const genericShotsOnly = buildFinalReply({
  status: "completed",
  workspace: {
    strategy: {},
    advisor_summary: {
      one_sentence_diagnosis: "证据不足。",
      first_content_task: {
        shots: genericShots
      }
    },
    evidence_contract: {}
  }
});
assert.match(genericShotsOnly, /当前内容证据不足|补充连续画面|标题字幕|作品链接/);
assert.doesNotMatch(genericShotsOnly, /最强冲突|情绪爆点|补充片源、人物关系或前因后果/);


const validUpstreamReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: {
        content_patterns: [
          { pattern_name: "ContentPatternA", evidence: ["ContentPatternA", "CoverElementA", "TitleStructureA", "#TagA", "WorkSampleA"], repeat_count: 3, surface_strength: "high" }
        ],
        missing_evidence: ["backend metrics missing", "comment samples missing"]
      },
      homepage_column_plan: [
        {
          title: "ContentPatternA column test",
          why_this: "Pattern is repeated in visible homepage evidence.",
          evidence_basis: ["ContentPatternA", "CoverElementA", "TitleStructureA", "#TagA", "WorkSampleA"],
          episode_idea: "Reuse WorkSampleA as the first controlled sample.",
          visual_suggestion: "Keep CoverElementA visible in the first frame.",
          caption_or_voiceover: "Use TitleStructureA as the opening sentence.",
          purpose: "Validate whether ContentPatternA deserves repeated publishing.",
          test_metric: "24/48h views, 3s retention, completion, comment keywords, profile clicks, follow conversion, negative feedback",
          confidence: "high"
        },
        {
          title: "ContentPatternB column test",
          why_this: "Second pattern also appears in upstream evidence.",
          evidence_basis: ["ContentPatternB", "CoverElementB", "TitleStructureB"],
          episode_idea: "Make one controlled sample around ContentPatternB.",
          visual_suggestion: "Use CoverElementB and keep the same title layout.",
          caption_or_voiceover: "State why ContentPatternB is being tested.",
          purpose: "Compare whether PatternB is worth the next round.",
          confidence: "medium"
        }
      ],
      validation_metrics: ["24/48h views", "3s retention", "completion", "comment keywords", "profile clicks", "follow conversion", "negative feedback"],
      review_template: "24/48h views=__; 3s retention=__; completion=__; comment keywords=__."
    },
    advisor_summary: {
      one_sentence_diagnosis: "Use upstream evidence to form a homepage column experiment.",
      evidence_chain: ["ContentPatternA", "CoverElementA", "TitleStructureA"]
    },
    evidence_contract: {
      direct_evidence: ["ContentPatternA", "CoverElementA", "TitleStructureA", "#TagA", "WorkSampleA", "ContentPatternB", "CoverElementB", "TitleStructureB"],
      missing_evidence: ["backend metrics missing", "comment samples missing"],
      forbidden_claims: ["cannot claim platform validated this direction"]
    }
  }
});
assert.match(validUpstreamReply, /ContentPatternA column test/);
assert.match(validUpstreamReply, /ContentPatternB column test/);
assert.match(validUpstreamReply, /ContentPatternA|CoverElementA|TitleStructureA|#TagA|WorkSampleA/);
assert.doesNotMatch(validUpstreamReply, /script_steps|homepage_column_plan|homepage_evidence_map|evidence_basis/);

const planWithoutEvidenceReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: { content_patterns: [] },
      homepage_column_plan: [{ title: "NoEvidencePlan", caption_or_voiceover: "Make one random post" }]
    },
    advisor_summary: { evidence_chain: ["OnlyProfileStatA"] },
    evidence_contract: { direct_evidence: ["OnlyProfileStatA"], missing_evidence: ["work samples missing"] }
  }
});
assert.doesNotMatch(planWithoutEvidenceReply, /NoEvidencePlan|Make one random post/);
assert.match(planWithoutEvidenceReply, /OnlyProfileStatA|work samples missing|当前证据不足/);

const noPlanDirectionReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "direction_only",
      homepage_evidence_map: { content_patterns: [{ pattern_name: "ContentPatternC", evidence: ["ContentPatternC", "CoverElementC"], repeat_count: 1, surface_strength: "medium" }] },
      homepage_column_plan: []
    },
    advisor_summary: { evidence_chain: ["ContentPatternC", "CoverElementC"] },
    evidence_contract: { direct_evidence: ["ContentPatternC", "CoverElementC"], missing_evidence: ["backend metrics missing"] }
  }
});
assert.match(noPlanDirectionReply, /ContentPatternC/);
assert.doesNotMatch(noPlanDirectionReply, /ContentPatternC column test/);

const insufficientHomepageReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: { homepage_column_plan_status: "insufficient_evidence", homepage_column_plan: [], homepage_evidence_map: { content_patterns: [] } },
    advisor_summary: { evidence_chain: ["OnlyProfileStatA"] },
    evidence_contract: { direct_evidence: ["OnlyProfileStatA"], missing_evidence: ["work detail screenshots missing", "cover title screenshots missing", "backend metrics missing", "comment screenshots missing"] }
  }
});
assert.match(insufficientHomepageReply, /OnlyProfileStatA|work detail screenshots missing|backend metrics missing|comment screenshots missing|当前证据不足/);
assert.doesNotMatch(insufficientHomepageReply, /ContentPatternA column test|ContentPatternB column test/);

const strongEntityWithoutEvidenceReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: { content_patterns: [{ pattern_name: "ContentPatternD", evidence: ["ContentPatternD", "CoverElementD"], repeat_count: 2, surface_strength: "high" }] },
      homepage_column_plan: [{ title: "Use TestEntityA1", evidence_basis: ["ContentPatternD", "CoverElementD"], episode_idea: "Make #TestTagA visible", visual_suggestion: "Use CoverElementD" }]
    },
    advisor_summary: { evidence_chain: ["ContentPatternD", "CoverElementD"] },
    evidence_contract: { direct_evidence: ["ContentPatternD", "CoverElementD"] }
  }
});
assert.doesNotMatch(strongEntityWithoutEvidenceReply, /TestEntityA1|#TestTagA/);

const noPlanNoFakeTitlesReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_evidence_map: { content_patterns: [{ pattern_name: "ContentPatternF", evidence: ["ContentPatternF", "CoverElementF"], repeat_count: 2, surface_strength: "medium" }] }
    },
    advisor_summary: { evidence_chain: ["ContentPatternF", "CoverElementF"] },
    evidence_contract: { direct_evidence: ["ContentPatternF", "CoverElementF"] }
  }
});
assert.doesNotMatch(noPlanNoFakeTitlesReply, /连发小样本|column test|栏目测试 1|主页最常出现的一类内容/);
assert.match(noPlanNoFakeTitlesReply, /当前证据不足|补充最近 3 条作品详情|方向级小样本/);

const strongEntityWithEvidenceReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: { content_patterns: [{ pattern_name: "ContentPatternE", evidence: ["ContentPatternE", "TestEntityA1", "#TestTagA"], repeat_count: 2, surface_strength: "high" }] },
      homepage_column_plan: [{ title: "Use TestEntityA1", evidence_basis: ["ContentPatternE", "TestEntityA1", "#TestTagA"], episode_idea: "Make #TestTagA visible", visual_suggestion: "Use TestEntityA1 as the visible sample", caption_or_voiceover: "Test #TestTagA", purpose: "Validate ContentPatternE", confidence: "medium" }]
    },
    advisor_summary: { evidence_chain: ["ContentPatternE", "TestEntityA1", "#TestTagA"] },
    evidence_contract: { direct_evidence: ["ContentPatternE", "TestEntityA1", "#TestTagA"] }
  }
});
assert.match(strongEntityWithEvidenceReply, /TestEntityA1|#TestTagA/);

const operationalOnlyReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "0-3 秒",
          visual: "current-video-recording-123.mp4 完成 8frames",
          caption_or_voiceover: "请分析我当前刷到的这条视频，不要默认把它当成账号主页诊断。",
          purpose: "Use Uploaded assets as hook",
          evidence: "platform hints=2 status=partial",
          confidence: "low"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "用户请求：请分析我当前刷到的这条视频，不要默认把它当成账号主页诊断。",
      evidence_chain: ["素材处理：video: current-video-recording-123.mp4 完成 8frames", "Uploaded assets: 1", "platform hints=2 status=partial"]
    },
    evidence_contract: { missing_evidence: ["缺少 OCR/ASR/连续画面"] }
  }
});
for (const forbidden of ["请分析我当前刷到的这条视频", "current-video-recording", "Uploaded assets", "hints=2", "status=partial", "用户请求：", "素材处理："]) {
  assert.doesNotMatch(operationalOnlyReply, new RegExp(forbidden), `operational metadata leaked: ${forbidden}`);
}
assert.match(operationalOnlyReply, /当前内容证据不足|补充连续画面|标题字幕|作品链接/);

const contentEvidenceReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "0-3 秒",
          visual: "屏幕文字A",
          caption_or_voiceover: "先用内容标题A建立语境。",
          purpose: "验证屏幕文字A能否带来 3 秒留存。",
          evidence: "title: 内容标题A；hashtag: #测试标签A；on_screen_text: 屏幕文字A",
          growth_reason: "用标题和屏幕文字帮助用户快速判断内容价值，提高停留和收藏概率。",
          confidence: "medium"
        }
      ]
    },
    advisor_summary: { one_sentence_diagnosis: "基于内容证据做保守分析。", evidence_chain: ["内容标题A", "#测试标签A", "屏幕文字A"] },
    evidence_contract: { direct_evidence: ["内容标题A", "#测试标签A", "屏幕文字A"] }
  }
});
assert.match(contentEvidenceReply, /内容标题A|#测试标签A|屏幕文字A/);
assert.match(contentEvidenceReply, /增长目的/);
assert.doesNotMatch(contentEvidenceReply, /growth_reason/);
assert.doesNotMatch(contentEvidenceReply, /current-video-recording|Uploaded assets|hints=|status=partial/);

const sourceText = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/koc-growth.ts", import.meta.url), "utf8"));
assert.doesNotMatch(sourceText, /buildHomepageClusters|koreaSignals|musicSignals|gameSignals|familySignals|movieSignals|lifeSignals|buildClusterPlanItem|concreteHomepageColumnPlan|unsupportedHomepageEntity|evidenceHits\(lines, \[/);
assert.doesNotMatch(sourceText + validUpstreamReply + noPlanDirectionReply + insufficientHomepageReply + strongEntityWithEvidenceReply, /ï¼|ä½|æ—|å½|è¯|ç´|ã€/);
console.log("koc final reply regression passed");

