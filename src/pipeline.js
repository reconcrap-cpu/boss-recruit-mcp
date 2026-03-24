import { parseRecruitInstruction } from "./parser.js";
import { runPipelinePreflight, runSearchCli, runScreenCli } from "./adapters.js";

function buildNeedInputResponse(parsedResult) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsedResult.missing_fields,
    search_params: parsedResult.searchParams,
    screen_params: parsedResult.screenParams,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段，请一次性补充缺失项后再执行。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsedResult) {
  return {
    status: "NEED_CONFIRMATION",
    proposed_keyword: parsedResult.proposed_keyword,
    search_params: {
      ...parsedResult.searchParams,
      keyword: parsedResult.proposed_keyword
    },
    screen_params: parsedResult.screenParams
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

  if (parsed.needs_keyword_confirmation) {
    return buildNeedConfirmationResponse(parsed);
  }

  if (parsed.missing_fields.length > 0) {
    return buildNeedInputResponse(parsed);
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
          checks: preflight.checks
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
      output_csv: summary.output_csv
    }
  };
}
