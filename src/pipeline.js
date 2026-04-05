import fs from "node:fs";
import path from "node:path";
import { parseRecruitInstruction } from "./parser.js";
import {
  attemptPipelineAutoRepair,
  ensureBossSearchPageReady,
  runPipelinePreflight,
  runSearchCli,
  runScreenCli
} from "./adapters.js";

export const PIPELINE_STATUS_READY_TO_START_ASYNC = "READY_TO_START_ASYNC";
const MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS = 3;

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function failedCheckSet(checks = []) {
  const failed = checks
    .filter((item) => item && item.ok === false && typeof item.key === "string")
    .map((item) => item.key);
  return new Set(failed);
}

function collectNpmInstallDirs(checks = [], workspaceRoot) {
  const npmCheckKeys = new Set([
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws"
  ]);
  const dirs = checks
    .filter((item) => item && item.ok === false && npmCheckKeys.has(item.key))
    .map((item) => item.install_cwd)
    .filter((value) => typeof value === "string" && value.trim());
  if (dirs.length > 0) return dedupe(dirs);
  return workspaceRoot ? [workspaceRoot] : [];
}

function buildNpmInstallCommands(checks = [], workspaceRoot) {
  const dirs = collectNpmInstallDirs(checks, workspaceRoot);
  const commands = [];
  for (const dir of dirs) {
    const escaped = String(dir).replace(/'/g, "''");
    commands.push(`Set-Location '${escaped}'`);
    commands.push("npm install");
  }
  return commands;
}

function formatCommandBlock(commands = []) {
  return commands.map((command) => `- ${command}`).join("\n");
}

function buildPreflightRecovery(checks = [], workspaceRoot) {
  const failed = failedCheckSet(checks);
  if (failed.size === 0) return null;

  const needNode = failed.has("node_cli");
  const needNpm = (
    failed.has("npm_dep_chrome_remote_interface_search")
    || failed.has("npm_dep_chrome_remote_interface_screen")
    || failed.has("npm_dep_ws")
  );
  const needPython = failed.has("python_cli");
  const needPillow = failed.has("python_pillow");

  const ordered_steps = [];
  if (needNode) {
    ordered_steps.push({
      id: "install_nodejs",
      title: "安装 Node.js >= 18",
      blocked_by: [],
      commands: [
        "winget install OpenJS.NodeJS.LTS",
        "node --version"
      ]
    });
  }
  if (needNpm) {
    ordered_steps.push({
      id: "install_npm_dependencies",
      title: "安装 npm 依赖（chrome-remote-interface / ws）",
      blocked_by: needNode ? ["install_nodejs"] : [],
      commands: buildNpmInstallCommands(checks, workspaceRoot)
    });
  }
  if (needPython) {
    ordered_steps.push({
      id: "install_python",
      title: "安装 Python（确保 python 命令可用）",
      blocked_by: [],
      commands: [
        "winget install Python.Python.3.12",
        "python --version"
      ]
    });
  }
  if (needPillow) {
    ordered_steps.push({
      id: "install_pillow",
      title: "安装 Pillow",
      blocked_by: needPython ? ["install_python"] : [],
      commands: [
        "python -m pip install --upgrade pip",
        "python -m pip install pillow"
      ]
    });
  }

  const promptLines = [
    "你是环境修复 agent。请先读取 diagnostics.checks，再严格按下面顺序执行，不要并行跳步：",
    "1) node_cli 失败 -> 先安装 Node.js，未成功前禁止执行 npm install。",
    "2) npm_dep_* 失败 -> 再安装 npm 依赖（chrome-remote-interface / ws）。",
    "3) python_cli 失败 -> 安装 Python 并确保 python 命令可用。",
    "4) python_pillow 失败 -> 最后安装 Pillow。",
    "每一步完成后都重新运行 doctor，直到所有检查通过后再重试 run_recruit_pipeline。"
  ];

  if (needNpm) {
    const npmCommands = buildNpmInstallCommands(checks, workspaceRoot);
    if (npmCommands.length > 0) {
      promptLines.push("建议执行的 npm 命令：");
      promptLines.push(formatCommandBlock(npmCommands));
    }
  }

  return {
    failed_check_keys: [...failed],
    ordered_steps,
    agent_prompt: promptLines.join("\n")
  };
}

function buildRequiredConfirmations(parsedResult) {
  const confirmations = [];

  if (parsedResult.needs_search_params_confirmation) {
    confirmations.push("search_params");
  }
  if (parsedResult.needs_keyword_confirmation) {
    confirmations.push("keyword");
  }
  if (parsedResult.needs_recent_viewed_filter_confirmation) {
    confirmations.push("filter_recent_viewed");
  }
  if (parsedResult.needs_criteria_confirmation) {
    confirmations.push("criteria");
  }
  if (parsedResult.has_unresolved_missing_fields) {
    confirmations.push("missing_fields_or_defaults");
  }

  return confirmations;
}

function buildNeedInputResponse(parsedResult) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsedResult.missing_fields,
    proposed_keyword: parsedResult.proposed_keyword,
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: parsedResult.searchParams,
    screen_params: parsedResult.screenParams,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段。请先补齐缺失项；若要按默认值继续，必须先明确确认默认值及其风险。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsedResult) {
  return {
    status: "NEED_CONFIRMATION",
    proposed_keyword: parsedResult.proposed_keyword,
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: {
      ...parsedResult.searchParams,
      keyword: parsedResult.proposed_keyword || parsedResult.searchParams.keyword
    },
    screen_params: parsedResult.screenParams,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review
  };
}

function buildFailedResponse(code, message, extra = {}) {
  return {
    status: "FAILED",
    error: {
      code,
      message,
      retryable: true
    },
    ...extra
  };
}

function buildPausedResponse(message, extra = {}) {
  return {
    status: "PAUSED",
    message: normalizeText(message || "") || "招聘流水线已暂停。",
    ...extra
  };
}

class PipelineAbortError extends Error {
  constructor(message = "Pipeline execution aborted") {
    super(message);
    this.name = "PipelineAbortError";
    this.code = "PIPELINE_ABORTED";
  }
}

function isAbortSignalTriggered(signal) {
  return Boolean(signal && signal.aborted);
}

function ensurePipelineNotAborted(signal) {
  if (isAbortSignalTriggered(signal)) {
    throw new PipelineAbortError("Pipeline execution aborted by caller.");
  }
}

function safeInvokeRuntimeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch {
    // Keep pipeline stable even if runtime callback fails.
  }
}

function createPipelineRuntime(runtime = null) {
  const signal = runtime?.signal;
  const heartbeatIntervalMs = Number.isFinite(runtime?.heartbeatIntervalMs) && runtime.heartbeatIntervalMs > 0
    ? runtime.heartbeatIntervalMs
    : 10_000;
  const precheckOnly = runtime?.precheckOnly === true;

  function setStage(stage, message = null) {
    safeInvokeRuntimeCallback(runtime?.onStage, {
      stage,
      message: normalizeText(message || "") || null,
      at: new Date().toISOString()
    });
  }

  function heartbeat(stage, details = null) {
    safeInvokeRuntimeCallback(runtime?.onHeartbeat, {
      stage,
      details: details || null,
      at: new Date().toISOString()
    });
  }

  function output(stage, event) {
    safeInvokeRuntimeCallback(runtime?.onOutput, {
      stage,
      ...(event || {}),
      at: new Date().toISOString()
    });
  }

  function progress(stage, payload) {
    safeInvokeRuntimeCallback(runtime?.onProgress, {
      stage,
      ...(payload || {}),
      at: new Date().toISOString()
    });
  }

   function context(payload) {
    safeInvokeRuntimeCallback(runtime?.onContext, {
      context: payload && typeof payload === "object"
        ? JSON.parse(JSON.stringify(payload))
        : null,
      at: new Date().toISOString()
    });
  }

  function adapterRuntime(stage) {
    return {
      signal,
      heartbeatIntervalMs,
      onOutput: (event) => output(stage, event),
      onHeartbeat: (event) => heartbeat(stage, event),
      onProgress: (payload) => progress(stage, payload)
    };
  }

  return {
    signal,
    heartbeatIntervalMs,
    precheckOnly,
    setStage,
    heartbeat,
    output,
    progress,
    context,
    existingContext: runtime?.existingContext || null,
    isPauseRequested: typeof runtime?.isPauseRequested === "function"
      ? runtime.isPauseRequested
      : () => false,
    adapterRuntime
  };
}

function isProcessAbortError(errorLike) {
  const code = normalizeText(errorLike?.code || errorLike?.error_code || "").toUpperCase();
  return code === "PROCESS_ABORTED" || code === "ABORTED";
}

function normalizeCsvPath(csvPath) {
  if (typeof csvPath !== "string") return null;
  const trimmed = csvPath.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function isReadableFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function collectReadableCsvPaths(csvPaths) {
  const unique = new Set();
  for (const rawPath of csvPaths || []) {
    const normalized = normalizeCsvPath(rawPath);
    if (!normalized || unique.has(normalized)) continue;
    if (isReadableFile(normalized)) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function parseCsvContent(content) {
  const normalized = String(content || "").replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  return {
    header: lines[0],
    rows: lines.slice(1)
  };
}

function mergeRoundCsvFiles(csvPaths) {
  const readablePaths = collectReadableCsvPaths(csvPaths);
  if (readablePaths.length === 0) return null;

  let header = null;
  const rows = [];

  for (const csvPath of readablePaths) {
    let content;
    try {
      content = fs.readFileSync(csvPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseCsvContent(content);
    if (!parsed) continue;
    if (!header) {
      header = parsed.header;
    }
    rows.push(...parsed.rows);
  }

  if (!header) return null;

  const outputDir = path.dirname(readablePaths[0]);
  const outputPath = path.join(outputDir, `筛选结果_合并_${Date.now()}.csv`);
  const mergedContent = `\uFEFF${header}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
  fs.writeFileSync(outputPath, mergedContent, "utf8");
  return outputPath;
}

function cloneJson(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeRoundState(round = {}) {
  return {
    round_index: Number.isInteger(round.round_index) && round.round_index > 0 ? round.round_index : null,
    state: normalizeText(round.state || "") || null,
    completion_reason: normalizeText(round.completion_reason || "") || null,
    search_params: round.search_params && typeof round.search_params === "object" ? cloneJson(round.search_params, {}) : null,
    candidate_count: Number.isInteger(round.candidate_count) && round.candidate_count >= 0 ? round.candidate_count : null,
    search_completed: round.search_completed === true,
    screen_output_csv: normalizeCsvPath(round.screen_output_csv),
    checkpoint_path: normalizeText(round.checkpoint_path || "") || null,
    auto_recovery_count: Number.isInteger(round.auto_recovery_count) && round.auto_recovery_count >= 0
      ? round.auto_recovery_count
      : 0,
    screen_processed_count: Number.isInteger(round.screen_processed_count) && round.screen_processed_count >= 0
      ? round.screen_processed_count
      : null,
    screen_passed_count: Number.isInteger(round.screen_passed_count) && round.screen_passed_count >= 0
      ? round.screen_passed_count
      : null
  };
}

function createPipelineContext(workspaceRoot, instruction, confirmation, overrides, existingContext = null) {
  const context = existingContext && typeof existingContext === "object"
    ? cloneJson(existingContext, {})
    : {};
  const rounds = Array.isArray(context.rounds)
    ? context.rounds.map((item) => normalizeRoundState(item)).filter(Boolean)
    : [];
  return {
    ...context,
    workspace_root: path.resolve(workspaceRoot),
    instruction: String(instruction || ""),
    confirmation: confirmation && typeof confirmation === "object" ? cloneJson(confirmation, {}) : {},
    overrides: overrides && typeof overrides === "object" ? cloneJson(overrides, {}) : {},
    rounds
  };
}

function upsertRoundContext(context, roundIndex, patch = {}) {
  if (!context || !Array.isArray(context.rounds)) return null;
  const existingIndex = context.rounds.findIndex((item) => item?.round_index === roundIndex);
  const existingRound = existingIndex >= 0 ? context.rounds[existingIndex] : {
    round_index: roundIndex,
    state: "queued",
    completion_reason: null,
    search_params: null,
    candidate_count: null,
    search_completed: false,
    screen_output_csv: null,
    checkpoint_path: null,
    auto_recovery_count: 0,
    screen_processed_count: null,
    screen_passed_count: null
  };
  const nextRound = normalizeRoundState({
    ...existingRound,
    ...patch,
    round_index: roundIndex
  });
  if (existingIndex >= 0) {
    context.rounds[existingIndex] = nextRound;
  } else {
    context.rounds.push(nextRound);
    context.rounds.sort((left, right) => (left.round_index || 0) - (right.round_index || 0));
  }
  return nextRound;
}

function getRoundContext(context, roundIndex) {
  if (!context || !Array.isArray(context.rounds)) return null;
  return context.rounds.find((item) => item?.round_index === roundIndex) || null;
}

function computeRoundDelta(context, roundIndex, roundProcessedCount = 0, roundPassedCount = 0) {
  const existingRound = Number.isInteger(roundIndex) && roundIndex > 0
    ? getRoundContext(context, roundIndex)
    : null;
  const previousProcessedCount = Number.isInteger(existingRound?.screen_processed_count)
    ? existingRound.screen_processed_count
    : 0;
  const previousPassedCount = Number.isInteger(existingRound?.screen_passed_count)
    ? existingRound.screen_passed_count
    : 0;
  return {
    previousProcessedCount,
    previousPassedCount,
    processedDelta: Math.max(roundProcessedCount - previousProcessedCount, 0),
    passedDelta: Math.max(roundPassedCount - previousPassedCount, 0)
  };
}

function summarizeRounds(context) {
  const rounds = Array.isArray(context?.rounds) ? context.rounds : [];
  let processedCount = 0;
  let passedCount = 0;
  const outputCsvPaths = [];
  for (const round of rounds) {
    if (Number.isInteger(round?.screen_processed_count) && round.screen_processed_count > 0) {
      processedCount += round.screen_processed_count;
    }
    if (Number.isInteger(round?.screen_passed_count) && round.screen_passed_count >= 0) {
      passedCount += round.screen_passed_count;
    }
    const csvPath = normalizeCsvPath(round?.screen_output_csv);
    if (csvPath && isReadableFile(csvPath)) {
      outputCsvPaths.push(csvPath);
    }
  }
  return {
    processedCount,
    passedCount,
    roundCount: rounds.length,
    outputCsvPaths: collectReadableCsvPaths(outputCsvPaths)
  };
}

function getActiveResumeRound(context) {
  const rounds = Array.isArray(context?.rounds) ? context.rounds : [];
  if (rounds.length === 0) return null;
  const lastRound = rounds[rounds.length - 1];
  if (!lastRound || !Number.isInteger(lastRound.round_index) || lastRound.round_index <= 0) return null;
  if (lastRound.state === "completed") return null;
  return lastRound;
}

function buildProgressDiagnostics({
  preflight,
  totalProcessedCount,
  totalPassedCount,
  roundCount,
  extra = {}
}) {
  return {
    debug_port: preflight.debug_port,
    total_processed_count: totalProcessedCount,
    total_passed_count: totalPassedCount,
    round_count: roundCount,
    ...extra
  };
}

function classifySearchFailure(searchResult) {
  const stderr = searchResult.stderr || "";
  const errorCode = searchResult.error_code || "";

  if (errorCode === "EPERM" || /spawn EPERM/i.test(stderr)) {
    return {
      code: "SEARCH_PROCESS_PERMISSION_DENIED",
      message: "搜索工具无法启动子进程，当前运行环境拒绝了进程创建权限。请在本地终端直接运行 MCP 或放宽运行权限后重试。"
    };
  }

  if (errorCode === "TIMEOUT" || /timed out/i.test(stderr)) {
    return {
      code: "SEARCH_TIMEOUT",
      message: "搜索工具执行超时，可能是 Chrome 远程调试未就绪、Boss 页面未打开，或页面交互卡住。"
    };
  }

  if (errorCode === "ENOENT" || /not recognized|Cannot find|MODULE_NOT_FOUND/i.test(stderr)) {
    return {
      code: "SEARCH_CLI_MISSING",
      message: "搜索工具入口不存在或 Node 环境不可用，请检查 boss-search-cli 安装与路径配置。"
    };
  }

  return {
    code: "SEARCH_CLI_FAILED",
    message: "搜索工具执行失败，请检查 Chrome 远程调试、Boss 登录状态和页面可访问性。"
  };
}

function classifyScreenFailure(screenResult) {
  const structuredError = screenResult?.error && typeof screenResult.error === "object"
    ? screenResult.error
    : null;
  const structuredCode = normalizeText(structuredError?.code || "").toUpperCase();
  if (structuredCode) {
    return {
      code: structuredCode,
      message: structuredError?.message || "筛选工具执行失败，请检查模型配置、Chrome 远程调试和页面状态。",
      recoverable: structuredError?.recoverable === true
    };
  }

  const stderr = screenResult.stderr || "";
  const errorCode = screenResult.error_code || "";

  if (screenResult.config_error) {
    return {
      code: "SCREEN_CONFIG_ERROR",
      message: "筛选工具配置缺失或格式错误，请检查 screening-config.json。",
      recoverable: false
    };
  }

  if (errorCode === "EPERM" || /spawn EPERM/i.test(stderr)) {
    return {
      code: "SCREEN_PROCESS_PERMISSION_DENIED",
      message: "筛选工具无法启动子进程，当前运行环境拒绝了进程创建权限。请在本地终端直接运行 MCP 或放宽运行权限后重试。",
      recoverable: false
    };
  }

  if (errorCode === "TIMEOUT" || /timed out/i.test(stderr)) {
    return {
      code: "SCREEN_TIMEOUT",
      message: "筛选工具执行超时，可能是 Boss 页面交互卡住、LLM 接口响应过慢，或候选人列表处理速度异常。",
      recoverable: true
    };
  }

  if (errorCode === "ENOENT" || /not recognized|Cannot find|MODULE_NOT_FOUND/i.test(stderr)) {
    return {
      code: "SCREEN_CLI_MISSING",
      message: "筛选工具入口不存在或 Node 环境不可用，请检查 boss-screen-cli 安装与路径配置。",
      recoverable: false
    };
  }

  if (/DOM收藏不可用且缺少可用校准文件/i.test(stderr)) {
    return {
      code: "CALIBRATION_REQUIRED",
      message: "当前页面无法通过DOM按钮完成收藏，且缺少可用的收藏校准文件用于回退点击。请运行 boss-recruit-mcp calibrate 生成 favorite-calibration.json 后重试。",
      recoverable: false
    };
  }

  return {
    code: "SCREEN_CLI_FAILED",
    message: "筛选工具执行失败，请检查模型配置、Chrome 远程调试和页面状态。",
    recoverable: false
  };
}

const defaultDependencies = {
  attemptPipelineAutoRepair,
  parseRecruitInstruction,
  ensureBossSearchPageReady,
  runPipelinePreflight,
  runSearchCli,
  runScreenCli
};

export async function runRecruitPipeline(
  {
    workspaceRoot,
    instruction,
    confirmation,
    overrides,
    resume = null
  },
  dependencies = defaultDependencies,
  runtime = null
) {
  const injectedDependencies = dependencies || {};
  const resolvedDependencies = { ...defaultDependencies, ...(dependencies || {}) };
  const {
    attemptPipelineAutoRepair: attemptAutoRepair,
    parseRecruitInstruction: parseInstruction,
    ensureBossSearchPageReady: ensureSearchPageReady,
    runPipelinePreflight: runPreflight,
    runSearchCli: searchCli,
    runScreenCli: screenCli
  } = resolvedDependencies;
  const runtimeHooks = createPipelineRuntime(runtime);
  ensurePipelineNotAborted(runtimeHooks.signal);
  const startedAt = Date.now();
  const parsed = parseInstruction({
    instruction,
    confirmation,
    overrides
  });

  if (parsed.has_unresolved_missing_fields) {
    return buildNeedInputResponse(parsed);
  }

  if (
    parsed.needs_keyword_confirmation
    || parsed.needs_search_params_confirmation
    || parsed.needs_recent_viewed_filter_confirmation
    || parsed.needs_criteria_confirmation
  ) {
    return buildNeedConfirmationResponse(parsed);
  }

  const pipelineContext = createPipelineContext(
    workspaceRoot,
    instruction,
    confirmation,
    overrides,
    runtimeHooks.existingContext
  );
  const publishContext = () => runtimeHooks.context(pipelineContext);
  const updateRound = (roundIndex, patch = {}) => {
    const round = upsertRoundContext(pipelineContext, roundIndex, patch);
    publishContext();
    return round;
  };
  const currentRoundCount = () => Array.isArray(pipelineContext.rounds) ? pipelineContext.rounds.length : 0;
  publishContext();

  ensurePipelineNotAborted(runtimeHooks.signal);
  runtimeHooks.setStage("preflight", "开始执行 preflight 检查。");
  runtimeHooks.heartbeat("preflight");
  let preflight = runPreflight(workspaceRoot);
  let autoRepair = null;
  const shouldAttemptAutoRepair = (
    dependencies === defaultDependencies
    || Object.prototype.hasOwnProperty.call(injectedDependencies, "attemptPipelineAutoRepair")
  );
  if (!preflight.ok && shouldAttemptAutoRepair && typeof attemptAutoRepair === "function") {
    autoRepair = attemptAutoRepair(workspaceRoot, preflight);
    if (autoRepair?.preflight) {
      preflight = autoRepair.preflight;
    }
  }
  if (!preflight.ok) {
    runtimeHooks.heartbeat("preflight", {
      status: "failed"
    });
    const recovery = buildPreflightRecovery(preflight.checks, workspaceRoot);
    return buildFailedResponse(
      "PIPELINE_PREFLIGHT_FAILED",
      "招聘流水线运行前检查失败，请先修复缺失的本地依赖或配置文件。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          checks: preflight.checks,
          debug_port: preflight.debug_port,
          calibration_path: preflight.calibration_path,
          auto_repair: autoRepair,
          recovery
        }
      }
    );
  }

  const initialTargetCount = parsed.screenParams.target_count;
  if (!Number.isInteger(initialTargetCount) || initialTargetCount <= 0) {
    return buildFailedResponse(
      "INVALID_TARGET_COUNT",
      "目标处理人数无效，请确认 target_count 为正整数后重试。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams
      }
    );
  }

  ensurePipelineNotAborted(runtimeHooks.signal);
  runtimeHooks.setStage("page_ready", "preflight 完成，开始检查 search 页面就绪状态。");
  runtimeHooks.heartbeat("page_ready");
  const initialPageCheck = await ensureSearchPageReady(workspaceRoot, {
    port: preflight.debug_port
  });
  if (!initialPageCheck.ok) {
    if (
      initialPageCheck.state === "LOGIN_REQUIRED"
      || initialPageCheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
    ) {
      return buildFailedResponse(
        "BOSS_LOGIN_REQUIRED",
        "Boss 页面未稳定停留在 search 页面，疑似未登录或登录态失效。请先在当前 Chrome 窗口手动登录 Boss，登录完成后再继续搜索和筛选。",
        {
          search_params: parsed.searchParams,
          screen_params: parsed.screenParams,
          diagnostics: buildProgressDiagnostics({
            preflight,
            totalProcessedCount: 0,
            totalPassedCount: 0,
            roundCount: 0,
            extra: {
              page_state: initialPageCheck.page_state
            }
          })
        }
      );
    }
    return buildFailedResponse(
      "BOSS_SEARCH_PAGE_NOT_READY",
      "无法确认 Boss search 页面已就绪。请先确保 Chrome 调试端口可连，并且页面能稳定停留在 https://www.zhipin.com/web/chat/search。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: buildProgressDiagnostics({
          preflight,
          totalProcessedCount: 0,
          totalPassedCount: 0,
          roundCount: 0,
          extra: {
            page_state: initialPageCheck.page_state
          }
        })
      }
    );
  }

  if (runtimeHooks.precheckOnly) {
    return {
      status: PIPELINE_STATUS_READY_TO_START_ASYNC,
      search_params: parsed.searchParams,
      screen_params: parsed.screenParams,
      message: "前置门禁检查通过，可启动异步流水线。"
    };
  }

  const restoredSummary = summarizeRounds(pipelineContext);
  let totalProcessedCount = restoredSummary.processedCount;
  let totalPassedCount = restoredSummary.passedCount;
  let roundOutputCsvPaths = [...restoredSummary.outputCsvPaths];
  let nextRoundIndex = restoredSummary.roundCount + 1;
  let pendingResumeRound = resume?.resume === true ? getActiveResumeRound(pipelineContext) : null;
  if (pendingResumeRound?.round_index) {
    nextRoundIndex = pendingResumeRound.round_index;
  }
  const resumeCompletionReason = normalizeText(resume?.previous_completion_reason || "").toLowerCase();
  const cancellationMessage = "流水线已取消，已导出取消前的累计结果。";

  function buildCanceledResponse({
    roundIndex = null,
    roundSearchParams = parsed.searchParams,
    roundScreenParams = parsed.screenParams,
    outputCsv = null,
    roundProcessedCount = 0,
    roundPassedCount = 0,
    checkpointPath = null,
    completionReason = "canceled_by_user"
  } = {}) {
    const delta = computeRoundDelta(pipelineContext, roundIndex, roundProcessedCount, roundPassedCount);
    const mergedCsvPath = mergeRoundCsvFiles([
      ...roundOutputCsvPaths,
      ...(outputCsv ? [outputCsv] : [])
    ]);
    const processedCount = totalProcessedCount + delta.processedDelta;
    const passedCount = totalPassedCount + delta.passedDelta;
    const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    runtimeHooks.setStage("finalize", "取消请求已生效，正在导出当前累计结果。");
    runtimeHooks.heartbeat("finalize", {
      status: "canceled"
    });
    runtimeHooks.progress("finalize", {
      processed: processedCount,
      passed: passedCount,
      skipped: Math.max(processedCount - passedCount, 0),
      greet_count: 0
    });
    if (Number.isInteger(roundIndex) && roundIndex > 0) {
      updateRound(roundIndex, {
        state: "canceled",
        completion_reason: completionReason,
        search_params: roundSearchParams,
        search_completed: true,
        screen_output_csv: outputCsv || null,
        checkpoint_path: checkpointPath || null,
        screen_processed_count: roundProcessedCount || null,
        screen_passed_count: roundPassedCount || null
      });
    }
    return buildFailedResponse(
      "PIPELINE_CANCELED",
      cancellationMessage,
      {
        search_params: roundSearchParams,
        screen_params: roundScreenParams,
        partial_result: {
          target_count: initialTargetCount,
          processed_count: processedCount,
          passed_count: passedCount,
          duration_sec: durationSec,
          output_csv: mergedCsvPath,
          round_count: currentRoundCount(),
          current_round_index: roundIndex,
          checkpoint_path: checkpointPath || null,
          completion_reason: completionReason,
          target_count_semantics: "target_count means processed candidate count, not passed candidate count"
        },
        diagnostics: buildProgressDiagnostics({
          preflight,
          totalProcessedCount: processedCount,
          totalPassedCount: passedCount,
          roundCount: currentRoundCount(),
          extra: {
            output_csv: mergedCsvPath,
            checkpoint_path: checkpointPath || null,
            completion_reason: completionReason
          }
        })
      }
    );
  }

  function buildPausedPartial({
    message,
    roundIndex = null,
    roundSearchParams = parsed.searchParams,
    roundScreenParams = parsed.screenParams,
    outputCsv = null,
    roundProcessedCount = 0,
    roundPassedCount = 0,
    checkpointPath = null,
    completionReason = "paused"
  } = {}) {
    const delta = computeRoundDelta(pipelineContext, roundIndex, roundProcessedCount, roundPassedCount);
    const mergedCsvPath = mergeRoundCsvFiles([
      ...roundOutputCsvPaths,
      ...(outputCsv ? [outputCsv] : [])
    ]);
    const processedCount = totalProcessedCount + delta.processedDelta;
    const passedCount = totalPassedCount + delta.passedDelta;
    if (Number.isInteger(roundIndex) && roundIndex > 0) {
      updateRound(roundIndex, {
        state: "paused",
        completion_reason: completionReason,
        search_params: roundSearchParams,
        search_completed: true,
        screen_output_csv: outputCsv || null,
        checkpoint_path: checkpointPath || null,
        screen_processed_count: roundProcessedCount || null,
        screen_passed_count: roundPassedCount || null
      });
    }
    return buildPausedResponse(message, {
      search_params: roundSearchParams,
      screen_params: roundScreenParams,
      partial_result: {
        target_count: initialTargetCount,
        processed_count: processedCount,
        passed_count: passedCount,
        output_csv: mergedCsvPath,
        round_count: currentRoundCount(),
        current_round_index: roundIndex,
        checkpoint_path: checkpointPath || null,
        completion_reason: completionReason,
        target_count_semantics: "target_count means processed candidate count, not passed candidate count"
      },
      diagnostics: buildProgressDiagnostics({
        preflight,
        totalProcessedCount: processedCount,
        totalPassedCount: passedCount,
        roundCount: currentRoundCount(),
        extra: {
          output_csv: mergedCsvPath,
          checkpoint_path: checkpointPath || null,
          completion_reason: completionReason
        }
      })
    });
  }

  while (totalProcessedCount < initialTargetCount) {
    if (runtimeHooks.isPauseRequested()) {
      return buildPausedPartial({
        message: "已在新一轮开始前暂停招聘流水线。",
        completionReason: "paused_before_round_start"
      });
    }

    if (isAbortSignalTriggered(runtimeHooks.signal)) {
      return buildCanceledResponse({
        completionReason: "canceled_before_round_start"
      });
    }

    const roundIndex = pendingResumeRound?.round_index || nextRoundIndex;
    const remainingTargetCount = Math.max(0, initialTargetCount - totalProcessedCount);
    const baseRoundSearchParams = pendingResumeRound?.search_params && typeof pendingResumeRound.search_params === "object"
      ? pendingResumeRound.search_params
      : parsed.searchParams;
    const roundSearchParams = {
      ...parsed.searchParams,
      ...baseRoundSearchParams,
      filter_recent_viewed: roundIndex >= 2
        ? true
        : baseRoundSearchParams.filter_recent_viewed ?? parsed.searchParams.filter_recent_viewed
    };
    const roundScreenParams = {
      ...parsed.screenParams,
      target_count: remainingTargetCount
    };
    let roundState = updateRound(roundIndex, {
      state: pendingResumeRound?.state || "queued",
      completion_reason: pendingResumeRound?.completion_reason || null,
      search_params: roundSearchParams,
      search_completed: pendingResumeRound?.search_completed === true,
      candidate_count: pendingResumeRound?.candidate_count ?? null,
      checkpoint_path: pendingResumeRound?.checkpoint_path || null,
      screen_output_csv: pendingResumeRound?.screen_output_csv || null,
      auto_recovery_count: pendingResumeRound?.auto_recovery_count || 0,
      screen_processed_count: pendingResumeRound?.screen_processed_count ?? null,
      screen_passed_count: pendingResumeRound?.screen_passed_count ?? null
    });

    if (roundIndex > 1 || pendingResumeRound) {
      runtimeHooks.setStage("page_ready", `第 ${roundIndex} 轮：检查 search 页面就绪状态。`);
      runtimeHooks.heartbeat("page_ready", {
        round: roundIndex
      });
    }
    const pageCheck = roundIndex === 1 && !pendingResumeRound
      ? initialPageCheck
      : await ensureSearchPageReady(workspaceRoot, {
          port: preflight.debug_port
        });
    if (isAbortSignalTriggered(runtimeHooks.signal)) {
      return buildCanceledResponse({
        roundIndex,
        roundSearchParams,
        roundScreenParams,
        completionReason: "canceled_during_page_ready"
      });
    }
    if (!pageCheck.ok) {
      if (
        pageCheck.state === "LOGIN_REQUIRED"
        || pageCheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
      ) {
        return buildFailedResponse(
          "BOSS_LOGIN_REQUIRED",
          "Boss 页面未稳定停留在 search 页面，疑似未登录或登录态失效。请先在当前 Chrome 窗口手动登录 Boss，登录完成后再继续搜索和筛选。",
          {
            search_params: roundSearchParams,
            screen_params: roundScreenParams,
            diagnostics: buildProgressDiagnostics({
              preflight,
              totalProcessedCount,
              totalPassedCount,
              roundCount: currentRoundCount(),
              extra: {
                page_state: pageCheck.page_state
              }
            })
          }
        );
      }

      return buildFailedResponse(
        "BOSS_SEARCH_PAGE_NOT_READY",
        "无法确认 Boss search 页面已就绪。请先确保 Chrome 调试端口可连，并且页面能稳定停留在 https://www.zhipin.com/web/chat/search。",
        {
          search_params: roundSearchParams,
          screen_params: roundScreenParams,
          diagnostics: buildProgressDiagnostics({
            preflight,
            totalProcessedCount,
            totalPassedCount,
            roundCount: currentRoundCount(),
            extra: {
              page_state: pageCheck.page_state
            }
          })
        }
      );
    }

    const isResumeRun = resume?.resume === true;
    const resumeFromPausedBeforeScreen = (
      isResumeRun
      && pendingResumeRound?.round_index === roundIndex
      && resumeCompletionReason === "paused_before_screen"
    );
    let shouldRunSearch = true;
    if (
      pendingResumeRound?.round_index === roundIndex
      && isResumeRun
      && !resumeFromPausedBeforeScreen
      && roundState.search_completed === true
      && Boolean(normalizeText(roundState.checkpoint_path || ""))
    ) {
      shouldRunSearch = false;
    }

    let searchResult = null;
    if (shouldRunSearch) {
      ensurePipelineNotAborted(runtimeHooks.signal);
      runtimeHooks.setStage("search", `第 ${roundIndex} 轮：开始执行 search。`);
      runtimeHooks.heartbeat("search", {
        round: roundIndex
      });
      searchResult = await searchCli({
        workspaceRoot,
        searchParams: roundSearchParams,
        runtime: runtimeHooks.adapterRuntime("search")
      });
      if (isProcessAbortError(searchResult) || isAbortSignalTriggered(runtimeHooks.signal)) {
        return buildCanceledResponse({
          roundIndex,
          roundSearchParams,
          roundScreenParams,
          completionReason: "canceled_during_search"
        });
      }

      if (!searchResult.ok) {
        const failure = classifySearchFailure(searchResult);
        return buildFailedResponse(
          failure.code,
          failure.message,
          {
            search_params: roundSearchParams,
            screen_params: roundScreenParams,
            diagnostics: buildProgressDiagnostics({
              preflight,
              totalProcessedCount,
              totalPassedCount,
              roundCount: currentRoundCount(),
              extra: {
                exit_code: searchResult.exit_code,
                error_code: searchResult.error_code,
                stderr: searchResult.stderr?.slice(0, 1200)
              }
            })
          }
        );
      }

      if (!Number.isInteger(searchResult.candidate_count)) {
        return buildFailedResponse(
          "SEARCH_RESULT_UNVERIFIED",
          "搜索流程未能确认候选人数量，说明搜索步骤可能没有真正完成，已停止后续筛选。",
          {
            search_params: roundSearchParams,
            screen_params: roundScreenParams,
            diagnostics: buildProgressDiagnostics({
              preflight,
              totalProcessedCount,
              totalPassedCount,
              roundCount: currentRoundCount(),
              extra: {
                candidate_count: searchResult.candidate_count,
                stdout: searchResult.stdout?.slice(-1200),
                stderr: searchResult.stderr?.slice(-1200)
              }
            })
          }
        );
      }

      roundState = updateRound(roundIndex, {
        state: "search_completed",
        completion_reason: null,
        search_params: roundSearchParams,
        candidate_count: searchResult.candidate_count,
        search_completed: true
      });
    } else {
      runtimeHooks.setStage("search", `第 ${roundIndex} 轮：复用暂停前的 search 结果，直接恢复 screen。`);
      runtimeHooks.heartbeat("search", {
        round: roundIndex,
        resume: true,
        reused_search: true
      });
      searchResult = {
        ok: true,
        candidate_count: roundState.candidate_count,
        no_data_tip_present: false
      };
    }

    const exhaustedByTipNoData = searchResult?.no_data_tip_present === true;
    if (exhaustedByTipNoData || searchResult.candidate_count === 0) {
      updateRound(roundIndex, {
        state: "completed",
        completion_reason: "search_exhausted_no_candidates",
        search_completed: true,
        candidate_count: searchResult?.candidate_count ?? null
      });
      runtimeHooks.setStage("finalize", "候选池已耗尽，正在汇总结果。");
      runtimeHooks.heartbeat("finalize");
      runtimeHooks.progress("finalize", {
        processed: totalProcessedCount,
        passed: totalPassedCount,
        skipped: Math.max(totalProcessedCount - totalPassedCount, 0),
        greet_count: 0
      });
      const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const mergedCsvPath = mergeRoundCsvFiles(roundOutputCsvPaths);
      return {
        status: "COMPLETED",
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        result: {
          target_count: initialTargetCount,
          processed_count: totalProcessedCount,
          passed_count: totalPassedCount,
          duration_sec: durationSec,
          output_csv: mergedCsvPath,
          round_count: currentRoundCount(),
          completion_reason: "search_exhausted_no_candidates",
          exhausted_by_tip_nodata: exhaustedByTipNoData,
          target_count_semantics: "target_count means processed candidate count, not passed candidate count"
        },
        message: exhaustedByTipNoData
          ? "流水线已完成。检测到页面出现 tip-nodata（i.tip-nodata），判定候选池已耗尽并结束。"
          : "流水线已完成。累计处理人数未达到目标前，会自动重跑搜索和筛选；当新一轮搜索无可筛选人选时，按候选池耗尽结束。"
      };
    }

    if (runtimeHooks.isPauseRequested()) {
      return buildPausedPartial({
        message: "已在 screen 阶段开始前暂停招聘流水线。",
        roundIndex,
        roundSearchParams,
        roundScreenParams,
        outputCsv: normalizeCsvPath(roundState.screen_output_csv),
        checkpointPath: normalizeText(roundState.checkpoint_path || "") || null,
        completionReason: "paused_before_screen"
      });
    }

    let screenAutoRecoveryCount = Number.isInteger(roundState.auto_recovery_count)
      ? roundState.auto_recovery_count
      : 0;
    let lastAutoRecovery = null;
    let currentResumeConfig = {
      checkpoint_path: normalizeText(
        roundState.checkpoint_path
        || resume?.checkpoint_path
        || ""
      ) || null,
      pause_control_path: normalizeText(resume?.pause_control_path || "") || null,
      output_csv: normalizeCsvPath(roundState.screen_output_csv || resume?.output_csv),
      resume: Boolean(
        pendingResumeRound
        && isResumeRun
        && (
          normalizeText(roundState.checkpoint_path || "")
          || normalizeText(roundState.screen_output_csv || "")
        )
      ),
      require_checkpoint: Boolean(
        pendingResumeRound
        && isResumeRun
        && normalizeText(roundState.checkpoint_path || "")
        && !resumeFromPausedBeforeScreen
      ),
      round_index: roundIndex
    };

    while (true) {
      ensurePipelineNotAborted(runtimeHooks.signal);
      runtimeHooks.setStage(
        screenAutoRecoveryCount > 0 ? "screen_recovery" : "screen",
        screenAutoRecoveryCount > 0
          ? `第 ${roundIndex} 轮：screen 自动恢复第 ${screenAutoRecoveryCount} 次后继续执行。`
          : `第 ${roundIndex} 轮：开始执行 screen。`
      );
      runtimeHooks.heartbeat(screenAutoRecoveryCount > 0 ? "screen_recovery" : "screen", {
        round: roundIndex,
        ...(lastAutoRecovery || {})
      });
      const screenResult = await screenCli({
        workspaceRoot,
        screenParams: roundScreenParams,
        resume: currentResumeConfig,
        runtime: runtimeHooks.adapterRuntime("screen")
      });
      const summary = screenResult.summary || {};
      const roundOutputCsvPath = normalizeCsvPath(summary.output_csv || currentResumeConfig.output_csv);
      const checkpointPath = normalizeText(summary.checkpoint_path || currentResumeConfig.checkpoint_path || "") || null;
      const roundProcessedCount = Number.isInteger(summary.processed_count) ? summary.processed_count : 0;
      const roundPassedCount = Number.isInteger(summary.passed_count) && summary.passed_count >= 0
        ? summary.passed_count
        : 0;
      const delta = computeRoundDelta(pipelineContext, roundIndex, roundProcessedCount, roundPassedCount);

      if (isProcessAbortError(screenResult) || isAbortSignalTriggered(runtimeHooks.signal)) {
        return buildCanceledResponse({
          roundIndex,
          roundSearchParams,
          roundScreenParams,
          outputCsv: roundOutputCsvPath,
          roundProcessedCount,
          roundPassedCount,
          checkpointPath,
          completionReason: "canceled_during_screen"
        });
      }

      if (screenResult.paused) {
        return buildPausedPartial({
          message: "招聘流水线已暂停，可使用 resume_recruit_pipeline_run 继续。",
          roundIndex,
          roundSearchParams,
          roundScreenParams,
          outputCsv: roundOutputCsvPath,
          roundProcessedCount,
          roundPassedCount,
          checkpointPath,
          completionReason: normalizeText(summary.completion_reason || "paused") || "paused"
        });
      }

      const noProgress = !screenResult.ok
        ? false
        : !Number.isInteger(roundProcessedCount) || roundProcessedCount <= 0;
      const hasRecoveryBasis = Boolean(checkpointPath || roundOutputCsvPath || delta.previousProcessedCount > 0);

      if (!screenResult.ok || noProgress) {
        const failure = noProgress
          ? {
              code: "SCREEN_NO_PROGRESS",
              message: hasRecoveryBasis
                ? "本轮筛选未产生新的有效进度，将尝试自动恢复。"
                : "本轮搜索返回了可筛选候选人，但筛选流程未产生有效处理进度。",
              recoverable: hasRecoveryBasis
            }
          : classifyScreenFailure(screenResult);
        const recoverable = screenResult.error?.recoverable === true || failure.recoverable === true;
        updateRound(roundIndex, {
          state: recoverable ? "screen_recovery" : "failed",
          completion_reason: failure.code.toLowerCase(),
          search_params: roundSearchParams,
          search_completed: true,
          screen_output_csv: roundOutputCsvPath,
          checkpoint_path: checkpointPath,
          auto_recovery_count: screenAutoRecoveryCount,
          screen_processed_count: roundProcessedCount || delta.previousProcessedCount || null,
          screen_passed_count: roundPassedCount || delta.previousPassedCount || null
        });

        if (recoverable && screenAutoRecoveryCount < MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS) {
          screenAutoRecoveryCount += 1;
          lastAutoRecovery = {
            trigger: screenResult.error?.code || failure.code,
            attempt: screenAutoRecoveryCount,
            max_attempts: MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS
          };
          updateRound(roundIndex, {
            state: "screen_recovery",
            auto_recovery_count: screenAutoRecoveryCount,
            screen_output_csv: roundOutputCsvPath,
            checkpoint_path: checkpointPath,
            screen_processed_count: roundProcessedCount || delta.previousProcessedCount || null,
            screen_passed_count: roundPassedCount || delta.previousPassedCount || null
          });
          runtimeHooks.setStage(
            "screen_recovery",
            `第 ${roundIndex} 轮 screen 可恢复失败，开始自动恢复（第 ${screenAutoRecoveryCount} 次）。`
          );
          runtimeHooks.heartbeat("screen_recovery", {
            round: roundIndex,
            ...lastAutoRecovery
          });

          const recoveryPageCheck = await ensureSearchPageReady(workspaceRoot, {
            port: preflight.debug_port
          });
          if (!recoveryPageCheck.ok) {
            return buildFailedResponse(
              recoveryPageCheck.state === "LOGIN_REQUIRED" || recoveryPageCheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
                ? "BOSS_LOGIN_REQUIRED"
                : "BOSS_SEARCH_PAGE_NOT_READY",
              recoveryPageCheck.state === "LOGIN_REQUIRED" || recoveryPageCheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
                ? "自动恢复期间发现 Boss 登录态失效，请先重新登录后再继续。"
                : "自动恢复期间未能重新确认 Boss search 页面就绪。",
              {
                search_params: roundSearchParams,
                screen_params: roundScreenParams,
                diagnostics: buildProgressDiagnostics({
                  preflight,
                  totalProcessedCount,
                  totalPassedCount,
                  roundCount: currentRoundCount(),
                  extra: {
                    page_state: recoveryPageCheck.page_state,
                    auto_recovery: lastAutoRecovery
                  }
                })
              }
            );
          }

          const recoverySearch = await searchCli({
            workspaceRoot,
            searchParams: roundSearchParams,
            runtime: runtimeHooks.adapterRuntime("search")
          });
          if (!recoverySearch.ok || !Number.isInteger(recoverySearch.candidate_count)) {
            const recoveryFailure = classifySearchFailure(recoverySearch);
            return buildFailedResponse(
              recoveryFailure.code,
              `自动恢复期间重跑 search 失败：${recoveryFailure.message}`,
              {
                search_params: roundSearchParams,
                screen_params: roundScreenParams,
                diagnostics: buildProgressDiagnostics({
                  preflight,
                  totalProcessedCount,
                  totalPassedCount,
                  roundCount: currentRoundCount(),
                  extra: {
                    auto_recovery: lastAutoRecovery,
                    exit_code: recoverySearch.exit_code,
                    error_code: recoverySearch.error_code,
                    stderr: recoverySearch.stderr?.slice(-1200)
                  }
                })
              }
            );
          }

          roundState = updateRound(roundIndex, {
            state: "search_completed",
            search_params: roundSearchParams,
            candidate_count: recoverySearch.candidate_count,
            search_completed: true,
            checkpoint_path: checkpointPath,
            screen_output_csv: roundOutputCsvPath,
            auto_recovery_count: screenAutoRecoveryCount,
            screen_processed_count: roundProcessedCount || delta.previousProcessedCount || null,
            screen_passed_count: roundPassedCount || delta.previousPassedCount || null
          });
          currentResumeConfig = {
            checkpoint_path: checkpointPath,
            pause_control_path: currentResumeConfig.pause_control_path,
            output_csv: roundOutputCsvPath || currentResumeConfig.output_csv,
            resume: true,
            require_checkpoint: Boolean(checkpointPath),
            round_index: roundIndex
          };
          continue;
        }

        const mergedCsvPath = mergeRoundCsvFiles([
          ...roundOutputCsvPaths,
          ...(roundOutputCsvPath ? [roundOutputCsvPath] : [])
        ]);
        return buildFailedResponse(
          failure.code,
          failure.message,
          {
            search_params: roundSearchParams,
            screen_params: roundScreenParams,
            partial_result: {
              target_count: initialTargetCount,
              processed_count: totalProcessedCount + delta.processedDelta,
              passed_count: totalPassedCount + delta.passedDelta,
              output_csv: mergedCsvPath,
              round_count: currentRoundCount(),
              current_round_index: roundIndex,
              checkpoint_path: checkpointPath,
              completion_reason: failure.code.toLowerCase(),
              target_count_semantics: "target_count means processed candidate count, not passed candidate count"
            },
            diagnostics: buildProgressDiagnostics({
              preflight,
              totalProcessedCount,
              totalPassedCount,
              roundCount: currentRoundCount(),
              extra: {
                candidate_count: searchResult?.candidate_count ?? null,
                round_processed_count: roundProcessedCount || null,
                round_passed_count: roundPassedCount || null,
                round_output_csv: roundOutputCsvPath,
                checkpoint_path: checkpointPath,
                auto_recovery: lastAutoRecovery,
                exit_code: screenResult.exit_code,
                error_code: screenResult.error_code,
                stderr: screenResult.stderr?.slice(0, 1200)
              }
            })
          }
        );
      }

      if (roundOutputCsvPath && isReadableFile(roundOutputCsvPath)) {
        roundOutputCsvPaths = collectReadableCsvPaths([
          ...roundOutputCsvPaths,
          roundOutputCsvPath
        ]);
      }

      totalProcessedCount += delta.processedDelta;
      totalPassedCount += delta.passedDelta;
      roundState = updateRound(roundIndex, {
        state: "completed",
        completion_reason: "screen_completed",
        search_params: roundSearchParams,
        search_completed: true,
        candidate_count: searchResult?.candidate_count ?? roundState.candidate_count ?? null,
        screen_output_csv: roundOutputCsvPath,
        checkpoint_path: checkpointPath,
        auto_recovery_count: screenAutoRecoveryCount,
        screen_processed_count: roundProcessedCount,
        screen_passed_count: roundPassedCount
      });
      runtimeHooks.progress("screen", {
        processed: totalProcessedCount,
        passed: totalPassedCount,
        skipped: Math.max(totalProcessedCount - totalPassedCount, 0),
        greet_count: 0
      });
      break;
    }

    pendingResumeRound = null;
    nextRoundIndex = roundIndex + 1;
  }

  runtimeHooks.setStage("finalize", "筛选完成，正在汇总结果。");
  runtimeHooks.heartbeat("finalize");
  const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const mergedCsvPath = mergeRoundCsvFiles(roundOutputCsvPaths);
  runtimeHooks.progress("finalize", {
    processed: totalProcessedCount,
    passed: totalPassedCount,
    skipped: Math.max(totalProcessedCount - totalPassedCount, 0),
    greet_count: 0
  });
  return {
    status: "COMPLETED",
    search_params: parsed.searchParams,
    screen_params: parsed.screenParams,
    result: {
      target_count: initialTargetCount,
      processed_count: totalProcessedCount,
      passed_count: totalPassedCount,
      duration_sec: durationSec,
      output_csv: mergedCsvPath,
      round_count: currentRoundCount(),
      completion_reason: "processed_target_reached",
      target_count_semantics: "target_count means processed candidate count, not passed candidate count"
    },
    message: "流水线已完成。target_count 表示处理人数目标，而不是通过人数目标；当累计处理人数仍不足时会自动多轮执行，且从第2轮起会强制过滤近14天查看过的人选。"
  };
}
