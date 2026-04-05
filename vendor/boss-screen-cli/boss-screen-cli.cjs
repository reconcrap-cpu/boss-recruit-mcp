#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const DEFAULT_DEBUG_PORT = 9222;

function parsePositiveInteger(raw) {
    const value = Number.parseInt(String(raw || ''), 10);
    if (Number.isFinite(value) && value > 0) {
        return value;
    }
    return null;
}

function resolveDebugPort({ explicitPort = null, configPort = null } = {}) {
    const fromExplicit = parsePositiveInteger(explicitPort);
    if (fromExplicit) return fromExplicit;
    const fromEnv = parsePositiveInteger(process.env.BOSS_RECRUIT_CHROME_PORT);
    if (fromEnv) return fromEnv;
    const fromConfig = parsePositiveInteger(configPort);
    if (fromConfig) return fromConfig;
    return DEFAULT_DEBUG_PORT;
}

function parseCliArgs(argv) {
    const parsed = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (token === '-h') {
            parsed.help = true;
            continue;
        }
        if (token === '-p') {
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
                parsed.port = next;
                i += 1;
            } else {
                parsed.port = true;
            }
            continue;
        }
        if (!token.startsWith('--')) {
            continue;
        }

        const eqIndex = token.indexOf('=');
        if (eqIndex > 2) {
            const key = token.slice(2, eqIndex);
            const value = token.slice(eqIndex + 1);
            parsed[key] = value || true;
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
            parsed[key] = next;
            i += 1;
        } else {
            parsed[key] = true;
        }
    }
    return parsed;
}

const args = parseCliArgs(process.argv.slice(2));

let baseUrl = args.baseurl || args.baseUrl || null;
let apiKey = args.apikey || args.apiKey || null;
let model = args.model || null;
let openaiOrganization = args['openai-organization'] || args.openaiOrganization || null;
let openaiProject = args['openai-project'] || args.openaiProject || null;
let criteria = args.criteria || null;
let targetCount = Number.parseInt(args.target || args.targetCount || '', 10);
if (!Number.isFinite(targetCount) || targetCount <= 0) {
    targetCount = null;
}
let roundIndex = parsePositiveInteger(args['round-index'] || args.roundIndex);
let debugPort = resolveDebugPort({ explicitPort: args.port });
let configFile = args.config ? path.resolve(String(args.config)) : path.resolve(process.cwd(), 'favorite-calibration.json');
let outputCsv = args.output || `筛选结果_${Date.now()}.csv`;
let checkpointPath = args['checkpoint-path'] ? path.resolve(String(args['checkpoint-path'])) : null;
let pauseControlPath = args['pause-control-path'] ? path.resolve(String(args['pause-control-path'])) : null;
const resumeRequested = args.resume === true;
const bossSearchUrl = 'https://www.zhipin.com/web/chat/search';
const calibrationScriptPath = path.join(__dirname, 'calibrate-favorite-position-v2.cjs');
const MAX_RESUME_TEXT_CHARS = 12000;
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const startupDiscovered = discoverInstalledBossRecruitResources();
applyDiscoveredResources(startupDiscovered);
applyOpenAIEnvironmentDefaults();

if (args.help) {
    printUsage();
    process.exit(0);
}

function printUsage() {
    const scriptName = path.basename(process.argv[1] || 'boss-screen-cli.cjs');
    console.log(`Usage: node ${scriptName} --criteria <criteria> --targetCount <n> [--baseurl <url>] [--apikey <key>] [--model <model>] [--openai-organization <org_id>] [--openai-project <project_id>] [--port <number>] [--config <favorite-calibration.json>] [--output <csv>] [--checkpoint-path <json>] [--pause-control-path <json>] [--round-index <n>] [--resume]`);
    console.log(`  -p, --port <number>   Chrome调试端口（默认: ${debugPort}）`);
    console.log('  -h, --help            显示帮助');
    console.log('  端口优先级: --port > BOSS_RECRUIT_CHROME_PORT > screening-config.json.debugPort > 9222');
    console.log('Tip: run without parameters to enter step-by-step interactive mode.');
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeReadJson(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function writeJsonAtomic(filePath, payload) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function resolvePauseControl(controlFilePath) {
    if (!controlFilePath) return { pause_requested: false, cancel_requested: false };
    const parsed = safeReadJson(controlFilePath);
    if (!parsed || typeof parsed !== 'object') {
        return { pause_requested: false, cancel_requested: false };
    }
    const control = parsed.control && typeof parsed.control === 'object' ? parsed.control : parsed;
    return {
        pause_requested: control.pause_requested === true,
        cancel_requested: control.cancel_requested === true
    };
}

function buildStructuredSummary(state = {}) {
    return {
        round_index: roundIndex || null,
        processed_count: Number.isInteger(state.processedCount) && state.processedCount >= 0 ? state.processedCount : 0,
        passed_count: Array.isArray(state.passedCandidates) ? state.passedCandidates.length : 0,
        output_csv: normalizeText(state.outputCsv || '') || null,
        checkpoint_path: normalizeText(state.checkpointPath || '') || null,
        completion_reason: normalizeText(state.completionReason || '') || null,
        candidate_cursor: {
            current_card_index: Number.isInteger(state.currentCardIndex) && state.currentCardIndex >= 0 ? state.currentCardIndex : 0,
            processed_candidate_keys_count: Array.isArray(state.completedCandidateKeys)
                ? state.completedCandidateKeys.length
                : (state.processedCardKeys instanceof Set ? state.processedCardKeys.size : 0),
            current_candidate_key: normalizeText(state.currentCandidateKey || '') || null
        }
    };
}

function emitStructuredResult(status, state = {}, error = null) {
    const payload = {
        status,
        result: buildStructuredSummary(state)
    };
    if (error) {
        payload.error = {
            code: error.code || 'SCREEN_FAILED',
            message: error.message || 'Unknown error',
            recoverable: error.recoverable === true
        };
    }
    console.log(JSON.stringify(payload));
    return payload;
}

function parseKeyValueOutput(text) {
    const map = {};
    String(text || '').split(/\r?\n/).forEach((line) => {
        const idx = line.indexOf('=');
        if (idx <= 0) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key && value) {
            map[key] = value;
        }
    });
    return map;
}

function looksLikePlaceholder(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    if (normalized.includes('replace-with-your')) return true;
    if (normalized.includes('your-api-key')) return true;
    if (normalized.includes('your-model-name')) return true;
    if (normalized.includes('example.com')) return true;
    return false;
}

function applyOpenAIEnvironmentDefaults() {
    const envBaseUrl = String(process.env.OPENAI_BASE_URL || '').trim();
    const envApiKey = String(process.env.OPENAI_API_KEY || '').trim();
    const envModel = String(process.env.OPENAI_MODEL || '').trim();
    const envOrg = String(process.env.OPENAI_ORG_ID || '').trim();
    const envProject = String(process.env.OPENAI_PROJECT_ID || '').trim();

    if (!apiKey && envApiKey) {
        apiKey = envApiKey;
    }
    if (!baseUrl) {
        if (envBaseUrl) {
            baseUrl = envBaseUrl;
        } else if (apiKey) {
            baseUrl = OPENAI_DEFAULT_BASE_URL;
        }
    }
    if (!model && envModel) {
        model = envModel;
    }
    if (!openaiOrganization && envOrg) {
        openaiOrganization = envOrg;
    }
    if (!openaiProject && envProject) {
        openaiProject = envProject;
    }
}

function readJsonFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function isUsableCalibrationFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const data = readJsonFile(filePath);
    return Boolean(data && data.favoritePosition && Number.isFinite(data.favoritePosition.pageX) && Number.isFinite(data.favoritePosition.pageY));
}

function runBossRecruitWhere() {
    const direct = spawnSync('boss-recruit-mcp', ['where'], {
        encoding: 'utf8'
    });
    if (direct.status === 0) {
        return parseKeyValueOutput(direct.stdout);
    }

    if (process.platform !== 'win32') {
        return null;
    }

    try {
        const fallback = spawnSync('cmd.exe', ['/d', '/s', '/c', 'boss-recruit-mcp where'], {
            encoding: 'utf8'
        });
        if (fallback.status !== 0) {
            return null;
        }
        return parseKeyValueOutput(fallback.stdout);
    } catch {
        return null;
    }
}

function discoverInstalledBossRecruitResources() {
    const where = runBossRecruitWhere();
    const codexHome = process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), '.codex');

    const configCandidates = [];
    if (where && where.config_target) {
        configCandidates.push(path.resolve(where.config_target));
    }
    configCandidates.push(path.join(codexHome, 'boss-recruit-mcp', 'screening-config.json'));

    let discoveredConfig = null;
    let discoveredConfigPath = null;
    for (const candidate of configCandidates) {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const parsed = readJsonFile(candidate);
        if (!parsed || typeof parsed !== 'object') continue;
        const hasUsableCore = !looksLikePlaceholder(parsed.baseUrl)
            && (!looksLikePlaceholder(parsed.apiKey) || Boolean(process.env.OPENAI_API_KEY))
            && !looksLikePlaceholder(parsed.model);
        if (!hasUsableCore) continue;
        discoveredConfig = parsed;
        discoveredConfigPath = candidate;
        break;
    }

    const calibrationCandidates = [];
    if (where && where.calibration_target) {
        calibrationCandidates.push(path.resolve(where.calibration_target));
    }
    if (discoveredConfig && discoveredConfigPath && typeof discoveredConfig.calibrationFile === 'string' && discoveredConfig.calibrationFile.trim()) {
        calibrationCandidates.unshift(path.resolve(path.dirname(discoveredConfigPath), discoveredConfig.calibrationFile));
    }
    calibrationCandidates.push(path.join(codexHome, 'boss-recruit-mcp', 'favorite-calibration.json'));

    let discoveredCalibrationPath = null;
    for (const candidate of calibrationCandidates) {
        if (isUsableCalibrationFile(candidate)) {
            discoveredCalibrationPath = candidate;
            break;
        }
    }

    return {
        where,
        config: discoveredConfig,
        configPath: discoveredConfigPath,
        calibrationPath: discoveredCalibrationPath
    };
}

function applyDiscoveredResources(discovered) {
    if (!discovered) return;

    if (discovered.config) {
        if (!baseUrl) baseUrl = discovered.config.baseUrl;
        if (!apiKey) apiKey = discovered.config.apiKey;
        if (!model) model = discovered.config.model;
        if (!openaiOrganization && typeof discovered.config.openaiOrganization === 'string' && discovered.config.openaiOrganization.trim()) {
            openaiOrganization = discovered.config.openaiOrganization.trim();
        }
        if (!openaiProject && typeof discovered.config.openaiProject === 'string' && discovered.config.openaiProject.trim()) {
            openaiProject = discovered.config.openaiProject.trim();
        }

        debugPort = resolveDebugPort({
            explicitPort: args.port,
            configPort: discovered.config.debugPort
        });

        if (!args.output && typeof discovered.config.outputDir === 'string' && discovered.config.outputDir.trim()) {
            const outputDir = discovered.config.outputDir.trim();
            const resolvedOutputDir = path.isAbsolute(outputDir)
                ? outputDir
                : path.resolve(path.dirname(discovered.configPath || process.cwd()), outputDir);
            try {
                fs.mkdirSync(resolvedOutputDir, { recursive: true });
                outputCsv = path.join(resolvedOutputDir, path.basename(outputCsv));
            } catch {}
        }
    }

    if (!args.config && discovered.calibrationPath) {
        configFile = discovered.calibrationPath;
    }
}

function runCalibrationScript(port, outputFilePath) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [
                calibrationScriptPath,
                '--port',
                String(port),
                '--output',
                outputFilePath,
                '--timeout-ms',
                '60000'
            ],
            {
                stdio: 'inherit',
                shell: false
            }
        );
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
    });
}

function askQuestion(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(String(answer || '').trim()));
    });
}

async function askRequired(rl, question) {
    while (true) {
        const value = await askQuestion(rl, question);
        if (value) return value;
        console.log('输入不能为空，请重试。');
    }
}

async function askPositiveInteger(rl, question, defaultValue = null) {
    while (true) {
        const raw = await askQuestion(rl, question);
        if (!raw && Number.isFinite(defaultValue) && defaultValue > 0) {
            return defaultValue;
        }
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
        console.log('请输入有效的正整数。');
    }
}

async function ensureRuntimeConfig() {
    const discovered = discoverInstalledBossRecruitResources();
    applyDiscoveredResources(discovered);
    applyOpenAIEnvironmentDefaults();

    const hasCoreConfig = Boolean(baseUrl && apiKey && model);
    const hasScreeningInputs = Boolean(criteria && Number.isFinite(targetCount) && targetCount > 0);
    const needsInteractive = !hasCoreConfig || !hasScreeningInputs;

    if (!needsInteractive) {
        return;
    }

    if (!process.stdin.isTTY) {
        printUsage();
        throw new Error('Missing required parameters in non-interactive mode.');
    }

    console.log('========================================');
    console.log('Boss Screen CLI Interactive Setup');
    console.log('========================================');

    if (discovered.configPath) {
        console.log(`发现可用 screening-config.json: ${discovered.configPath}`);
    } else {
        console.log('未发现可用 screening-config.json，需要手动输入 LLM 参数。');
    }
    if (isUsableCalibrationFile(configFile)) {
        console.log(`发现可用校准文件: ${configFile}`);
    } else {
        console.log('未发现可用校准文件：将优先使用DOM收藏；仅在DOM不可用时才需要calibration回退。');
    }
    console.log('');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        if (!criteria) {
            criteria = await askRequired(rl, 'Step 1/6 请输入筛选标准 criteria: ');
        }

        if (!Number.isFinite(targetCount) || targetCount <= 0) {
            targetCount = await askPositiveInteger(rl, 'Step 2/6 请输入目标处理人数 targetCount (例如 10): ', 10);
        }

        if (!args.port) {
            debugPort = await askPositiveInteger(rl, `Step 3/6 请输入 Chrome 调试端口 (默认 ${debugPort}): `, debugPort);
        }

        if (!baseUrl) {
            baseUrl = await askRequired(rl, 'Step 4/6 请输入 LLM Base URL: ');
        }
        if (!apiKey) {
            apiKey = await askRequired(rl, 'Step 5/6 请输入 LLM API Key: ');
        }
        if (!model) {
            model = await askRequired(rl, 'Step 6/6 请输入 LLM 模型型号: ');
        }
    } finally {
        rl.close();
    }

}

function loadCalibration() {
    if (!isUsableCalibrationFile(configFile)) {
        return null;
    }
    const content = fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(content);
    if (!data || !data.favoritePosition) {
        return null;
    }
    return data.favoritePosition;
}

async function getChromeTab() {
    return getChromeTabWithGuard({ autoLaunchIfMissing: process.stdin.isTTY === true });
}

function createTaggedError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) {
        error.cause = cause;
    }
    return error;
}

function getChromeExecutablePath() {
    const candidates = [
        process.env.BOSS_RECRUIT_CHROME_PATH,
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {}
    }
    return null;
}

function getChromeUserDataDirForPort(port) {
    const codexHome = process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), '.codex');
    const dir = path.join(codexHome, 'boss-recruit-mcp', `chrome-profile-${port}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function launchChromeDebugInstance(port) {
    const chromePath = getChromeExecutablePath();
    if (!chromePath) {
        return {
            ok: false,
            error: '未找到 Chrome 可执行文件，请先安装 Chrome 或设置 BOSS_RECRUIT_CHROME_PATH。'
        };
    }

    try {
        const userDataDir = getChromeUserDataDirForPort(port);
        const child = spawn(
            chromePath,
            [
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${userDataDir}`,
                '--new-window',
                bossSearchUrl
            ],
            {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            }
        );
        child.unref();
        return {
            ok: true,
            chromePath,
            userDataDir
        };
    } catch (error) {
        return {
            ok: false,
            error: `启动 Chrome 失败: ${error.message}`
        };
    }
}

async function listChromeTabsOnPort(port) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(createTaggedError('DEBUG_PORT_BAD_STATUS', `DevTools 返回状态码 ${res.statusCode}`));
                    return;
                }
                try {
                    const tabs = JSON.parse(data);
                    if (!Array.isArray(tabs)) {
                        reject(createTaggedError('DEBUG_PORT_BAD_RESPONSE', 'DevTools 返回数据不是数组'));
                        return;
                    }
                    resolve(tabs);
                } catch (error) {
                    reject(createTaggedError('DEBUG_PORT_BAD_RESPONSE', `DevTools 返回无法解析: ${error.message}`, error));
                }
            });
        });

        req.setTimeout(5000, () => {
            req.destroy(createTaggedError('DEBUG_PORT_TIMEOUT', `连接调试端口 ${port} 超时`));
        });

        req.on('error', (error) => {
            const tagged = createTaggedError(
                'DEBUG_PORT_UNAVAILABLE',
                `无法连接调试端口 ${port}: ${error.message}`,
                error
            );
            tagged.originalCode = error.code;
            reject(tagged);
        });
    });
}

function findBossTabFromTabs(tabs) {
    return tabs.find((tab) => tab && typeof tab.url === 'string' && tab.url.includes('zhipin.com')) || null;
}

function isDebugPortUnavailableError(error) {
    if (!error) return false;
    if (error.code === 'DEBUG_PORT_UNAVAILABLE' || error.code === 'DEBUG_PORT_TIMEOUT') return true;
    const msg = String(error.message || '');
    return /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|connect)/i.test(msg);
}

async function promptUserAfterChromeAutoLaunch(port) {
    console.log('');
    console.log(`端口 ${port} 未检测到可用 Chrome 调试实例，已自动启动新的 Chrome 窗口。`);
    console.log('请在该窗口中完成以下操作：');
    console.log('1. 登录 Boss 账号');
    console.log('2. 打开 Boss 搜索页并完成你要筛选的搜索条件');
    console.log('3. 保持页面停留在搜索结果相关页面');
    console.log('');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        while (true) {
            const answer = (await askQuestion(rl, '完成后输入 done 继续（输入 quit 退出）: ')).toLowerCase();
            if (['done', 'd', 'ok', 'yes', 'y', '完成', '已完成', '继续', 'ready'].includes(answer)) {
                return true;
            }
            if (['quit', 'q', 'exit', 'no', 'n', '取消'].includes(answer)) {
                return false;
            }
            console.log('未识别输入，请输入 done 或 quit。');
        }
    } finally {
        rl.close();
    }
}

async function waitForBossTabAfterConfirmation(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const tabs = await listChromeTabsOnPort(port);
            const bossTab = findBossTabFromTabs(tabs);
            if (bossTab) {
                return bossTab;
            }
        } catch {}
        await sleep(800);
    }
    return null;
}

async function getChromeTabWithGuard(options = {}) {
    const autoLaunchIfMissing = options.autoLaunchIfMissing === true;

    try {
        const tabs = await listChromeTabsOnPort(debugPort);
        const bossTab = findBossTabFromTabs(tabs);
        if (bossTab) {
            return bossTab;
        }
        throw createTaggedError('BOSS_TAB_NOT_FOUND', `调试端口 ${debugPort} 可连接，但未找到 Boss 页面`);
    } catch (error) {
        if (!isDebugPortUnavailableError(error) || !autoLaunchIfMissing) {
            throw error;
        }

        const launchResult = launchChromeDebugInstance(debugPort);
        if (!launchResult.ok) {
            throw createTaggedError('CHROME_AUTO_LAUNCH_FAILED', launchResult.error);
        }

        console.log(`已自动启动 Chrome: ${launchResult.chromePath}`);
        console.log(`调试端口: ${debugPort}`);

        const confirmed = await promptUserAfterChromeAutoLaunch(debugPort);
        if (!confirmed) {
            throw createTaggedError('USER_ABORTED_PREPARE_SEARCH', '用户取消了登录/搜索准备流程');
        }

        const bossTab = await waitForBossTabAfterConfirmation(debugPort, 20000);
        if (!bossTab) {
            throw createTaggedError('BOSS_TAB_NOT_FOUND_AFTER_CONFIRM', '用户确认完成后仍未检测到 Boss 页面，请检查是否在正确端口打开');
        }

        return bossTab;
    }
}

class CDPClient {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.msgId = 0;
        this.pending = new Map();
        this.networkListeners = new Map();
        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && this.pending.has(msg.id)) {
                this.pending.get(msg.id)(msg);
                this.pending.delete(msg.id);
            } else if (msg.method && this.networkListeners.has(msg.method)) {
                this.networkListeners.get(msg.method)(msg.params);
            }
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.pending.set(id, (msg) => {
                if (msg.result) {
                    const result = msg.result.result || msg.result;
                    resolve(result.value !== undefined ? result.value : result);
                } else if (msg.error) {
                    reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                    reject(new Error('Unknown CDP response: ' + JSON.stringify(msg)));
                }
            });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    resolve(null);
                }
            }, 10000);
        });
    }

    on(method, callback) {
        this.networkListeners.set(method, callback);
    }

    close() {
        this.ws.close();
    }
}

let capturedResumeData = null;
let resumeRequestId = null;
let favoriteActionResult = null;
let favoriteRequestId = null;
let pendingFavoriteClick = false;

async function enableNetworkInterception(cdp) {
    await cdp.send('Network.enable');
    
    cdp.on('Network.requestWillBeSent', (params) => {
        if (params.request && params.request.url) {
            const url = params.request.url;
            
            if (url.includes('/wapi/zpitem/web/boss/search/geek/info')) {
                resumeRequestId = params.requestId;
            }
            if (url.includes('userMark')) {
                favoriteRequestId = params.requestId;
                if (pendingFavoriteClick) {
                    if (url.includes('/add')) {
                        favoriteActionResult = 'add';
                        console.log(`  [检测到] 收藏请求 add`);
                    } else if (url.includes('/del')) {
                        favoriteActionResult = 'del';
                        console.log(`  [检测到] 收藏请求 del`);
                    }
                    pendingFavoriteClick = false;
                }
            }
            if (url.includes('actionLog/common.json') && pendingFavoriteClick) {
                const postData = params.request.postData;
                if (postData) {
                    try {
                        const payload = JSON.parse(postData);
                        if (payload.action === 'star-interest-click') {
                            if (payload.p3 === 1) {
                                favoriteActionResult = 'add';
                                console.log(`  [actionLog检测到] 添加收藏`);
                            } else if (payload.p3 === 0) {
                                favoriteActionResult = 'del';
                                console.log(`  [actionLog检测到] 取消收藏`);
                            }
                            pendingFavoriteClick = false;
                        }
                    } catch (e) {}
                }
            }
        }
    });
    cdp.on('Network.loadingFinished', (params) => {
        if (params.requestId === resumeRequestId) {
            setTimeout(async () => {
                try {
                    const responseBody = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
                    if (responseBody && responseBody.body) {
                        const data = JSON.parse(responseBody.body);
                        if (data && data.zpData) {
                            capturedResumeData = data.zpData;
                        }
                    }
                } catch (e) {}
            }, 100);
        }
        if (params.requestId === favoriteRequestId) {
            setTimeout(async () => {
                try {
                    const responseBody = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
                    if (responseBody && responseBody.body) {
                        const url = responseBody.url || '';
                        if (url.includes('/add')) {
                            favoriteActionResult = 'add';
                        } else if (url.includes('/del')) {
                            favoriteActionResult = 'del';
                        }
                    }
                } catch (e) {}
            }, 100);
        }
    });
}

async function getResumeDataViaCDP(cdp, requestId) {
    try {
        const responseBody = await cdp.send('Network.getResponseBody', { requestId: requestId });
        if (responseBody && responseBody.body) {
            const data = JSON.parse(responseBody.body);
            if (data && data.zpData) {
                return data.zpData;
            }
        }
    } catch (e) {
        console.log('  CDP获取简历失败');
    }
    return null;
}

const jsGetList = `(function(){
    var frame=window.frames['searchFrame'];
    if(!frame)return JSON.stringify({error:'searchFrame not found'});
    var doc=frame.document||frame.contentDocument;
    if(!doc)return JSON.stringify({error:'cannot access frame'});

    // 优先使用 li.card-item 选择器（与扩展一致）
    var cards=doc.querySelectorAll('li.card-item');

    // 备用：使用 a[data-jid][data-itemid] 选择器
    if(cards.length===0){
        cards=doc.querySelectorAll('a[data-jid][data-itemid]');
    }

    // 再备用：所有 li 元素
    if(cards.length===0){
        cards=doc.querySelectorAll('li');
    }

    return JSON.stringify({totalCards:cards.length});
})()`;

const jsGetNextCard = (idx) => '(function(idx){' +
    'try{' +
    'var frame=window.frames["searchFrame"];' +
    'if(!frame)return JSON.stringify({error:"searchFrame not found"});' +
    'var doc=frame.document||frame.contentDocument;' +
    'if(!doc)return JSON.stringify({error:"cannot access frame doc"});' +
    'var allCards=doc.querySelectorAll("li.card-item");' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("a[data-jid][data-itemid]");}' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("li");}' +
    'if(allCards.length===0){return JSON.stringify({found:false,total:0,error:"no cards found"});}' +
    'if(idx>=allCards.length){return JSON.stringify({found:false,total:allCards.length,error:"index out of range"});}' +
    'var card=null;var count=0;' +
    'for(var i=0;i<allCards.length;i++){' +
    'var c=allCards[i];' +
    'if(c&&(c.dataset||c.getAttribute)){' +
    'if(count===idx){card=c;break;}' +
    'count++;}' +
    '}' +
    'if(!card){return JSON.stringify({found:false,total:allCards.length,error:"card element not found at index "+idx});}' +
    'var jid="";var itemid="";' +
    'if(card.dataset){jid=card.dataset.jid||"";itemid=card.dataset.itemid||"";}' +
    'else if(card.getAttribute){jid=card.getAttribute("data-jid")||"";itemid=card.getAttribute("data-itemid")||"";}' +
    'var cardText=card.innerText||card.textContent||"";' +
    'return JSON.stringify({found:true,index:idx,jid:jid,itemid:itemid,total:allCards.length,hasName:cardText.length>0,preview:cardText.substring(0,50)});' +
    '}catch(e){return JSON.stringify({error:e.message});}' +
    '})(' + idx + ')';

const jsFindNextUnprocessedCard = `(function(startIdx, processedKeys){
    var frame=window.frames["searchFrame"];
    if(!frame)return JSON.stringify({error:'searchFrame not found'});
    var doc=frame.document||frame.contentDocument;
    var allCards=doc.querySelectorAll("li.card-item");
    if(allCards.length===0){allCards=doc.querySelectorAll("a[data-jid][data-itemid]");}
    if(allCards.length===0){allCards=doc.querySelectorAll("li");}
    if(allCards.length===0){return JSON.stringify({found:false,total:0,error:'no cards found'});}

    for(var i=startIdx;i<allCards.length;i++){
        var card=allCards[i];
        if(!card)continue;

        // 优先从 data-lid 获取唯一标识 (与扩展一致)
        var linkEl=card.querySelector('a[data-lid]');
        var lid='';
        if(linkEl){
            lid=linkEl.getAttribute('data-lid')||'';
            var match=lid.match(/lookupsearchgeek\\.(\\d+)/);
            if(match){lid='geek_'+match[1];}
        }

        // 备用: data-jid, data-geek, data-geekid
        var jid='';
        if(card.dataset){
            jid=card.dataset.jid||card.dataset.geek||card.dataset.geekid||'';
        } else if(card.getAttribute){
            jid=card.getAttribute('data-jid')||card.getAttribute('data-geek')||card.getAttribute('data-geekid')||'';
        }

        var cardText=card.innerText||card.textContent||'';
        // 生成 key: 优先用 lid > jid > (itemid+文本前20字)
        var key=lid||jid;
        if(!key){
            var itemid='';
            if(card.dataset){
                itemid=card.dataset.itemid||'';
            } else if(card.getAttribute){
                itemid=card.getAttribute('data-itemid')||'';
            }
            key=itemid+'_'+cardText.substring(0,20);
        }

        if(processedKeys&&processedKeys.has&&processedKeys.has(key)){
            continue;
        }
        return JSON.stringify({found:true,index:i,jid:key,lid:lid,itemid:jid,total:allCards.length,key:key,hasName:cardText.length>0});
    }
    return JSON.stringify({found:false,total:allCards.length,error:'all cards processed'});
})`;
const jsClickCard = (idx) => '(function(idx){' +
    'var frame=window.frames["searchFrame"];' +
    'if(!frame)return JSON.stringify({error:"searchFrame not found"});' +
    'var doc=frame.document||frame.contentDocument;' +
    'var allCards=doc.querySelectorAll("li.card-item");' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("a[data-jid][data-itemid]");}' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("li");}' +
    'if(allCards.length===0)return JSON.stringify({error:"no cards found"});' +
    'if(idx>=allCards.length)return JSON.stringify({error:"Index out of range: "+idx});' +
    'var card=null;var count=0;' +
    'for(var i=0;i<allCards.length;i++){' +
    'var c=allCards[i];' +
    'if(c&&(c.dataset||c.getAttribute)){' +
    'if(count===idx){card=c;break;}' +
    'count++;}' +
    '}' +
    'if(!card)return JSON.stringify({error:"card not found at index "+idx});' +
    'if(card.click){card.click();return JSON.stringify({success:true,method:"direct-click"});}' +
    'var evt=new MouseEvent("click",{bubbles:true,cancelable:true,view:window});' +
    'card.dispatchEvent(evt);' +
    'return JSON.stringify({success:true,method:"dispatch-event"});' +
    '})(' + idx + ')';

const jsGetCardPosition = (idx) => '(function(idx){' +
    'try{' +
    'var frame=window.frames["searchFrame"];' +
    'if(!frame)return JSON.stringify({error:"searchFrame not found"});' +
    'var doc=frame.document||frame.contentDocument;' +
    'var allCards=doc.querySelectorAll("li.card-item");' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("a[data-jid][data-itemid]");}' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("li");}' +
    'if(allCards.length===0)return JSON.stringify({error:"no cards found"});' +
    'var card=null;var count=0;' +
    'for(var i=0;i<allCards.length;i++){' +
    'var c=allCards[i];' +
    'if(c&&(c.dataset||c.getAttribute)){' +
    'if(count===idx){card=c;break;}' +
    'count++;}' +
    '}' +
    'if(!card)return JSON.stringify({error:"card not found at index "+idx});' +
    'card.scrollIntoView({behavior:"smooth",block:"center"});' +
    'return JSON.stringify({success:true,scrolled:true});' +
    '}catch(e){return JSON.stringify({error:e.message});}' +
    '})(' + idx + ')';

const jsGetCardPositionAfterScroll = (idx) => '(function(idx){' +
    'try{' +
    'var frame=window.frames["searchFrame"];' +
    'if(!frame)return JSON.stringify({error:"searchFrame not found"});' +
    'var doc=frame.document||frame.contentDocument;' +
    'var allCards=doc.querySelectorAll("li.card-item");' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("a[data-jid][data-itemid]");}' +
    'if(allCards.length===0){allCards=doc.querySelectorAll("li");}' +
    'if(allCards.length===0)return JSON.stringify({error:"no cards found"});' +
    'var card=null;var count=0;' +
    'for(var i=0;i<allCards.length;i++){' +
    'var c=allCards[i];' +
    'if(c&&(c.dataset||c.getAttribute)){' +
    'if(count===idx){card=c;break;}' +
    'count++;}' +
    '}' +
    'if(!card)return JSON.stringify({error:"card not found at index "+idx});' +
    'var rect=card.getBoundingClientRect();' +
    'var iframe=frame.frameElement;' +
    'var iframeRect=iframe?iframe.getBoundingClientRect():{left:0,top:0};' +
    'var x=iframeRect.left+rect.left+rect.width/2;' +
    'var y=iframeRect.top+rect.top+rect.height/2;' +
    'return JSON.stringify({success:true,x:Math.round(x),y:Math.round(y),width:Math.round(rect.width),height:Math.round(rect.height)});' +
    '}catch(e){return JSON.stringify({error:e.message});}' +
    '})(' + idx + ')';

const jsWaitForResume = `(function(){
    var iframes=document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
        var src=iframes[i].src||'';
        if(src.includes('c-resume')||src.includes('resume')||src.includes('geek')){
            try{
                if(iframes[i].contentDocument&&iframes[i].contentDocument.readyState==='complete'){
                    return JSON.stringify({found:true,state:'complete'});
                }
            }catch(e){}
            return JSON.stringify({found:true,state:'loading'});
        }
    }
    return JSON.stringify({found:false});
})()`;

const jsGetResumeInfo = `(function(){
    var iframes=document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
        var src=iframes[i].src||'';
        if(src.includes('c-resume')||src.includes('resume')||src.includes('geek')){
            try{
                var iframe=iframes[i];
                var iframeDoc=iframe.contentDocument||iframe.contentWindow.document;
                if(!iframeDoc||!iframeDoc.body)return JSON.stringify({error:'cannot access resume doc'});

                // 优先获取内部文本内容
                var bodyText=iframeDoc.body.innerText||'';
                if(bodyText&&bodyText.length>50){
                    var info={name:'',school:'',major:'',company:'',position:'',resumeText:bodyText.substring(0,5000)};

                    // 尝试提取姓名
                    var nameEl=iframeDoc.querySelector('.name-panel .name')||iframeDoc.querySelector('.geek-top .name')||iframeDoc.querySelector('.geek-name')||iframeDoc.querySelector('[class*="name"]');
                    if(nameEl)info.name=nameEl.textContent.trim();

                    // 尝试提取学校
                    var schoolEl=iframeDoc.querySelector('.school-name')||iframeDoc.querySelector('.edu-school')||iframeDoc.querySelector('[class*="school"]');
                    if(schoolEl)info.school=schoolEl.textContent.trim();

                    // 尝试提取公司
                    var companyEl=iframeDoc.querySelector('.company-name')||iframeDoc.querySelector('.exp-company')||iframeDoc.querySelector('[class*="company"]');
                    if(companyEl)info.company=companyEl.textContent.trim();

                    return JSON.stringify(info);
                }

                // 如果没有文本，尝试获取innerHTML
                var htmlText=iframeDoc.body.innerHTML||'';
                if(htmlText){
                    // 去除script和style标签内容
                    htmlText=htmlText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'');
                    htmlText=htmlText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'');
                    // 获取纯文本
                    var temp=iframeDoc.createElement('div');
                    temp.innerHTML=htmlText;
                    var pureText=temp.textContent||temp.innerText||'';
                    if(pureText.length>50){
                        return JSON.stringify({resumeText:pureText.substring(0,5000)});
                    }
                }

                return JSON.stringify({error:'no content found'});
            }catch(e){
                return JSON.stringify({error:e.message});
            }
        }
    }
    return JSON.stringify({error:'resume iframe not found'});
})()`;

const jsCloseResume = `(function(){
    // 使用更精确的关闭按钮选择器，与Chrome扩展一致
    var closeSelectors=[
        '.boss-popup__close',
        '.popup-close',
        '.modal-close',
        '.dialog-close',
        '[class*="close"]',
        '.close-btn',
        'button[aria-label*="关闭"]',
        'button[title*="关闭"]',
        '.icon-close'
    ];

    for(var i=0;i<closeSelectors.length;i++){
        var closeBtns=document.querySelectorAll(closeSelectors[i]);
        for(var j=0;j<closeBtns.length;j++){
            var btn=closeBtns[j];
            try{
                // 跳过不可见的按钮
                if(btn.offsetParent===null)continue;
                btn.click();

                // 使用更精确的modal选择器，与jsIsResumeClosed一致
                var modal=btn.closest('.boss-popup__wrapper')||btn.closest('.boss-popup_wrapper')||btn.closest('.boss-dialog_wrapper')||btn.closest('.dialog-wrap')||btn.closest('.boss-dialog')||btn.closest('[class*="popup"][class*="wrapper"]')||btn.closest('[class*="dialog"][class*="wrapper"]')||btn.closest('.geek-detail-modal');
                if(modal){
                    var style=window.getComputedStyle(modal);
                    if(style.display==='none'||style.visibility==='hidden'){
                        return JSON.stringify({success:true,method:'btn-click',selector:closeSelectors[i]});
                    }
                } else {
                    // 没有找到modal容器，也认为关闭成功
                    return JSON.stringify({success:true,method:'btn-click',selector:closeSelectors[i]});
                }
            }catch(e){}
        }
    }

    // 尝试发送ESC键关闭
    var escEvent=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true});
    document.dispatchEvent(escEvent);
    document.body.dispatchEvent(escEvent);
    return JSON.stringify({success:true,method:'ESC'});
})()`;

const jsIsResumeClosed = `(function(){
    // 使用更精确的选择器，避免误判列表页上的普通元素为弹窗
    // 与Chrome扩展一致：同时需要"popup/dialog"和"wrapper"两个类特征
    var popupSelectors=[
        '.boss-popup__wrapper',
        '.boss-popup_wrapper',
        '.boss-dialog_wrapper',
        '.dialog-wrap.active',
        '.boss-dialog',
        '[class*="popup"][class*="wrapper"]',
        '[class*="dialog"][class*="wrapper"]',
        '.geek-detail-modal'
    ];
    for(var i=0;i<popupSelectors.length;i++){
        try{
            var popups=document.querySelectorAll(popupSelectors[i]);
            for(var j=0;j<popups.length;j++){
                if(popups[j].offsetParent!==null){
                    var style=window.getComputedStyle(popups[j]);
                    if(style.display!=='none'&&style.visibility!=='hidden'){
                        return JSON.stringify({closed:false,reason:'popup visible: '+popupSelectors[i]});
                    }
                }
            }
        }catch(e){}
    }

    // 检查resume iframe是否可见
    var iframes=document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
        var src=iframes[i].src||'';
        if(src.includes('c-resume')||src.includes('resume')||src.includes('geek')){
            try{
                if(iframes[i].offsetParent!==null){
                    var style=window.getComputedStyle(iframes[i]);
                    if(style.display!=='none'&&style.visibility!=='hidden'){
                        return JSON.stringify({closed:false,reason:'resume iframe visible'});
                    }
                }
            }catch(e){}
        }
    }

    return JSON.stringify({closed:true,reason:'no popup or iframe visible'});
})()`;

async function closeResumePage(cdp, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        console.log(`  关闭详情页 (尝试 ${attempt + 1}/${maxRetries})...`);

        const closeResultRaw = await cdp.send('Runtime.evaluate', { expression: jsCloseResume, returnByValue: true });
        const closeResult = parseResult(closeResultRaw);

        await sleep(humanDelay(500, 200));

        const isClosedRaw = await cdp.send('Runtime.evaluate', { expression: jsIsResumeClosed, returnByValue: true });
        const isClosed = parseResult(isClosedRaw);

        if (isClosed && isClosed.closed) {
            console.log(`  详情页已关闭 (${isClosed.reason})`);
            return true;
        }

        console.log(`  详情页未关闭 (${isClosed?.reason || 'unknown'})，重试...`);
        await sleep(humanDelay(500, 200));
    }

    console.log('  详情页关闭失败，尝试强制关闭...');

    const checkRaw = await cdp.send('Runtime.evaluate', { expression: jsIsResumeClosed, returnByValue: true });
    const checkResult = parseResult(checkRaw);
    if (checkResult && checkResult.closed) {
        console.log(`  已确认在列表页 (${checkResult.reason})`);
        return true;
    }

    console.log('  详情页仍打开，发送ESC键强制关闭...');
    await cdp.send('Runtime.evaluate', { expression: `(function(){
        var escEvent=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true});
        document.dispatchEvent(escEvent);
        document.body.dispatchEvent(escEvent);
        return JSON.stringify({success:true});
    })()`, returnByValue: true });
    await sleep(humanDelay(1000, 300));

    console.log('  再次发送ESC键...');
    await cdp.send('Runtime.evaluate', { expression: `(function(){
        var escEvent=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true});
        document.dispatchEvent(escEvent);
        document.body.dispatchEvent(escEvent);
        return JSON.stringify({success:true});
    })()`, returnByValue: true });
    await sleep(1000);

    const finalCheck = await cdp.send('Runtime.evaluate', { expression: jsIsResumeClosed, returnByValue: true });
    const finalResult = parseResult(finalCheck);
    if (finalResult && finalResult.closed) {
        console.log(`  强制关闭成功`);
        return true;
    }

    console.log('  无法确认页面状态');
    return false;
}

const jsGetScrollPosition = `(function(){
    var frame=window.frames['searchFrame'];
    if(!frame)return JSON.stringify({error:'searchFrame not found'});
    var iframeDoc=frame.document||frame.contentDocument;
    return JSON.stringify({
        scrollTop: iframeDoc.body.scrollTop,
        scrollHeight: iframeDoc.body.scrollHeight,
        clientHeight: iframeDoc.body.clientHeight
    });
})()`;

const jsDetectBottom = `(function(){
    var frame=window.frames['searchFrame'];
    if(!frame)return JSON.stringify({isBottom:false,reason:'searchFrame not found'});
    var iframeDoc=frame.document||frame.contentDocument;

    var bottomSelectors=['.no-more','.list-end','.end-tip','.empty-tip','.no-more-tip','.list-no-more'];
    var bottomKeywords=['没有更多','已加载全部','已经到底','没有数据了','暂无更多','已显示全部'];

    for(var i=0;i<bottomSelectors.length;i++){
        var els=iframeDoc.querySelectorAll(bottomSelectors[i]);
        for(var j=0;j<els.length;j++){
            if(els[j]&&els[j].offsetParent!==null){
                var text=els[j].textContent||'';
                for(var k=0;k<bottomKeywords.length;k++){
                    if(text.indexOf(bottomKeywords[k])!==-1){
                        return JSON.stringify({isBottom:true,reason:'bottom text found: '+bottomKeywords[k]});
                    }
                }
            }
        }
    }

    var divs=iframeDoc.querySelectorAll('div,span,p');
    for(var i=0;i<divs.length;i++){
        if(divs[i].offsetParent===null)continue;
        var text=divs[i].textContent||'';
        if(text.length>50)continue;
        for(var k=0;k<bottomKeywords.length;k++){
            if(text.indexOf(bottomKeywords[k])!==-1){
                return JSON.stringify({isBottom:true,reason:'keyword found: '+bottomKeywords[k]});
            }
        }
    }

    return JSON.stringify({isBottom:false,reason:'no bottom indicator'});
})()`;

const jsScrollAndLoadMore = `(function(){
    var frame=window.frames['searchFrame'];
    if(!frame)return JSON.stringify({error:'searchFrame not found'});
    var iframeDoc=frame.document||frame.contentDocument;

    // 记录滚动前位置
    var beforePos={
        scrollTop: iframeDoc.body.scrollTop,
        scrollHeight: iframeDoc.body.scrollHeight,
        clientHeight: iframeDoc.body.clientHeight
    };

    // 方式1: 滚动最后一个 li 元素
    var lastLi=iframeDoc.querySelector('li.geek-info-card:last-child')||iframeDoc.querySelector('li:last-child');
    if(lastLi){
        lastLi.scrollIntoView({behavior:'smooth',block:'end'});
    }

    // 方式2: 直接设置 scrollTop
    var targetScroll=iframeDoc.body.scrollHeight-iframeDoc.body.clientHeight;
    iframeDoc.body.scrollTop=targetScroll;

    // 方式3: 使用 window.scrollTo
    var win=window.frames['searchFrame'];
    if(win&&win.scrollTo){
        win.scrollTo(0,iframeDoc.body.scrollHeight);
    }

    // 触发滚动事件
    var scrollEvent=new Event('scroll',{bubbles:true});
    iframeDoc.body.dispatchEvent(scrollEvent);

    // 记录滚动后位置
    var afterPos={
        scrollTop: iframeDoc.body.scrollTop,
        scrollHeight: iframeDoc.body.scrollHeight,
        clientHeight: iframeDoc.body.clientHeight
    };

    return JSON.stringify({
        before: beforePos,
        after: afterPos,
        scrolled: beforePos.scrollTop!==afterPos.scrollTop||beforePos.scrollHeight!==afterPos.scrollHeight
    });
})()`;

const jsClickFavorite = (px, py) => `(function(px,py){var iframes=document.querySelectorAll('iframe');for(var i=0;i<iframes.length;i++){var iframe=iframes[i];if(iframe.src&&iframe.src.includes('c-resume')){try{var iframeDoc=iframe.contentDocument||iframe.contentWindow.document;var canvases=iframeDoc.querySelectorAll('canvas');if(canvases.length>0){var canvas=canvases[0];var rect=canvas.getBoundingClientRect();var mousedownEvent=new MouseEvent('mousedown',{view:window,bubbles:true,cancelable:true,clientX:px,clientY:py,pageX:px,pageY:py,button:0});var mouseupEvent=new MouseEvent('mouseup',{view:window,bubbles:true,cancelable:true,clientX:px,clientY:py,pageX:px,pageY:py,button:0});var clickEvent=new MouseEvent('click',{view:window,bubbles:true,cancelable:true,clientX:px,clientY:py,pageX:px,pageY:py,button:0});canvas.dispatchEvent(mousedownEvent);canvas.dispatchEvent(mouseupEvent);canvas.dispatchEvent(clickEvent);return JSON.stringify({success:true,canvasRect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},clickPos:{x:px,y:py}});}}catch(e){return JSON.stringify({success:false,error:e.message});}break;}}return JSON.stringify({success:false,error:'Canvas not found'});})(` + px + `,` + py + `)`;

const jsGetFavoriteCanvasPosition = `(function(){
    var iframes=document.querySelectorAll('iframe');
    for(var i=0;i<iframes.length;i++){
        var iframe=iframes[i];
        if(iframe.src&&iframe.src.includes('c-resume')){
            try{
                var iframeDoc=iframe.contentDocument||iframe.contentWindow.document;
                var canvases=iframeDoc.querySelectorAll('canvas');
                if(canvases.length>0){
                    var canvas=canvases[0];
                    var canvasRect=canvas.getBoundingClientRect();
                    var iframeRect=iframe.getBoundingClientRect();
                    return JSON.stringify({
                        success:true,
                        absX:Math.round(iframeRect.left+canvasRect.left),
                        absY:Math.round(iframeRect.top+canvasRect.top),
                        width:Math.round(canvasRect.width),
                        height:Math.round(canvasRect.height)
                    });
                }
            }catch(e){
                return JSON.stringify({success:false,error:e.message});
            }
            break;
        }
    }
    return JSON.stringify({success:false,error:'Canvas not found'});
})()`;

const jsGetFavoriteDomState = `(function(){
    function isFrameVisible(iframe){
        if(!iframe) return false;
        try{
            var rect=iframe.getBoundingClientRect();
            if(!rect||rect.width<=0||rect.height<=0) return false;
            var style=window.getComputedStyle?window.getComputedStyle(iframe):null;
            if(style&&(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||'1')<=0)) return false;
            return true;
        }catch(e){
            return false;
        }
    }
    function isButtonVisible(btn,view){
        if(!btn) return false;
        try{
            var rect=btn.getBoundingClientRect();
            if(!rect||rect.width<=0||rect.height<=0) return false;
            var style=(view&&view.getComputedStyle)?view.getComputedStyle(btn):null;
            if(style&&(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||'1')<=0)) return false;
            return true;
        }catch(e){
            return false;
        }
    }
    function pickButton(doc){
        if(!doc) return null;
        var selectors=[
            'div.interested[aria-label*="收藏"]',
            'div.interested:not(.already-interested)',
            'div.interested',
            '.interested'
        ];
        var view=doc.defaultView||window;
        for(var i=0;i<selectors.length;i++){
            var nodes=doc.querySelectorAll(selectors[i]);
            for(var j=0;j<nodes.length;j++){
                if(isButtonVisible(nodes[j],view)){
                    return {button:nodes[j],selector:selectors[i]};
                }
            }
        }
        return null;
    }
    function buildState(match,source){
        var btn=match.button;
        var aria=(btn.getAttribute('aria-label')||'').trim();
        var already=btn.classList.contains('already-interested')||aria.indexOf('取消收藏')>=0||aria.indexOf('已收藏')>=0;
        var rect=btn.getBoundingClientRect();
        var clickX=Math.round(rect.left+rect.width/2);
        var clickY=Math.round(rect.top+rect.height/2);
        if(source&&source.iframe){
            var iframeRect=source.iframe.getBoundingClientRect();
            clickX=Math.round(iframeRect.left+rect.left+rect.width/2);
            clickY=Math.round(iframeRect.top+rect.top+rect.height/2);
        }
        return {
            success:true,
            found:true,
            source:source&&source.type?source.type:'top',
            iframeSrc:source&&source.iframe?String(source.iframe.getAttribute('src')||source.iframe.src||''):'',
            selector:match.selector,
            ariaLabel:aria,
            className:btn.className||'',
            alreadyInterested:already,
            clickX:clickX,
            clickY:clickY
        };
    }

    try{
        var topMatch=pickButton(document);
        if(topMatch){
            return JSON.stringify(buildState(topMatch,{type:'top'}));
        }

        var iframes=document.querySelectorAll('iframe');
        for(var i=0;i<iframes.length;i++){
            var iframe=iframes[i];
            if(!isFrameVisible(iframe)) continue;
            try{
                var doc=iframe.contentDocument||(iframe.contentWindow&&iframe.contentWindow.document);
                if(!doc) continue;
                var frameMatch=pickButton(doc);
                if(frameMatch){
                    return JSON.stringify(buildState(frameMatch,{type:'iframe',iframe:iframe}));
                }
            }catch(e){
                // ignore inaccessible iframe
            }
        }

        return JSON.stringify({
            success:true,
            found:false,
            reason:'favorite dom button not found in top document or accessible iframes'
        });
    }catch(e){
        return JSON.stringify({success:false,reason:e.message||String(e)});
    }
})()`;

const jsClickFavoriteDom = `(function(){
    function isFrameVisible(iframe){
        if(!iframe) return false;
        try{
            var rect=iframe.getBoundingClientRect();
            if(!rect||rect.width<=0||rect.height<=0) return false;
            var style=window.getComputedStyle?window.getComputedStyle(iframe):null;
            if(style&&(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||'1')<=0)) return false;
            return true;
        }catch(e){
            return false;
        }
    }
    function isButtonVisible(btn,view){
        if(!btn) return false;
        try{
            var rect=btn.getBoundingClientRect();
            if(!rect||rect.width<=0||rect.height<=0) return false;
            var style=(view&&view.getComputedStyle)?view.getComputedStyle(btn):null;
            if(style&&(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||'1')<=0)) return false;
            return true;
        }catch(e){
            return false;
        }
    }
    function findButton(doc){
        if(!doc) return null;
        var selectors=[
            'div.interested[aria-label*="收藏"]',
            'div.interested:not(.already-interested)',
            'div.interested',
            '.interested'
        ];
        var view=doc.defaultView||window;
        for(var i=0;i<selectors.length;i++){
            var nodes=doc.querySelectorAll(selectors[i]);
            for(var j=0;j<nodes.length;j++){
                if(isButtonVisible(nodes[j],view)){
                    return {button:nodes[j],selector:selectors[i],doc:doc};
                }
            }
        }
        return null;
    }
    function dispatchHumanLikeClick(btn,doc){
        var view=(doc&&doc.defaultView)?doc.defaultView:window;
        var MouseCtor=view.MouseEvent||MouseEvent;
        var rect=btn.getBoundingClientRect();
        var cx=rect.left+rect.width/2;
        var cy=rect.top+rect.height/2;
        var opts={bubbles:true,cancelable:true,composed:true,view:view,clientX:cx,clientY:cy,button:0};
        btn.dispatchEvent(new MouseCtor('mousemove',opts));
        btn.dispatchEvent(new MouseCtor('mousedown',opts));
        btn.dispatchEvent(new MouseCtor('mouseup',opts));
        btn.dispatchEvent(new MouseCtor('click',opts));
        if(typeof btn.click==='function'){
            btn.click();
        }
    }
    try{
        var found=findButton(document);
        var source='top';
        var iframeSrc='';

        if(!found){
            var iframes=document.querySelectorAll('iframe');
            for(var i=0;i<iframes.length;i++){
                var iframe=iframes[i];
                if(!isFrameVisible(iframe)) continue;
                try{
                    var doc=iframe.contentDocument||(iframe.contentWindow&&iframe.contentWindow.document);
                    if(!doc) continue;
                    found=findButton(doc);
                    if(found){
                        source='iframe';
                        iframeSrc=String(iframe.getAttribute('src')||iframe.src||'');
                        break;
                    }
                }catch(e){
                    // ignore inaccessible iframe
                }
            }
        }

        if(!found){
            return JSON.stringify({success:false,reason:'favorite dom button not found in top document or accessible iframes'});
        }

        var btn=found.button;
        var aria=(btn.getAttribute('aria-label')||'').trim();
        var already=btn.classList.contains('already-interested')||aria.indexOf('取消收藏')>=0||aria.indexOf('已收藏')>=0;
        if(already){
            return JSON.stringify({success:true,clicked:false,alreadyInterested:true,source:source,iframeSrc:iframeSrc,selector:found.selector});
        }

        dispatchHumanLikeClick(btn,found.doc);
        return JSON.stringify({success:true,clicked:true,alreadyInterested:false,source:source,iframeSrc:iframeSrc,selector:found.selector});
    }catch(e){
        return JSON.stringify({success:false,reason:e.message||String(e)});
    }
})()`;

const jsGetCardCount = `(function(){
    var frame=window.frames['searchFrame'];
    if(!frame)return '0';
    var doc=frame.document||frame.contentDocument;

    // 优先使用 li.card-item 选择器
    var cards=doc.querySelectorAll('li.card-item');
    if(cards.length===0){
        cards=doc.querySelectorAll('a[data-jid][data-itemid]');
    }
    if(cards.length===0){
        cards=doc.querySelectorAll('li');
    }

    return String(cards.length);
})()`;

const jsGetDownloadPopupState = `(function(){
    try{
        var popup=document.querySelector('.boss-popup__wrapper.dialog-bosszp-download');
        var currentUrl=window.location.href||'';
        if(!popup){
            return JSON.stringify({found:false,visible:false,currentUrl:currentUrl});
        }
        var style=window.getComputedStyle(popup);
        var visible=popup.offsetParent!==null&&style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0';
        return JSON.stringify({found:true,visible:visible,currentUrl:currentUrl});
    }catch(e){
        return JSON.stringify({found:false,visible:false,currentUrl:window.location.href||'',error:e.message});
    }
})()`;

const jsRecoverFromDownloadPopup = (mode, targetUrl) => `(function(mode,targetUrl){
    try{
        var popup=document.querySelector('.boss-popup__wrapper.dialog-bosszp-download');
        if(popup){
            var closeBtn=popup.querySelector('.boss-popup__close')||popup.querySelector('.icon-close');
            if(closeBtn){
                try{closeBtn.click();}catch(e){}
            }
        }
        if(mode==='navigate'){
            window.location.href=targetUrl;
            return JSON.stringify({success:true,action:'navigate',targetUrl:targetUrl});
        }
        window.location.reload();
        return JSON.stringify({success:true,action:'reload'});
    }catch(e){
        return JSON.stringify({success:false,error:e.message,action:mode});
    }
})(${JSON.stringify(mode)},${JSON.stringify(targetUrl)})`;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function humanDelay(baseMs, varianceMs) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(100, baseMs + z * varianceMs);
}

function generateBezierPath(start, end, steps = 20) {
    const path = [];
    const midX = (start.x + end.x) / 2 + (Math.random() - 0.5) * 100;
    const midY = (start.y + end.y) / 2 + (Math.random() - 0.5) * 50;
    
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * midX + Math.pow(t, 2) * end.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * midY + Math.pow(t, 2) * end.y;
        path.push({ x, y });
    }
    return path;
}

async function simulateMouseMoveToArea(cdp, targetX, targetY, startX, startY) {
    const actualStartX = startX || Math.round(Math.random() * 200 + 100);
    const actualStartY = startY || Math.round(Math.random() * 200 + 100);
    const path = generateBezierPath(
        { x: actualStartX, y: actualStartY },
        { x: targetX, y: targetY }
    );

    console.log(`  [鼠标轨迹] 从 (${actualStartX}, ${actualStartY}) 移动到 (${targetX}, ${targetY}), 路径点数: ${path.length}`);

    for (let i = 0; i < path.length; i++) {
        const point = path[i];
        const jitterX = Math.round((Math.random() - 0.5) * 3);
        const jitterY = Math.round((Math.random() - 0.5) * 3);
        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: Math.round(point.x) + jitterX,
                y: Math.round(point.y) + jitterY
            });
        } catch (e) {}
        await sleep(Math.random() * 20 + 5);
    }

    await sleep(humanDelay(300, 100));
    console.log(`  [鼠标轨迹] 移动完成，悬停中...`);
}

async function scrollDetailPage(cdp) {
    console.log(`  [滚动] 开始模拟阅读简历...`);

    const areaX = 600 + Math.floor(Math.random() * 400);
    const areaY = 300 + Math.floor(Math.random() * 300);

    console.log(`  [滚动] 移动鼠标到内容区域 (${areaX}, ${areaY})`);
    await simulateMouseMoveToArea(cdp, areaX, areaY);

    const downSteps = 2 + Math.floor(Math.random() * 2);
    const downDelta = 2000 + Math.floor(Math.random() * 2000);
    const totalDownDelta = downSteps * downDelta;

    const upSteps = 1 + Math.floor(Math.random() * 3);
    const upDelta = Math.ceil(totalDownDelta / upSteps) + 500 + Math.floor(Math.random() * 500);

    console.log(`  [滚动] 向下滚动 ${downSteps} 次，每次 ${downDelta}px`);

    for (let i = 0; i < downSteps; i++) {
        const hoverJitterX = Math.round((Math.random() - 0.5) * 6);
        const hoverJitterY = Math.round((Math.random() - 0.5) * 6);
        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: areaX + hoverJitterX,
                y: areaY + hoverJitterY
            });
        } catch (e) {}
        await sleep(100 + Math.floor(Math.random() * 200));

        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: areaX,
                y: areaY,
                deltaX: 0,
                deltaY: downDelta
            });
            console.log(`  [滚动] 第 ${i + 1}/${downSteps} 次向下滚动完成`);
            await sleep(200 + Math.floor(Math.random() * 300));
        } catch (e) {}
    }

    await sleep(humanDelay(1000, 300));

    console.log(`  [滚动] 向上滚动 ${upSteps} 次，每次 ${upDelta}px`);

    for (let i = 0; i < upSteps; i++) {
        const hoverJitterX = Math.round((Math.random() - 0.5) * 6);
        const hoverJitterY = Math.round((Math.random() - 0.5) * 6);
        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: areaX + hoverJitterX,
                y: areaY + hoverJitterY
            });
        } catch (e) {}
        await sleep(100 + Math.floor(Math.random() * 200));

        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: areaX,
                y: areaY,
                deltaX: 0,
                deltaY: -upDelta
            });
            console.log(`  [滚动] 第 ${i + 1}/${upSteps} 次向上滚动完成`);
            await sleep(200 + Math.floor(Math.random() * 300));
        } catch (e) {}
    }

    await sleep(humanDelay(500, 200));
    console.log(`  [滚动] 模拟阅读完成`);

    return true;
}

async function simulateHumanClick(cdp, targetX, targetY) {
    targetX = Math.round(targetX);
    targetY = Math.round(targetY);

    if (targetX < 0 || targetY < 0) {
        throw new Error(`Invalid coordinates: (${targetX}, ${targetY})`);
    }

    const startPos = {
        x: Math.round(Math.random() * 200 + 100),
        y: Math.round(Math.random() * 200 + 100)
    };

    const path = generateBezierPath(startPos, { x: targetX, y: targetY });

    console.log(`  [鼠标轨迹] 从 (${startPos.x}, ${startPos.y}) 移动到 (${targetX}, ${targetY}), 路径点数: ${path.length}`);

    for (const point of path) {
        const jitterX = Math.round((Math.random() - 0.5) * 3);
        const jitterY = Math.round((Math.random() - 0.5) * 3);
        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: Math.round(point.x) + jitterX,
                y: Math.round(point.y) + jitterY
            });
        } catch (e) {
            // 忽略移动错误
        }
        await sleep(Math.random() * 20 + 5);
    }

    const hoverSteps = 3 + Math.floor(Math.random() * 5);
    console.log(`  [鼠标轨迹] 悬停中，抖动 ${hoverSteps} 次...`);
    for (let i = 0; i < hoverSteps; i++) {
        const hoverJitterX = Math.round((Math.random() - 0.5) * 6);
        const hoverJitterY = Math.round((Math.random() - 0.5) * 6);
        try {
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: targetX + hoverJitterX,
                y: targetY + hoverJitterY
            });
        } catch (e) {}
        await sleep(Math.random() * 20 + 10);
    }

    const hoverDuration = humanDelay(820, 200);
    console.log(`  [鼠标轨迹] 悬停等待 ${Math.round(hoverDuration)}ms...`);
    await sleep(hoverDuration);

    try {
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: targetX,
            y: targetY,
            button: 'left',
            clickCount: 1
        });
        console.log(`  [鼠标轨迹] mousePressed`);

        await sleep(Math.random() * 50 + 30);

        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: targetX,
            y: targetY,
            button: 'left',
            clickCount: 1
        });
        console.log(`  [鼠标轨迹] mouseReleased，点击完成`);
    } catch (e) {
        throw new Error(`CDP click failed: ${e.message}`);
    }

    return true;
}

function saveProgressToCsv(candidates, filepath) {
    if (candidates.length === 0) {
        console.log('  没有可保存的结果');
        return false;
    }
    try {
        const header = '姓名,最高学历学校,最高学历专业,最近工作公司,最近工作职位,评估通过详细原因\n';
        const rows = candidates.map(c =>
            `"${c.name || ''}","${c.school || ''}","${c.major || ''}","${c.company || ''}","${c.position || ''}","${c.reason || ''}"`
        ).join('\n');
        fs.writeFileSync(filepath, '\ufeff' + header + rows, 'utf8');
        return true;
    } catch (e) {
        console.log('  保存失败:', e.message);
        return false;
    }
}

function setupSaveSignalHandler(passedCandidates, outputCsv) {
    let saveRequested = false;
    let paused = false;
    let stopRequested = false;
    let hasPrintedPauseHint = false;
    let cleanedUp = false;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        process.off('SIGINT', onSigint);
        if (process.stdin.isTTY) {
            try {
                process.stdin.setRawMode(false);
            } catch {}
        }
    };

    const saveAndExit = () => {
        console.log('\n收到中断信号，正在保存当前进度...');
        if (saveProgressToCsv(passedCandidates, outputCsv)) {
            console.log(`已保存 ${passedCandidates.length} 条结果到: ${outputCsv}`);
        }
        cleanup();
        process.exit(0);
    };

    const onSigint = () => {
        stopRequested = true;
    };

    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.resume();
        process.stdin.setRawMode(true);
    }

    process.on('SIGINT', onSigint);

    if (process.stdin.isTTY) {
        process.stdin.on('keypress', (str, key) => {
            if (!key) return;
            if (key.ctrl && key.name === 's') {
                saveRequested = true;
                return;
            }
            if (key.ctrl && key.name === 'p') {
                paused = !paused;
                console.log(paused ? '\n已暂停筛选（再次按 Ctrl+P 继续）' : '\n继续筛选...');
                return;
            }
            if (key.ctrl && key.name === 'c') {
                stopRequested = true;
            }
        });
    }

    const checkAndHandleControl = async () => {
        if (stopRequested) {
            saveAndExit();
        }

        if (saveRequested) {
            saveRequested = false;
            console.log('\n========================================');
            console.log('快速保存已触发!');
            console.log(`当前已通过: ${passedCandidates.length} 人`);
            if (saveProgressToCsv(passedCandidates, outputCsv)) {
                console.log(`结果已保存到: ${outputCsv}`);
            }
            console.log('继续筛选...');
            console.log('========================================');
        }

        while (paused) {
            if (!hasPrintedPauseHint) {
                hasPrintedPauseHint = true;
                console.log('暂停中：按 Ctrl+P 继续，按 Ctrl+S 保存，按 Ctrl+C 保存并退出');
            }

            if (stopRequested) {
                saveAndExit();
            }

            if (saveRequested) {
                saveRequested = false;
                if (saveProgressToCsv(passedCandidates, outputCsv)) {
                    console.log(`暂停中已保存到: ${outputCsv}`);
                }
            }

            await sleep(300);
        }
        hasPrintedPauseHint = false;
    };

    checkAndHandleControl.cleanup = cleanup;
    return checkAndHandleControl;
}

function parseResult(result) {
    if (result === null || result === undefined) return null;
    if (typeof result === 'string') {
        try {
            return JSON.parse(result);
        } catch {
            return result;
        }
    }
    return result;
}

function resolveChatCompletionsEndpoint(rawBaseUrl) {
    const cleaned = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
    if (!cleaned) {
        throw new Error('LLM baseUrl is empty');
    }
    if (/\/chat\/completions$/i.test(cleaned)) {
        return cleaned;
    }
    return `${cleaned}/chat/completions`;
}

function extractTextFromContentParts(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }

    const parts = [];
    for (const item of content) {
        if (!item) continue;
        if (typeof item === 'string') {
            parts.push(item);
            continue;
        }
        if (typeof item.text === 'string') {
            parts.push(item.text);
            continue;
        }
        if (typeof item.output_text === 'string') {
            parts.push(item.output_text);
        }
    }
    return parts.length ? parts.join('\n') : null;
}

function extractAssistantText(data) {
    const directChoiceContent = data?.choices?.[0]?.message?.content;
    const fromChoiceMessage = extractTextFromContentParts(directChoiceContent);
    if (fromChoiceMessage) return fromChoiceMessage;

    const fromChoiceText = data?.choices?.[0]?.text;
    if (typeof fromChoiceText === 'string' && fromChoiceText.trim()) {
        return fromChoiceText;
    }

    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
        return data.output_text;
    }

    if (Array.isArray(data?.output)) {
        const outputParts = [];
        for (const block of data.output) {
            const extracted = extractTextFromContentParts(block?.content);
            if (extracted) {
                outputParts.push(extracted);
            }
        }
        if (outputParts.length) {
            return outputParts.join('\n');
        }
    }

    return null;
}

async function getDownloadPopupState(cdp) {
    const raw = await cdp.send('Runtime.evaluate', { expression: jsGetDownloadPopupState, returnByValue: true });
    const parsed = parseResult(raw);
    if (!parsed || typeof parsed !== 'object') {
        return {
            found: false,
            visible: false,
            currentUrl: '',
            error: 'invalid popup state response'
        };
    }
    return parsed;
}

async function recoverFromDownloadPopup(cdp, mode, targetUrl) {
    const expr = jsRecoverFromDownloadPopup(mode, targetUrl);
    const raw = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const parsed = parseResult(raw);
    if (!parsed || typeof parsed !== 'object') {
        return { success: false, error: 'invalid recover response', action: mode };
    }
    return parsed;
}

async function ensureDownloadPopupCleared(cdp, options = {}) {
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 3;
    const expectedUrl = options.expectedUrl || bossSearchUrl;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const state = await getDownloadPopupState(cdp);
        const currentUrl = String(state.currentUrl || '');
        const onSearchPage = currentUrl.includes('/web/chat/search');

        if (!state.visible) {
            if (!onSearchPage) {
                console.log(`  当前不在Boss搜索页，重新导航到搜索页 (尝试 ${attempt}/${maxAttempts})...`);
                const navResult = await recoverFromDownloadPopup(cdp, 'navigate', expectedUrl);
                if (!navResult.success) {
                    return {
                        ok: false,
                        error: `navigate failed: ${navResult.error || 'unknown'}`
                    };
                }
                await sleep(3500);
                continue;
            }
            console.log('  下载广告弹窗检查通过');
            return { ok: true };
        }

        const mode = attempt % 2 === 1 ? 'reload' : 'navigate';
        console.log(`  检测到下载广告弹窗，执行${mode === 'reload' ? '刷新' : '重进搜索页'}恢复 (尝试 ${attempt}/${maxAttempts})...`);
        const recoverResult = await recoverFromDownloadPopup(cdp, mode, expectedUrl);
        if (!recoverResult.success) {
            return {
                ok: false,
                error: `${mode} failed: ${recoverResult.error || 'unknown'}`
            };
        }
        await sleep(3500);
    }

    const finalState = await getDownloadPopupState(cdp);
    if (finalState.visible) {
        return {
            ok: false,
            error: 'download popup still visible after recovery'
        };
    }

    const finalUrl = String(finalState.currentUrl || '');
    if (!finalUrl.includes('/web/chat/search')) {
        return {
            ok: false,
            error: `boss search page not ready after recovery, current url: ${finalUrl || 'unknown'}`
        };
    }

    return { ok: true };
}

function formatResumeApiData(data) {
    const parts = [];

    const geekDetail = data.geekDetail || data;
    const baseInfo = geekDetail.geekBaseInfo || {};
    const expectList = geekDetail.geekExpectList || [];
    const workExpList = geekDetail.geekWorkExpList || [];
    const projExpList = geekDetail.geekProjExpList || [];
    const eduExpList = geekDetail.geekEduExpList || geekDetail.geekEducationList || [];
    const advantage = geekDetail.geekAdvantage || baseInfo.userDesc || baseInfo.userDescription || '';
    const skillList = geekDetail.geekSkillList || geekDetail.skillList || [];

    parts.push('=== 基本信息===');
    if (baseInfo.name) parts.push('姓名: ' + baseInfo.name);
    if (baseInfo.ageDesc) parts.push('年龄: ' + baseInfo.ageDesc);
    if (baseInfo.gender !== undefined) parts.push('性别: ' + (baseInfo.gender === 1 ? '男' : '女'));
    if (baseInfo.degreeCategory) parts.push('学历: ' + baseInfo.degreeCategory);
    if (baseInfo.workYearDesc) parts.push('工作经验: ' + baseInfo.workYearDesc);
    if (baseInfo.activeTimeDesc) parts.push('活跃状态: ' + baseInfo.activeTimeDesc);
    if (baseInfo.applyStatusContent) parts.push('求职状态: ' + baseInfo.applyStatusContent);

    if (expectList.length > 0) {
        parts.push('\n=== 期望工作 ===');
        expectList.forEach((expect, index) => {
            parts.push(`${index + 1}. 期望城市: ${expect.locationName || '未知'}`);
            if (expect.positionName) parts.push('   期望职位: ' + expect.positionName);
            if (expect.salaryDesc) parts.push('   期望薪资: ' + expect.salaryDesc);
            if (expect.industryDesc) parts.push('   期望行业: ' + expect.industryDesc);
        });
    }

    if (advantage) {
        parts.push('\n=== 个人优势 ===');
        parts.push(advantage.replace(/<em class='h'>/g, '').replace(/<\/em>/g, ''));
    }

    if (workExpList.length > 0) {
        parts.push('\n=== 工作经历 ===');
        workExpList.forEach((exp, index) => {
            const company = exp.company || '';
            const position = (exp.positionName || '').replace(/<em class='h'>/g, '').replace(/<\/em>/g, '');
            parts.push(`${index + 1}. ${company} - ${position}`);
            if (exp.startYearMonStr) {
                parts.push('   时间: ' + exp.startYearMonStr + ' ~ ' + (exp.endYearMonStr || '至今'));
            }
            if (exp.responsibility) {
                const responsibility = exp.responsibility.replace(/<em class='h'>/g, '').replace(/<\/em>/g, '');
                parts.push('   职责: ' + responsibility);
            }
        });
    }

    if (projExpList.length > 0) {
        parts.push('\n=== 项目经历 ===');
        projExpList.forEach((proj, index) => {
            parts.push(`${index + 1}. ${proj.name || '未知项目'}`);
            if (proj.roleName) parts.push('   角色: ' + proj.roleName);
            if (proj.startYearMonStr) {
                parts.push('   时间: ' + proj.startYearMonStr + ' ~ ' + (proj.endYearMonStr || '至今'));
            }
            if (proj.description) {
                const description = proj.description.replace(/<em class='h'>/g, '').replace(/<\/em>/g, '');
                parts.push('   描述: ' + description);
            }
            if (proj.performance) {
                const performance = proj.performance.replace(/<em class='h'>/g, '').replace(/<\/em>/g, '');
                parts.push('   成果: ' + performance);
            }
        });
    }

    if (eduExpList.length > 0) {
        parts.push('\n=== 教育经历 ===');
        eduExpList.forEach((edu, index) => {
            parts.push(`${index + 1}. ${edu.school || edu.schoolName || '未知学校'}`);
            if (edu.major || edu.majorName) parts.push('   专业: ' + (edu.major || edu.majorName));
            if (edu.degree || edu.degreeCategory) parts.push('   学历: ' + (edu.degree || edu.degreeCategory));
            if (edu.startYearMonStr) {
                parts.push('   时间: ' + edu.startYearMonStr + ' ~ ' + (edu.endYearMonStr || ''));
            }
        });
    }

    if (skillList.length > 0) {
        parts.push('\n=== 技能标签 ===');
        skillList.forEach((skill) => {
            if (skill.skillName || skill.name) {
                parts.push('- ' + (skill.skillName || skill.name) + (skill.level ? ' (' + skill.level + ')' : ''));
            }
        });
    }

    return parts.join('\n');
}

async function callLLM(prompt, maxRetries = 3) {
    const strictPrompt = `【重要】你必须且只能返回以下格式的JSON，禁止返回任何其他文字、解释或格式：

{"passed":true/false,"reason":"通过/不通过的具体原因","summary":"简历摘要"}

【示例响应】
{"passed":true,"reason":"硕士学历，符合本科及以上要求","summary":"厦门大学硕士，研究方向匹配"}

请直接返回JSON，不要有任何前缀或后缀文字：

${prompt}`;

    const llmEndpoint = resolveChatCompletionsEndpoint(baseUrl);
    const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };
    if (openaiOrganization) {
        requestHeaders['OpenAI-Organization'] = openaiOrganization;
    }
    if (openaiProject) {
        requestHeaders['OpenAI-Project'] = openaiProject;
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let response;
        try {
            response = await fetch(llmEndpoint, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: strictPrompt }],
                    temperature: 0.1,
                    max_tokens: 500
                })
            });
        } catch (error) {
            if (attempt < maxRetries - 1) {
                console.log(`  LLM网络请求失败，重试 (${attempt + 1}/${maxRetries})...`);
                await sleep(800 + attempt * 400);
                continue;
            }
            throw new Error(`LLM网络请求失败(endpoint=${llmEndpoint}): ${error.message}`);
        }

        if (!response.ok) {
            const errorText = await response.text();
            const retryableStatus = new Set([429, 500, 502, 503, 504]);
            if (retryableStatus.has(response.status) && attempt < maxRetries - 1) {
                console.log(`  LLM返回${response.status}，重试 (${attempt + 1}/${maxRetries})...`);
                await sleep(800 + attempt * 400);
                continue;
            }
            throw new Error(`API请求失败(endpoint=${llmEndpoint}): ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();

        if (data.error) {
            throw new Error(`API错误: ${data.error.message}`);
        }

        const content = extractAssistantText(data);
        if (!content) {
            if (attempt < maxRetries - 1) {
                console.log('  LLM响应中未找到可解析文本，重试...');
                await sleep(800 + attempt * 400);
                continue;
            }
            throw new Error('LLM返回中缺少可解析文本（expected choices[0].message.content）');
        }

        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                if (typeof result.passed === 'boolean' && result.reason && result.summary) {
                    return content;
                }
            }
            if (attempt < maxRetries - 1) {
                console.log('  LLM返回格式不规范，重试...');
                continue;
            }
        } catch (e) {
            if (attempt < maxRetries - 1) {
                console.log('  JSON解析失败，重试...');
                continue;
            }
        }

        return content;
    }

    throw new Error('LLM返回格式不规范，已达最大重试次数');
}

async function main() {
    await ensureRuntimeConfig();

    console.log('========================================');
    console.log('BOSS直聘简历筛选CLI工具 (Node.js)');
    console.log('========================================');
    console.log('');
    console.log('配置:');
    console.log(`  目标人数: ${targetCount}`);
    console.log(`  模型: ${model}`);
    console.log(`  筛选标准: ${criteria}`);
    console.log('');

    const pos = loadCalibration();
    if (pos) {
        console.log(`已加载校准坐标: pageX=${pos.pageX}, pageY=${pos.pageY}`);
    } else {
        console.log('未加载校准坐标：将优先使用DOM收藏，必要时再回退calibration。');
    }
    console.log('');

    console.log('[1/6] 连接Chrome...');
    const tab = await getChromeTab();
    console.log(`找到: ${tab.title}`);

    const cdp = new CDPClient(tab.webSocketDebuggerUrl);
    await new Promise(r => setTimeout(r, 500));
    console.log('WebSocket已连接!');

    console.log('[1.5/6] 启用网络拦截...');
    await enableNetworkInterception(cdp);
    console.log('网络拦截已启用!');
    console.log('');

    console.log('[2/6] 检查当前页面状态...');
    const currentUrl = await cdp.send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true });
    console.log(`当前页面: ${currentUrl}`);
    console.log('');

    console.log('[2.5/6] 检查下载广告弹窗...');
    const popupReady = await ensureDownloadPopupCleared(cdp, { maxAttempts: 4, expectedUrl: bossSearchUrl });
    if (!popupReady.ok) {
        console.error(`错误: ${popupReady.error}`);
        cdp.close();
        process.exit(1);
    }
    console.log('');

    console.log('[3/6] 获取列表页信息...');
    const listInfoRaw = await cdp.send('Runtime.evaluate', { expression: jsGetList, returnByValue: true });

    const listInfo = parseResult(listInfoRaw);

    if (!listInfo || listInfo.error) {
        console.error(`错误: ${listInfo ? listInfo.error : 'CDP timeout'}`);
        cdp.close();
        process.exit(1);
    }
    console.log(`当前列表页显示: ${listInfo.totalCards} 个人选`);
    console.log('');

    console.log('[4/6] 开始筛选流程...');
    console.log('========================================');
    console.log('快捷键: Ctrl+S 保存当前进度 | Ctrl+P 暂停/继续 | Ctrl+C 保存并退出');
    console.log('========================================');
    console.log('');

    const passedCandidates = [];
    let processedCount = 0;
    let currentCardIndex = 0;
    let lastCardCount = listInfo.totalCards;
    let scrollRetryCount = 0;
    const maxScrollRetries = 3;
    const processedCardKeys = new Set();
    let consecutiveCount = 0;
    let restThreshold = 30 + Math.floor(Math.random() * 11);
    let uncertainFavoriteCount = 0;
    let lastVisibleCandidateKeys = [];
    let currentCandidateKey = null;
    const failureStreaks = {
        detail_load: 0,
        resume_extract: 0
    };

    function buildCheckpointPayload() {
        const completedCandidateKeys = Array.from(processedCardKeys).filter((key) => key !== currentCandidateKey);
        const stableProcessedCount = currentCandidateKey ? Math.max(processedCount - 1, 0) : processedCount;
        return {
            round_index: roundIndex || null,
            criteria,
            target_count: targetCount,
            output_csv: outputCsv,
            checkpoint_path: checkpointPath,
            processed_count: stableProcessedCount,
            passed_count: passedCandidates.length,
            current_card_index: currentCardIndex,
            completed_candidate_keys: completedCandidateKeys,
            current_candidate_key: currentCandidateKey,
            last_visible_candidate_keys: lastVisibleCandidateKeys,
            uncertain_favorite_count: uncertainFavoriteCount,
            consecutive_count: consecutiveCount,
            rest_threshold: restThreshold,
            failure_streaks: { ...failureStreaks },
            passed_candidates: passedCandidates.map((candidate) => ({
                name: candidate.name || '',
                school: candidate.school || '',
                major: candidate.major || '',
                company: candidate.company || '',
                position: candidate.position || '',
                reason: candidate.reason || '',
                summary: candidate.summary || ''
            }))
        };
    }

    function saveCheckpoint() {
        if (!checkpointPath) return;
        writeJsonAtomic(checkpointPath, buildCheckpointPayload());
    }

    function loadCheckpointIfNeeded() {
        if (!resumeRequested || !checkpointPath || !fs.existsSync(checkpointPath)) return false;
        const checkpoint = safeReadJson(checkpointPath);
        if (!checkpoint || typeof checkpoint !== 'object') {
            const error = new Error(`无法读取 checkpoint: ${checkpointPath}`);
            error.code = 'RESUME_CHECKPOINT_INVALID';
            error.recoverable = false;
            throw error;
        }
        if (typeof checkpoint.output_csv === 'string' && checkpoint.output_csv.trim()) {
            outputCsv = path.resolve(checkpoint.output_csv);
        }
        processedCount = Number.isInteger(checkpoint.processed_count) && checkpoint.processed_count >= 0
            ? checkpoint.processed_count
            : processedCount;
        currentCardIndex = Number.isInteger(checkpoint.current_card_index) && checkpoint.current_card_index >= 0
            ? checkpoint.current_card_index
            : currentCardIndex;
        uncertainFavoriteCount = Number.isInteger(checkpoint.uncertain_favorite_count) && checkpoint.uncertain_favorite_count >= 0
            ? checkpoint.uncertain_favorite_count
            : uncertainFavoriteCount;
        consecutiveCount = Number.isInteger(checkpoint.consecutive_count) && checkpoint.consecutive_count >= 0
            ? checkpoint.consecutive_count
            : consecutiveCount;
        restThreshold = Number.isInteger(checkpoint.rest_threshold) && checkpoint.rest_threshold > 0
            ? checkpoint.rest_threshold
            : restThreshold;
        currentCandidateKey = normalizeText(checkpoint.current_candidate_key || '') || null;
        lastVisibleCandidateKeys = Array.isArray(checkpoint.last_visible_candidate_keys)
            ? checkpoint.last_visible_candidate_keys.filter(Boolean)
            : [];
        processedCardKeys.clear();
        for (const key of Array.isArray(checkpoint.completed_candidate_keys) ? checkpoint.completed_candidate_keys.filter(Boolean) : []) {
            processedCardKeys.add(key);
        }
        passedCandidates.splice(0, passedCandidates.length, ...(
            Array.isArray(checkpoint.passed_candidates)
                ? checkpoint.passed_candidates.map((candidate) => ({
                    name: candidate?.name || '',
                    school: candidate?.school || '',
                    major: candidate?.major || '',
                    company: candidate?.company || '',
                    position: candidate?.position || '',
                    reason: candidate?.reason || '',
                    summary: candidate?.summary || ''
                }))
                : []
        ));
        if (checkpoint.failure_streaks && typeof checkpoint.failure_streaks === 'object') {
            failureStreaks.detail_load = Number.isInteger(checkpoint.failure_streaks.detail_load) && checkpoint.failure_streaks.detail_load >= 0
                ? checkpoint.failure_streaks.detail_load
                : 0;
            failureStreaks.resume_extract = Number.isInteger(checkpoint.failure_streaks.resume_extract) && checkpoint.failure_streaks.resume_extract >= 0
                ? checkpoint.failure_streaks.resume_extract
                : 0;
        }
        return true;
    }

    function shouldPauseAtBoundary() {
        return resolvePauseControl(pauseControlPath).pause_requested === true;
    }

    function buildTerminalState(completionReason) {
        return {
            processedCount,
            passedCandidates,
            outputCsv,
            checkpointPath,
            currentCardIndex,
            currentCandidateKey,
            completedCandidateKeys: Array.from(processedCardKeys),
            completionReason
        };
    }

    function finalizeCandidateBoundary() {
        currentCandidateKey = null;
        saveCheckpoint();
    }

    const checkAndHandleSave = setupSaveSignalHandler(passedCandidates, outputCsv);
    const restoredFromCheckpoint = loadCheckpointIfNeeded();
    if (restoredFromCheckpoint) {
        console.log(`[恢复] 已从 checkpoint 恢复，已处理 ${processedCount} 位候选人。`);
    }

    while (processedCount < targetCount) {
        console.log('');
        console.log('----------------------------------------');
        console.log(`处理进度: 已处理 ${processedCount}/${targetCount}（目标处理人数） 已通过 ${passedCandidates.length} 人 未确认收藏 ${uncertainFavoriteCount} 人`);

        if (shouldPauseAtBoundary()) {
            saveCheckpoint();
            emitStructuredResult('PAUSED', buildTerminalState('paused'));
            if (typeof checkAndHandleSave.cleanup === 'function') {
                checkAndHandleSave.cleanup();
            }
            cdp.close();
            return;
        }
        currentCandidateKey = null;

        const processedKeysArray = Array.from(processedCardKeys);
        lastVisibleCandidateKeys = processedKeysArray;
        const findCardExpr = jsFindNextUnprocessedCard + '(' + currentCardIndex + ',' + JSON.stringify(processedKeysArray) + ')';
        const nextCardRaw = await cdp.send('Runtime.evaluate', { expression: findCardExpr, returnByValue: true });
        const nextCard = parseResult(nextCardRaw);

        await checkAndHandleSave();


        if (!nextCard || !nextCard.found) {
            console.log('列表已到底，尝试滚动加载更多...');

            const scrollBeforeRaw = await cdp.send('Runtime.evaluate', { expression: jsGetScrollPosition, returnByValue: true });
            const scrollBefore = parseResult(scrollBeforeRaw);

            const scrollResultRaw = await cdp.send('Runtime.evaluate', { expression: jsScrollAndLoadMore, returnByValue: true });
            const scrollResult = parseResult(scrollResultRaw);

            await sleep(humanDelay(1500, 500));

            const scrollAfterRaw = await cdp.send('Runtime.evaluate', { expression: jsGetScrollPosition, returnByValue: true });
            const scrollAfter = parseResult(scrollAfterRaw);

            const bottomResultRaw = await cdp.send('Runtime.evaluate', { expression: jsDetectBottom, returnByValue: true });
            const bottomResult = parseResult(bottomResultRaw);

            const newCountRaw = await cdp.send('Runtime.evaluate', { expression: jsGetCardCount, returnByValue: true });
            const newCount = parseResult(newCountRaw);
            const actualNewCount = typeof newCount === 'string' ? parseInt(newCount, 10) : (typeof newCount === 'number' ? newCount : 0);

            const didScroll = scrollBefore && scrollAfter &&
                (scrollBefore.scrollTop !== scrollAfter.scrollTop ||
                 scrollBefore.scrollHeight !== scrollAfter.scrollHeight);

            if (bottomResult && bottomResult.isBottom) {
                console.log(`检测到底部提示: ${bottomResult.reason}`);
                console.log('已到达列表底部，结束筛选');
                break;
            }

            if (actualNewCount > lastCardCount) {
                lastCardCount = actualNewCount;
                scrollRetryCount = 0;
                console.log(`加载成功，当前共 ${lastCardCount} 个人选`);
                continue;
            }

            if (!didScroll) {
                console.log('滚动未生效，重试...');
                scrollRetryCount++;
                if (scrollRetryCount >= maxScrollRetries) {
                    console.log('滚动多次未生效，结束筛选');
                    break;
                }
                continue;
            }

            scrollRetryCount++;
            if (scrollRetryCount >= maxScrollRetries) {
                console.log('已无法加载更多候选人，结束筛选');
                break;
            }
            console.log(`滚动后数量未增加，重试 (${scrollRetryCount}/${maxScrollRetries})...`);
            continue;
        }

        processedCount++;
        const cardKey = nextCard.key || nextCard.jid || ('item_' + nextCard.index);
        processedCardKeys.add(cardKey);
        currentCandidateKey = cardKey;
        currentCardIndex = nextCard.index + 1;
        console.log('');
        console.log(`>>> 点击第 ${nextCard.index + 1} 位人选 (key: ${cardKey})`);

        const scrollResultRaw = await cdp.send('Runtime.evaluate', { expression: jsGetCardPosition(nextCard.index), returnByValue: true });
        const scrollResult = parseResult(scrollResultRaw);
        
        if (scrollResult && scrollResult.success && scrollResult.scrolled) {
            console.log(`  滚动到卡片位置 (center)`);
            await sleep(humanDelay(500, 200));
        }
        
        const cardPosRaw = await cdp.send('Runtime.evaluate', { expression: jsGetCardPositionAfterScroll(nextCard.index), returnByValue: true });
        const cardPos = parseResult(cardPosRaw);
        
        if (cardPos && cardPos.success && cardPos.x && cardPos.y) {
            console.log(`  卡片坐标: (${cardPos.x}, ${cardPos.y}), 尺寸: ${cardPos.width}x${cardPos.height}`);
            const offsetX = Math.floor(Math.random() * 60) - 30;
            const maxOffsetY = Math.min(50, Math.floor(cardPos.height / 3));
            const offsetY = Math.floor(Math.random() * maxOffsetY * 2) - maxOffsetY;
            const clickX = cardPos.x + offsetX;
            const clickY = cardPos.y + offsetY;
            console.log(`  使用CDP鼠标轨迹点击 (${clickX}, ${clickY}) [偏移: ${offsetX}, ${offsetY}]...`);
            try {
                await simulateHumanClick(cdp, clickX, clickY);
                console.log('  鼠标轨迹点击完成');
            } catch (e) {
                console.log(`  CDP点击失败: ${e.message}，回退到JS点击`);
                const clickResultRaw = await cdp.send('Runtime.evaluate', { expression: jsClickCard(nextCard.index), returnByValue: true });
                const clickResult = parseResult(clickResultRaw);
                if (!clickResult || !clickResult.success) {
                    console.log(`  JS点击也失败: ${clickResult ? clickResult.error : 'CDP timeout'}`);
                    finalizeCandidateBoundary();
                    continue;
                }
            }
        } else {
            console.log(`  无法获取卡片坐标，使用JS点击: ${cardPos?.error || 'unknown'}`);
            const clickResultRaw = await cdp.send('Runtime.evaluate', { expression: jsClickCard(nextCard.index), returnByValue: true });
            const clickResult = parseResult(clickResultRaw);
            if (!clickResult || !clickResult.success) {
                console.log(`  点击失败: ${clickResult ? clickResult.error : 'CDP timeout'}`);
                finalizeCandidateBoundary();
                continue;
            }
        }

        console.log('  等待详情页加载...');
        let detailLoaded = false;
        for (let i = 0; i < 20; i++) {
            await sleep(humanDelay(500, 150));
            const hasResumeRaw = await cdp.send('Runtime.evaluate', { expression: jsWaitForResume, returnByValue: true });
            const hasResume = parseResult(hasResumeRaw);
            if (hasResume && hasResume.found) {
                detailLoaded = true;
                console.log(`  详情页已加载 (状态: ${hasResume.state || 'unknown'})`);
                break;
            }
        }

        if (!detailLoaded) {
            console.log('  详情页加载超时，跳过');
            failureStreaks.detail_load += 1;
            finalizeCandidateBoundary();
            continue;
        }
        failureStreaks.detail_load = 0;
        console.log('  详情页已加载!');

        console.log('  等待简历API响应...');
        capturedResumeData = null;
        let apiResumeData = null;

        await sleep(humanDelay(1000, 300));
        if (resumeRequestId) {
            console.log('  尝试直接获取简历数据...');
            apiResumeData = await getResumeDataViaCDP(cdp, resumeRequestId);
            if (apiResumeData) {
                capturedResumeData = apiResumeData;
                console.log(`  通过CDP直接获取到简历: ${apiResumeData.geekDetail?.geekBaseInfo?.name || '未知'}`);
            }
        }

        if (!capturedResumeData) {
            for (let wait = 0; wait < 8; wait++) {
                await sleep(humanDelay(500, 150));
                if (capturedResumeData) {
                    apiResumeData = capturedResumeData;
                    console.log(`  通过回调获取到简历: ${apiResumeData.geekDetail?.geekBaseInfo?.name || '未知'}`);
                    break;
                }
            }
        }

        let candidateInfo = null;
        let resumeData = null;
        if (apiResumeData || capturedResumeData) {
            resumeData = apiResumeData || capturedResumeData;
            const geekDetail = resumeData.geekDetail || resumeData;
            const baseInfo = geekDetail.geekBaseInfo || {};
            candidateInfo = {
                name: baseInfo.name || geekDetail.geekName || resumeData.geekName || '',
                school: (geekDetail.geekEduExpList && geekDetail.geekEduExpList[0]?.school) || (geekDetail.geekEducationList && geekDetail.geekEducationList[0]?.school) || '',
                major: (geekDetail.geekEduExpList && geekDetail.geekEduExpList[0]?.major) || (geekDetail.geekEducationList && geekDetail.geekEducationList[0]?.major) || '',
                company: (geekDetail.geekWorkExpList && geekDetail.geekWorkExpList[0]?.company) || '',
                position: (geekDetail.geekWorkExpList && geekDetail.geekWorkExpList[0]?.positionName) || '',
                resumeText: formatResumeApiData(resumeData),
                alreadyInterested: resumeData.alreadyInterested === true
            };
        } else {
            console.log('  API未返回数据，尝试从DOM提取...');
            const candidateInfoRaw = await cdp.send('Runtime.evaluate', { expression: jsGetResumeInfo, returnByValue: true });
            candidateInfo = parseResult(candidateInfoRaw);
        }

        if (!candidateInfo || candidateInfo.error || !candidateInfo.resumeText) {
            console.log(`  获取简历信息失败`);
            failureStreaks.resume_extract += 1;
            await closeResumePage(cdp);
            await sleep(humanDelay(800, 200));
            finalizeCandidateBoundary();
            continue;
        }
        failureStreaks.resume_extract = 0;

        console.log(`  姓名: ${candidateInfo.name || '未知'}`);
        console.log(`  学校: ${candidateInfo.school || '未知'}`);
        console.log(`  公司: ${candidateInfo.company || '未知'}`);

        console.log('  调用LLM评估...');
        const resumeTextForLLM = String(candidateInfo.resumeText || '').slice(0, MAX_RESUME_TEXT_CHARS);
        if (resumeTextForLLM.length < String(candidateInfo.resumeText || '').length) {
            console.log(`  简历内容过长，已截断到 ${MAX_RESUME_TEXT_CHARS} 字符后再调用LLM`);
        }
        const prompt = `你是一位专业的HR招聘助手，请根据以下筛选标准分析候选人简历，判断是否匹配。\n\n筛选标准:\n${criteria}\n\n简历内容:\n${resumeTextForLLM}\n\n请仔细分析简历，返回以下格式的JSON（必须是有效的JSON格式，不要包含任何其他内容）：\n{\n    "passed": true或false,\n    "reason": "通过或不通过的具体原因",\n    "summary": "简历摘要"\n}`;

        try {
            const content = await callLLM(prompt);

            let passed = false;
            let reason = '';
            let summary = '';

            console.log(`  LLM返回内容: ${content.substring(0, 100)}...`);

            try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const result = JSON.parse(jsonMatch[0]);
                    passed = result.passed;
                    reason = result.reason || '';
                    summary = result.summary || '';
                } else {
                    console.log('  LLM返回不是JSON格式');
                }
            } catch (jsonError) {
                console.log(`  JSON解析失败: ${jsonError.message}`);
                console.log('  跳过此人选');
                await closeResumePage(cdp);
                await sleep(humanDelay(800, 200));
                finalizeCandidateBoundary();
                continue;
            }

            console.log('  模拟阅读简历（滚动详情页）...');
            const scrolled = await scrollDetailPage(cdp);
            if (scrolled) {
                console.log('  详情页滚动完成');
            } else {
                console.log('  详情页无需滚动或滚动失败');
            }

            if (passed) {
                console.log('  LLM评估结果: 通过');
                console.log(`  原因: ${reason}`);

                console.log('  执行收藏操作...');
                let favoriteDone = false;
                let clickCount = 0;
                const maxClicks = 5;

                while (clickCount < maxClicks && !favoriteDone) {
                    clickCount++;
                    favoriteActionResult = null;
                    pendingFavoriteClick = true;
                    
                    try {
                        await cdp.send('Page.bringToFront');
                    } catch (e) {}

                    await sleep(humanDelay(200, 100));

                    let usedDomFlow = false;
                    const domStateRaw = await cdp.send('Runtime.evaluate', { expression: jsGetFavoriteDomState, returnByValue: true });
                    const domState = parseResult(domStateRaw);
                    if (domState && domState.success && domState.found && domState.alreadyInterested) {
                        console.log('  DOM检测显示已是收藏状态，跳过点击');
                        favoriteDone = true;
                        pendingFavoriteClick = false;
                        usedDomFlow = true;
                    } else if (domState && domState.success && domState.found) {
                        console.log('  优先使用DOM收藏按钮点击...');
                        const domClickRaw = await cdp.send('Runtime.evaluate', { expression: jsClickFavoriteDom, returnByValue: true });
                        const domClick = parseResult(domClickRaw);
                        if (domClick && domClick.success && (domClick.clicked || domClick.alreadyInterested)) {
                            usedDomFlow = true;
                            console.log('  DOM点击已执行，等待状态确认...');
                        } else {
                            console.log(`  DOM点击失败，将回退legacy方案: ${domClick?.reason || 'unknown'}`);
                        }
                    } else {
                        console.log(`  DOM收藏按钮未就绪: ${domState?.reason || 'unknown'}`);
                    }

                    if (!usedDomFlow) {
                        if (!pos) {
                            pendingFavoriteClick = false;
                            throw new Error('DOM收藏不可用且缺少可用校准文件，无法执行回退点击。请运行 boss-recruit-mcp calibrate 生成 favorite-calibration.json。');
                        }
                        const canvasPosRaw = await cdp.send('Runtime.evaluate', { expression: jsGetFavoriteCanvasPosition, returnByValue: true });
                        const canvasPos = parseResult(canvasPosRaw);
                        
                        if (canvasPos && canvasPos.success) {
                            const offsetX = Math.floor(Math.random() * 7) - 3;
                            const offsetY = Math.floor(Math.random() * 7) - 3;
                            const clickX = canvasPos.absX + pos.canvasX + offsetX;
                            const clickY = canvasPos.absY + pos.canvasY + offsetY;
                            
                            console.log(`  使用CDP鼠标轨迹点击收藏按钮 (${clickX}, ${clickY})...`);
                            
                            try {
                                await simulateHumanClick(cdp, clickX, clickY);
                                console.log('  CDP点击完成');
                            } catch (e) {
                                console.log(`  CDP点击失败: ${e.message}，回退到JS点击`);
                                const favResultRaw = await cdp.send('Runtime.evaluate', { expression: jsClickFavorite(pos.pageX + offsetX, pos.pageY + offsetY), returnByValue: true });
                                const favResult = parseResult(favResultRaw);
                                if (!favResult || !favResult.success) {
                                    console.log(`  JS点击也失败: ${favResult?.error || 'unknown'}`);
                                    pendingFavoriteClick = false;
                                    break;
                                }
                            }
                        } else {
                            console.log(`  无法获取Canvas位置，使用校准坐标: ${canvasPos?.error || 'unknown'}`);
                            const offsetX = Math.floor(Math.random() * 7) - 3;
                            const offsetY = Math.floor(Math.random() * 7) - 3;
                            const clickX = pos.pageX + offsetX;
                            const clickY = pos.pageY + offsetY;
                            
                            try {
                                await simulateHumanClick(cdp, clickX, clickY);
                                console.log('  CDP点击完成');
                            } catch (e) {
                                console.log(`  CDP点击失败: ${e.message}，回退到JS点击`);
                                const favResultRaw = await cdp.send('Runtime.evaluate', { expression: jsClickFavorite(clickX, clickY), returnByValue: true });
                                const favResult = parseResult(favResultRaw);
                                if (!favResult || !favResult.success) {
                                    console.log(`  JS点击也失败: ${favResult?.error || 'unknown'}`);
                                    pendingFavoriteClick = false;
                                    break;
                                }
                            }
                        }
                    }

                    let waitResult = null;
                    for (let wait = 0; wait < 5; wait++) {
                        await sleep(humanDelay(500, 150));
                        if (favoriteActionResult) {
                            waitResult = favoriteActionResult;
                            break;
                        }
                        const domStateAfterRaw = await cdp.send('Runtime.evaluate', { expression: jsGetFavoriteDomState, returnByValue: true });
                        const domStateAfter = parseResult(domStateAfterRaw);
                        if (domStateAfter && domStateAfter.success && domStateAfter.found && domStateAfter.alreadyInterested) {
                            waitResult = 'add';
                            break;
                        }
                    }

                    if (waitResult === 'add') {
                        console.log(`  收藏成功`);
                        favoriteDone = true;
                    } else if (waitResult === 'del') {
                        console.log(`  检测到取消收藏，重新点击...`);
                    } else {
                        if (clickCount < maxClicks) {
                            console.log(`  第${clickCount}次未检测到响应，重试...`);
                        }
                    }
                }

                if (!favoriteDone) {
                    console.log('  收藏操作未能确认成功');
                    uncertainFavoriteCount++;
                }

                pendingFavoriteClick = false;

                passedCandidates.push({
                    name: candidateInfo.name,
                    school: candidateInfo.school,
                    major: candidateInfo.major,
                    company: candidateInfo.company,
                    position: candidateInfo.position,
                    reason: reason,
                    summary: summary
                });
            } else {
                console.log('  LLM评估结果: 不通过');
                console.log(`  原因: ${reason}`);
            }
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.includes('DOM收藏不可用且缺少可用校准文件')) {
                throw e;
            }
            console.log(`  LLM调用失败: ${e.message}`);
        }

        await closeResumePage(cdp);
        await sleep(humanDelay(800, 200));
        finalizeCandidateBoundary();

        consecutiveCount++;

        if (Math.random() < 0.1) {
            const shortBreak = 5000 + Math.random() * 10000;
            console.log('');
            console.log(`[随机休息] 10%概率触发，休息 ${Math.round(shortBreak/1000)} 秒...`);
            for (let i = 0; i < shortBreak; i += 1000) {
                await checkAndHandleSave();
                await sleep(1000);
            }
            console.log('随机休息结束，继续筛选...');
        }

        if (consecutiveCount >= restThreshold) {
            const breakTime = 120000 + Math.random() * 180000;
            const breakMinutes = Math.round(breakTime / 60000);
            console.log('');
            console.log(`========================================`);
            console.log(`已连续处理 ${consecutiveCount} 人，随机休息 ${breakMinutes} 分钟...`);
            console.log(`========================================`);
            for (let i = 0; i < breakTime; i += 1000) {
                await checkAndHandleSave();
                await sleep(1000);
            }
            consecutiveCount = 0;
            restThreshold = 30 + Math.floor(Math.random() * 11);
            console.log('休息结束，继续筛选...');
        }

        if (processedCount >= targetCount * 3) {
            console.log('警告: 已处理超过目标处理人数3倍，强制结束');
            break;
        }
    }

    console.log('');
    console.log('[5/6] 导出结果到CSV...');

    if (passedCandidates.length > 0) {
        const header = '姓名,最高学历学校,最高学历专业,最近工作公司,最近工作职位,评估通过详细原因\n';
        const rows = passedCandidates.map(c =>
            `"${c.name}","${c.school}","${c.major}","${c.company}","${c.position}","${c.reason}"`
        ).join('\n');
        fs.writeFileSync(outputCsv, '\ufeff' + header + rows, 'utf8');
        console.log(`结果已导出到: ${outputCsv}`);
        console.log(`共导出 ${passedCandidates.length} 位通过筛选的人选`);
    } else {
        console.log('没有通过筛选的人选');
    }

    console.log('[6/6] 清理资源...');
    if (typeof checkAndHandleSave.cleanup === 'function') {
        checkAndHandleSave.cleanup();
    }
    cdp.close();

    console.log('');
    console.log('========================================');
    console.log('筛选完成!');
    console.log('========================================');
    console.log('处理结果:');
    console.log(`  已处理: ${processedCount} 人`);
    console.log(`  通过筛选: ${passedCandidates.length} 人`);
    console.log(`  目标处理人数: ${targetCount} 人`);
    console.log(`  完成条件: 已处理人数达到目标处理人数；不要求通过人数达到该值`);
    console.log('');
    console.log('Done.');
    saveCheckpoint();
    emitStructuredResult(
        'COMPLETED',
        buildTerminalState(processedCount >= targetCount ? 'processed_target_reached' : 'completed')
    );
}

main().catch(e => {
    if (process.stdin && process.stdin.isTTY) {
        try {
            process.stdin.setRawMode(false);
        } catch {}
    }
    const errorMessage = e && e.message ? e.message : String(e);
    emitStructuredResult(
        'FAILED',
        {
            processedCount: 0,
            passedCandidates: [],
            outputCsv,
            checkpointPath,
            currentCardIndex: 0,
            currentCandidateKey: null,
            completedCandidateKeys: [],
            completionReason: 'failed'
        },
        {
            code: e && e.code ? e.code : 'RECRUIT_SCREEN_FAILED',
            message: errorMessage,
            recoverable: e && e.recoverable === true
        }
    );
    console.error('Fatal error:', errorMessage);
    process.exit(1);
});
