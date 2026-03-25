#!/usr/bin/env node
import { BossSearcher } from './boss-searcher.js';

class BossSearchCLI {
  constructor() {
    const args = this.parseArgs();
    this.args = args;
    this.searcher = new BossSearcher(args.port);
  }

  async run() {
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

      console.log('🔄 刷新iframe清除现有搜索条件...');
      await this.searcher.refreshIframe();
      console.log('');

      // 第一步：必须先选择"不限职位"，否则后续设置的城市会被重置
      console.log('💼 选择"不限职位"...');
      await this.searcher.setJobTitle('不限职位');
      await this.searcher.sleep(500);
      console.log('');

      // 第二步：设置其他过滤条件（城市、学历、院校等）
      if (args.city) {
        await this.searcher.setCity(this.args.city);
        await this.searcher.sleep(500);
        console.log('');
      }

      await this.searchWithConfig(this.args);
    } catch (error) {
      console.error('❌ 执行出错:', error);
    } finally {
      await this.searcher.disconnect();
    }
  }

  parseArgs() {
    const args = {
      keywords: '',
      degree: '不限',
      schools: [],
      city: null,
      filterRecentViewed: null,
      port: 9222,
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
        const port = Number.parseInt(argv[++i], 10);
        if (Number.isFinite(port) && port > 0) {
          args.port = port;
        }
      }
    }

    if (!args.keywords) {
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
      await this.searcher.setDegree(config.degree);
    }

    if (config.schools.length > 0) {
      await this.searcher.setSchoolRequirements(config.schools);
    }

    if (config.keywords) {
      await this.searcher.setKeywords(config.keywords);
      console.log('  [DEBUG] 关键词设置完成，等待500ms让下拉提示消失...');
      await this.searcher.sleep(500);
    }

    await this.searcher.clickSearch();

    if (config.filterRecentViewed) {
      await this.searcher.setRecentViewedFilter(true);
    }

    await this.searcher.sleep(2000);
    await this.searcher.getResults();

    console.log('\n✅ 搜索完成！');
  }
}

const cli = new BossSearchCLI();
cli.run();
