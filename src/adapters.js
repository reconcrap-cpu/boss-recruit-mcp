import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";
const currentFilePath = fileURLToPath(import.meta.url);
const packagedMcpDir = path.resolve(path.dirname(currentFilePath), "..");
const bossSearchUrl = "https://www.zhipin.com/web/chat/search";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const screenConfigTemplateDefaults = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "replace-with-openai-api-key",
  model: "gpt-4.1-mini"
};
const DEFAULT_RECRUIT_SCREEN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

function safeInvokeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch {
    // Ignore callback errors to keep pipeline runtime stable.
  }
}

function runProcess({
  command,
  args,
  cwd,
  timeoutMs,
  onOutput,
  onLine,
  onHeartbeat,
  heartbeatIntervalMs = 10_000,
  signal
}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let settled = false;
    let timer = null;
    let heartbeatTimer = null;
    let abortForceTimer = null;
    let abortedBySignal = Boolean(signal?.aborted);
    let abortListener = null;

    function notifyHeartbeat(source) {
      safeInvokeCallback(onHeartbeat, {
        source,
        command,
        args,
        cwd,
        at: new Date().toISOString()
      });
    }

    function emitLine(stream, line) {
      const normalized = String(line ?? "").replace(/\r$/, "");
      if (!normalized) return;
      safeInvokeCallback(onLine, {
        stream,
        line: normalized,
        at: new Date().toISOString()
      });
    }

    function pushLineBuffer(stream, chunkText) {
      if (stream === "stdout") {
        stdoutLineBuffer += chunkText;
      } else {
        stderrLineBuffer += chunkText;
      }
      let buffer = stream === "stdout" ? stdoutLineBuffer : stderrLineBuffer;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        emitLine(stream, buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      if (stream === "stdout") {
        stdoutLineBuffer = buffer;
      } else {
        stderrLineBuffer = buffer;
      }
    }

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (abortForceTimer) clearTimeout(abortForceTimer);
      if (signal && typeof signal.removeEventListener === "function" && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      emitLine("stdout", stdoutLineBuffer);
      emitLine("stderr", stderrLineBuffer);
      stdoutLineBuffer = "";
      stderrLineBuffer = "";
      resolve(payload);
    }

    function requestAbort() {
      abortedBySignal = true;
      try {
        child.kill("SIGINT");
      } catch {
        try {
          child.kill();
        } catch {}
      }
      abortForceTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
      }, 5000);
    }

    if (abortedBySignal) {
      finish({
        code: -1,
        stdout,
        stderr: "Process aborted before spawn",
        error_code: "ABORTED"
      });
      return;
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

    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => requestAbort();
      signal.addEventListener("abort", abortListener, { once: true });
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

    if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        notifyHeartbeat("timer");
      }, heartbeatIntervalMs);
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pushLineBuffer("stdout", text);
      safeInvokeCallback(onOutput, {
        stream: "stdout",
        text,
        at: new Date().toISOString()
      });
      notifyHeartbeat("stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      pushLineBuffer("stderr", text);
      safeInvokeCallback(onOutput, {
        stream: "stderr",
        text,
        at: new Date().toISOString()
      });
      notifyHeartbeat("stderr");
    });

    child.on("close", (code) => {
      if (abortedBySignal) {
        finish({
          code: -1,
          stdout,
          stderr: `${stderr}\nProcess aborted by signal`.trim(),
          error_code: "ABORTED"
        });
        return;
      }
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

function runProcessSync({ command, args, cwd }) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: process.env,
      encoding: "utf8"
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    return {
      ok: result.status === 0,
      status: result.status,
      stdout,
      stderr,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      error_code: result.error?.code || null,
      error_message: result.error?.message || null
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      stdout: "",
      stderr: "",
      output: "",
      error_code: error.code || "SPAWN_FAILED",
      error_message: error.message || String(error)
    };
  }
}

function parseMajorVersion(raw) {
  const match = String(raw || "").match(/v?(\d+)(?:\.\d+){0,2}/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

function buildNodeCommandCheck() {
  const probe = runProcessSync({
    command: "node",
    args: ["--version"]
  });
  const major = parseMajorVersion(probe.output);
  const versionOk = Number.isInteger(major) && major >= 18;
  return {
    key: "node_cli",
    ok: probe.ok && versionOk,
    path: "node --version",
    message: probe.ok
      ? (versionOk
        ? `Node 命令可用 (${probe.output || "unknown version"})`
        : `Node 版本过低 (${probe.output || "unknown version"})，要求 >= 18`)
      : `未找到 node 命令，请先安装 Node.js >= 18。${probe.error_message ? ` (${probe.error_message})` : ""}`
  };
}

function detectPythonCommand() {
  const python = runProcessSync({
    command: "python",
    args: ["--version"]
  });
  if (python.ok) {
    return {
      ok: true,
      command: "python",
      probe: python
    };
  }
  const python3 = runProcessSync({
    command: "python3",
    args: ["--version"]
  });
  if (python3.ok) {
    return {
      ok: false,
      command: null,
      probe: python,
      fallback: python3
    };
  }
  return {
    ok: false,
    command: null,
    probe: python,
    fallback: null
  };
}

function buildPythonCommandCheck() {
  const detected = detectPythonCommand();
  if (detected.ok) {
    return {
      key: "python_cli",
      ok: true,
      path: "python --version",
      message: `Python 命令可用 (${detected.probe.output || "unknown version"})`
    };
  }
  if (detected.fallback) {
    return {
      key: "python_cli",
      ok: false,
      path: "python --version",
      message: `检测到 ${detected.fallback.output || "python3"}，但当前流程依赖 python 命令；请创建 python 别名后重试。`
    };
  }
  return {
    key: "python_cli",
    ok: false,
    path: "python --version",
    message: "未找到 python 命令，请安装 Python 并确保 python 在 PATH 中。"
  };
}

function buildPillowCheck() {
  const detected = detectPythonCommand();
  if (!detected.ok || !detected.command) {
    return {
      key: "python_pillow",
      ok: false,
      path: "python -c \"import PIL\"",
      message: "无法校验 Pillow：python 命令不可用。"
    };
  }
  const probe = runProcessSync({
    command: detected.command,
    args: ["-c", "import PIL, PIL.Image; print(PIL.__version__)"]
  });
  return {
    key: "python_pillow",
    ok: probe.ok,
    path: `${detected.command} -c "import PIL"`,
    message: probe.ok
      ? `Pillow 可用 (${probe.output || "version unknown"})`
      : "Pillow 未安装。请执行 `python -m pip install pillow`。"
  };
}

function buildNodePackageCheck({ key, moduleName, cwd, missingMessage }) {
  if (!cwd || !pathExists(cwd)) {
    return {
      key,
      ok: false,
      path: moduleName,
      module: moduleName,
      install_cwd: null,
      message: missingMessage
    };
  }
  const probe = runProcessSync({
    command: "node",
    args: ["-e", `require.resolve(${JSON.stringify(moduleName)});`],
    cwd
  });
  return {
    key,
    ok: probe.ok,
    path: moduleName,
    module: moduleName,
    install_cwd: cwd,
    message: probe.ok
      ? `${moduleName} npm 依赖可用`
      : `缺少 npm 依赖 ${moduleName}，请在 boss-recruit-mcp 目录执行 npm install。`
  };
}

function buildRuntimeDependencyChecks({ searchDir, screenDir }) {
  return [
    buildNodeCommandCheck(),
    buildPythonCommandCheck(),
    buildPillowCheck(),
    buildNodePackageCheck({
      key: "npm_dep_chrome_remote_interface_search",
      moduleName: "chrome-remote-interface",
      cwd: searchDir,
      missingMessage: "无法校验 chrome-remote-interface：boss-search-cli 目录不存在。"
    }),
    buildNodePackageCheck({
      key: "npm_dep_chrome_remote_interface_screen",
      moduleName: "chrome-remote-interface",
      cwd: screenDir,
      missingMessage: "无法校验 chrome-remote-interface：boss-screen-cli 目录不存在。"
    }),
    buildNodePackageCheck({
      key: "npm_dep_ws",
      moduleName: "ws",
      cwd: screenDir,
      missingMessage: "无法校验 ws：boss-screen-cli 目录不存在。"
    })
  ];
}

function parseSearchCount(output) {
  const m = output.match(/找到\s*(\d+)\s*个候选人/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

async function detectSearchNoDataTip(debugPort) {
  let client = null;
  try {
    const targets = await CDP.List({ port: debugPort });
    const target = targets.find(
      (item) => typeof item?.url === "string" && item.url.includes("/web/chat/search")
    ) || targets.find((item) => item?.type === "page");
    if (!target) {
      return {
        ok: false,
        exhausted: null,
        error: "No page target found on Chrome DevTools"
      };
    }

    client = await CDP({
      port: debugPort,
      target
    });
    const { Runtime } = client;
    await Runtime.enable();

    const expression = `(function () {
      try {
        var rootDoc = document;
        var iframe = document.querySelector("iframe");
        if (iframe && iframe.contentWindow && iframe.contentWindow.document) {
          rootDoc = iframe.contentWindow.document;
        }
        var tip = rootDoc.querySelector("i.tip-nodata");
        return {
          exhausted: Boolean(tip),
          selector: "i.tip-nodata"
        };
      } catch (err) {
        return {
          exhausted: false,
          selector: "i.tip-nodata",
          error: String(err && err.message ? err.message : err)
        };
      }
    })()`;
    const evaluated = await Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (evaluated.exceptionDetails) {
      return {
        ok: false,
        exhausted: null,
        error: evaluated.exceptionDetails.exception?.description || "Runtime.evaluate failed"
      };
    }

    const value = evaluated.result?.value || {};
    return {
      ok: true,
      exhausted: value.exhausted === true,
      details: value
    };
  } catch (error) {
    return {
      ok: false,
      exhausted: null,
      error: error.message
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

function parseScreenSummary(output) {
  const processed = output.match(/已处理:\s*(\d+)\s*人/);
  const passed = output.match(/通过筛选:\s*(\d+)\s*人/);
  const target = output.match(/目标(?:处理)?人数:\s*(\d+)\s*人/);
  const csv = output.match(/(?:结果已导出到|结果已保存到|暂停中已保存到|已保存\s*\d+\s*条结果到):\s*(.+)/);
  const savedCount = output.match(/已保存\s*(\d+)\s*条结果到:\s*(.+)/);

  return {
    processed_count: processed ? Number.parseInt(processed[1], 10) : null,
    passed_count: passed
      ? Number.parseInt(passed[1], 10)
      : (savedCount ? Number.parseInt(savedCount[1], 10) : null),
    target_count: target ? Number.parseInt(target[1], 10) : null,
    output_csv: csv ? csv[1].trim() : null
  };
}

function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      continue;
    }
  }
  return null;
}

function createScreenProgressTracker(currentTracker = {}) {
  const outcome = String(currentTracker.outcome || "").trim();
  return {
    candidate_index: Number.isInteger(currentTracker.candidate_index) ? currentTracker.candidate_index : null,
    outcome: outcome === "pass" || outcome === "skip" ? outcome : null,
    action_failed: currentTracker.action_failed === true
  };
}

function finalizeCandidateProgress(progress, tracker) {
  if (!Number.isInteger(tracker.candidate_index)) {
    return false;
  }

  let changed = false;
  if (tracker.action_failed === true) {
    progress.skipped += 1;
    changed = true;
  } else if (tracker.outcome === "pass") {
    progress.passed += 1;
    changed = true;
  } else if (tracker.outcome === "skip") {
    progress.skipped += 1;
    changed = true;
  }

  tracker.candidate_index = null;
  tracker.outcome = null;
  tracker.action_failed = false;
  return changed;
}

function parseScreenProgressLine(line, currentProgress = {}, currentTracker = {}) {
  const normalizedLine = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalizedLine) return null;

  const nextProgress = {
    processed: Number.isInteger(currentProgress.processed) ? currentProgress.processed : 0,
    passed: Number.isInteger(currentProgress.passed) ? currentProgress.passed : 0,
    skipped: Number.isInteger(currentProgress.skipped) ? currentProgress.skipped : 0,
    greet_count: Number.isInteger(currentProgress.greet_count) ? currentProgress.greet_count : 0
  };
  const nextTracker = createScreenProgressTracker(currentTracker);
  let changed = false;

  const processedMatch = normalizedLine.match(/处理第\s*(\d+)\s*位候选人/u);
  if (processedMatch) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
    const processed = Number.parseInt(processedMatch[1], 10);
    if (Number.isInteger(processed) && processed >= 0 && processed !== nextProgress.processed) {
      nextProgress.processed = processed;
      changed = true;
    }
    nextTracker.candidate_index = processed;
    nextTracker.outcome = null;
    nextTracker.action_failed = false;
  }

  if (/LLM评估结果:\s*通过/u.test(normalizedLine)) {
    if (nextTracker.outcome !== "pass" || nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.outcome = "pass";
    nextTracker.action_failed = false;
  } else if (/LLM评估结果:\s*不通过/u.test(normalizedLine)) {
    if (nextTracker.outcome !== "skip" || nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.outcome = "skip";
    nextTracker.action_failed = false;
  }

  if (/候选人处理失败\s*:/u.test(normalizedLine) || /获取简历信息失败/u.test(normalizedLine)) {
    if (!nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.action_failed = true;
  }

  if (/^\[关闭详情\].*成功/u.test(normalizedLine) || /详情页已关闭/u.test(normalizedLine)) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
  }

  if (/Process timed out after|"status"\s*:\s*"(?:COMPLETED|PAUSED|FAILED)"/u.test(normalizedLine)) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
  }

  if (!changed) return null;
  return {
    line: normalizedLine,
    progress: nextProgress,
    tracker: nextTracker
  };
}

function resolveRecruitScreenTimeoutMs(runtime = null) {
  const runtimeTimeoutMs = parsePositiveInteger(runtime?.timeoutMs);
  const envTimeoutMs = parsePositiveInteger(process.env.BOSS_RECRUIT_SCREEN_TIMEOUT_MS);
  return runtimeTimeoutMs || envTimeoutMs || DEFAULT_RECRUIT_SCREEN_TIMEOUT_MS;
}

function buildRecruitScreenProcessError(result, screenTimeoutMs) {
  if (result.code === 0) return null;
  if (result.error_code === "TIMEOUT") {
    return {
      code: "TIMEOUT",
      message: `招聘筛选命令执行超时（${screenTimeoutMs}ms）。`
    };
  }
  if (result.error_code === "ABORTED") {
    return {
      code: "PROCESS_ABORTED",
      message: "招聘筛选命令已取消。"
    };
  }
  return {
    code: "SCREEN_CLI_FAILED",
    message: "招聘筛选命令执行失败。"
  };
}

function looksLikePlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("replace-with")) return true;
  if (normalized.includes("your-api-key")) return true;
  if (normalized.includes("your-model-name")) return true;
  if (normalized.includes("example.com")) return true;
  return false;
}

function validateScreenConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      reason: "INVALID_OR_MISSING_CONFIG",
      message: "screening-config.json 缺失或格式无效。请填写 baseUrl、apiKey、model。"
    };
  }
  const baseUrl = String(config.baseUrl || "").trim();
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  const missing = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model) missing.push("model");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "MISSING_REQUIRED_FIELDS",
      message: `screening-config.json 缺少必填字段：${missing.join(", ")}。`
    };
  }
  if (looksLikePlaceholder(apiKey) || apiKey === screenConfigTemplateDefaults.apiKey) {
    return {
      ok: false,
      reason: "PLACEHOLDER_API_KEY",
      message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
    };
  }
  if (
    baseUrl === screenConfigTemplateDefaults.baseUrl
    && apiKey === screenConfigTemplateDefaults.apiKey
    && model === screenConfigTemplateDefaults.model
  ) {
    return {
      ok: false,
      reason: "PLACEHOLDER_TEMPLATE_VALUES",
      message: "screening-config.json 仍是默认模板值，请填写 baseUrl、apiKey、model。"
    };
  }
  return { ok: true, reason: "OK", message: "screening-config.json 校验通过。" };
}

function loadScreenConfig(configPath) {
  const parsed = readScreenConfigJson(configPath);
  const validation = validateScreenConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: `${validation.message} (path: ${configPath})`
    };
  }
  return { ok: true, config: parsed };
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
  const screenConfigValidation = validateScreenConfig(rawConfig);
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
      ok: screenConfigValidation.ok,
      path: screenConfigPath,
      reason: screenConfigValidation.reason || null,
      message: screenConfigValidation.ok ? "screening-config.json 可用" : screenConfigValidation.message
    },
    {
      key: "favorite_calibration",
      ok: pathExists(calibrationPath),
      path: calibrationPath,
      optional: true,
      message: "favorite-calibration.json 不存在（可选，仅在旧页面回退点击时需要）"
    }
  ];
  checks.push(...buildRuntimeDependencyChecks({ searchDir, screenDir }));

  const requiredCheckKeys = new Set([
    "search_cli_dir",
    "search_cli_entry",
    "screen_cli_dir",
    "screen_cli_entry",
    "screen_config",
    "node_cli",
    "python_cli",
    "python_pillow",
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws"
  ]);

  return {
    ok: checks.every((item) => !requiredCheckKeys.has(item.key) || item.ok),
    checks,
    debug_port: debugPort,
    calibration_path: calibrationPath
  };
}

function collectFailedCheckKeys(checks = []) {
  return new Set(
    checks
      .filter((item) => item && item.ok === false && typeof item.key === "string")
      .map((item) => item.key)
  );
}

function collectNpmInstallDirsFromChecks(checks = [], workspaceRoot) {
  const npmKeys = new Set([
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws"
  ]);
  const dirs = checks
    .filter((item) => item && item.ok === false && npmKeys.has(item.key))
    .map((item) => item.install_cwd)
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => path.resolve(item));
  if (dirs.length > 0) {
    return [...new Set(dirs)];
  }
  return [path.resolve(workspaceRoot)];
}

function installNpmDependencies(checks, workspaceRoot) {
  const dirs = collectNpmInstallDirsFromChecks(checks, workspaceRoot);
  const commandResults = [];
  let allOk = true;
  for (const cwd of dirs) {
    const result = runProcessSync({
      command: "npm",
      args: ["install"],
      cwd
    });
    commandResults.push({
      cwd,
      ok: result.ok,
      output: result.output || result.error_message || ""
    });
    if (!result.ok) allOk = false;
  }
  return {
    ok: allOk,
    action: "install_npm_dependencies",
    changed: true,
    command_results: commandResults,
    message: allOk ? "npm 依赖自动安装完成。" : "npm 依赖自动安装失败。"
  };
}

function installPillowIfPossible() {
  const detected = detectPythonCommand();
  if (!detected.ok || !detected.command) {
    return {
      ok: false,
      action: "install_pillow",
      changed: false,
      message: "未检测到可用 python 命令，无法自动安装 Pillow。"
    };
  }
  const install = runProcessSync({
    command: detected.command,
    args: ["-m", "pip", "install", "pillow"]
  });
  return {
    ok: install.ok,
    action: "install_pillow",
    changed: install.ok,
    message: install.ok ? "Pillow 自动安装完成。" : `Pillow 自动安装失败：${install.output || install.error_message || "unknown"}`
  };
}

export function attemptPipelineAutoRepair(workspaceRoot, preflight = {}) {
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  const failed = collectFailedCheckKeys(checks);
  const actions = [];

  if (
    failed.has("npm_dep_chrome_remote_interface_search")
    || failed.has("npm_dep_chrome_remote_interface_screen")
    || failed.has("npm_dep_ws")
  ) {
    if (!failed.has("node_cli")) {
      actions.push(installNpmDependencies(checks, workspaceRoot));
    } else {
      actions.push({
        ok: false,
        action: "install_npm_dependencies",
        changed: false,
        message: "Node 命令不可用，跳过 npm 自动安装。"
      });
    }
  }

  if (failed.has("python_pillow")) {
    if (!failed.has("python_cli")) {
      actions.push(installPillowIfPossible());
    } else {
      actions.push({
        ok: false,
        action: "install_pillow",
        changed: false,
        message: "python 命令不可用，跳过 Pillow 自动安装。"
      });
    }
  }

  const attempted = actions.length > 0;
  const nextPreflight = runPipelinePreflight(workspaceRoot);
  return {
    attempted,
    actions,
    preflight: nextPreflight
  };
}

function localDirHint(workspaceRoot, dirName) {
  return path.join(workspaceRoot, dirName);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultChromeExecutableCandidates() {
  const candidates = [process.env.BOSS_RECRUIT_CHROME_PATH].filter(Boolean);
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium"
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function getChromeExecutable() {
  const candidates = getDefaultChromeExecutableCandidates();
  return candidates.find((candidate) => pathExists(candidate)) || null;
}

function getChromeUserDataDir(port) {
  const profileDir = path.join(getCodexHome(), "boss-recruit-mcp", `chrome-profile-${port}`);
  fs.mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

function launchChromeWithDebugPort(port) {
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    return {
      ok: false,
      code: "CHROME_EXECUTABLE_NOT_FOUND",
      message: "未找到 Chrome 可执行文件，请安装 Chrome 或设置 BOSS_RECRUIT_CHROME_PATH。"
    };
  }
  const userDataDir = getChromeUserDataDir(port);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    bossSearchUrl
  ];
  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return {
      ok: true,
      code: "CHROME_LAUNCHED",
      chrome_path: chromePath,
      user_data_dir: userDataDir
    };
  } catch (error) {
    return {
      ok: false,
      code: "CHROME_LAUNCH_FAILED",
      message: error.message || "Chrome 启动失败。"
    };
  }
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
  let launchAttempt = null;
  if (pageState.state === "SEARCH_READY") {
    const stableState = await verifySearchPageStable(debugPort, { settleMs, pollMs });
    return {
      ok: stableState.state === "SEARCH_READY",
      debug_port: debugPort,
      state: stableState.state,
      page_state: {
        ...stableState,
        launch_attempt: launchAttempt
      }
    };
  }
  if (pageState.state === "LOGIN_REQUIRED") {
    return {
      ok: false,
      debug_port: debugPort,
      state: pageState.state,
      page_state: {
        ...pageState,
        launch_attempt: launchAttempt
      }
    };
  }

  if (pageState.state === "DEBUG_PORT_UNREACHABLE") {
    launchAttempt = launchChromeWithDebugPort(debugPort);
    if (launchAttempt.ok) {
      await sleep(settleMs + 1200);
      pageState = await inspectBossPageState(debugPort, { timeoutMs: inspectTimeoutMs, pollMs });
      if (pageState.state === "SEARCH_READY") {
        const stableState = await verifySearchPageStable(debugPort, { settleMs, pollMs });
        return {
          ok: stableState.state === "SEARCH_READY",
          debug_port: debugPort,
          state: stableState.state,
          page_state: {
            ...stableState,
            launch_attempt: launchAttempt
          }
        };
      }
      if (pageState.state === "LOGIN_REQUIRED") {
        return {
          ok: false,
          debug_port: debugPort,
          state: pageState.state,
          page_state: {
            ...pageState,
            launch_attempt: launchAttempt
          }
        };
      }
    } else {
      return {
        ok: false,
        debug_port: debugPort,
        state: pageState.state,
        page_state: {
          ...pageState,
          launch_attempt: launchAttempt
        }
      };
    }
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
        page_state: {
          ...stableState,
          launch_attempt: launchAttempt
        }
      };
    }
    if (pageState.state === "LOGIN_REQUIRED") {
      return {
        ok: false,
        debug_port: debugPort,
        state: pageState.state,
        page_state: {
          ...pageState,
          launch_attempt: launchAttempt
        }
      };
    }
  }

  return {
    ok: false,
    debug_port: debugPort,
    state: pageState.state || "UNKNOWN",
    page_state: {
      ...pageState,
      launch_attempt: launchAttempt
    }
  };
}

export async function runSearchCli({ workspaceRoot, searchParams, runtime = null }) {
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
    timeoutMs: 180000,
    heartbeatIntervalMs: runtime?.heartbeatIntervalMs,
    signal: runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(runtime?.onOutput, event);
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(runtime?.onHeartbeat, event);
    }
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const candidateCount = parseSearchCount(combined);
  const tipCheck = result.code === 0
    ? await detectSearchNoDataTip(debugPort)
    : { ok: false, exhausted: null, error: null };

  return {
    ok: result.code === 0,
    exit_code: result.code,
    candidate_count: candidateCount,
    no_data_tip_present: tipCheck.ok ? tipCheck.exhausted : null,
    no_data_tip_check: tipCheck.ok
      ? { ok: true, details: tipCheck.details || null }
      : { ok: false, error: tipCheck.error || null },
    stdout: result.stdout,
    stderr: result.stderr,
    error_code: result.error_code || null
  };
}

export async function runScreenCli({ workspaceRoot, screenParams, resume = null, runtime = null }) {
  const screenDir = resolveScreenCliDir(workspaceRoot);
  if (!screenDir) {
    return {
      ok: false,
      exit_code: -1,
      summary: null,
      structured: null,
      stdout: "",
      stderr: "boss-screen-cli package not found",
      error: {
        code: "SCREEN_CLI_MISSING",
        message: "boss-screen-cli 目录不存在。"
      }
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
      structured: null,
      summary: null,
      stdout: "",
      stderr: loaded.error,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: loaded.error
      }
    };
  }

  const calibration = loaded.config.calibrationFile
    ? path.resolve(configBaseDir, loaded.config.calibrationFile)
    : getUserCalibrationPath();
  const debugPort = resolveWorkspaceDebugPort(workspaceRoot);

  const fixedOutput = normalizeText(resume?.output_csv || "");
  const outputName = `筛选结果_${Date.now()}.csv`;
  let outputPath = fixedOutput ? path.resolve(fixedOutput) : outputName;
  if (!fixedOutput) {
    if (loaded.config.outputDir) {
      const resolvedOutputDir = path.resolve(configBaseDir, loaded.config.outputDir);
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
      outputPath = path.join(resolvedOutputDir, outputName);
    } else {
      const desktopDir = getDesktopDir();
      fs.mkdirSync(desktopDir, { recursive: true });
      outputPath = path.join(desktopDir, outputName);
    }
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  const checkpointPath = normalizeText(resume?.checkpoint_path || "")
    ? path.resolve(String(resume.checkpoint_path))
    : null;
  const pauseControlPath = normalizeText(resume?.pause_control_path || "")
    ? path.resolve(String(resume.pause_control_path))
    : null;
  const resumeRequested = resume?.resume === true;
  const requireCheckpoint = resume?.require_checkpoint === true;
  const roundIndex = Number.isInteger(resume?.round_index) && resume.round_index > 0
    ? resume.round_index
    : null;
  if (resumeRequested && requireCheckpoint) {
    if (!checkpointPath) {
      return {
        ok: false,
        paused: false,
        stdout: "",
        stderr: "",
        structured: null,
        summary: null,
        error: {
          code: "RESUME_CHECKPOINT_MISSING",
          message: "恢复执行缺少 checkpoint_path，无法从上次进度继续。"
        }
      };
    }
    if (!fs.existsSync(checkpointPath)) {
      return {
        ok: false,
        paused: false,
        stdout: "",
        stderr: "",
        structured: null,
        summary: null,
        error: {
          code: "RESUME_CHECKPOINT_MISSING",
          message: `恢复执行未找到 checkpoint 文件：${checkpointPath}`
        }
      };
    }
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

  if (loaded.config.openaiOrganization) {
    args.push("--openai-organization", loaded.config.openaiOrganization);
  }
  if (loaded.config.openaiProject) {
    args.push("--openai-project", loaded.config.openaiProject);
  }
  if (checkpointPath) {
    args.push("--checkpoint-path", checkpointPath);
  }
  if (pauseControlPath) {
    args.push("--pause-control-path", pauseControlPath);
  }
  if (resumeRequested) {
    args.push("--resume");
  }
  if (roundIndex) {
    args.push("--round-index", String(roundIndex));
  }

  let inferredProgress = {
    processed: 0,
    passed: 0,
    skipped: 0,
    greet_count: 0
  };
  let inferredTracker = createScreenProgressTracker();
  const screenTimeoutMs = resolveRecruitScreenTimeoutMs(runtime);

  const result = await runProcess({
    command: "node",
    args,
    cwd: screenDir,
    timeoutMs: screenTimeoutMs,
    heartbeatIntervalMs: runtime?.heartbeatIntervalMs,
    signal: runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(runtime?.onOutput, event);
    },
    onLine: (event) => {
      const parsed = parseScreenProgressLine(event?.line, inferredProgress, inferredTracker);
      if (!parsed) return;
      inferredProgress = parsed.progress;
      inferredTracker = parsed.tracker;
      safeInvokeCallback(runtime?.onProgress, {
        ...inferredProgress,
        line: parsed.line
      });
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(runtime?.onHeartbeat, event);
    }
  });

  const structured = parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr);
  const status = normalizeText(structured?.status || "").toUpperCase();
  const combined = `${result.stdout}\n${result.stderr}`;
  const summary = structured?.result || parseScreenSummary(combined);
  if (summary) {
    safeInvokeCallback(runtime?.onProgress, {
      processed: Number.isInteger(summary.processed_count) ? summary.processed_count : inferredProgress.processed,
      passed: Number.isInteger(summary.passed_count) ? summary.passed_count : inferredProgress.passed,
      skipped: inferredProgress.skipped,
      greet_count: inferredProgress.greet_count
    });
  }

  const missingOutputError = result.code === 0 && !structured
    ? {
        code: "SCREEN_NO_OUTPUT",
        message: "招聘筛选命令执行结束但未返回可解析结果。"
      }
    : null;
  return {
    ok: result.code === 0 && status === "COMPLETED",
    paused: result.code === 0 && status === "PAUSED",
    exit_code: result.code,
    summary,
    structured,
    stdout: result.stdout,
    stderr: result.stderr,
    error_code: result.error_code || null,
    error: structured?.error || missingOutputError || buildRecruitScreenProcessError(result, screenTimeoutMs)
  };
}

export const __testables = {
  runProcess,
  parseJsonOutput,
  parseScreenProgressLine,
  resolveRecruitScreenTimeoutMs,
  buildRecruitScreenProcessError
};
