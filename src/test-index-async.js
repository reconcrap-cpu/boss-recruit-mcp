import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";

const {
  handleRequest,
  activeAsyncRuns,
  setRunPipelineImplForTests
} = __testables;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeToolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  };
}

async function readToolPayload(response) {
  return response?.result?.structuredContent;
}

async function waitForTerminalRunState(runId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await handleRequest(
      makeToolCall(100, "get_recruit_pipeline_run", { run_id: runId }),
      process.cwd()
    );
    const payload = await readToolPayload(response);
    const state = payload?.run?.state;
    if (["completed", "failed", "canceled"].includes(String(state || "").toLowerCase())) {
      return payload.run;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting terminal run state for run_id=${runId}`);
}

async function waitForPausedRunState(runId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await handleRequest(
      makeToolCall(101, "get_recruit_pipeline_run", { run_id: runId }),
      process.cwd()
    );
    const payload = await readToolPayload(response);
    const state = payload?.run?.state;
    if (String(state || "").toLowerCase() === "paused") {
      return payload.run;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting paused run state for run_id=${runId}`);
}

async function testAsyncStartStatusCancelAndSyncCompatibility() {
  const previousHome = process.env.BOSS_RECRUIT_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recruit-index-async-"));

  setRunPipelineImplForTests(async (input, _deps, runtime) => {
    if (runtime?.precheckOnly) {
      if (input.instruction.includes("need-confirm")) {
        return {
          status: "NEED_CONFIRMATION",
          required_confirmations: ["keyword"],
          pending_questions: [
            {
              field: "keyword",
              question: "请先确认关键词"
            }
          ]
        };
      }
      if (input.instruction.includes("precheck-fail")) {
        return {
          status: "FAILED",
          error: {
            code: "BOSS_LOGIN_REQUIRED",
            message: "mock login required",
            retryable: true
          }
        };
      }
      return {
        status: "READY_TO_START_ASYNC"
      };
    }

    runtime?.onContext?.({
      workspace_root: process.cwd(),
      instruction: input.instruction,
      confirmation: input.confirmation || {},
      overrides: input.overrides || {},
      rounds: [{
        round_index: 1,
        state: "screen",
        search_completed: true
      }]
    });
    runtime?.onStage?.({ stage: "preflight", message: "preflight started" });
    await sleep(50);

    if (input.instruction.includes("fail")) {
      runtime?.onStage?.({ stage: "search", message: "search failed" });
      return {
        status: "FAILED",
        error: {
          code: "SEARCH_CLI_FAILED",
          message: "mock search failed",
          retryable: true
        }
      };
    }

    runtime?.onStage?.({ stage: "screen", message: "screen running" });
    const startAt = input?.resume?.resume === true ? 21 : 1;
    const checkpointPath = path.join(tempHome, "mock-checkpoint.json");
    const outputCsv = path.join(tempHome, "mock-output.csv");
    for (let i = startAt; i <= 40; i += 1) {
      if (runtime?.signal?.aborted) {
        const error = new Error("aborted");
        error.code = "PIPELINE_ABORTED";
        throw error;
      }
      if (runtime?.isPauseRequested?.() && i >= 20) {
        return {
          status: "PAUSED",
          partial_result: {
            processed_count: i - 1,
            passed_count: Math.floor((i - 1) / 5),
            output_csv: outputCsv,
            checkpoint_path: checkpointPath,
            completion_reason: "paused"
          }
        };
      }
      runtime?.onProgress?.({
        stage: "screen",
        processed: i,
        passed: Math.floor(i / 5),
        skipped: i - Math.floor(i / 5),
        greet_count: 0,
        line: `处理第 ${i} 位候选人`
      });
      await sleep(input.instruction.includes("slow") ? 25 : 5);
    }

    return {
      status: "COMPLETED",
      result: {
        processed_count: 40,
        passed_count: 8
      }
    };
  });

  process.env.BOSS_RECRUIT_HOME = tempHome;

  try {
    const gatedStartResponse = await handleRequest(
      makeToolCall(1, "start_recruit_pipeline_run", { instruction: "need-confirm slow task" }),
      process.cwd()
    );
    const gatedStartPayload = await readToolPayload(gatedStartResponse);
    assert.equal(gatedStartPayload.status, "NEED_CONFIRMATION");
    assert.deepEqual(gatedStartPayload.required_confirmations, ["keyword"]);
    assert.equal(gatedStartPayload.run_id, undefined);

    const startResponse = await handleRequest(
      makeToolCall(2, "start_recruit_pipeline_run", { instruction: "slow task for cancel" }),
      process.cwd()
    );
    const started = await readToolPayload(startResponse);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(typeof started.run_id, "string");
    assert.equal(started.poll_after_sec >= 5 && started.poll_after_sec <= 15, true);

    const statusResponse = await handleRequest(
      makeToolCall(3, "get_recruit_pipeline_run", { run_id: started.run_id }),
      process.cwd()
    );
    const initialStatus = await readToolPayload(statusResponse);
    assert.equal(initialStatus.status, "RUN_STATUS");
    assert.equal(["queued", "running"].includes(initialStatus.run.state), true);

    const cancelResponse = await handleRequest(
      makeToolCall(4, "cancel_recruit_pipeline_run", { run_id: started.run_id }),
      process.cwd()
    );
    const canceled = await readToolPayload(cancelResponse);
    assert.equal(["CANCEL_REQUESTED", "CANCEL_IGNORED"].includes(canceled.status), true);

    const canceledRun = await waitForTerminalRunState(started.run_id);
    assert.equal(canceledRun.state, "canceled");

    const pauseStartResponse = await handleRequest(
      makeToolCall(41, "start_recruit_pipeline_run", { instruction: "slow task for pause" }),
      process.cwd()
    );
    const pauseStarted = await readToolPayload(pauseStartResponse);
    assert.equal(pauseStarted.status, "ACCEPTED");
    const pauseRequestResponse = await handleRequest(
      makeToolCall(42, "pause_recruit_pipeline_run", { run_id: pauseStarted.run_id }),
      process.cwd()
    );
    const pauseRequested = await readToolPayload(pauseRequestResponse);
    assert.equal(pauseRequested.status, "PAUSE_REQUESTED");
    const pausedRun = await waitForPausedRunState(pauseStarted.run_id);
    assert.equal(pausedRun.state, "paused");
    assert.equal(typeof pausedRun.resume.checkpoint_path, "string");

    const resumeResponse = await handleRequest(
      makeToolCall(43, "resume_recruit_pipeline_run", { run_id: pauseStarted.run_id }),
      process.cwd()
    );
    const resumed = await readToolPayload(resumeResponse);
    assert.equal(resumed.status, "RESUME_REQUESTED");
    const resumedRun = await waitForTerminalRunState(pauseStarted.run_id);
    assert.equal(resumedRun.state, "completed");

    const defaultAsyncGatedResponse = await handleRequest(
      makeToolCall(5, "run_recruit_pipeline", { instruction: "need-confirm default async" }),
      process.cwd()
    );
    const defaultAsyncGatedPayload = await readToolPayload(defaultAsyncGatedResponse);
    assert.equal(defaultAsyncGatedPayload.status, "NEED_CONFIRMATION");
    assert.deepEqual(defaultAsyncGatedPayload.required_confirmations, ["keyword"]);

    const defaultAsyncResponse = await handleRequest(
      makeToolCall(6, "run_recruit_pipeline", { instruction: "fast async accepted run" }),
      process.cwd()
    );
    const defaultAsyncPayload = await readToolPayload(defaultAsyncResponse);
    assert.equal(defaultAsyncPayload.status, "ACCEPTED");
    assert.equal(typeof defaultAsyncPayload.run_id, "string");
    const completedDefaultAsyncRun = await waitForTerminalRunState(defaultAsyncPayload.run_id);
    assert.equal(completedDefaultAsyncRun.state, "completed");

    const syncResponse = await handleRequest(
      makeToolCall(7, "run_recruit_pipeline", {
        instruction: "fast forced sync run",
        execution_mode: "sync"
      }),
      process.cwd()
    );
    const syncPayload = await readToolPayload(syncResponse);
    assert.equal(syncPayload.status, "COMPLETED");
    assert.equal(typeof syncPayload.result.run_id, "string");
    assert.equal(syncPayload.result.processed_count, 40);

    const failedSyncResponse = await handleRequest(
      makeToolCall(8, "run_recruit_pipeline", {
        instruction: "force fail",
        execution_mode: "sync"
      }),
      process.cwd()
    );
    const syncFailedPayload = await readToolPayload(failedSyncResponse);
    assert.equal(syncFailedPayload.status, "FAILED");
    assert.equal(typeof syncFailedPayload.diagnostics?.run_id, "string");
    assert.equal(typeof syncFailedPayload.diagnostics?.last_stage, "string");

    const precheckFailedResponse = await handleRequest(
      makeToolCall(9, "start_recruit_pipeline_run", { instruction: "precheck-fail" }),
      process.cwd()
    );
    const precheckFailedPayload = await readToolPayload(precheckFailedResponse);
    assert.equal(precheckFailedPayload.status, "FAILED");
    assert.equal(precheckFailedPayload.error.code, "BOSS_LOGIN_REQUIRED");

    assert.equal(activeAsyncRuns.size >= 0, true);
  } finally {
    setRunPipelineImplForTests(null);
    if (previousHome === undefined) {
      delete process.env.BOSS_RECRUIT_HOME;
    } else {
      process.env.BOSS_RECRUIT_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function main() {
  await testAsyncStartStatusCancelAndSyncCompatibility();
  console.log("index async tests passed");
}

await main();
