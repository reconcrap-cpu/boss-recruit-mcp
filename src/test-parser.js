import assert from "node:assert/strict";
import { parseRecruitInstruction } from "./parser.js";

function testNeedInput() {
  const r = parseRecruitInstruction({
    instruction: "帮我找做过AI infra的人选",
    confirmation: null,
    overrides: null
  });

  assert.equal(r.needs_keyword_confirmation, true);
  assert.equal(r.needs_search_params_confirmation, true);
  assert.equal(r.proposed_keyword?.toLowerCase(), "ai infra");
  assert.deepEqual(
    r.default_preview,
    {
      city: "不限城市",
      degree: "不限",
      schools: "不限院校标签",
      target_count: 10
    }
  );
}

function testExampleExtraction() {
  const instruction =
    "帮我找35岁以下，做过AI infra的人选，地点在杭州，学历本科及以上，毕业院校必须是985、211或者qs100的学校，必须发表过CCF-A区论文。至少筛选500位人选。";

  const firstPass = parseRecruitInstruction({
    instruction,
    confirmation: null,
    overrides: null
  });

  assert.equal(firstPass.needs_keyword_confirmation, true);
  assert.equal(firstPass.proposed_keyword?.toLowerCase(), "ai infra");
  assert.equal(firstPass.searchParams.city, "杭州");
  assert.equal(firstPass.searchParams.degree, "本科及以上");
  assert.deepEqual(firstPass.searchParams.schools.sort(), ["211院校", "985院校", "QS 100"].sort());
  assert.equal(firstPass.screenParams.target_count, 500);

  const confirmed = parseRecruitInstruction({
    instruction,
    confirmation: {
      keyword_confirmed: true,
      keyword_value: "ai infra",
      search_params_confirmed: true
    },
    overrides: null
  });

  assert.equal(confirmed.needs_keyword_confirmation, false);
  assert.equal(confirmed.needs_search_params_confirmation, false);
  assert.equal(confirmed.searchParams.keyword, "ai infra");
  assert.equal(confirmed.missing_fields.length, 0);
}

function testMissingFieldsBatch() {
  const r = parseRecruitInstruction({
    instruction: "帮我筛选做过推荐系统的人",
    confirmation: { keyword_confirmed: true, keyword_value: "推荐系统" },
    overrides: null
  });

  assert.deepEqual(r.missing_fields.sort(), ["city", "degree", "schools", "target_count"].sort());
}

function testStructuredInputAndCriteriaCleanup() {
  const r = parseRecruitInstruction({
    instruction:
      "使用boss-recruit-pipeline skills帮我在boss上找做过AI infra的人选，必须发表过CCF-A区论文。城市：杭州，学历：本科，学校：985、211、qs100，目标人数：10人",
    confirmation: {
      keyword_confirmed: true,
      keyword_value: "AI infra",
      search_params_confirmed: true
    },
    overrides: null
  });

  assert.equal(r.searchParams.city, "杭州");
  assert.equal(r.searchParams.degree, "本科");
  assert.equal(r.screenParams.target_count, 10);
  assert.equal(
    r.screenParams.criteria,
    "做过AI infra；必须发表过CCF-A区论文"
  );
}

function testCitySanitizationAndConfirmationGate() {
  const r = parseRecruitInstruction({
    instruction:
      "在 Boss 直聘按城市杭州筛选做过 AI infra 的人选，学历为本科及以上，来自 985/211/QS100 学校，必须有 CCF-A 区会议论文，目标 10 人，关键词 AI infra。",
    confirmation: null,
    overrides: null
  });

  assert.equal(r.searchParams.city, "杭州");
  assert.equal(r.needs_search_params_confirmation, true);
  assert.equal(r.suspicious_fields.length, 0);
}

function testDefaultsCanOnlyApplyWhenExplicitlyRequested() {
  const r = parseRecruitInstruction({
    instruction: "帮我找做过推荐系统的人",
    confirmation: {
      keyword_confirmed: true,
      keyword_value: "推荐系统",
      use_default_for_missing: true,
      search_params_confirmed: true
    },
    overrides: null
  });

  assert.equal(r.searchParams.city, null);
  assert.equal(r.searchParams.degree, "不限");
  assert.deepEqual(r.searchParams.schools, []);
  assert.equal(r.screenParams.target_count, 10);
  assert.deepEqual(r.applied_defaults, {
    city: "不限城市",
    degree: "不限",
    schools: "不限院校标签",
    target_count: 10
  });
}

function main() {
  testNeedInput();
  testExampleExtraction();
  testMissingFieldsBatch();
  testStructuredInputAndCriteriaCleanup();
  testCitySanitizationAndConfirmationGate();
  testDefaultsCanOnlyApplyWhenExplicitlyRequested();
  // eslint-disable-next-line no-console
  console.log("parser tests passed");
}

main();
