#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BossSearcher } from './boss-searcher.js';

const DEFAULT_DEBUG_PORT = 9222;

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ''), 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function collectConfigCandidates() {
  const currentFilePath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(currentFilePath);

  return [
    process.env.BOSS_RECRUIT_SCREEN_CONFIG
      ? path.resolve(process.env.BOSS_RECRUIT_SCREEN_CONFIG)
      : null,
    path.join(getCodexHome(), 'boss-recruit-mcp', 'screening-config.json'),
    path.resolve(process.cwd(), 'boss-recruit-mcp', 'config', 'screening-config.json'),
    path.resolve(process.cwd(), 'config', 'screening-config.json'),
    path.resolve(scriptDir, '..', '..', '..', 'config', 'screening-config.json')
  ].filter(Boolean);
}

function resolvePortFromConfig() {
  for (const configPath of collectConfigCandidates()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const port = parsePositiveInteger(parsed?.debugPort);
      if (port) return port;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveDebugPort(explicitPort) {
  if (explicitPort) return explicitPort;

  const envPort = parsePositiveInteger(process.env.BOSS_RECRUIT_CHROME_PORT);
  if (envPort) return envPort;

  const configPort = resolvePortFromConfig();
  if (configPort) return configPort;

  return DEFAULT_DEBUG_PORT;
}

class BossSearchCLI {
  constructor() {
    const args = this.parseArgs();
    args.port = resolveDebugPort(args.port);
    this.args = args;
    this.searcher = args.help ? null : new BossSearcher(args.port);
  }

  ensureStep(result, label) {
    if (result && result.success) {
      return result;
    }

    const detail = result && result.error ? `: ${result.error}` : '';
    throw new Error(`${label}失败${detail}`);
  }

  async run() {
    if (this.args.help) {
      this.printHelp();
      return;
    }

    console.log('========================================');
    console.log('  Boss直聘搜索自动化工具');
    console.log('========================================\n');

    const connected = await this.searcher.connect();
    if (!connected) {
      console.log('\n请确保Chrome已通过以下命令启动：');
      console.log(`chrome.exe --remote-debugging-port=${this.args.port}`);
      process.exit(1);
    }

    try {
      await this.searcher.sleep(500);

      console.log('🧹 检查并清理下载广告弹窗...');
      this.ensureStep(await this.searcher.ensureDownloadPopupCleared(), '处理下载广告弹窗');
      console.log('');

      console.log('🔄 刷新iframe清除现有搜索条件...');
      this.ensureStep(await this.searcher.refreshIframe(), '刷新iframe清除现有搜索条件');
      console.log('');

      // 第一步：必须先选择"不限职位"，否则后续设置的城市会被重置
      console.log('💼 选择"不限职位"...');
      this.ensureStep(await this.searcher.setJobTitle('不限职位'), '选择不限职位');
      await this.searcher.sleep(500);
      console.log('');

      // 第二步：设置其他过滤条件（城市、学历、院校等）
      if (this.args.city) {
        this.ensureStep(await this.searcher.setCity(this.args.city), '设置城市');
        await this.searcher.sleep(500);
        console.log('');
      }

      await this.searchWithConfig(this.args);
    } catch (error) {
      console.error('❌ 执行出错:', error);
      process.exitCode = 1;
    } finally {
      await this.searcher.disconnect();
    }
  }

  printHelp() {
    console.log('Boss直聘搜索自动化工具');
    console.log('');
    console.log('用法:');
    console.log('  node src/cli.js [options]');
    console.log('');
    console.log('选项:');
    console.log('  -k, --keywords <text>             搜索关键词');
    console.log('  -d, --degree <text>               学历要求（默认: 不限）');
    console.log('  -s, --schools <list>              院校要求，支持逗号分隔');
    console.log('  -c, --city <text>                 城市');
    console.log('      --filter-recent-viewed <bool> 过滤近14天查看');
    console.log(`  -p, --port <number>               Chrome调试端口（默认: ${this.args.port}）`);
    console.log('  -h, --help                        显示帮助');
    console.log('');
    console.log('端口优先级: --port > BOSS_RECRUIT_CHROME_PORT > screening-config.json.debugPort > 9222');
  }

  parseArgs() {
    const args = {
      keywords: '',
      degree: '不限',
      schools: [],
      city: null,
      filterRecentViewed: null,
      port: null,
      help: false,
      experience: '不限',
      ageMin: null,
      ageMax: null
    };

    const schoolMap = {
      '211': '211院校',
      '211院校': '211院校',
      '985': '985院校',
      '985院校': '985院校',
      'qs': 'QS 100',
      'qs100': 'QS 100',
      'qs500': 'QS 500',
      '双一流': '双一流院校',
      '双一流院校': '双一流院校',
      '双一流学校': '双一流院校',
      '留学生': '留学生',
      '统招': '统招本科',
      '统招本科': '统招本科',
      '统招本': '统招本科',
      '全日制本科': '统招本科'
    };

    function resolveQsSchool(normalizedSchool) {
      const matched = normalizedSchool.match(/^qs(\d+)$/);
      if (!matched) return null;

      const rank = Number.parseInt(matched[1], 10);
      if (!Number.isFinite(rank)) return null;

      return rank > 100 ? 'QS 500' : 'QS 100';
    }

    function normalizeSchool(rawSchool) {
      const raw = String(rawSchool || '').trim();
      if (!raw) return raw;
      const normalized = raw.toLowerCase().replace(/\s+/g, '');
      const qsSchool = resolveQsSchool(normalized);
      if (qsSchool) return qsSchool;
      return schoolMap[normalized] || schoolMap[raw] || raw;
    }

    function parseBooleanArg(rawValue) {
      const normalized = String(rawValue || '').trim().toLowerCase();
      if (!normalized) return null;
      if (['true', '1', 'yes', 'y', 'on', '是', '要', '需要', '过滤'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off', '否', '不要', '不需要', '不过滤'].includes(normalized)) return false;
      return null;
    }

    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--keywords' || arg === '-k') {
        args.keywords = argv[++i];
      } else if (arg === '--degree' || arg === '-d') {
        args.degree = argv[++i];
      } else if (arg === '--schools' || arg === '-s') {
        const schools = String(argv[++i] || '').split(/[，,]/);
        args.schools = Array.from(new Set(schools.map(normalizeSchool).filter(Boolean)));
      } else if (arg === '--city' || arg === '-c') {
        args.city = argv[++i];
      } else if (arg === '--filter-recent-viewed') {
        args.filterRecentViewed = parseBooleanArg(argv[++i]);
      } else if (arg === '--port' || arg === '-p') {
        const port = parsePositiveInteger(argv[++i]);
        if (port) {
          args.port = port;
        }
      } else if (arg === '--help' || arg === '-h') {
        args.help = true;
      }
    }

    if (!args.help && !args.keywords) {
      console.log('⚠️  未指定搜索关键词，使用默认值');
      args.keywords = '算法工程师';
    }

    return args;
  }

  async searchWithConfig(config) {
    console.log('📋 搜索配置:');
    console.log('  关键词:', config.keywords);
    console.log('  学历要求:', config.degree);
    if (config.schools.length > 0) {
      console.log('  院校要求:', config.schools.join(', '));
    }
    if (typeof config.filterRecentViewed === 'boolean') {
      console.log('  过滤近14天查看:', config.filterRecentViewed ? '是' : '否');
    }
    console.log('');

    await this.searcher.sleep(500);

    if (config.degree && config.degree !== '不限') {
      this.ensureStep(await this.searcher.setDegree(config.degree), '设置学历要求');
    }

    if (config.schools.length > 0) {
      this.ensureStep(await this.searcher.setSchoolRequirements(config.schools), '设置院校要求');
    }

    if (config.keywords) {
      this.ensureStep(await this.searcher.setKeywords(config.keywords), '设置搜索关键词');
      console.log('  [DEBUG] 关键词设置完成，等待500ms让下拉提示消失...');
      await this.searcher.sleep(500);
    }

    this.ensureStep(await this.searcher.clickSearch(), '执行搜索');

    if (typeof config.filterRecentViewed === 'boolean') {
      this.ensureStep(
        await this.searcher.setRecentViewedFilter(config.filterRecentViewed),
        `设置近14天查看过滤为${config.filterRecentViewed ? '开启' : '关闭'}`
      );
    }

    await this.searcher.sleep(2000);
    await this.searcher.getResults();

    console.log('\n✅ 搜索完成！');
  }
}

const cli = new BossSearchCLI();
cli.run();
