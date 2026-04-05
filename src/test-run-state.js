import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUN_MODE_ASYNC,
  RUN_STAGE_SCREEN,
  RUN_STATE_COMPLETED,
  RUN_STATE_PAUSED,
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  cleanupExpiredRuns,
  createRunId,
  createRunStateSnapshot,
  getRunsDir,
  readRunState,
  touchRunHeartbeat,
  updateRunProgress,
  updateRunState,
  writeRunState
} from "./run-state.js";

function withTempHome(testFn) {
  const previous = process.env.BOSS_RECRUIT_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recruit-run-state-"));
  process.env.BOSS_RECRUIT_HOME = tempHome;
  try {
    testFn(tempHome);
  } finally {
    if (previous === undefined) {
      delete process.env.BOSS_RECRUIT_HOME;
    } else {
      process.env.BOSS_RECRUIT_HOME = previous;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function testRunStateLifecycle() {
  withTempHome((tempHome) => {
    const runId = createRunId();
    const queued = writeRunState(createRunStateSnapshot({
      runId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_QUEUED,
      stage: "preflight",
      context: {
        workspace_root: tempHome,
        instruction: "test instruction",
        confirmation: { keyword_confirmed: true },
        overrides: { city: "杭州" },
        rounds: []
      },
      control: {
        pause_requested: false,
        cancel_requested: false
      },
      resume: {
        checkpoint_path: path.join(tempHome, "checkpoint.json"),
        pause_control_path: path.join(tempHome, "run.json"),
        output_csv: null
      }
    }));
    assert.equal(queued.run_id, runId);
    assert.equal(queued.state, RUN_STATE_QUEUED);
    assert.equal(queued.context.workspace_root, tempHome);
    assert.equal(queued.control.pause_requested, false);

    const running = updateRunState(runId, {
      state: RUN_STATE_RUNNING,
      stage: RUN_STAGE_SCREEN,
      last_message: "screening in progress",
      control: {
        pause_requested: true,
        pause_requested_by: "pause_recruit_pipeline_run"
      },
      context: {
        workspace_root: tempHome,
        instruction: "test instruction",
        confirmation: { keyword_confirmed: true },
        overrides: { city: "杭州" },
        rounds: [{
          round_index: 1,
          state: "screen",
          search_completed: true,
          checkpoint_path: path.join(tempHome, "checkpoint.json")
        }]
      }
    });
    assert.equal(running.state, RUN_STATE_RUNNING);
    assert.equal(running.stage, RUN_STAGE_SCREEN);
    assert.equal(running.control.pause_requested, true);
    assert.equal(running.context.rounds[0].checkpoint_path, path.join(tempHome, "checkpoint.json"));
    const heartbeatBeforeProgress = running.heartbeat_at;

    const progressed = updateRunProgress(runId, {
      processed: 7,
      passed: 2,
      skipped: 5,
      greet_count: 1
    });
    assert.equal(progressed.progress.processed, 7);
    assert.equal(progressed.progress.passed, 2);
    assert.equal(progressed.progress.skipped, 5);
    assert.equal(progressed.progress.greet_count, 1);
    assert.equal(progressed.heartbeat_at, heartbeatBeforeProgress);

    const paused = updateRunState(runId, {
      state: RUN_STATE_PAUSED,
      resume: {
        output_csv: path.join(tempHome, "output.csv"),
        resume_count: 1,
        last_paused_at: new Date().toISOString()
      }
    });
    assert.equal(paused.state, RUN_STATE_PAUSED);
    assert.equal(paused.resume.resume_count, 1);

    const heartbeated = touchRunHeartbeat(runId, "still running");
    assert.equal(heartbeated.last_message, "still running");
    assert.equal(Date.parse(heartbeated.heartbeat_at) >= Date.parse(heartbeatBeforeProgress), true);

    const completed = updateRunState(runId, {
      state: RUN_STATE_COMPLETED,
      stage: "finalize",
      result: {
        status: "COMPLETED",
        result: {
          processed_count: 7
        }
      }
    });
    assert.equal(completed.state, RUN_STATE_COMPLETED);
    assert.equal(completed.result.status, "COMPLETED");

    const reloaded = readRunState(runId);
    assert.equal(reloaded.state, RUN_STATE_COMPLETED);
    assert.equal(reloaded.progress.processed, 7);
  });
}

function testRunStateCleanup() {
  withTempHome(() => {
    const runId = createRunId();
    writeRunState(createRunStateSnapshot({ runId, mode: RUN_MODE_ASYNC }));
    const runFile = path.join(getRunsDir(), `${runId}.json`);
    const oldSeconds = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);
    fs.utimesSync(runFile, oldSeconds, oldSeconds);

    const cleaned = cleanupExpiredRuns(1000);
    assert.equal(cleaned.removed.some((item) => item.endsWith(`${runId}.json`)), true);
    assert.equal(fs.existsSync(runFile), false);
  });
}

function main() {
  testRunStateLifecycle();
  testRunStateCleanup();
  console.log("run-state tests passed");
}

main();

