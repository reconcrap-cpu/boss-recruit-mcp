import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRecruitPipeline } from "./pipeline.js";

const CSV_HEADER = "姓名,最高学历学校,最高学历专业,最近工作公司,最近工作职位,评估通过详细原因";

function createTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `boss-pipeline-${tag}-`));
}

function writeCsv(filePath, rows) {
  const body = rows.length > 0 ? `${rows.join("\n")}\n` : "";
  fs.writeFileSync(filePath, `\uFEFF${CSV_HEADER}\n${body}`, "utf8");
}

function readCsvLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

function createParsed(overrides = {}) {
  return {
    has_unresolved_missing_fields: false,
    needs_keyword_confirmation: false,
    needs_search_params_confirmation: false,
    needs_recent_viewed_filter_confirmation: false,
    needs_criteria_confirmation: false,
    missing_fields: [],
    proposed_keyword: null,
    pending_questions: [],
    review: {},
    searchParams: {
      city: "杭州",
      degree: "本科",
      schools: ["985院校"],
      filter_recent_viewed: false,
      keyword: "AI infra"
    },
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 100
    },
    ...overrides
  };
}

function buildSearchOk(candidateCount) {
  return {
    ok: true,
    candidate_count: candidateCount,
    no_data_tip_present: false,
    no_data_tip_check: { ok: true, details: { exhausted: false } },
    stdout: "",
    stderr: "",
    error_code: null
  };
}

function buildScreenOk({ processedCount, passedCount = 0, outputCsv = null }) {
  return {
    ok: true,
    summary: {
      processed_count: processedCount,
      passed_count: passedCount,
      output_csv: outputCsv
    },
    stdout: "",
    stderr: "",
    error_code: null
  };
}

function createDependencies({
  parsed,
  searchResults,
  screenResults,
  pageStates
}) {
  const searchQueue = [...searchResults];
  const screenQueue = [...screenResults];
  const pageQueue = pageStates ? [...pageStates] : [];
  const calls = {
    searchParams: [],
    screenParams: [],
    pageChecks: 0,
    preflightChecks: 0
  };

  return {
    calls,
    deps: {
      parseRecruitInstruction: () => parsed,
      runPipelinePreflight: () => {
        calls.preflightChecks += 1;
        return {
          ok: true,
          checks: [],
          debug_port: 9222,
          calibration_path: null
        };
      },
      ensureBossSearchPageReady: async () => {
        calls.pageChecks += 1;
        if (pageQueue.length > 0) {
          return pageQueue.shift();
        }
        return {
          ok: true,
          state: "SEARCH_READY",
          debug_port: 9222,
          page_state: {}
        };
      },
      runSearchCli: async ({ searchParams }) => {
        calls.searchParams.push({ ...searchParams });
        if (searchQueue.length === 0) {
          throw new Error("runSearchCli called more times than expected");
        }
        return searchQueue.shift();
      },
      runScreenCli: async ({ screenParams }) => {
        calls.screenParams.push({ ...screenParams });
        if (screenQueue.length === 0) {
          throw new Error("runScreenCli called more times than expected");
        }
        return screenQueue.shift();
      }
    }
  };
}

async function testSearchExhaustedCompletesAndMergesCsv() {
  const tempDir = createTempDir("exhausted");
  const round1Csv = path.join(tempDir, "round-1.csv");
  writeCsv(round1Csv, [
    "张三,清华大学,计算机,甲公司,算法工程师,理由A"
  ]);

  const parsed = createParsed({
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 100
    }
  });
  const { deps, calls } = createDependencies({
    parsed,
    searchResults: [buildSearchOk(160), buildSearchOk(0)],
    screenResults: [
      buildScreenOk({
        processedCount: 80,
        passedCount: 12,
        outputCsv: round1Csv
      })
    ]
  });

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.completion_reason, "search_exhausted_no_candidates");
  assert.equal(result.result.processed_count, 80);
  assert.equal(result.result.passed_count, 12);
  assert.equal(result.result.round_count, 2);
  assert.equal(calls.searchParams[0].filter_recent_viewed, false);
  assert.equal(calls.searchParams[1].filter_recent_viewed, true);
  assert.ok(result.result.output_csv && fs.existsSync(result.result.output_csv));
  const mergedLines = readCsvLines(result.result.output_csv);
  assert.equal(mergedLines.length, 2);
}

async function testSearchExhaustedByTipNodataEvenWhenCandidateCountPositive() {
  const tempDir = createTempDir("exhausted-tip");
  const round1Csv = path.join(tempDir, "round-1.csv");
  writeCsv(round1Csv, [
    "赵六,浙大,电子信息,戊公司,工程师,理由D"
  ]);

  const parsed = createParsed({
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 100
    }
  });
  const { deps, calls } = createDependencies({
    parsed,
    searchResults: [
      buildSearchOk(120),
      {
        ...buildSearchOk(87),
        no_data_tip_present: true,
        no_data_tip_check: {
          ok: true,
          details: {
            exhausted: true,
            selector: "i.tip-nodata"
          }
        }
      }
    ],
    screenResults: [
      buildScreenOk({
        processedCount: 80,
        passedCount: 4,
        outputCsv: round1Csv
      })
    ]
  });

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.completion_reason, "search_exhausted_no_candidates");
  assert.equal(result.result.exhausted_by_tip_nodata, true);
  assert.equal(result.result.processed_count, 80);
  assert.equal(result.result.round_count, 2);
  assert.equal(calls.searchParams[1].filter_recent_viewed, true);
}

async function testTargetReachedAcrossRoundsAndDuplicateRowsKept() {
  const tempDir = createTempDir("target");
  const round1Csv = path.join(tempDir, "round-1.csv");
  const round2Csv = path.join(tempDir, "round-2.csv");
  const dupRow = "重复候选人,北大,计算机,乙公司,后端工程师,重复原因";
  writeCsv(round1Csv, [
    "张三,清华大学,计算机,甲公司,算法工程师,理由A",
    dupRow
  ]);
  writeCsv(round2Csv, [
    dupRow,
    "李四,复旦大学,软件工程,丙公司,推荐算法工程师,理由B"
  ]);

  const parsed = createParsed({
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 100
    }
  });
  const { deps, calls } = createDependencies({
    parsed,
    searchResults: [buildSearchOk(120), buildSearchOk(120)],
    screenResults: [
      buildScreenOk({
        processedCount: 60,
        passedCount: 5,
        outputCsv: round1Csv
      }),
      buildScreenOk({
        processedCount: 40,
        passedCount: 8,
        outputCsv: round2Csv
      })
    ]
  });

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.completion_reason, "processed_target_reached");
  assert.equal(result.result.processed_count, 100);
  assert.equal(result.result.passed_count, 13);
  assert.equal(result.result.round_count, 2);
  assert.equal(calls.searchParams[0].filter_recent_viewed, false);
  assert.equal(calls.searchParams[1].filter_recent_viewed, true);
  assert.equal(calls.screenParams[1].target_count, 40);

  const mergedLines = readCsvLines(result.result.output_csv);
  assert.equal(mergedLines.length, 5);
  const duplicateCount = mergedLines.filter((line) => line === dupRow).length;
  assert.equal(duplicateCount, 2);
}

async function testScreenNoProgressWithZeroProcessedExportsBeforeFail() {
  const tempDir = createTempDir("no-progress-zero");
  const round1Csv = path.join(tempDir, "round-1.csv");
  const round2Csv = path.join(tempDir, "round-2.csv");
  writeCsv(round1Csv, [
    "张三,清华大学,计算机,甲公司,算法工程师,理由A"
  ]);
  writeCsv(round2Csv, [
    "王五,浙大,软件工程,丁公司,算法工程师,理由C"
  ]);

  const parsed = createParsed({
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 100
    }
  });
  const { deps } = createDependencies({
    parsed,
    searchResults: [buildSearchOk(120), buildSearchOk(120)],
    screenResults: [
      buildScreenOk({
        processedCount: 80,
        passedCount: 9,
        outputCsv: round1Csv
      }),
      buildScreenOk({
        processedCount: 0,
        passedCount: 0,
        outputCsv: round2Csv
      })
    ]
  });

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "SCREEN_NO_PROGRESS");
  assert.equal(result.diagnostics.total_processed_count, 80);
  assert.equal(result.diagnostics.round_count, 2);
  assert.ok(result.diagnostics.output_csv && fs.existsSync(result.diagnostics.output_csv));
  const mergedLines = readCsvLines(result.diagnostics.output_csv);
  assert.equal(mergedLines.length, 3);
}

async function testScreenNoProgressWithInvalidProcessedAndNoCsv() {
  const tempDir = createTempDir("no-progress-invalid");
  const parsed = createParsed({
    screenParams: {
      criteria: "候选人需有 AI infra 相关经历",
      target_count: 60
    }
  });
  const { deps } = createDependencies({
    parsed,
    searchResults: [buildSearchOk(88)],
    screenResults: [
      buildScreenOk({
        processedCount: null,
        passedCount: 0,
        outputCsv: null
      })
    ]
  });

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "SCREEN_NO_PROGRESS");
  assert.equal(result.diagnostics.round_count, 1);
  assert.equal(result.diagnostics.output_csv, null);
}

async function testNeedInputGateStillWorks() {
  const tempDir = createTempDir("need-input");
  const parsed = createParsed({
    has_unresolved_missing_fields: true,
    missing_fields: ["city"]
  });
  let preflightCalled = false;
  const deps = {
    parseRecruitInstruction: () => parsed,
    runPipelinePreflight: () => {
      preflightCalled = true;
      return { ok: true, checks: [], debug_port: 9222, calibration_path: null };
    },
    ensureBossSearchPageReady: async () => ({ ok: true, state: "SEARCH_READY", debug_port: 9222, page_state: {} }),
    runSearchCli: async () => buildSearchOk(0),
    runScreenCli: async () => buildScreenOk({ processedCount: 0, passedCount: 0, outputCsv: null })
  };

  const result = await runRecruitPipeline(
    {
      workspaceRoot: tempDir,
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    deps
  );

  assert.equal(result.status, "NEED_INPUT");
  assert.equal(preflightCalled, false);
}

async function main() {
  await testSearchExhaustedCompletesAndMergesCsv();
  await testSearchExhaustedByTipNodataEvenWhenCandidateCountPositive();
  await testTargetReachedAcrossRoundsAndDuplicateRowsKept();
  await testScreenNoProgressWithZeroProcessedExportsBeforeFail();
  await testScreenNoProgressWithInvalidProcessedAndNoCsv();
  await testNeedInputGateStillWorks();
  // eslint-disable-next-line no-console
  console.log("pipeline tests passed");
}

await main();
