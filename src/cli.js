import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.js";
import { runPipelinePreflight } from "./adapters.js";
import { runRecruitPipeline } from "./pipeline.js";

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const skillName = "boss-recruit-pipeline";
const skillSourceDir = path.join(packageRoot, "skills", skillName);
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");
const calibrationScriptPath = path.join(
  packageRoot,
  "vendor",
  "boss-screen-cli",
  "calibrate-favorite-position-v2.cjs"
);
const bossUrl = "https://www.zhipin.com/web/chat/search";
const CHROME_ONBOARDING_URL_PATTERN = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const SUPPORTED_MCP_CLIENTS = ["generic", "cursor", "trae", "claudecode", "openclaw"];
const DEFAULT_MCP_SERVER_NAME = "boss-recruit";
const DEFAULT_MCP_COMMAND = "npx";
const DEFAULT_MCP_ARGS = ["-y", "@reconcrap/boss-recruit-mcp@latest", "start"];
const AUTO_SYNC_SKIP_COMMANDS = new Set([
  "install",
  "install-skill",
  "where",
  "help",
  "--help",
  "-h"
]);

function getPackageVersion() {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback below.
  }
  return "0.0.0";
}

const packageVersion = getPackageVersion();

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function getUserConfigPath() {
  return path.join(getCodexHome(), "boss-recruit-mcp", "screening-config.json");
}

function getUserCalibrationPath() {
  return path.join(getCodexHome(), "boss-recruit-mcp", "favorite-calibration.json");
}

function getSkillTargetDir() {
  return path.join(getCodexHome(), "skills", skillName);
}

function getSkillVersionMarkerPath() {
  return path.join(getSkillTargetDir(), ".installed-version");
}

function readInstalledSkillVersion() {
  const markerPath = getSkillVersionMarkerPath();
  if (!fs.existsSync(markerPath)) return null;
  try {
    return fs.readFileSync(markerPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeInstalledSkillVersion(version) {
  const markerPath = getSkillVersionMarkerPath();
  ensureDir(path.dirname(markerPath));
  fs.writeFileSync(markerPath, `${version}\n`, "utf8");
}

function getChromeUserDataDir(port, options = {}) {
  const rawProvided = options.userDataDir ?? options["user-data-dir"];
  const provided = typeof rawProvided === "string" ? rawProvided.trim() : "";
  const basePath = provided || path.join(getCodexHome(), "boss-recruit-mcp", `chrome-profile-${port}`);
  const targetPath = path.resolve(basePath);
  ensureDir(targetPath);
  return targetPath;
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function parseJsonObjectOption(value, label) {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  const parsed = parseJsonOption(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseStringArrayOption(value, label) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const parsed = parseJsonOption(value, label);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a JSON string array`);
  }
  return parsed;
}

function normalizeMcpClientName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claudecode";
  return raw;
}

function parseMcpClientTargets(rawValue) {
  if (!rawValue) return SUPPORTED_MCP_CLIENTS.slice();
  const raw = String(rawValue).trim().toLowerCase();
  if (!raw || raw === "all") {
    return SUPPORTED_MCP_CLIENTS.slice();
  }
  const candidates = raw
    .split(",")
    .map((item) => normalizeMcpClientName(item))
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  const invalid = unique.filter((item) => !SUPPORTED_MCP_CLIENTS.includes(item));
  if (invalid.length) {
    throw new Error(
      `Unsupported --client value: ${invalid.join(", ")}. Supported: ${SUPPORTED_MCP_CLIENTS.join(", ")}`
    );
  }
  return unique;
}

function getAgentConfigOutputDir(options = {}) {
  if (typeof options["output-dir"] === "string" && options["output-dir"].trim()) {
    return path.resolve(options["output-dir"]);
  }
  return path.join(getCodexHome(), "boss-recruit-mcp", "agent-mcp-configs");
}

function buildMcpLaunchConfig(options = {}) {
  const command =
    typeof options.command === "string" && options.command.trim()
      ? options.command.trim()
      : DEFAULT_MCP_COMMAND;
  const args = parseStringArrayOption(options["args-json"], "args-json");
  const env = parseJsonObjectOption(options["env-json"], "env-json");
  const launchArgs = args.length
    ? args
    : command === "boss-recruit-mcp"
      ? ["start"]
      : DEFAULT_MCP_ARGS.slice();
  const launchConfig = {
    command,
    args: launchArgs
  };
  if (Object.keys(env).length > 0) {
    launchConfig.env = env;
  }
  return launchConfig;
}

function buildMcpConfigFileContent(options = {}) {
  const serverName =
    typeof options["server-name"] === "string" && options["server-name"].trim()
      ? options["server-name"].trim()
      : DEFAULT_MCP_SERVER_NAME;
  return {
    mcpServers: {
      [serverName]: buildMcpLaunchConfig(options)
    }
  };
}

function writeMcpConfigFiles(options = {}) {
  const clients = parseMcpClientTargets(options.client);
  const outputDir = getAgentConfigOutputDir(options);
  ensureDir(outputDir);
  const files = [];

  for (const client of clients) {
    const filePath = path.join(outputDir, `mcp.${client}.json`);
    const content = buildMcpConfigFileContent(options);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
    files.push({ client, file: filePath });
  }

  return { outputDir, files };
}

function readTextFile(filePath, label) {
  const resolved = path.resolve(String(filePath));
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${label} file: ${resolved}. ${error.message}`);
  }
}

function parseJsonOption(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const raw = String(value).replace(/^\uFEFF/, "").trim();
  const normalizedQuotes = raw
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");

  const candidates = [];
  const pushCandidate = (item) => {
    if (typeof item === "string" && item.trim()) {
      candidates.push(item.trim());
    }
  };

  pushCandidate(raw);
  if (normalizedQuotes !== raw) {
    pushCandidate(normalizedQuotes);
  }
  if (
    normalizedQuotes.length >= 2
    && normalizedQuotes.startsWith("'")
    && normalizedQuotes.endsWith("'")
  ) {
    pushCandidate(normalizedQuotes.slice(1, -1));
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
      try {
        const unwrapped = JSON.parse(candidate);
        if (typeof unwrapped === "string") {
          return JSON.parse(unwrapped);
        }
      } catch {
        // Continue trying next candidate.
      }
    }
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const hint = "Tip: in PowerShell prefer --*-file or wrap JSON with single quotes.";
    const reason = lastError?.message || error.message;
    throw new Error(`Invalid ${label} JSON: ${reason}. ${hint}`);
  }
}

function getRunInstruction(options) {
  if (typeof options.instruction === "string" && options.instruction.trim()) {
    return options.instruction.trim();
  }

  const instructionFile = options["instruction-file"];
  if (typeof instructionFile === "string" && instructionFile.trim()) {
    return readTextFile(instructionFile, "instruction").trim();
  }

  throw new Error("Missing required --instruction or --instruction-file");
}

function getRunConfirmation(options) {
  if (typeof options["confirmation-file"] === "string" && options["confirmation-file"].trim()) {
    return parseJsonOption(
      readTextFile(options["confirmation-file"], "confirmation"),
      "confirmation"
    );
  }

  return parseJsonOption(options["confirmation-json"], "confirmation");
}

function getRunOverrides(options) {
  if (typeof options["overrides-file"] === "string" && options["overrides-file"].trim()) {
    return parseJsonOption(
      readTextFile(options["overrides-file"], "overrides"),
      "overrides"
    );
  }

  return parseJsonOption(options["overrides-json"], "overrides");
}

function getWorkspaceRoot(options) {
  const raw = options["workspace-root"] || process.env.BOSS_WORKSPACE_ROOT || process.cwd();
  return path.resolve(String(raw));
}

function parsePositivePort(raw) {
  const port = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function getActiveScreenConfigPath(workspaceRoot) {
  const preflight = runPipelinePreflight(workspaceRoot);
  const screenConfigCheck = preflight.checks.find((item) => item.key === "screen_config");
  if (screenConfigCheck?.path) {
    return path.resolve(screenConfigCheck.path);
  }
  return getUserConfigPath();
}

function readJsonObjectFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config content must be a JSON object");
  }
  return parsed;
}

function readDebugPortFromConfigPath(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const parsed = readJsonObjectFile(configPath);
    return parsePositivePort(parsed.debugPort);
  } catch {
    return null;
  }
}

function persistDebugPortSelection(port, options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const configPath = getActiveScreenConfigPath(workspaceRoot);
  const existed = fs.existsSync(configPath);
  let config = {};

  if (existed) {
    config = readJsonObjectFile(configPath);
  }

  config.debugPort = port;
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  return {
    port,
    configPath,
    existed
  };
}

function applyExplicitPortSelection(options = {}, extras = {}) {
  const selected = parsePositivePort(options.port);
  if (!selected) return null;

  process.env.BOSS_RECRUIT_CHROME_PORT = String(selected);
  if (!extras.persist) return { port: selected, persisted: false };

  try {
    const persisted = persistDebugPortSelection(selected, options);
    return {
      port: selected,
      persisted: true,
      configPath: persisted.configPath
    };
  } catch (error) {
    return {
      port: selected,
      persisted: false,
      error: error.message
    };
  }
}

function setDebugPort(options = {}) {
  const selected = parsePositivePort(options.port);
  if (!selected) {
    throw new Error("Missing required --port <number> for set-port.");
  }

  process.env.BOSS_RECRUIT_CHROME_PORT = String(selected);
  const result = persistDebugPortSelection(selected, options);

  return {
    port: selected,
    configPath: result.configPath,
    existed: result.existed
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
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
    if (typeof tab?.url === "string" && CHROME_ONBOARDING_URL_PATTERN.test(tab.url)) {
      return tab.url;
    }
  }
  return null;
}

async function inspectBossPageState(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const expectedUrl = options.expectedUrl || bossUrl;
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
          message: "Boss 页面没有停留在 search 页面，通常表示需要重新登录。请用户手动登录 Boss 后再继续。"
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
      message: "Chrome 当前停留在登录/引导页，正在尝试自动拉回 Boss 搜索页。",
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
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(bossUrl)}`;
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

async function ensureBossSearchReady(port, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, options.attempts) : 4;
  const inspectTimeoutMs = Number.isFinite(options.inspectTimeoutMs) ? options.inspectTimeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 800;

  let pageState = await inspectBossPageState(port, { timeoutMs: inspectTimeoutMs, pollMs });
  if (pageState.state === "SEARCH_READY" || pageState.state === "LOGIN_REQUIRED") {
    return pageState;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (pageState.state === "DEBUG_PORT_UNREACHABLE") {
      await sleep(settleMs);
    } else {
      const openResult = await openBossSearchTab(port);
      if (openResult.ok) {
        console.log(
          `Requested Boss search tab via DevTools /json/new (${openResult.method}) [attempt ${attempt}/${attempts}]`
        );
      } else {
        console.log(
          `Could not request Boss search tab via DevTools /json/new [attempt ${attempt}/${attempts}]: ${openResult.error}`
        );
      }
      await sleep(settleMs);
    }

    pageState = await inspectBossPageState(port, { timeoutMs: inspectTimeoutMs, pollMs });
    if (pageState.state === "SEARCH_READY" || pageState.state === "LOGIN_REQUIRED") {
      return pageState;
    }
  }

  return pageState;
}

function hasModule(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function getDebugPort(options = {}) {
  const fromOption = parsePositivePort(options.port);
  if (fromOption) return fromOption;

  const fromEnv = parsePositivePort(process.env.BOSS_RECRUIT_CHROME_PORT);
  if (fromEnv) return fromEnv;

  const workspaceRoot = getWorkspaceRoot(options);
  const configPath = getActiveScreenConfigPath(workspaceRoot);
  const fromConfig = readDebugPortFromConfigPath(configPath);
  if (fromConfig) return fromConfig;

  return 9222;
}

function getCalibrationTimeoutMs(options = {}) {
  const raw = options["timeout-ms"] || options.timeoutMs || options.timeout || "60000";
  const timeout = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 60000;
  }
  return Math.max(5000, timeout);
}

function getChromeExecutable() {
  const candidates = [
    process.env.BOSS_RECRUIT_CHROME_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: packageRoot,
      stdio: "inherit",
      windowsHide: false,
      shell: false
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

function syncSkillAssets(options = {}) {
  const force = options.force === true;
  const targetDir = getSkillTargetDir();
  const skillEntry = path.join(targetDir, "SKILL.md");
  const installedVersion = readInstalledSkillVersion();
  const needsSync = force || !fs.existsSync(skillEntry) || installedVersion !== packageVersion;
  if (!needsSync) {
    return { targetDir, updated: false, installedVersion, packageVersion };
  }
  ensureDir(path.dirname(targetDir));
  fs.cpSync(skillSourceDir, targetDir, { recursive: true, force: true });
  writeInstalledSkillVersion(packageVersion);
  return { targetDir, updated: true, installedVersion, packageVersion };
}

function installSkill() {
  const result = syncSkillAssets({ force: true });
  return result.targetDir;
}

function ensureAssetsUpToDate(command) {
  if (AUTO_SYNC_SKIP_COMMANDS.has(command)) {
    return;
  }
  try {
    syncSkillAssets({ force: false });
  } catch {
    // Keep runtime commands stable even if asset sync fails.
  }
}

function ensureUserConfig() {
  const targetDir = path.join(getCodexHome(), "boss-recruit-mcp");
  const targetPath = getUserConfigPath();
  ensureDir(targetDir);
  if (!fs.existsSync(targetPath)) {
    const template = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
    template.outputDir = getDesktopDir();
    fs.writeFileSync(targetPath, JSON.stringify(template, null, 2), "utf8");
    return { path: targetPath, created: true };
  }
  return { path: targetPath, created: false };
}

async function printDoctor(options) {
  applyExplicitPortSelection(options, { persist: true });
  const port = getDebugPort(options);
  const workspaceRoot = getWorkspaceRoot(options);
  const checks = runPipelinePreflight(workspaceRoot).checks.slice();
  const pageState = await inspectBossPageState(port, { timeoutMs: 2000, pollMs: 500 });
  const userConfigPath = getUserConfigPath();
  checks.push({
    key: "user_config",
    ok: fs.existsSync(userConfigPath),
    path: userConfigPath,
    message: "用户配置不存在"
  });
  checks.push({
    key: "calibration_script",
    ok: fs.existsSync(calibrationScriptPath),
    path: calibrationScriptPath,
    message: "校准脚本不存在"
  });
  checks.push({
    key: "dependency_ws",
    ok: hasModule("ws"),
    path: "ws",
    message: "缺少 ws 依赖"
  });
  checks.push({
    key: "dependency_chrome_remote_interface",
    ok: hasModule("chrome-remote-interface"),
    path: "chrome-remote-interface",
    message: "缺少 chrome-remote-interface 依赖"
  });
  checks.push({
    key: "chrome_debug_port",
    ok: pageState.state !== "DEBUG_PORT_UNREACHABLE",
    path: `http://localhost:${port}`,
    message:
      pageState.state === "DEBUG_PORT_UNREACHABLE"
        ? `无法连接 Chrome 调试端口 ${port}`
        : `Chrome 调试端口 ${port} 可连接`
  });
  checks.push(pageState);
  console.log(JSON.stringify({ ok: checks.every((item) => item.ok), port, checks }, null, 2));
}

async function calibrate(options) {
  applyExplicitPortSelection(options, { persist: true });
  const port = getDebugPort(options);
  const output = options.output ? path.resolve(String(options.output)) : getUserCalibrationPath();
  const timeoutMs = getCalibrationTimeoutMs(options);

  console.log("Calibration checklist:");
  console.log("1. The tool will auto-open Boss search page now.");
  console.log("2. Open any candidate detail page in that Boss window.");
  console.log("3. Click favorite once, then click again to unfavorite.");
  console.log("4. Close the detail page.");
  console.log(`5. The calibration listener will wait for ${Math.round(timeoutMs / 1000)} seconds.`);
  console.log("");

  let launchResult = null;
  const preState = await inspectBossPageState(port, { timeoutMs: 2000, pollMs: 500 });
  if (preState.state === "DEBUG_PORT_UNREACHABLE") {
    launchResult = await launchChrome(options);
    if (process.exitCode && process.exitCode !== 0) {
      return;
    }
  } else {
    console.log(`Detected existing Chrome debug instance on port ${port}; calibration will reuse it.`);
    const pageState =
      preState.state === "SEARCH_READY"
        ? preState
        : await ensureBossSearchReady(port, { attempts: 4, inspectTimeoutMs: 6000, pollMs: 1000 });
    launchResult = {
      ok: pageState.state === "SEARCH_READY",
      state: pageState.state,
      pageState,
      reused_existing_instance: true
    };
  }

  if (launchResult?.state === "LOGIN_REQUIRED") {
    console.log("Boss page requires login. Please log in in the opened Chrome window, then complete the checklist within the listener window.");
  } else if (launchResult?.state === "SEARCH_READY") {
    console.log("Boss search page is ready. Start the checklist now.");
  } else {
    console.log("Proceeding with calibration listener. If no click is captured, retry after ensuring Boss search page is open.");
  }
  console.log("");

  const code = await runNodeScript(calibrationScriptPath, [
    "--port",
    String(port),
    "--output",
    output,
    "--timeout-ms",
    String(timeoutMs)
  ]);
  process.exitCode = code;
}

async function launchChrome(options) {
  applyExplicitPortSelection(options, { persist: true });
  const port = getDebugPort(options);
  const initialState = await inspectBossPageState(port, { timeoutMs: 2000, pollMs: 500 });
  let usedExistingInstance = initialState.state !== "DEBUG_PORT_UNREACHABLE";

  if (usedExistingInstance) {
    console.log(`Reusing existing Chrome debug instance on port ${port}`);

    if (initialState.state !== "SEARCH_READY") {
      const openResult = await openBossSearchTab(port);
      if (openResult.ok) {
        console.log(
          `Requested Boss search tab via DevTools /json/new (${openResult.method}) on port ${port}`
        );
      } else {
        console.log(
          `Could not request Boss search tab via DevTools /json/new: ${openResult.error}`
        );
      }
    }
  } else {
    const chromePath = getChromeExecutable();
    if (!chromePath) {
      console.error("Chrome executable not found. Set BOSS_RECRUIT_CHROME_PATH or install Google Chrome.");
      process.exitCode = 1;
      return { ok: false, state: "CHROME_NOT_FOUND" };
    }

    const userDataDir = getChromeUserDataDir(port, options);
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "about:blank"
    ];
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    console.log(`Chrome launched with remote debugging port ${port}`);
    console.log(`User data dir: ${userDataDir}`);
    console.log(`Target URL: ${bossUrl}`);
  }

  const pageState = await ensureBossSearchReady(port, { attempts: 6, inspectTimeoutMs: 6000, pollMs: 1000 });

  if (pageState.state === "SEARCH_READY") {
    console.log("Boss search page is ready.");
    console.log(`Current URL: ${pageState.current_url}`);
    return {
      ok: true,
      state: "SEARCH_READY",
      pageState,
      reused_existing_instance: usedExistingInstance
    };
  }

  if (pageState.state === "LOGIN_REQUIRED") {
    console.log("Boss page redirected away from search. Manual login is required.");
    console.log(`Current URL: ${pageState.current_url}`);
    console.log("Please log in to Boss manually in the opened Chrome window, then tell the AI agent to continue.");
    return {
      ok: false,
      state: "LOGIN_REQUIRED",
      pageState,
      reused_existing_instance: usedExistingInstance
    };
  }

  if (usedExistingInstance && pageState.state === "DEBUG_PORT_UNREACHABLE") {
    // Existing instance may have been closed while launching; surface it clearly.
    usedExistingInstance = false;
  }
  console.log(pageState.message);
  if (pageState.current_url) {
    console.log(`Current URL: ${pageState.current_url}`);
  }
  return {
    ok: false,
    state: pageState.state || "UNKNOWN",
    pageState,
    reused_existing_instance: usedExistingInstance
  };
}

function printHelp() {
  console.log("boss-recruit-mcp");
  console.log("");
  console.log("Usage:");
  console.log("  boss-recruit-mcp              Start the MCP server");
  console.log("  boss-recruit-mcp start        Start the MCP server");
  console.log("  boss-recruit-mcp run          Run the pipeline once via CLI and print JSON");
  console.log("  boss-recruit-mcp install      Install Codex skill and initialize user config");
  console.log("  boss-recruit-mcp install-skill Install only the Codex skill");
  console.log("  boss-recruit-mcp init-config  Create ~/.codex/boss-recruit-mcp/screening-config.json if missing");
  console.log("  boss-recruit-mcp set-port     Persist preferred Chrome debug port to active screening-config");
  console.log("  boss-recruit-mcp mcp-config   Generate MCP config JSON for Cursor/Trae/Claude Code/OpenClaw");
  console.log("  boss-recruit-mcp doctor       Check config, calibration, and runtime prerequisites");
  console.log("  boss-recruit-mcp calibrate    Auto-open Boss search page, then run favorite-button calibration");
  console.log("  boss-recruit-mcp launch-chrome Reuse existing Chrome debug instance when possible; otherwise launch one, open Boss search, and check login state");
  console.log("  boss-recruit-mcp where        Print installed package, skill, and config paths");
  console.log("");
  console.log("Run command:");
  console.log("  boss-recruit-mcp run --instruction \"找杭州本科做过推荐系统的人\" [--confirmation-json '{...}'] [--overrides-json '{...}']");
  console.log("  boss-recruit-mcp run --instruction-file request.txt [--confirmation-file confirmation.json] [--overrides-file overrides.json]");
  console.log("");
  console.log("Calibration command:");
  console.log("  boss-recruit-mcp calibrate --port 9222 [--timeout-ms 60000] [--output <path>]");
  console.log("");
  console.log("Port command:");
  console.log("  boss-recruit-mcp set-port --port 19222");
  console.log("");
  console.log("MCP config command:");
  console.log("  boss-recruit-mcp mcp-config --client cursor");
  console.log("  boss-recruit-mcp mcp-config --client all --output-dir <dir>");
  console.log("  boss-recruit-mcp mcp-config --client generic --command boss-recruit-mcp --args-json '[\"start\"]'");
}

function printPaths() {
  const codexHome = getCodexHome();
  console.log(`package_root=${packageRoot}`);
  console.log(`skill_source=${skillSourceDir}`);
  console.log(`codex_home=${codexHome}`);
  console.log(`skill_target=${path.join(codexHome, "skills", "boss-recruit-pipeline")}`);
  console.log(`config_target=${getUserConfigPath()}`);
  console.log(`calibration_target=${getUserCalibrationPath()}`);
  console.log(`desktop_output_default=${getDesktopDir()}`);
}

function printMcpConfig(options = {}) {
  const clients = parseMcpClientTargets(options.client);
  if (clients.length === 1 && !options["output-dir"]) {
    const config = buildMcpConfigFileContent(options);
    printJson(config);
    return;
  }

  const result = writeMcpConfigFiles(options);
  console.log(`MCP config templates exported to: ${result.outputDir}`);
  for (const item of result.files) {
    console.log(`- ${item.client}: ${item.file}`);
  }
  console.log("");
  console.log("Tip:");
  console.log("1. Choose the template file matching your AI client.");
  console.log("2. Merge its mcpServers block into that client's MCP config.");
}

function installAll() {
  const skillTarget = installSkill();
  const configResult = ensureUserConfig();
  const mcpTemplateResult = writeMcpConfigFiles({ client: "all" });
  console.log(`Skill installed to: ${skillTarget}`);
  if (configResult.created) {
    console.log(`Config template created at: ${configResult.path}`);
  } else {
    console.log(`Config already exists at: ${configResult.path}`);
  }
  console.log(`MCP config templates exported to: ${mcpTemplateResult.outputDir}`);
  for (const item of mcpTemplateResult.files) {
    console.log(`- ${item.client}: ${item.file}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("1. Fill in baseUrl/apiKey/model in the config file above.");
  console.log("2. Choose a client template from the exported MCP config files and merge it into your AI client config.");
  console.log("3. Choose a Chrome remote-debugging port (9222 is recommended, but you can reuse an existing port).");
  console.log("4. Run `boss-recruit-mcp set-port --port <your-port>` once to persist your chosen port for all later commands.");
  console.log("5. Run `boss-recruit-mcp doctor` (or `boss-recruit-mcp doctor --port <your-port>`) to verify config, calibration, and runtime prerequisites.");
  console.log("6. Run `boss-recruit-mcp launch-chrome` (or `--port <your-port>`); if it reports the page redirected away from search, log in to Boss manually in that Chrome window.");
  console.log("7. Run `boss-recruit-mcp calibrate` (or `--port <your-port>`) to generate favorite-calibration.json for this environment.");
  console.log("8. Run `boss-recruit-mcp start` or configure your MCP client to launch the command from the generated template.");
}

async function runPipelineOnce(options) {
  applyExplicitPortSelection(options, { persist: true });
  const instruction = getRunInstruction(options);
  const confirmation = getRunConfirmation(options);
  const overrides = getRunOverrides(options);
  const workspaceRoot = getWorkspaceRoot(options);

  const result = await runRecruitPipeline({
    workspaceRoot,
    instruction,
    confirmation,
    overrides
  });

  printJson(result);
}

const command = process.argv[2] || "start";
const options = parseOptions(process.argv.slice(3));
ensureAssetsUpToDate(command);

switch (command) {
  case "start":
    startServer();
    break;
  case "run":
    try {
      await runPipelineOnce(options);
    } catch (error) {
      printJson({
        status: "FAILED",
        error: {
          code: "INVALID_CLI_INPUT",
          message: error.message || "Invalid CLI input",
          retryable: false
        }
      });
      process.exitCode = 1;
    }
    break;
  case "install":
    installAll();
    break;
  case "install-skill":
    console.log(`Skill installed to: ${installSkill()}`);
    break;
  case "init-config": {
    const result = ensureUserConfig();
    console.log(
      result.created
        ? `Config template created at: ${result.path}`
        : `Config already exists at: ${result.path}`
    );
    break;
  }
  case "set-port": {
    try {
      const result = setDebugPort(options);
      console.log(`Preferred debug port saved: ${result.port}`);
      console.log(`Updated config: ${result.configPath}`);
      console.log("Port priority for runtime commands: --port > BOSS_RECRUIT_CHROME_PORT > screening-config.json.debugPort > 9222");
    } catch (error) {
      console.error(error.message || "Failed to persist debug port.");
      process.exitCode = 1;
    }
    break;
  }
  case "mcp-config":
    try {
      printMcpConfig(options);
    } catch (error) {
      console.error(error.message || "Failed to generate MCP config template.");
      process.exitCode = 1;
    }
    break;
  case "doctor":
    await printDoctor(options);
    break;
  case "calibrate":
    await calibrate(options);
    break;
  case "launch-chrome":
    await launchChrome(options);
    break;
  case "where":
    printPaths();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run `boss-recruit-mcp --help` for usage.");
    process.exitCode = 1;
}
