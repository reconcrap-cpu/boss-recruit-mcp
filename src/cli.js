import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.js";
import { runPipelinePreflight } from "./adapters.js";

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

function printDoctor(options) {
  const port = getDebugPort(options);
  const checks = runPipelinePreflight(process.cwd()).checks.slice();
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
    ok: true,
    path: `http://localhost:${port}`,
    message: `建议使用 Chrome 调试端口 ${port}`
  });
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

function launchChrome(options) {
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    console.error("Chrome executable not found. Set BOSS_RECRUIT_CHROME_PATH or install Google Chrome.");
    process.exitCode = 1;
    return;
  }
  const port = getDebugPort(options);
  const args = [
    `--remote-debugging-port=${port}`,
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
  console.log(`URL: ${bossUrl}`);
}

function printHelp() {
  console.log("boss-recruit-mcp");
  console.log("");
  console.log("Usage:");
  console.log("  boss-recruit-mcp              Start the MCP server");
  console.log("  boss-recruit-mcp start        Start the MCP server");
  console.log("  boss-recruit-mcp install      Install Codex skill and initialize user config");
  console.log("  boss-recruit-mcp install-skill Install only the Codex skill");
  console.log("  boss-recruit-mcp init-config  Create ~/.codex/boss-recruit-mcp/screening-config.json if missing");
  console.log("  boss-recruit-mcp doctor       Check config, calibration, and runtime prerequisites");
  console.log("  boss-recruit-mcp calibrate    Run favorite-button calibration and save favorite-calibration.json");
  console.log("  boss-recruit-mcp launch-chrome Launch Chrome in remote-debugging mode and open Boss search");
  console.log("  boss-recruit-mcp where        Print installed package, skill, and config paths");
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

function installAll() {
  const skillTarget = installSkill();
  const configResult = ensureUserConfig();
  console.log(`Skill installed to: ${skillTarget}`);
  if (configResult.created) {
    console.log(`Config template created at: ${configResult.path}`);
  } else {
    console.log(`Config already exists at: ${configResult.path}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("1. Fill in baseUrl/apiKey/model in the config file above.");
  console.log("2. Choose a Chrome remote-debugging port (9222 is recommended, but you can reuse an existing port).");
  console.log("3. Run `boss-recruit-mcp doctor --port <your-port>` to verify config, calibration, and runtime prerequisites.");
  console.log("4. Run `boss-recruit-mcp launch-chrome --port <your-port>` and log in to Boss if needed.");
  console.log("5. Run `boss-recruit-mcp calibrate --port <your-port>` to generate favorite-calibration.json for this environment.");
  console.log("6. Run `boss-recruit-mcp start` or configure your MCP client to launch `boss-recruit-mcp`.");
}

const command = process.argv[2] || "start";
const options = parseOptions(process.argv.slice(3));

switch (command) {
  case "start":
    startServer();
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
  case "doctor":
    printDoctor(options);
    break;
  case "calibrate":
    await calibrate(options);
    break;
  case "launch-chrome":
    launchChrome(options);
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
