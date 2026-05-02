import assert from "node:assert/strict";
import { buildFinalReply } from "../src/koc-growth.js";

const factLedger = {
  text_facts: ["宫廷玉液酒，一百八一杯"],
  visible_facts: ["太后大酒楼", "经理夸张推销动作"],
  characters_or_people: [
    { name: "赵丽蓉", role: "unknown", confidence: "medium", evidence: ["用户提供人物线索"] },
    { name: "巩汉林", role: "unknown", confidence: "medium", evidence: ["用户提供人物线索"] },
    { name: "金珠", role: "unknown", confidence: "low", evidence: ["用户提供人物线索"] }
  ],
  possible_source: {
    name: "疑似经典春晚小品",
    confidence: "medium",
    evidence: ["台词：宫廷玉液酒，一百八一杯", "场景：太后大酒楼"]
  },
  limitations: ["无评论区", "无后台数据", "无授权信息", "只有短片段"]
};

const job = {
  status: "completed",
  result: {
    workspace_version: "mock-e2e",
    task_type: "single_work_analysis"
  },
  workspace: {
    task_type: "single_work_analysis",
    asset_analysis: {
      fact_ledger: factLedger,
      work_fact_ledger: factLedger
    },
    work_understanding: {
      fact_ledger: factLedger,
      work_fact_ledger: factLedger
    },
    strategy: {
      copyright_or_usage_boundary: "结构复用；评论性引用；授权素材或平台可用素材；避免完整搬运原片。",
      growth_hypothesis: "用具体台词、场景符号和动作线索做开头，比泛化模板更容易验证停留。",
      test_action: "围绕台词、酒楼场景和夸张推销动作做一条 20-35 秒最小测试。",
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
          caption_or_voiceover: "这句台词先放出来，直接给记忆点。",
          purpose: "用已核验台词建立 3 秒停留理由。",
          evidence: "fact_ledger.text_facts",
          confidence: "medium"
        },
        {
          time: "4-10 秒",
          visual: "太后大酒楼",
          caption_or_voiceover: "场景只交代到这里，不扩写完整剧情。",
          purpose: "让用户识别场景符号。",
          evidence: "fact_ledger.visible_facts",
          confidence: "medium"
        },
        {
          time: "11-25 秒",
          visual: "经理夸张推销动作",
          caption_or_voiceover: "把动作和台词放在一起解释笑点。",
          purpose: "用具体动作解释看点，引导发布后观察评论关键词。",
          evidence: "work_fact_ledger.visible_facts",
          confidence: "low"
        }
      ],
      risks: ["小品/春晚/版权/授权素材需注意边界，避免完整搬运原片。"]
    },
    advisor_summary: {
      one_sentence_diagnosis: "这条作品适合先测试具体台词、场景符号和夸张动作，不适合上升为账号长期方向。",
      core_judgements: [
        "当前问题：只有短片段、无评论区、无后台数据、无授权信息，所以只能做低风险小样本测试。",
        "脚本应围绕直接可见可读线索，而不是套固定模板。"
      ],
      evidence_chain: ["直接台词：宫廷玉液酒，一百八一杯", "直接场景：太后大酒楼", "直接动作：经理夸张推销动作"],
      first_actions: ["按建议脚本剪一版", "发布后回填 3 秒留存、完播率、评论关键词和负反馈"]
    },
    evidence_contract: {
      direct_evidence: ["宫廷玉液酒，一百八一杯", "太后大酒楼", "经理夸张推销动作"],
      inferred_claims: [{ claim: "疑似经典春晚小品", basis: "台词和场景符号", confidence: "medium" }],
      low_confidence_claims: [{ claim: "人物角色关系仍不能确认", basis: "只有短片段", confidence: "low" }],
      missing_evidence: ["评论区截图缺失", "后台数据缺失", "授权信息缺失", "完整视频上下文缺失"],
      forbidden_claims: ["不能声称评论区都在说", "不能声称后台数据证明", "不能声称账号长期方向已经确定", "不能声称官方/授权搬运已确认", "不能声称完整剧情已经确认"],
      missing_keys: ["browser_visible_metrics", "fetched_platform_data"],
      degraded_keys: ["video_timeline"],
      must_not_claim: ["不能把疑似判断写成确定事实"]
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

const clueHits = ["宫廷玉液酒", "太后大酒楼", "夸张推销动作"].filter((clue) => reply.includes(clue));
assert.ok(clueHits.length >= 2, `expected at least two concrete clues, got ${clueHits.join(", ")}`);

for (const metric of ["3 秒留存", "平均播放时长", "完播率", "评论关键词", "收藏率", "主页点击率", "负反馈"]) {
  assert.match(reply, new RegExp(metric), `missing metric ${metric}`);
}

for (const key of [
  "script_steps",
  "fact_ledger",
  "work_fact_ledger",
  "direct_evidence",
  "inferred_claims",
  "low_confidence_claims",
  "missing_evidence",
  "forbidden_claims",
  "caption_or_voiceover",
  "growth_hypothesis",
  "test_action",
  "validation_metrics",
  "decision_rules",
  "review_template"
]) {
  assert.doesNotMatch(reply, new RegExp(key), `leaked key ${key}`);
}

for (const forbidden of ["后台数据证明", "一定会爆", "评论区都在说", "账号长期方向已经确定", "官方/授权搬运已确认", "完整剧情已经确认"]) {
  assert.doesNotMatch(reply, new RegExp(forbidden), `forbidden phrase ${forbidden}`);
}

for (const boundary of ["结构复用", "评论性引用", "授权素材|平台可用素材", "避免完整搬运原片"]) {
  assert.match(reply, new RegExp(boundary), `missing boundary ${boundary}`);
}

console.log("koc e2e mock job regression passed");
