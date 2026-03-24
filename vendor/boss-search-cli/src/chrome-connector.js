import CDP from 'chrome-remote-interface';

export class ChromeConnector {
  constructor(port = 9222) {
    this.port = port;
    this.client = null;
    this.DOM = null;
    this.Runtime = null;
    this.Page = null;
    this.Input = null;
  }

  async connect() {
    try {
      console.log(`正在连接远程Chrome (端口: ${this.port})...`);
      this.client = await CDP({ port: this.port });
      const { DOM, Runtime, Page, Input } = this.client;
      this.DOM = DOM;
      this.Runtime = Runtime;
      this.Page = Page;
      this.Input = Input;
      
      await Promise.all([
        DOM.enable(),
        Runtime.enable(),
        Page.enable()
      ]);
      
      console.log('✅ 成功连接到远程Chrome');
      return true;
    } catch (error) {
      console.error('❌ 连接远程Chrome失败:', error.message);
      console.error('请确保Chrome已通过以下命令启动：');
      console.error('chrome.exe --remote-debugging-port=9222');
      return false;
    }
  }

  async evaluate(expression) {
    const result = await this.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception.description);
    }
    return result.result.value;
  }

  async getDocument() {
    const { root } = await this.DOM.getDocument();
    return root;
  }

  async clickElement(selector) {
    await this.evaluate(`
      (async () => {
        const el = document.querySelector('${selector}');
        if (el) {
          el.click();
          return true;
        }
        return false;
      })()
    `);
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      console.log('已断开与Chrome的连接');
    }
  }
}
