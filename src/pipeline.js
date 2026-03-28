import { parseRecruitInstruction } from "./parser.js";
import { runPipelinePreflight, runSearchCli, runScreenCli } from "./adapters.js";

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
  const stderr = screenResult.stderr || "";
  const errorCode = screenResult.error_code || "";

  if (screenResult.config_error) {
    return {
      code: "SCREEN_CONFIG_ERROR",
      message: "筛选工具配置缺失或格式错误，请检查 screening-config.json。"
    };
  }

  if (errorCode === "EPERM" || /spawn EPERM/i.test(stderr)) {
    return {
      code: "SCREEN_PROCESS_PERMISSION_DENIED",
      message: "筛选工具无法启动子进程，当前运行环境拒绝了进程创建权限。请在本地终端直接运行 MCP 或放宽运行权限后重试。"
    };
  }

  if (errorCode === "TIMEOUT" || /timed out/i.test(stderr)) {
    return {
      code: "SCREEN_TIMEOUT",
      message: "筛选工具执行超时，可能是 Boss 页面交互卡住、LLM 接口响应过慢，或候选人列表处理速度异常。"
    };
  }

  if (errorCode === "ENOENT" || /not recognized|Cannot find|MODULE_NOT_FOUND/i.test(stderr)) {
    return {
      code: "SCREEN_CLI_MISSING",
      message: "筛选工具入口不存在或 Node 环境不可用，请检查 boss-screen-cli 安装与路径配置。"
    };
  }

  if (/DOM收藏不可用且缺少可用校准文件/i.test(stderr)) {
    return {
      code: "CALIBRATION_REQUIRED",
      message: "当前页面无法通过DOM按钮完成收藏，且缺少可用的收藏校准文件用于回退点击。请运行 boss-recruit-mcp calibrate 生成 favorite-calibration.json 后重试。"
    };
  }

  return {
    code: "SCREEN_CLI_FAILED",
    message: "筛选工具执行失败，请检查模型配置、Chrome 远程调试和页面状态。"
  };
}

export async function runRecruitPipeline({
  workspaceRoot,
  instruction,
  confirmation,
  overrides
}) {
  const startedAt = Date.now();
  const parsed = parseRecruitInstruction({
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

  const preflight = runPipelinePreflight(workspaceRoot);
  if (!preflight.ok) {
    return buildFailedResponse(
      "PIPELINE_PREFLIGHT_FAILED",
      "招聘流水线运行前检查失败，请先修复缺失的本地依赖或配置文件。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          checks: preflight.checks,
          debug_port: preflight.debug_port,
          calibration_path: preflight.calibration_path
        }
      }
    );
  }

  const searchResult = await runSearchCli({
    workspaceRoot,
    searchParams: parsed.searchParams
  });

  if (!searchResult.ok) {
    const failure = classifySearchFailure(searchResult);
    return buildFailedResponse(
      failure.code,
      failure.message,
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          exit_code: searchResult.exit_code,
          error_code: searchResult.error_code,
          stderr: searchResult.stderr?.slice(0, 1200)
        }
      }
    );
  }

  if (!Number.isInteger(searchResult.candidate_count)) {
    return buildFailedResponse(
      "SEARCH_RESULT_UNVERIFIED",
      "搜索流程未能确认候选人数量，说明搜索步骤可能没有真正完成，已停止后续筛选。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          candidate_count: searchResult.candidate_count,
          stdout: searchResult.stdout?.slice(-1200),
          stderr: searchResult.stderr?.slice(-1200)
        }
      }
    );
  }

  if (searchResult.candidate_count === 0) {
    return buildFailedResponse(
      "SEARCH_EMPTY_RESULT",
      "搜索结果为空，已停止后续筛选。请调整搜索条件后重试。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          candidate_count: 0
        }
      }
    );
  }

  const screenResult = await runScreenCli({
    workspaceRoot,
    screenParams: parsed.screenParams
  });

  if (!screenResult.ok) {
    const failure = classifyScreenFailure(screenResult);
    return buildFailedResponse(failure.code, failure.message, {
      search_params: parsed.searchParams,
      screen_params: parsed.screenParams,
      diagnostics: {
        exit_code: screenResult.exit_code,
        error_code: screenResult.error_code,
        stderr: screenResult.stderr?.slice(0, 1200)
      }
    });
  }

  const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const summary = screenResult.summary || {};
  return {
    status: "COMPLETED",
    search_params: parsed.searchParams,
    screen_params: parsed.screenParams,
    result: {
      target_count: summary.target_count ?? parsed.screenParams.target_count,
      processed_count: summary.processed_count ?? null,
      passed_count: summary.passed_count ?? null,
      duration_sec: durationSec,
      output_csv: summary.output_csv,
      completion_reason: "processed_target_reached",
      target_count_semantics: "target_count means processed candidate count, not passed candidate count"
    },
    message: "流水线已完成。target_count 表示处理人数目标，而不是通过人数目标；即使通过人数小于 target_count，只要已处理达到目标人数，也应视为本轮完成。"
  };
}
