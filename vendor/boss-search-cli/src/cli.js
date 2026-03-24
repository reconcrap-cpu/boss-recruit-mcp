#!/usr/bin/env node
import { BossSearcher } from './boss-searcher.js';

class BossSearchCLI {
  constructor() {
    this.searcher = new BossSearcher(9222);
  }

  async run() {
    console.log('========================================');
    console.log('  Boss直聘搜索自动化工具');
    console.log('========================================\n');

    const args = this.parseArgs();
    
    const connected = await this.searcher.connect();
    if (!connected) {
      console.log('\n请确保Chrome已通过以下命令启动：');
      console.log('chrome.exe --remote-debugging-port=9222');
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
        await this.searcher.setCity(args.city);
        await this.searcher.sleep(500);
        console.log('');
      }

      await this.searchWithConfig(args);
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
      experience: '不限',
      ageMin: null,
      ageMax: null
    };

    const schoolMap = {
      '211': '211院校',
      '985': '985院校',
      'qs100': 'QS 100',
      'qs500': 'QS 500',
      '双一流': '双一流院校',
      '留学生': '留学生',
      '统招': '统招本科'
    };

    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--keywords' || arg === '-k') {
        args.keywords = argv[++i];
      } else if (arg === '--degree' || arg === '-d') {
        args.degree = argv[++i];
      } else if (arg === '--schools' || arg === '-s') {
        const schools = argv[++i].split(',');
        args.schools = schools.map(function(s) {
          const normalized = s.trim().toLowerCase();
          return schoolMap[normalized] || s;
        });
      } else if (arg === '--city' || arg === '-c') {
        args.city = argv[++i];
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
    await this.searcher.sleep(2000);
    await this.searcher.getResults();

    console.log('\n✅ 搜索完成！');
  }
}

const cli = new BossSearchCLI();
cli.run();
