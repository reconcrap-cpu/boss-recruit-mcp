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
const skillSourceDir = path.join(packageRoot, "skills", "boss-recruit-pipeline");
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");
const calibrationScriptPath = path.join(
  packageRoot,
  "vendor",
  "boss-screen-cli",
  "calibrate-favorite-position-v2.cjs"
);
const bossUrl = "https://www.zhipin.com/web/chat/search";
const SUPPORTED_MCP_CLIENTS = ["generic", "cursor", "trae", "claudecode", "openclaw"];
const DEFAULT_MCP_SERVER_NAME = "boss-recruit";
const DEFAULT_MCP_COMMAND = "npx";
const DEFAULT_MCP_ARGS = ["-y", "@reconcrap/boss-recruit-mcp@latest", "start"];

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

  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
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

  return buildBossPageState({
    ok: false,
    state: "BOSS_TAB_NOT_FOUND",
    path: expectedUrl,
    current_url: null,
    title: null,
    requires_login: false,
    expected_url: expectedUrl,
    message: "未检测到 Boss 页面标签页。请确认 Chrome 已打开 Boss 搜索页。",
    sample_urls: lastTabs
      .map((tab) => tab?.url)
      .filter(Boolean)
      .slice(0, 5)
  });
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
  const raw = options.port || process.env.BOSS_RECRUIT_CHROME_PORT || "9222";
  const port = Number.parseInt(String(raw), 10);
  return Number.isFinite(port) && port > 0 ? port : 9222;
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

function installSkill() {
  const codexHome = getCodexHome();
  const targetDir = path.join(codexHome, "skills", "boss-recruit-pipeline");
  ensureDir(path.dirname(targetDir));
  fs.cpSync(skillSourceDir, targetDir, { recursive: true, force: true });
  return targetDir;
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
  const port = getDebugPort(options);
  const checks = runPipelinePreflight(process.cwd()).checks.slice();
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
  const port = getDebugPort(options);
  const output = options.output ? path.resolve(String(options.output)) : getUserCalibrationPath();
  console.log("Before calibration:");
  console.log("1. Open Boss search page.");
  console.log("2. Open any candidate detail page.");
  console.log("3. Click the favorite button once.");
  console.log("4. Click again to cancel favorite for that candidate.");
  console.log("5. Close the detail page after calibration completes.");
  console.log("");
  const code = await runNodeScript(calibrationScriptPath, [
    "--port",
    String(port),
    "--output",
    output
  ]);
  process.exitCode = code;
}

async function launchChrome(options) {
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    console.error("Chrome executable not found. Set BOSS_RECRUIT_CHROME_PATH or install Google Chrome.");
    process.exitCode = 1;
    return;
  }
  const port = getDebugPort(options);
  const userDataDir = getChromeUserDataDir(port, options);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--new-window",
    bossUrl
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  console.log(`Chrome launched with remote debugging port ${port}`);
  console.log(`User data dir: ${userDataDir}`);
  console.log(`URL: ${bossUrl}`);

  const pageState = await inspectBossPageState(port, { timeoutMs: 12000, pollMs: 1000 });
  if (pageState.state === "SEARCH_READY") {
    console.log("Boss search page is ready.");
    console.log(`Current URL: ${pageState.current_url}`);
    return;
  }

  if (pageState.state === "LOGIN_REQUIRED") {
    console.log("Boss page redirected away from search. Manual login is required.");
    console.log(`Current URL: ${pageState.current_url}`);
    console.log("Please log in to Boss manually in the opened Chrome window, then tell the AI agent to continue.");
    return;
  }

  console.log(pageState.message);
  if (pageState.current_url) {
    console.log(`Current URL: ${pageState.current_url}`);
  }
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
  console.log("  boss-recruit-mcp mcp-config   Generate MCP config JSON for Cursor/Trae/Claude Code/OpenClaw");
  console.log("  boss-recruit-mcp doctor       Check config, calibration, and runtime prerequisites");
  console.log("  boss-recruit-mcp calibrate    Run favorite-button calibration and save favorite-calibration.json");
  console.log("  boss-recruit-mcp launch-chrome Launch Chrome in remote-debugging mode, open Boss search, and check login state");
  console.log("  boss-recruit-mcp where        Print installed package, skill, and config paths");
  console.log("");
  console.log("Run command:");
  console.log("  boss-recruit-mcp run --instruction \"找杭州本科做过推荐系统的人\" [--confirmation-json '{...}'] [--overrides-json '{...}']");
  console.log("  boss-recruit-mcp run --instruction-file request.txt [--confirmation-file confirmation.json] [--overrides-file overrides.json]");
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
  console.log("4. Run `boss-recruit-mcp doctor --port <your-port>` to verify config, calibration, and runtime prerequisites.");
  console.log("5. Run `boss-recruit-mcp launch-chrome --port <your-port>`; if it reports the page redirected away from search, log in to Boss manually in that Chrome window.");
  console.log("6. Run `boss-recruit-mcp calibrate --port <your-port>` to generate favorite-calibration.json for this environment.");
  console.log("7. Run `boss-recruit-mcp start` or configure your MCP client to launch the command from the generated template.");
}

async function runPipelineOnce(options) {
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
