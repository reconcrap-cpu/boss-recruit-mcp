import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const currentFilePath = fileURLToPath(import.meta.url);
const packagedMcpDir = path.resolve(path.dirname(currentFilePath), "..");
const bossSearchUrl = "https://www.zhipin.com/web/chat/search";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getUserConfigPath() {
  return path.join(getCodexHome(), "boss-recruit-mcp", "screening-config.json");
}

function getUserCalibrationPath() {
  return path.join(getCodexHome(), "boss-recruit-mcp", "favorite-calibration.json");
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function resolveScreenConfigPath(workspaceRoot) {
  const envConfigPath = process.env.BOSS_RECRUIT_SCREEN_CONFIG
    ? path.resolve(process.env.BOSS_RECRUIT_SCREEN_CONFIG)
    : null;
  const workspaceConfigPath = path.join(workspaceRoot, "boss-recruit-mcp", "config", "screening-config.json");
  const userConfigPath = getUserConfigPath();
  const packagedConfigPath = path.join(packagedMcpDir, "config", "screening-config.json");
  const candidates = [
    envConfigPath,
    workspaceConfigPath,
    userConfigPath,
    packagedConfigPath
  ].filter(Boolean);

  return candidates.find((candidate) => pathExists(candidate)) || candidates[0];
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveSearchCliDir(workspaceRoot) {
  const localDir = path.join(workspaceRoot, "boss-search-cli");
  if (pathExists(localDir)) {
    return localDir;
  }
  const vendoredDir = path.join(packagedMcpDir, "vendor", "boss-search-cli");
  if (pathExists(vendoredDir)) {
    return vendoredDir;
  }
  return null;
}

function resolveScreenCliDir(workspaceRoot) {
  const localDir = path.join(workspaceRoot, "boss-screen-cli");
  if (pathExists(localDir)) {
    return localDir;
  }
  const vendoredDir = path.join(packagedMcpDir, "vendor", "boss-screen-cli");
  if (pathExists(vendoredDir)) {
    return vendoredDir;
  }
  return null;
}

function resolveScreenCliEntry(screenDir) {
  const candidates = [
    path.join(screenDir, "boss-screen-cli.js"),
    path.join(screenDir, "boss-screen-cli.cjs")
  ];
  return candidates.find((candidate) => pathExists(candidate)) || candidates[0];
}

function runProcess({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        env: process.env
      });
    } catch (error) {
      finish({
        code: -1,
        stdout,
        stderr: error.message,
        error_code: error.code || "SPAWN_FAILED"
      });
      return;
    }

    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({
          code: -1,
          stdout,
          stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms`.trim(),
          error_code: "TIMEOUT"
        });
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        error_code: error.code || "SPAWN_FAILED"
      });
    });
  });
}

function parseSearchCount(output) {
  const m = output.match(/找到\s*(\d+)\s*个候选人/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

function parseScreenSummary(output) {
  const processed = output.match(/已处理:\s*(\d+)\s*人/);
  const passed = output.match(/通过筛选:\s*(\d+)\s*人/);
  const target = output.match(/目标(?:处理)?人数:\s*(\d+)\s*人/);
  const csv = output.match(/结果已导出到:\s*(.+)/);

  return {
    processed_count: processed ? Number.parseInt(processed[1], 10) : null,
    passed_count: passed ? Number.parseInt(passed[1], 10) : null,
    target_count: target ? Number.parseInt(target[1], 10) : null,
    output_csv: csv ? csv[1].trim() : null
  };
}

function loadScreenConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      error: `Screen config file not found: ${configPath}`
    };
  }
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed.baseUrl || !parsed.apiKey || !parsed.model) {
      return {
        ok: false,
        error: "Invalid screen config: baseUrl/apiKey/model are required"
      };
    }
    return { ok: true, config: parsed };
  } catch (error) {
    return { ok: false, error: `Failed to read screen config: ${error.message}` };
  }
}

function readScreenConfigJson(configPath) {
  if (!pathExists(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveDebugPortFromConfigPath(configPath) {
  const parsed = readScreenConfigJson(configPath);
  const fromConfig = parsePositiveInteger(parsed?.debugPort);
  if (fromConfig) return fromConfig;
  return null;
}

function resolveWorkspaceDebugPort(workspaceRoot) {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECRUIT_CHROME_PORT);
  if (fromEnv) return fromEnv;

  const configPath = resolveScreenConfigPath(workspaceRoot);
  const fromConfig = resolveDebugPortFromConfigPath(configPath);
  if (fromConfig) return fromConfig;

  return 9222;
}

export function runPipelinePreflight(workspaceRoot) {
  const searchDir = resolveSearchCliDir(workspaceRoot);
  const screenDir = resolveScreenCliDir(workspaceRoot);
  const screenConfigPath = resolveScreenConfigPath(workspaceRoot);
  const rawConfig = readScreenConfigJson(screenConfigPath);
  const debugPort = resolveWorkspaceDebugPort(workspaceRoot);
  const calibrationPath = rawConfig?.calibrationFile
    ? path.resolve(path.dirname(screenConfigPath), rawConfig.calibrationFile)
    : getUserCalibrationPath();
  const checks = [
    {
      key: "search_cli_dir",
      ok: Boolean(searchDir && pathExists(searchDir)),
      path: searchDir || localDirHint(workspaceRoot, "boss-search-cli"),
      message: "boss-search-cli 目录不存在"
    },
    {
      key: "search_cli_entry",
      ok: Boolean(searchDir && pathExists(path.join(searchDir, "src", "cli.js"))),
      path: searchDir ? path.join(searchDir, "src", "cli.js") : path.join(localDirHint(workspaceRoot, "boss-search-cli"), "src", "cli.js"),
      message: "boss-search-cli 入口文件缺失"
    },
    {
      key: "screen_cli_dir",
      ok: Boolean(screenDir && pathExists(screenDir)),
      path: screenDir || localDirHint(workspaceRoot, "boss-screen-cli"),
      message: "boss-screen-cli 目录不存在"
    },
    {
      key: "screen_cli_entry",
      ok: Boolean(screenDir && pathExists(resolveScreenCliEntry(screenDir))),
      path: screenDir ? resolveScreenCliEntry(screenDir) : path.join(localDirHint(workspaceRoot, "boss-screen-cli"), "boss-screen-cli.js"),
      message: "boss-screen-cli 入口文件缺失"
    },
    {
      key: "screen_config",
      ok: pathExists(screenConfigPath),
      path: screenConfigPath,
      message: "screening-config.json 不存在"
    },
    {
      key: "favorite_calibration",
      ok: pathExists(calibrationPath),
      path: calibrationPath,
      optional: true,
      message: "favorite-calibration.json 不存在（可选，仅在旧页面回退点击时需要）"
    }
  ];

  const requiredCheckKeys = new Set([
    "search_cli_dir",
    "search_cli_entry",
    "screen_cli_dir",
    "screen_cli_entry",
    "screen_config"
  ]);

  return {
    ok: checks.every((item) => !requiredCheckKeys.has(item.key) || item.ok),
    checks,
    debug_port: debugPort,
    calibration_path: calibrationPath
  };
}

function localDirHint(workspaceRoot, dirName) {
  return path.join(workspaceRoot, dirName);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listChromeTabs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function buildBossPageState(payload) {
  return {
    key: "boss_page_state",
    ...payload
  };
}

function extractSampleUrls(tabs, limit = 5) {
  return tabs
    .map((tab) => tab?.url)
    .filter(Boolean)
    .slice(0, limit);
}

function findChromeOnboardingUrl(tabs) {
  for (const tab of tabs) {
    if (typeof tab?.url === "string" && chromeOnboardingUrlPattern.test(tab.url)) {
      return tab.url;
    }
  }
  return null;
}

async function inspectBossPageState(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const expectedUrl = options.expectedUrl || bossSearchUrl;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastTabs = [];

  while (Date.now() < deadline) {
    try {
      const tabs = await listChromeTabs(port);
      lastTabs = tabs;

      const exactSearchTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("/web/chat/search")
      );
      if (exactSearchTab) {
        return buildBossPageState({
          ok: true,
          state: "SEARCH_READY",
          path: exactSearchTab.url,
          current_url: exactSearchTab.url,
          title: exactSearchTab.title || null,
          requires_login: false,
          message: "Boss 搜索页已打开，且当前仍停留在 search 页面。"
        });
      }

      const bossTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")
      );
      if (bossTab) {
        return buildBossPageState({
          ok: false,
          state: "LOGIN_REQUIRED",
          path: bossTab.url,
          current_url: bossTab.url,
          title: bossTab.title || null,
          requires_login: true,
          expected_url: expectedUrl,
          message: "Boss 页面没有停留在 search 页面，通常表示需要重新登录。请手动登录 Boss 后再继续。"
        });
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(pollMs);
  }

  if (lastError) {
    return buildBossPageState({
      ok: false,
      state: "DEBUG_PORT_UNREACHABLE",
      path: `http://127.0.0.1:${port}`,
      current_url: null,
      title: null,
      requires_login: false,
      expected_url: expectedUrl,
      message: `无法连接到 Chrome DevTools 端口 ${port}。请确认 Chrome 已以远程调试模式启动。`,
      error: lastError.message
    });
  }

  const onboardingUrl = findChromeOnboardingUrl(lastTabs);
  if (onboardingUrl) {
    return buildBossPageState({
      ok: false,
      state: "CHROME_ONBOARDING_INTERCEPTED",
      path: onboardingUrl,
      current_url: onboardingUrl,
      title: null,
      requires_login: false,
      expected_url: expectedUrl,
      message: "Chrome 当前停留在登录/引导页，尚未稳定到 Boss 搜索页。",
      sample_urls: extractSampleUrls(lastTabs)
    });
  }

  return buildBossPageState({
    ok: false,
    state: "BOSS_TAB_NOT_FOUND",
    path: expectedUrl,
    current_url: null,
    title: null,
    requires_login: false,
    expected_url: expectedUrl,
    message: "未检测到 Boss 页面标签页。请确认 Chrome 已打开 Boss 搜索页。",
    sample_urls: extractSampleUrls(lastTabs)
  });
}

async function openBossSearchTab(port) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(bossSearchUrl)}`;
  const attempts = ["PUT", "GET"];
  let lastError = null;

  for (const method of attempts) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        return { ok: true, method };
      }
      lastError = new Error(`DevTools /json/new returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: lastError?.message || "Failed to open Boss search tab via DevTools /json/new"
  };
}

async function verifySearchPageStable(port, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1500;
  const recheckTimeoutMs = Number.isFinite(options.recheckTimeoutMs) ? options.recheckTimeoutMs : 2500;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 600;

  await sleep(settleMs);
  const recheck = await inspectBossPageState(port, { timeoutMs: recheckTimeoutMs, pollMs });
  if (recheck.state === "SEARCH_READY") {
    return recheck;
  }
  if (recheck.state === "LOGIN_REQUIRED") {
    return buildBossPageState({
      ...recheck,
      state: "LOGIN_REQUIRED_AFTER_REDIRECT",
      message: "Boss 页面曾进入 search 但随后跳转到其他页面，通常表示登录态失效。请先手动登录后再继续搜索和筛选。"
    });
  }
  return recheck;
}

export async function ensureBossSearchPageReady(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, options.attempts) : 3;
  const inspectTimeoutMs = Number.isFinite(options.inspectTimeoutMs) ? options.inspectTimeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 800;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 800;

  let pageState = await inspectBossPageState(debugPort, { timeoutMs: inspectTimeoutMs, pollMs });
  if (pageState.state === "SEARCH_READY") {
    const stableState = await verifySearchPageStable(debugPort, { settleMs, pollMs });
    return {
      ok: stableState.state === "SEARCH_READY",
      debug_port: debugPort,
      state: stableState.state,
      page_state: stableState
    };
  }
  if (pageState.state === "LOGIN_REQUIRED") {
    return {
      ok: false,
      debug_port: debugPort,
      state: pageState.state,
      page_state: pageState
    };
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (pageState.state === "DEBUG_PORT_UNREACHABLE") {
      break;
    }
    await openBossSearchTab(debugPort);
    await sleep(settleMs);
    pageState = await inspectBossPageState(debugPort, { timeoutMs: inspectTimeoutMs, pollMs });
    if (pageState.state === "SEARCH_READY") {
      const stableState = await verifySearchPageStable(debugPort, { settleMs, pollMs });
      return {
        ok: stableState.state === "SEARCH_READY",
        debug_port: debugPort,
        state: stableState.state,
        page_state: stableState
      };
    }
    if (pageState.state === "LOGIN_REQUIRED") {
      return {
        ok: false,
        debug_port: debugPort,
        state: pageState.state,
        page_state: pageState
      };
    }
  }

  return {
    ok: false,
    debug_port: debugPort,
    state: pageState.state || "UNKNOWN",
    page_state: pageState
  };
}

export async function runSearchCli({ workspaceRoot, searchParams }) {
  const searchDir = resolveSearchCliDir(workspaceRoot);
  const debugPort = resolveWorkspaceDebugPort(workspaceRoot);
  if (!searchDir) {
    return {
      ok: false,
      exit_code: -1,
      candidate_count: null,
      stdout: "",
      stderr: "boss-search-cli package not found",
      error_code: "ENOENT"
    };
  }
  const cliPath = path.join(searchDir, "src", "cli.js");
  const args = [
    cliPath,
    "--keywords",
    searchParams.keyword,
    "--degree",
    searchParams.degree,
    "--schools",
    searchParams.schools.join(","),
    "--city",
    searchParams.city,
    "--port",
    String(debugPort)
  ];

  if (typeof searchParams.filter_recent_viewed === "boolean") {
    args.push("--filter-recent-viewed", String(searchParams.filter_recent_viewed));
  }

  const result = await runProcess({
    command: "node",
    args,
    cwd: searchDir,
    timeoutMs: 180000
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const candidateCount = parseSearchCount(combined);

  return {
    ok: result.code === 0,
    exit_code: result.code,
    candidate_count: candidateCount,
    stdout: result.stdout,
    stderr: result.stderr,
    error_code: result.error_code || null
  };
}

export async function runScreenCli({ workspaceRoot, screenParams }) {
  const screenDir = resolveScreenCliDir(workspaceRoot);
  if (!screenDir) {
    return {
      ok: false,
      exit_code: -1,
      summary: null,
      stdout: "",
      stderr: "boss-screen-cli package not found",
      error_code: "ENOENT"
    };
  }
  const cliPath = resolveScreenCliEntry(screenDir);

  const configPath = resolveScreenConfigPath(workspaceRoot);
  const configBaseDir = path.dirname(configPath);
  const loaded = loadScreenConfig(configPath);
  if (!loaded.ok) {
    return {
      ok: false,
      config_error: true,
      exit_code: -1,
      stdout: "",
      stderr: loaded.error,
      error_code: "INVALID_SCREEN_CONFIG"
    };
  }

  const calibration = loaded.config.calibrationFile
    ? path.resolve(configBaseDir, loaded.config.calibrationFile)
    : getUserCalibrationPath();
  const debugPort = resolveWorkspaceDebugPort(workspaceRoot);

  const outputName = `筛选结果_${Date.now()}.csv`;
  let outputPath = outputName;
  if (loaded.config.outputDir) {
    const resolvedOutputDir = path.resolve(configBaseDir, loaded.config.outputDir);
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    outputPath = path.join(resolvedOutputDir, outputName);
  } else {
    const desktopDir = getDesktopDir();
    fs.mkdirSync(desktopDir, { recursive: true });
    outputPath = path.join(desktopDir, outputName);
  }

  const args = [
    cliPath,
    "--baseurl",
    loaded.config.baseUrl,
    "--apikey",
    loaded.config.apiKey,
    "--model",
    loaded.config.model,
    "--port",
    String(debugPort),
    "--criteria",
    screenParams.criteria,
    "--targetCount",
    String(screenParams.target_count),
    "--config",
    calibration,
    "--output",
    outputPath
  ];

  const result = await runProcess({
    command: "node",
    args,
    cwd: screenDir
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const summary = parseScreenSummary(combined);

  return {
    ok: result.code === 0,
    exit_code: result.code,
    summary,
    stdout: result.stdout,
    stderr: result.stderr,
    error_code: result.error_code || null
  };
}
