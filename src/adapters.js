import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const currentFilePath = fileURLToPath(import.meta.url);
const packagedMcpDir = path.resolve(path.dirname(currentFilePath), "..");

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
  const target = output.match(/目标人数:\s*(\d+)\s*人/);
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

function resolveDebugPort(config) {
  const fromEnv = Number.parseInt(process.env.BOSS_RECRUIT_CHROME_PORT || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromConfig = Number.parseInt(String(config?.debugPort || ""), 10);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return 9222;
}

function resolveWorkspaceDebugPort(workspaceRoot) {
  const configPath = resolveScreenConfigPath(workspaceRoot);
  if (pathExists(configPath)) {
    const loaded = loadScreenConfig(configPath);
    if (loaded.ok) {
      return resolveDebugPort(loaded.config);
    }
  }
  return resolveDebugPort(null);
}

export function runPipelinePreflight(workspaceRoot) {
  const searchDir = resolveSearchCliDir(workspaceRoot);
  const screenDir = resolveScreenCliDir(workspaceRoot);
  const screenConfigPath = resolveScreenConfigPath(workspaceRoot);
  const loaded = pathExists(screenConfigPath) ? loadScreenConfig(screenConfigPath) : null;
  const debugPort = loaded?.ok ? resolveDebugPort(loaded.config) : resolveDebugPort(null);
  const calibrationPath = loaded?.ok
    ? (loaded.config.calibrationFile
      ? path.resolve(path.dirname(screenConfigPath), loaded.config.calibrationFile)
      : getUserCalibrationPath())
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
      message: "favorite-calibration.json 不存在，请先完成收藏按钮校准"
    }
  ];

  return {
    ok: checks.every((item) => item.ok),
    checks,
    debug_port: debugPort,
    calibration_path: calibrationPath
  };
}

function localDirHint(workspaceRoot, dirName) {
  return path.join(workspaceRoot, dirName);
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
  const debugPort = resolveDebugPort(loaded.config);

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
