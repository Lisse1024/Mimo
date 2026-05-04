import assert from "node:assert/strict";
import { buildFinalReply } from "../src/koc-growth.js";
import { appendKocRunToMemory, createEmptyKocMemory } from "../src/koc-memory.js";

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

const homepageRuntimeMetadataReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: {
        content_patterns: [
          { pattern_name: "当前窗口进程", evidence: ["msedgewebview2", "image/png", "screen"], repeat_count: 3, surface_strength: "high" },
          { pattern_name: "VisiblePatternA", evidence: ["VisiblePatternA", "CoverTextA"], repeat_count: 2, surface_strength: "medium" }
        ]
      },
      homepage_column_plan: [
        {
          title: "Use current window process",
          evidence_basis: ["msedgewebview2", "image/png"],
          episode_idea: "Use screen file as topic",
          visual_suggestion: "Show upload metadata",
          caption_or_voiceover: "Talk about mime and file size",
          purpose: "Validate runtime",
          confidence: "high"
        },
        {
          title: "VisiblePatternA controlled sample",
          evidence_basis: ["VisiblePatternA", "CoverTextA"],
          episode_idea: "Make one sample around VisiblePatternA.",
          visual_suggestion: "Keep CoverTextA visible.",
          caption_or_voiceover: "Use VisiblePatternA as the opening line.",
          purpose: "Validate the visible homepage pattern.",
          confidence: "medium"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "当前窗口标题 screen；平台已经验证某方向；限流；转粉停滞。",
      evidence_chain: ["当前窗口进程 msedgewebview2", "VisiblePatternA", "CoverTextA"]
    },
    evidence_contract: { direct_evidence: ["VisiblePatternA", "CoverTextA"], missing_evidence: ["backend metrics missing", "comment screenshots missing"] }
  }
});
for (const forbidden of ["本地用户", "当前窗口进程", "当前窗口标题", "msedgewebview2", "image/png", "video/mp4", "screen", "upload", "asset", "mime", "文件大小", "browser hint", "platform hint"]) {
  assert.doesNotMatch(homepageRuntimeMetadataReply, new RegExp(forbidden, "i"), `homepage runtime metadata leaked: ${forbidden}`);
}
assert.match(homepageRuntimeMetadataReply, /VisiblePatternA|CoverTextA/);
assert.doesNotMatch(homepageRuntimeMetadataReply, /限流|转粉停滞|平台已经验证某方向/);
assert.match(homepageRuntimeMetadataReply, /不能证明|证据不足|缺少后台/);

const homepageOnlyRuntimeReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "specific",
      homepage_evidence_map: {
        content_patterns: [
          { pattern_name: "screen", evidence: ["current window title", "image/png", "file size 123"], repeat_count: 3, surface_strength: "high" }
        ]
      },
      homepage_column_plan: [
        {
          title: "screen upload plan",
          evidence_basis: ["image/png", "file size 123"],
          episode_idea: "Use uploaded asset",
          visual_suggestion: "Show mime",
          caption_or_voiceover: "browser hint",
          purpose: "runtime test",
          confidence: "high"
        }
      ]
    },
    advisor_summary: { evidence_chain: ["current window title", "image/png", "file size 123"] },
    evidence_contract: { missing_evidence: ["work detail screenshots missing", "backend metrics missing", "comment screenshots missing"] }
  }
});
assert.doesNotMatch(homepageOnlyRuntimeReply, /screen|image\/png|file size|uploaded asset|browser hint/i);
assert.match(homepageOnlyRuntimeReply, /当前证据不足|补充最近 3 条作品详情|封面标题|后台|评论区/);

const controversialSingleWorkReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "0-3 秒",
          visual: "字幕显示真实人物A争议性评价A",
          caption_or_voiceover: "真实人物A争议性评价A",
          purpose: "讨论争议叙事如何制造评论。",
          evidence: "OCR: 真实人物A争议性评价A",
          confidence: "low"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "真实人物A争议性评价A。",
      evidence_chain: ["OCR: 真实人物A争议性评价A"]
    },
    evidence_contract: { direct_evidence: ["OCR: 真实人物A争议性评价A"], low_confidence_claims: ["不能把争议评价当成事实"] }
  }
});
assert.match(controversialSingleWorkReply, /视频字幕声称|片段叙事|画面文本表达为/);
assert.doesNotMatch(controversialSingleWorkReply, /^有效结论：真实人物A争议性评价A。/m);

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

const disclaimerScriptReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "结尾",
          visual: "作者声明：'虚构演绎，仅供娱乐'",
          caption_or_voiceover: "你最先记住的是「作者声明：'虚构演绎，仅供娱乐'」，还是片段里的另一个细节？",
          purpose: "结尾引导评论。",
          evidence: "作者声明：'虚构演绎，仅供娱乐'",
          growth_reason: "用评论关键词判断是否继续同类。",
          confidence: "medium"
        },
        {
          time: "结尾",
          visual: "情绪转折字幕A",
          caption_or_voiceover: "你更认同情绪转折字幕A里的说法吗？",
          purpose: "围绕片段里的具体叙事点提问。",
          evidence: "OCR：情绪转折字幕A",
          growth_reason: "用具体内容线索引导评论关键词，而不是把边界声明当看点。",
          confidence: "medium"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "基于当前内容证据做保守分析。",
      evidence_chain: ["OCR：情绪转折字幕A"]
    },
    evidence_contract: { direct_evidence: ["情绪转折字幕A"] }
  }
});
assert.match(disclaimerScriptReply, /情绪转折字幕A/);
assert.doesNotMatch(disclaimerScriptReply, /作者声明|虚构演绎|仅供娱乐/);

const inferredAudienceScriptReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "0-3 秒",
          visual: "标签明确标注#关系标签A，这是热门CP组合",
          caption_or_voiceover: "CP向标签#关系标签A吸引BL同人受众",
          purpose: "用受众推断做开头。",
          evidence: "标签明确标注#关系标签A，这是热门CP组合",
          confidence: "medium"
        },
        {
          time: "00:00 附近",
          visual: "字幕00:00：内容字幕A",
          caption_or_voiceover: "先看字幕00:00里的内容字幕A。",
          purpose: "用可见字幕建立停留理由。",
          evidence: "OCR：字幕00:00：内容字幕A",
          growth_reason: "用直接字幕线索提高3秒停留，而不是使用受众推断。",
          confidence: "medium"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "基于当前内容证据做保守分析。",
      evidence_chain: ["OCR：字幕00:00：内容字幕A", "标签：#关系标签A"]
    },
    evidence_contract: { direct_evidence: ["字幕00:00：内容字幕A", "#关系标签A"] }
  }
});
assert.match(inferredAudienceScriptReply, /字幕00:00：内容字幕A/);
assert.doesNotMatch(inferredAudienceScriptReply, /热门CP|BL同人|吸引BL同人受众|CP向标签/);

const pageContextScriptReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      script_steps: [
        {
          time: "承接：解释可见内容价值",
          visual: "账号信息：@测试账号 · 2月8日",
          caption_or_voiceover: "这段先按片源处理。",
          purpose: "识别片源。",
          evidence: "账号信息：@测试账号 · 2月8日",
          confidence: "medium"
        },
        {
          time: "核心看点：放大可验证细节",
          visual: "合集标签：第427集：#作品A #话题A",
          caption_or_voiceover: "把重点落在合集标签。",
          purpose: "解释具体看点。",
          evidence: "合集标签：第427集：#作品A #话题A",
          confidence: "medium"
        },
        {
          time: "00:09-00:14 附近",
          visual: "字幕00:09-00:14：我只跟过去的自己比",
          caption_or_voiceover: "先看这句字幕，它把人物状态说清楚了。",
          purpose: "用可见字幕建立停留理由。",
          evidence: "OCR：字幕00:09-00:14：我只跟过去的自己比",
          growth_reason: "用直接字幕线索提高3秒停留。",
          confidence: "medium"
        },
        {
          time: "中后段",
          visual: "字幕文本序列：'做人类好累啊'→'永远要分一二三等'→'人还分三六九等'→'做动物就好了'→'不分阶级'→'没有烦恼'→'不是的动物也有'→'我看过泰国当地一个新闻'",
          caption_or_voiceover: "把长字幕序列压成递进拍点。",
          purpose: "验证台词递进能否带来完播。",
          evidence: "OCR长字幕序列",
          confidence: "medium"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "核心看点是「搜索框文字：作品番外篇」。",
      evidence_chain: ["搜索栏明确显示作品番外篇", "OCR：字幕00:09-00:14：我只跟过去的自己比"]
    },
    evidence_contract: { direct_evidence: ["字幕00:09-00:14：我只跟过去的自己比", "搜索框文字：作品番外篇"] }
  }
});
assert.match(pageContextScriptReply, /字幕00:09-00:14：我只跟过去的自己比/);
assert.match(pageContextScriptReply, /字幕递进/);
assert.doesNotMatch(pageContextScriptReply, /我看过泰国当地一个新闻/);
assert.doesNotMatch(pageContextScriptReply, /账号信息：@测试账号|合集标签：第427集|时间段：承接：解释可见内容价值|时间段：核心看点：放大可验证细节/);
assert.doesNotMatch(pageContextScriptReply, /核心看点是「搜索框文字/);

const performanceScriptReply = buildFinalReply({
  status: "completed",
  result: { task_type: "single_work_analysis" },
  workspace: {
    task_type: "single_work_analysis",
    strategy: {
      content_type: "performance",
      validation_metrics: ["3 秒留存", "完播率", "分享率", "评论关键词：点歌/求曲名", "负反馈"],
      script_steps: [
        {
          time: "开头",
          visual: "平台：抖音网页版（Microsoft 微软浏览器浏览器）",
          caption_or_voiceover: "把平台信息作为核心看点。",
          purpose: "错误示例：运行环境不应进入演奏脚本。",
          evidence: "平台：抖音网页版（Microsoft 微软浏览器浏览器）",
          confidence: "medium"
        },
        {
          time: "开头",
          visual: "视频时长：29秒（进度条显示00:01/00:29）",
          caption_or_voiceover: "把视频时长作为核心看点。",
          purpose: "错误示例：进度条不应进入演奏脚本。",
          evidence: "视频时长：29秒（进度条显示00:01/00:29）",
          confidence: "medium"
        },
        {
          time: "开头",
          visual: "抖音原生界面元素完整（点赞/评论/收藏按钮布局）",
          caption_or_voiceover: "把按钮布局作为证据。",
          purpose: "错误示例：原生平台 UI 不应作为内容看点。",
          evidence: "抖音原生界面元素完整（点赞/评论/收藏按钮布局）",
          confidence: "medium"
        },
        {
          time: "开头",
          visual: "画面：手部吉他指弹近景",
          caption_or_voiceover: "先听这一段旋律进入，再看手部指弹动作。",
          purpose: "用声音和动作建立停留理由。",
          evidence: "画面：手部吉他指弹近景；可听到吉他旋律进入",
          growth_reason: "先放可识别旋律和演奏动作，提高完播和分享起点。",
          confidence: "medium"
        },
        {
          time: "中段",
          visual: "平台UI元素：抖音精选、推荐、关注等导航栏",
          caption_or_voiceover: "这段 UI 能说明平台页面结构。",
          purpose: "错误示例：页面 UI 不应作为演奏看点。",
          evidence: "平台UI元素：抖音精选、推荐、关注等导航栏",
          confidence: "medium"
        },
        {
          time: "中后段",
          visual: "时间戳：7小时前",
          caption_or_voiceover: "把重点落在时间戳：7小时前。",
          purpose: "错误示例：发布时间不应作为脚本素材。",
          evidence: "时间戳：7小时前",
          confidence: "medium"
        },
        {
          time: "中后段",
          visual: "右下角互动数据：点赞7628，评论120，收藏418，分享589",
          caption_or_voiceover: "把重点落在右下角互动数据。",
          purpose: "错误示例：可见互动指标不应作为脚本画面。",
          evidence: "右下角互动数据：点赞7628，评论120，收藏418，分享589",
          confidence: "medium"
        },
        {
          time: "结尾",
          visual: "文案直接引用测试歌曲名，配合慢节奏吉他演奏，目标受众为夜间寻求情绪慰藉的用户",
          caption_or_voiceover: "你觉得这段最值得讨论的是情怀金曲吗？",
          purpose: "错误示例：受众和情怀推断不应写入画面素材。",
          evidence: "标题：在这寂寞的季节~~ 抱歉最近更新晚了",
          confidence: "low"
        }
      ]
    },
    advisor_summary: {
      one_sentence_diagnosis: "这轮先按影视/综艺/剧集片段拆解：核心看点是「视频时长：29秒（进度条显示00:01/00:29）」。",
      evidence_chain: ["画面：手部吉他指弹近景", "可听到吉他旋律进入", "平台：抖音网页版（Microsoft 微软浏览器浏览器）", "视频时长：29秒（进度条显示00:01/00:29）", "抖音原生界面元素完整（点赞/评论/收藏按钮布局）", "短视频平台常见经典华语歌曲吉他改编内容"]
    },
    evidence_contract: { direct_evidence: ["画面：手部吉他指弹近景", "可听到吉他旋律进入"] }
  }
});
assert.match(performanceScriptReply, /画面：手部吉他指弹近景|可听到吉他旋律进入/);
for (const forbidden of ["平台：抖音网页版", "Microsoft", "微软浏览器", "浏览器浏览器", "视频时长", "进度条", "00:01/00:29", "抖音原生界面", "点赞/评论/收藏按钮布局", "短视频平台常见", "平台UI元素", "抖音精选", "时间戳", "7小时前", "右下角互动数据", "点赞7628", "收藏418", "90后", "00后", "集体记忆", "情怀金曲", "目标受众", "夜间寻求", "抱歉最近更新晚了", "核心看点是「标题：", "核心看点是「平台：", "核心看点是「视频时长：", "避免完整搬运原片"]) {
  assert.doesNotMatch(performanceScriptReply, new RegExp(forbidden), `performance page/title pollution leaked: ${forbidden}`);
}
assert.match(performanceScriptReply, /分享率|点歌|求曲名/);

const experimentReviewReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
     previous_experiment: {
      hypothesis: "\u4e0a\u6b21\u5b9e\u9a8c\uff1a\u540c\u65b9\u5411\u5185\u5bb9\u8fde\u53d1\u540e\uff0c\u89c2\u5bdf\u4e3b\u9875\u70b9\u51fb\u548c\u5173\u6ce8\u8f6c\u5316\u3002",
      test_action: "\u8fde\u7eed\u53d1 1-3 \u6761\u540c\u65b9\u5411\u5185\u5bb9\u5e76\u56de\u586b 24/48 \u5c0f\u65f6\u6570\u636e\u3002"
    },   request: { message: "我按上次诊断连续发了 1 条同方向内容。数据如下：第 1 条播放8600，3秒留存80%，完播75%，评论关键词很有趣，主页点击10000，涨粉600。这里还有新主页截图。" },
    profile: {
      user_request: "我按上次诊断连续发了 1 条同方向内容。数据如下：第 1 条播放8600，3秒留存80%，完播75%，评论关键词很有趣，主页点击10000，涨粉600。这里还有新主页截图。",
      evidence_facts: [
        { source_type: "user_provided_metric", text: "第 1 条：播放8600，3秒留存80%，完播75%，评论关键词很有趣，主页点击10000，涨粉600" },
        { source_type: "homepage_visible_evidence", text: "新主页截图显示同栏目作品已出现在主页首屏" }
      ]
    },
    strategy: {
      homepage_evidence_map: {
        content_patterns: [{ pattern_name: "同栏目主页承接", evidence: ["新主页截图显示同栏目作品已出现在主页首屏"], repeat_count: 1, surface_strength: "medium" }]
      },
      homepage_column_plan_status: "specific",
      homepage_column_plan: [
        {
          title: "不应在复盘里重新生成栏目方案",
          evidence_basis: ["新主页截图显示同栏目作品已出现在主页首屏"],
          episode_idea: "不应展示",
          visual_suggestion: "不应展示",
          caption_or_voiceover: "不应展示",
          purpose: "不应展示"
        }
      ]
    },
    advisor_summary: { one_sentence_diagnosis: "普通主页诊断文案不应被使用。" },
    evidence_contract: {
      direct_evidence: ["新主页截图显示同栏目作品已出现在主页首屏"],
      missing_evidence: ["后台截图仍需复核", "评论区截图缺失"]
    }
  }
});
assert.match(experimentReviewReply, /实验是否有效|下一步继续还是调整|证据边界/);
assert.match(experimentReviewReply, /播放8600|3秒留存80%|完播75%|主页点击10000|涨粉600/);
assert.match(experimentReviewReply, /人工提供指标|新主页截图/);
assert.doesNotMatch(experimentReviewReply, /user_provided_metric|homepage_visible_evidence/);
assert.match(experimentReviewReply, /\u590d\u76d8\u8bc1\u636e\u56fe/);
assert.match(experimentReviewReply, /\u4e0a\u6b21\u5b9e\u9a8c/);
assert.match(experimentReviewReply, /\u7528\u6237\u56de\u586b\u6307\u6807/);
assert.match(experimentReviewReply, /\u65b0\u4e3b\u9875\u53ef\u89c1\u8bc1\u636e/);
assert.match(experimentReviewReply, /\u5df2\u89c2\u5bdf\u4fe1\u53f7|\u8fd8\u7f3a/);
assert.doesNotMatch(experimentReviewReply, /experiment_review_map|previous_experiment_memory|user_provided_metric|homepage_visible_evidence/);
assert.match(experimentReviewReply, /继续测试价值|局部有效信号/);
assert.doesNotMatch(experimentReviewReply, /栏目测试方案|普通主页诊断文案|不应在复盘里重新生成栏目方案/);

const noMemoryReviewCandidateReply = buildFinalReply({
  status: "completed",
  result: { task_type: "experiment_review" },
  workspace: {
    task_type: "experiment_review",
    request: { message: "\u6211\u6b63\u5728\u67e5\u770b\u4e00\u4e2a\u793e\u5a92\u4e3b\u9875" },
    profile: {
      user_request: "\u6211\u6b63\u5728\u67e5\u770b\u4e00\u4e2a\u793e\u5a92\u4e3b\u9875",
      evidence_facts: [{ source_type: "user_provided_metric", text: "\u6211\u6b63\u5728\u67e5\u770b\u4e00\u4e2a\u793e\u5a92\u4e3b\u9875" }]
    },
    strategy: {
      homepage_column_plan_status: "direction_only",
      homepage_evidence_map: {
        content_patterns: [{ pattern_name: "VisiblePatternAfterMemoryClear", evidence: ["VisiblePatternAfterMemoryClear", "VisibleCoverA"], repeat_count: 2, surface_strength: "medium" }]
      }
    },
    advisor_summary: { one_sentence_diagnosis: "\u6e05\u7a7a\u8bb0\u5fc6\u540e\u5e94\u6309\u4e3b\u9875\u8bca\u65ad\u5904\u7406\u3002", evidence_chain: ["VisiblePatternAfterMemoryClear"] },
    evidence_contract: { direct_evidence: ["VisiblePatternAfterMemoryClear"], missing_evidence: ["backend metrics missing", "comment samples missing"] }
  }
});
assert.doesNotMatch(noMemoryReviewCandidateReply, /\u672c\u8f6e\u590d\u76d8\u5df2\u5b8c\u6210|\u5b9e\u9a8c\u662f\u5426\u6709\u6548|\u590d\u76d8\u8bc1\u636e\u56fe/);
assert.match(noMemoryReviewCandidateReply, /\u680f\u76ee\u6d4b\u8bd5\u65b9\u6848|VisiblePatternAfterMemoryClear/);

const metricsButNoPreviousMemoryReply = buildFinalReply({
  status: "completed",
  result: { task_type: "experiment_review" },
  workspace: {
    task_type: "experiment_review",
    request: { message: "\u6211\u6309\u4e0a\u6b21\u8bca\u65ad\u53d1\u4e86 1 \u6761\uff0c\u6570\u636e\u5982\u4e0b\uff1a\u64ad\u653e8600\uff0c3\u79d2\u7559\u5b5880%\u3002" },
    profile: {
      user_request: "\u6211\u6309\u4e0a\u6b21\u8bca\u65ad\u53d1\u4e86 1 \u6761\uff0c\u6570\u636e\u5982\u4e0b\uff1a\u64ad\u653e8600\uff0c3\u79d2\u7559\u5b5880%\u3002",
      evidence_facts: [{ source_type: "user_provided_metric", text: "\u64ad\u653e8600\uff0c3\u79d2\u7559\u5b5880%" }]
    },
    strategy: {
      homepage_column_plan_status: "direction_only",
      homepage_evidence_map: {
        content_patterns: [{ pattern_name: "VisiblePatternNoPriorExperiment", evidence: ["VisiblePatternNoPriorExperiment"], repeat_count: 1, surface_strength: "medium" }]
      }
    },
    advisor_summary: { one_sentence_diagnosis: "\u672a\u627e\u5230\u4e0a\u6b21\u5b9e\u9a8c\u8bb0\u5f55\uff0c\u4e0d\u8fdb\u5165\u590d\u76d8\u3002", evidence_chain: ["VisiblePatternNoPriorExperiment"] },
    evidence_contract: { direct_evidence: ["VisiblePatternNoPriorExperiment"], missing_evidence: ["previous experiment memory missing"] }
  }
});
assert.doesNotMatch(metricsButNoPreviousMemoryReply, /\u672c\u8f6e\u590d\u76d8\u5df2\u5b8c\u6210|\u5b9e\u9a8c\u662f\u5426\u6709\u6548|\u590d\u76d8\u8bc1\u636e\u56fe/);
assert.match(metricsButNoPreviousMemoryReply, /\u680f\u76ee\u6d4b\u8bd5\u65b9\u6848|VisiblePatternNoPriorExperiment/);

const homepagePolishReply = buildFinalReply({
  status: "completed",
  result: { task_type: "homepage_review" },
  workspace: {
    task_type: "homepage_review",
    strategy: {
      homepage_column_plan_status: "direction_only",
      homepage_evidence_map: {
        content_patterns: [{ pattern_name: "MusicVisiblePatternA", evidence: ["MusicVisiblePatternA", "CoverTextA"], repeat_count: 2, surface_strength: "medium" }]
      }
    },
    advisor_summary: {
      one_sentence_diagnosis: "\u7b97\u6cd5\u96be\u4ee5\u5efa\u7acb\u7a33\u5b9a\u63a8\u8350\u6a21\u578b\u3002",
      evidence_chain: [
        "\u7d20\u6750\u5206\u6790\u5931\u8d25\uff0c\u5df2\u964d\u7ea7\u4e3a\u6587\u672c\u94fe\u8def\u7ee7\u7eed\uff1aname 'resolve / safe / path' is not defined",
        "\u8f6c\u7c89\u7387\u7ea623.5%\uff0c\u5904\u4e8e\u6b63\u5e38\u51b7\u542f\u52a8\u8303\u56f4",
        "\u7b2c\u4e00\u5f20\u622a\u56fe\u9876\u90e8\u6570\u636e\u680f"
      ],
      core_judgements: ["\u6d41\u91cf\u6d6a\u8d39\u4e25\u91cd\uff0c\u76ee\u6807\u53d7\u4f17\u4e3a\u97f3\u4e50\u7231\u597d\u8005\u3001\u5409\u4ed6\u5b66\u4e60\u8005\u3002"]
    },
    evidence_contract: {
      direct_evidence: ["MusicVisiblePatternA", "CoverTextA"],
      missing_evidence: ["backend metrics missing", "comment samples missing"],
      forbidden_claims: ["\u4e0d\u80fd\u58f0\u79f0\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e\uff0c\u4e0d\u80fd\u8bc1\u660e\u5e73\u53f0\u65b9\u5411\u5df2\u7ecf\u88ab\u9a8c\u8bc1"]
    }
  }
});
assert.doesNotMatch(homepagePolishReply, /name 'resolve \/ safe \/ path' is not defined|\u7d20\u6750\u5206\u6790\u5931\u8d25|\u8f6c\u7c89\u7387\u7ea623\.5%|\u5904\u4e8e\u6b63\u5e38\u51b7\u542f\u52a8\u8303\u56f4|\u6d41\u91cf\u6d6a\u8d39\u4e25\u91cd|\u7b2c\u4e00\u5f20\u622a\u56fe|\u4e0d\u80fd\u58f0\u79f0\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e/);
assert.match(homepagePolishReply, /\u7d20\u6750\u8bc6\u522b\u94fe\u8def\u51fa\u73b0\u964d\u7ea7|\u7f3a\u5c11\u4e3b\u9875\u8bbf\u95ee\u548c\u5173\u6ce8\u6765\u6e90\u6570\u636e|\u5f53\u524d\u622a\u56fe|\u5f53\u524d\u7f3a\u5c11\u540e\u53f0\u6570\u636e/);

const reviewMemory = appendKocRunToMemory(createEmptyKocMemory("review-memory-test"), {
  userMessage: "\u6211\u6309\u4e0a\u6b21\u8bca\u65ad\u53d1\u4e86 1 \u6761\uff0c\u6570\u636e\u5982\u4e0b\u3002",
  platformSummary: "",
  mediaSummary: "\u65b0\u4e3b\u9875\u622a\u56fe\u663e\u793a\u540c\u65b9\u5411\u5185\u5bb9\u5df2\u51fa\u73b0\u3002",
  taskType: "experiment_review",
  platformKey: "test-platform",
  accountKey: "test-platform:account:review",
  objectKind: "account",
  status: "completed",
  evidenceLevel: "medium",
  jobId: "review-job-1",
  resultSummary: "\u5b9e\u9a8c\u662f\u5426\u6709\u6548\uff1a\u5c40\u90e8\u6709\u6548\u4fe1\u53f7\u3002",
  decisionSummary: "\u7ee7\u7eed\u540c\u65b9\u5411\uff0c\u540c\u65f6\u4f18\u5316\u627f\u63a5",
  evidenceGaps: ["\u7f3a\u5c11\u8bc4\u8bba\u533a\u622a\u56fe"],
  reusableLearnings: ["3 \u79d2\u7559\u5b58\u5df2\u56de\u586b"],
  experiment: {
    hypothesis: "\u4e0a\u6b21\u5b9e\u9a8c\u5047\u8bbe",
    suggestedAction: "\u4e0b\u4e00\u6b65\u7ee7\u7eed\u6d4b\u8bd5",
    expectedSignal: "\u89c2\u5bdf 24/48 \u5c0f\u65f6\u6570\u636e",
    result: "positive",
    conclusion: "\u7528\u6237\u56de\u586b\u6570\u636e\u663e\u793a\u5c40\u90e8\u6709\u6548\u4fe1\u53f7",
    metrics: ["3 \u79d2\u7559\u5b58\u5df2\u56de\u586b"],
    reviewedAt: Date.now(),
    reviewMetrics: { user_metrics: ["\u64ad\u653e8600"], new_homepage_evidence: ["\u65b0\u4e3b\u9875\u622a\u56fe"] },
    reviewMap: { decision: { decision: "continue" } },
    nextAction: "\u7ee7\u7eed\u540c\u65b9\u5411"
  }
});
assert.equal(reviewMemory.experiments.length, 1);
assert.equal(reviewMemory.experiments[0].result, "positive");
assert.deepEqual(reviewMemory.experiments[0].reviewMetrics, { user_metrics: ["\u64ad\u653e8600"], new_homepage_evidence: ["\u65b0\u4e3b\u9875\u622a\u56fe"] });
assert.match(reviewMemory.effectivePatterns.join("\n"), /\u5c40\u90e8\u6709\u6548\u4fe1\u53f7/);
const dedupedReviewMemory = appendKocRunToMemory(reviewMemory, {
  userMessage: "duplicate",
  platformSummary: "",
  mediaSummary: "",
  taskType: "experiment_review",
  platformKey: "test-platform",
  accountKey: "test-platform:account:review",
  objectKind: "account",
  status: "completed",
  evidenceLevel: "medium",
  jobId: "review-job-1",
  resultSummary: "duplicate"
});
assert.equal(dedupedReviewMemory.runs.length, 1);
assert.equal(dedupedReviewMemory.experiments.length, 1);
const sourceText = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/koc-growth.ts", import.meta.url), "utf8"));
assert.doesNotMatch(sourceText, /buildHomepageClusters|koreaSignals|musicSignals|gameSignals|familySignals|movieSignals|lifeSignals|buildClusterPlanItem|concreteHomepageColumnPlan|unsupportedHomepageEntity|evidenceHits\(lines, \[/);
assert.doesNotMatch(sourceText + validUpstreamReply + noPlanDirectionReply + insufficientHomepageReply + strongEntityWithEvidenceReply, /ï¼|ä½|æ—|å½|è¯|ç´|ã€/);
console.log("koc final reply regression passed");

