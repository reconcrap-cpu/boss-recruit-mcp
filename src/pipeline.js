import fs from "node:fs";
import path from "node:path";
import { parseRecruitInstruction } from "./parser.js";
import {
  ensureBossSearchPageReady,
  runPipelinePreflight,
  runSearchCli,
  runScreenCli
} from "./adapters.js";

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

const defaultDependencies = {
  parseRecruitInstruction,
  ensureBossSearchPageReady,
  runPipelinePreflight,
  runSearchCli,
  runScreenCli
};

export async function runRecruitPipeline({
  workspaceRoot,
  instruction,
  confirmation,
  overrides
}, dependencies = defaultDependencies) {
  const {
    parseRecruitInstruction: parseInstruction,
    ensureBossSearchPageReady: ensureSearchPageReady,
    runPipelinePreflight: runPreflight,
    runSearchCli: searchCli,
    runScreenCli: screenCli
  } = dependencies;
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

  const preflight = runPreflight(workspaceRoot);
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

  let totalProcessedCount = 0;
  let totalPassedCount = 0;
  let roundCount = 0;
  const roundOutputCsvPaths = [];

  while (totalProcessedCount < initialTargetCount) {
    roundCount += 1;

    const remainingTargetCount = Math.max(0, initialTargetCount - totalProcessedCount);
    const roundSearchParams = {
      ...parsed.searchParams,
      filter_recent_viewed: roundCount >= 2 ? true : parsed.searchParams.filter_recent_viewed
    };
    const roundScreenParams = {
      ...parsed.screenParams,
      target_count: remainingTargetCount
    };

    const pageCheck = await ensureSearchPageReady(workspaceRoot, {
      port: preflight.debug_port
    });
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
              roundCount,
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
            roundCount,
            extra: {
              page_state: pageCheck.page_state
            }
          })
        }
      );
    }

    const searchResult = await searchCli({
      workspaceRoot,
      searchParams: roundSearchParams
    });

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
            roundCount,
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
            roundCount,
            extra: {
              candidate_count: searchResult.candidate_count,
              stdout: searchResult.stdout?.slice(-1200),
              stderr: searchResult.stderr?.slice(-1200)
            }
          })
        }
      );
    }

    if (searchResult.candidate_count === 0) {
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
          round_count: roundCount,
          completion_reason: "search_exhausted_no_candidates",
          target_count_semantics: "target_count means processed candidate count, not passed candidate count"
        },
        message: "流水线已完成。累计处理人数未达到目标前，会自动重跑搜索和筛选；当新一轮搜索无可筛选人选时，按候选池耗尽结束。"
      };
    }

    const screenResult = await screenCli({
      workspaceRoot,
      screenParams: roundScreenParams
    });

    if (!screenResult.ok) {
      const failure = classifyScreenFailure(screenResult);
      return buildFailedResponse(failure.code, failure.message, {
        search_params: roundSearchParams,
        screen_params: roundScreenParams,
        diagnostics: buildProgressDiagnostics({
          preflight,
          totalProcessedCount,
          totalPassedCount,
          roundCount,
          extra: {
            exit_code: screenResult.exit_code,
            error_code: screenResult.error_code,
            stderr: screenResult.stderr?.slice(0, 1200)
          }
        })
      });
    }

    const summary = screenResult.summary || {};
    const roundOutputCsvPath = normalizeCsvPath(summary.output_csv);
    const roundProcessedCount = summary.processed_count;

    if (!Number.isInteger(roundProcessedCount) || roundProcessedCount <= 0) {
      const mergedCsvPath = mergeRoundCsvFiles([
        ...roundOutputCsvPaths,
        roundOutputCsvPath
      ]);
      return buildFailedResponse(
        "SCREEN_NO_PROGRESS",
        "本轮搜索返回了可筛选候选人，但筛选流程未产生有效处理进度。已先导出当前累计 CSV 结果，请检查页面状态或筛选工具日志后重试。",
        {
          search_params: roundSearchParams,
          screen_params: roundScreenParams,
          diagnostics: buildProgressDiagnostics({
            preflight,
            totalProcessedCount,
            totalPassedCount,
            roundCount,
            extra: {
              candidate_count: searchResult.candidate_count,
              round_processed_count: roundProcessedCount ?? null,
              round_passed_count: summary.passed_count ?? null,
              round_output_csv: roundOutputCsvPath,
              output_csv: mergedCsvPath
            }
          })
        }
      );
    }

    if (roundOutputCsvPath && isReadableFile(roundOutputCsvPath)) {
      roundOutputCsvPaths.push(roundOutputCsvPath);
    }

    const roundPassedCount =
      Number.isInteger(summary.passed_count) && summary.passed_count >= 0
        ? summary.passed_count
        : 0;
    totalProcessedCount += roundProcessedCount;
    totalPassedCount += roundPassedCount;
  }

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
      round_count: roundCount,
      completion_reason: "processed_target_reached",
      target_count_semantics: "target_count means processed candidate count, not passed candidate count"
    },
    message: "流水线已完成。target_count 表示处理人数目标，而不是通过人数目标；当累计处理人数仍不足时会自动多轮执行，且从第2轮起会强制过滤近14天查看过的人选。"
  };
}
