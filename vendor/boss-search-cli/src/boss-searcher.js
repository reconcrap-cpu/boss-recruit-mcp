
import CDP from 'chrome-remote-interface';

export class BossSearcher {
  constructor(port = 9222) {
    this.port = port;
    this.client = null;
    this.Runtime = null;
  }

  async connect() {
    try {
      console.log('正在连接Boss直聘 (端口: ' + this.port + ')...');
      this.client = await CDP({ port: this.port });
      const { Runtime } = this.client;
      this.Runtime = Runtime;
      await Runtime.enable();
      console.log('✅ 连接成功');
      return true;
    } catch (error) {
      console.error('❌ 连接失败:', error.message);
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

  async executeInIframe(expression) {
    return this.evaluate(expression);
  }

  async sleep(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  async refreshIframe() {
    console.log('🔄 刷新iframe...');
    try {
      await this.evaluate(
        "(function() {" +
        "  const iframe = document.querySelector('iframe');" +
        "  if (iframe && iframe.contentWindow) {" +
        "    iframe.contentWindow.location.reload();" +
        "    return { refreshed: true };" +
        "  }" +
        "  return { error: 'no iframe' };" +
        "})()"
      );
      await this.sleep(4000);
      console.log('✅ iframe已刷新');
      return { success: true };
    } catch (e) {
      console.log('  刷新iframe时出错:', e.message);
      return { error: e.message };
    }
  }

  async setKeywords(keywords) {
    console.log('🔍 设置搜索关键词: ' + keywords);
    try {
      const safeKeywords = keywords.replace(/'/g, "\\'");
      console.log('  [DEBUG] 开始设置关键词...');
      const result = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
        '  const doc = iframe.contentWindow.document;' +
        '  const input = doc.querySelector("input.search-input");' +
        '  if (input) {' +
        '    console.log("[DEBUG] 找到输入框，当前值:", input.value);' +
        '    input.focus();' +
        '    input.value = \'' + safeKeywords + '\';' +
        '    const event = new Event("input", { bubbles: true });' +
        '    input.dispatchEvent(event);' +
        '    console.log("[DEBUG] 已设置值:", input.value);' +
        '    ' +
        '    const dropdown = doc.querySelector(".search-result-C");' +
        '    const dropdownVisible = dropdown && dropdown.offsetParent !== null;' +
        '    console.log("[DEBUG] 下拉提示是否可见:", dropdownVisible);' +
        '    if (dropdownVisible) {' +
        '      const items = dropdown.querySelectorAll(".search-result-item");' +
        '      console.log("[DEBUG] 下拉选项数量:", items.length);' +
        '    }' +
        '    return { success: true, value: input.value, dropdownVisible: dropdownVisible };' +
        '  }' +
        '  return { error: "input not found" };' +
        '})()'
      );
      console.log('  [DEBUG] setKeywords 结果:', JSON.stringify(result));
      return result;
    } catch (e) {
      console.log('  设置关键词时出错:', e.message);
      return { error: e.message };
    }
  }

  async setDegree(degree) {
    console.log('🎓 设置学历要求: ' + degree);
    const degreeMap = {
      '不限': 0,
      '本科': 1,
      '本科及以上': 1,
      '硕士': 2,
      '硕士及以上': 2,
      '博士': 3
    };

    const idx = degreeMap[degree] || 0;
    
    try {
      const result = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
        '  const doc = iframe.contentWindow.document;' +
        '  const items = doc.querySelectorAll(".degree-list-C .degree-item");' +
        '  if (items && items[' + idx + ']) {' +
        '    items[' + idx + '].click();' +
        '    return { success: true, selected: items[' + idx + '].textContent ? items[' + idx + '].textContent.trim() : "" };' +
        '  }' +
        '  return { error: "items not found" };' +
        '})()'
      );
      await this.sleep(300);
      return result;
    } catch (e) {
      console.log('  设置学历时出错:', e.message);
      return { error: e.message };
    }
  }

  async setSchoolRequirements(schools) {
    console.log('🏫 设置院校要求: ' + schools.join(', '));

    try {
      for (const school of schools) {
        const safeSchool = school.replace(/'/g, "\\'");
        const result = await this.evaluate(
          '(function() {' +
          '  const iframe = document.querySelector("iframe");' +
          '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
          '  const doc = iframe.contentWindow.document;' +
          '  const schoolItems = doc.querySelectorAll(".school-item");' +
          '  const targetTexts = ["统招本科", "双一流院校", "211院校", "985院校", "留学生", "QS 100", "QS 500"];' +
          '  const targetIdx = targetTexts.indexOf("' + safeSchool + '");' +
          '  if (targetIdx >= 0 && schoolItems[targetIdx]) {' +
          '    const label = schoolItems[targetIdx].querySelector("label.checkbox");' +
          '    if (label) {' +
          '      label.click();' +
          '      const checkbox = schoolItems[targetIdx].querySelector(".checkbox-input");' +
          '      return { success: true, school: "' + safeSchool + '", checked: checkbox ? checkbox.checked : false };' +
          '    }' +
          '  }' +
          '  return { error: "school item not found" };' +
          '})()'
        );
        console.log('  ' + safeSchool + ': ' + (result && result.success ? '✅' : '❌'));
        await this.sleep(300);
      }
      return { success: true };
    } catch (e) {
      console.log('  设置院校要求时出错:', e.message);
      return { error: e.message };
    }
  }

  async setJobTitle(jobTitle = '不限职位') {
    console.log('💼 设置职位: ' + jobTitle);
    try {
      const result = await this.evaluate(
        "(function() {" +
        "  const iframe = document.querySelector('iframe');" +
        "  if (!iframe || !iframe.contentWindow) return { error: 'no iframe' };" +
        "  const doc = iframe.contentWindow.document;" +
        "  const container = doc.querySelector('.search-job-list-C');" +
        "  if (!container) return { error: 'search-job-list-C not found' };" +
        "  const firstOption = container.querySelector('li[ka=\"search_select_job\"]');" +
        "  if (firstOption) {" +
        "    firstOption.click();" +
        "    return { success: true, selected: firstOption.textContent ? firstOption.textContent.trim() : '' };" +
        "  }" +
        "  return { error: 'job option not found' };" +
        "})()"
      );
      await this.sleep(300);
      return result;
    } catch (e) {
      console.log('  设置职位时出错:', e.message);
      return { error: e.message };
    }
  }

  async _click(x, y) {
    const { Input } = this.client;
    await Input.dispatchMouseEvent({
      type: 'mousePressed',
      x, y,
      button: 'left',
      clickCount: 1
    });
    await this.sleep(50);
    await Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x, y,
      button: 'left',
      clickCount: 1
    });
  }

  async _hover(x, y) {
    const { Input } = this.client;
    await Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x, y
    });
  }

  async _getElementPos(selector) {
    return await this.evaluate(
      "(function() {" +
      "  const iframe = document.querySelector('iframe');" +
      "  if (!iframe) return null;" +
      "  const doc = iframe.contentDocument;" +
      "  const el = doc.querySelector('" + selector + "');" +
      "  if (!el) return null;" +
      "  const rect = el.getBoundingClientRect();" +
      "  const iframeRect = iframe.getBoundingClientRect();" +
      "  return {" +
      "    x: rect.left + iframeRect.left + rect.width / 2," +
      "    y: rect.top + iframeRect.top + rect.height / 2" +
      "  };" +
      "})()"
    );
  }

  async _getElementPosByText(containerSelector, text) {
    const safeText = text.replace(/'/g, "\\'");
    return await this.evaluate(
      "(function() {" +
      "  const iframe = document.querySelector('iframe');" +
      "  if (!iframe) return null;" +
      "  const doc = iframe.contentDocument;" +
      "  const container = doc.querySelector('" + containerSelector + "');" +
      "  if (!container) return null;" +
      "  const items = container.querySelectorAll('li');" +
      "  for (let i = 0; i < items.length; i++) {" +
      "    const t = items[i].textContent ? items[i].textContent.trim() : '';" +
      "    if (t.startsWith('" + safeText + "') || t === '" + safeText + "') {" +
      "      const rect = items[i].getBoundingClientRect();" +
      "      const iframeRect = iframe.getBoundingClientRect();" +
      "      return {" +
      "        x: rect.left + iframeRect.left + rect.width / 2," +
      "        y: rect.top + iframeRect.top + rect.height / 2" +
      "      };" +
      "    }" +
      "  }" +
      "  return null;" +
      "})()"
    );
  }

  async getCurrentCity() {
    const result = await this.evaluate(
      "(function() {" +
      "  const iframe = document.querySelector('iframe');" +
      "  if (!iframe) return null;" +
      "  const doc = iframe.contentDocument;" +
      "  const selectors = [" +
      "    '.city-wrap .city-text'," +
      "    '.city-wrap .city'," +
      "    '.city-wrap .current-city'," +
      "    '.city-wrap .selected-city'," +
      "    '.city-wrap span.city-text'," +
      "    '.city-wrap span'," +
      "    '.search-city-kw .city-text'," +
      "    '.search-city-kw input'," +
      "    '.city-text'" +
      "  ];" +
      "  for (let i = 0; i < selectors.length; i++) {" +
      "    const el = doc.querySelector(selectors[i]);" +
      "    if (el && el.textContent) {" +
      "      const text = el.textContent.trim();" +
      "      if (text && text.length > 0 && text.length < 20) {" +
      "        return text;" +
      "      }" +
      "    }" +
      "  }" +
      "  const cityWrap = doc.querySelector('.city-wrap');" +
      "  if (cityWrap) {" +
      "    const allText = cityWrap.textContent ? cityWrap.textContent.trim() : '';" +
      "    const parts = allText.split(/\\s+/);" +
      "    for (let i = 0; i < parts.length; i++) {" +
      "      if (parts[i].length > 0 && parts[i].length < 10) {" +
      "        return parts[i];" +
      "      }" +
      "    }" +
      "  }" +
      "  return null;" +
      "})()"
    );
    return result;
  }

  async setCity(city) {
    console.log('📍 设置城市: ' + city);
    const safeCity = city.replace(/'/g, "\\'");
    
    try {
      console.log('  1. 获取城市输入框位置...');
      const inputPos = await this.evaluate(
        "(function() {" +
        "  const iframe = document.querySelector('iframe');" +
        "  if (!iframe) return null;" +
        "  const doc = iframe.contentDocument;" +
        "  const input = doc.querySelector('.city-wrap .search-city-kw input');" +
        "  if (!input) return null;" +
        "  const rect = input.getBoundingClientRect();" +
        "  const iframeRect = iframe.getBoundingClientRect();" +
        "  return {" +
        "    x: rect.left + iframeRect.left + rect.width / 2," +
        "    y: rect.top + iframeRect.top + rect.height / 2" +
        "  };" +
        "})()"
      );
      if (!inputPos) {
        console.log('  ❌ 找不到城市输入框');
        return { error: 'input not found' };
      }

      console.log('  2. 点击输入框...');
      await this._hover(inputPos.x, inputPos.y);
      await this.sleep(100);
      await this._click(inputPos.x, inputPos.y);
      await this.sleep(300);

      console.log('  3. 输入城市名称: ' + city);
      await this.evaluate(
        "(function() {" +
        "  const iframe = document.querySelector('iframe');" +
        "  if (!iframe) return;" +
        "  const doc = iframe.contentDocument;" +
        "  const input = doc.querySelector('.city-wrap .search-city-kw input');" +
        "  if (input) {" +
        "    input.value = '" + safeCity + "';" +
        "    input.dispatchEvent(new Event('input', { bubbles: true }));" +
        "  }" +
        "})()"
      );
      await this.sleep(800);

      console.log('  4. 检查搜索结果下拉...');
      const searchResult = await this.evaluate(
        "(function() {" +
        "  const iframe = document.querySelector('iframe');" +
        "  if (!iframe) return { error: 'no iframe' };" +
        "  const doc = iframe.contentDocument;" +
        "  const cityBox = doc.querySelector('.city-box');" +
        "  if (!cityBox) return { notFound: true };" +
        "  const searchResultC = cityBox.querySelector('.search-result-C');" +
        "  if (!searchResultC) return { notFound: true };" +
        "  const items = searchResultC.querySelectorAll('.search-result-item');" +
        "  if (items.length === 0) return { notFound: true };" +
        "  const firstText = items[0].textContent ? items[0].textContent.trim() : '';" +
        "  if (firstText.includes('暂无结果') || firstText.includes('无结果')) {" +
        "    return { needFallback: true };" +
        "  }" +
        "  return {" +
        "    found: true," +
        "    items: Array.from(items).slice(0, 5).map(function(i) {" +
        "      return { text: i.textContent ? i.textContent.trim() : '' };" +
        "    })" +
        "  };" +
        "})()"
      );

      if (searchResult && searchResult.found) {
        console.log('  5. 找到下拉选项:', searchResult.items.map(function(i) { return i.text; }).join(', '));
        
        const targetItem = searchResult.items.find(function(item) { return item.text === city; });
        if (targetItem) {
          console.log('  6. 点击目标城市: ' + city);
          await this.evaluate(
            "(function() {" +
            "  const iframe = document.querySelector('iframe');" +
            "  if (!iframe) return;" +
            "  const doc = iframe.contentDocument;" +
            "  const cityBox = doc.querySelector('.city-box');" +
            "  if (cityBox) {" +
            "    const searchResultC = cityBox.querySelector('.search-result-C');" +
            "    if (searchResultC) {" +
            "      const items = searchResultC.querySelectorAll('.search-result-item');" +
            "      for (let i = 0; i < items.length; i++) {" +
            "        const text = items[i].textContent ? items[i].textContent.trim() : '';" +
            "        if (text === '" + safeCity + "') {" +
            "          items[i].click();" +
            "          return;" +
            "        }" +
            "      }" +
            "    }" +
            "  }" +
            "})()"
          );
          await this.sleep(500);
          
          const currentCity = await this.getCurrentCity();
          if (currentCity === city) {
            console.log('  ✅ 城市已选择: ' + city);
            return { success: true, city: city };
          } else {
            console.log('  ⚠️ 验证失败，当前城市: ' + currentCity);
          }
        } else {
          console.log('  ⚠️ 下拉中没有目标城市，启用fallback...');
        }
      }

      if (searchResult && searchResult.needFallback) {
        console.log('  5. 没有搜索结果，启用fallback...');
      } else {
        console.log('  5. 下拉未出现，启用fallback...');
      }

      for (let retry = 0; retry < 3; retry++) {
        console.log('  6. 清空输入框...');
        await this.evaluate(
          "(function() {" +
          "  const iframe = document.querySelector('iframe');" +
          "  if (!iframe) return;" +
          "  const doc = iframe.contentDocument;" +
          "  const input = doc.querySelector('.city-wrap .search-city-kw input');" +
          "  if (input) {" +
          "    input.value = '';" +
          "    input.dispatchEvent(new Event('input', { bubbles: true }));" +
          "  }" +
          "})()"
        );
        await this.sleep(500);

        console.log('  7. 点击空div触发省份下拉...');
        const emptyDivPos = await this.evaluate(
          "(function() {" +
          "  const iframe = document.querySelector('iframe');" +
          "  if (!iframe) return null;" +
          "  const doc = iframe.contentDocument;" +
          "  const searchCityKw = doc.querySelector('.search-city-kw');" +
          "  if (!searchCityKw) return null;" +
          "  const divs = searchCityKw.querySelectorAll('div');" +
          "  for (let i = 0; i < divs.length; i++) {" +
          "    const div = divs[i];" +
          "    if (!div.className && div.innerHTML.trim() === '') {" +
          "      const rect = div.getBoundingClientRect();" +
          "      const iframeRect = iframe.getBoundingClientRect();" +
          "      return {" +
          "        x: rect.left + iframeRect.left + rect.width / 2," +
          "        y: rect.top + iframeRect.top + rect.height / 2" +
          "      };" +
          "    }" +
          "  }" +
          "  return null;" +
          "})()"
        );
        if (emptyDivPos) {
          await this._hover(emptyDivPos.x, emptyDivPos.y);
          await this.sleep(100);
          await this._click(emptyDivPos.x, emptyDivPos.y);
          await this.sleep(800);
        }

        console.log('  8. Hover "热门"...');
        const hotPos = await this.evaluate(
          "(function() {" +
          "  const iframe = document.querySelector('iframe');" +
          "  if (!iframe) return null;" +
          "  const doc = iframe.contentDocument;" +
          "  const dropdownProvince = doc.querySelector('.dropdown-province');" +
          "  if (!dropdownProvince) return null;" +
          "  const items = dropdownProvince.querySelectorAll('li');" +
          "  for (let i = 0; i < items.length; i++) {" +
          "    const text = items[i].textContent ? items[i].textContent.trim() : '';" +
          "    if (text.startsWith('热门')) {" +
          "      const rect = items[i].getBoundingClientRect();" +
          "      const iframeRect = iframe.getBoundingClientRect();" +
          "      return {" +
          "        x: rect.left + iframeRect.left + rect.width / 2," +
          "        y: rect.top + iframeRect.top + rect.height / 2" +
          "      };" +
          "    }" +
          "  }" +
          "  return null;" +
          "})()"
        );
        if (hotPos) {
          await this._hover(hotPos.x, hotPos.y);
          await this.sleep(800);
        }

        console.log('  9. 点击"全国"...');
        const nationwidePos = await this.evaluate(
          "(function() {" +
          "  const iframe = document.querySelector('iframe');" +
          "  if (!iframe) return null;" +
          "  const doc = iframe.contentDocument;" +
          "  const dropdownCity = doc.querySelector('.dropdown-city');" +
          "  if (!dropdownCity) return null;" +
          "  const items = dropdownCity.querySelectorAll('li');" +
          "  for (let i = 0; i < items.length; i++) {" +
          "    const text = items[i].textContent ? items[i].textContent.trim() : '';" +
          "    if (text === '全国') {" +
          "      const rect = items[i].getBoundingClientRect();" +
          "      const iframeRect = iframe.getBoundingClientRect();" +
          "      return {" +
          "        x: rect.left + iframeRect.left + rect.width / 2," +
          "        y: rect.top + iframeRect.top + rect.height / 2" +
          "      };" +
          "    }" +
          "  }" +
          "  return null;" +
          "})()"
        );
        if (nationwidePos) {
          await this._click(nationwidePos.x, nationwidePos.y);
          await this.sleep(800);
        }

        const currentCity = await this.getCurrentCity();
        if (currentCity === '全国') {
          console.log('  ✅ 已选择: 全国 (fallback)');
          return { success: true, city: '全国' };
        } else {
          console.log('  ⚠️ 第' + (retry + 1) + '次尝试失败，当前城市: ' + currentCity);
        }
      }

      console.log('  ❌ fallback失败，无法选择全国');
      return { error: 'fallback failed' };
    } catch (e) {
      console.log('  设置城市时出错:', e.message);
      return { error: e.message };
    }
  }

  async clickSearch() {
    console.log('🚀 执行搜索...');
    try {
      console.log('  [DEBUG] 搜索前检查下拉状态...');
      const beforeSearch = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
        '  const doc = iframe.contentWindow.document;' +
        '  const dropdown = doc.querySelector(".search-result-C");' +
        '  const dropdownVisible = dropdown && dropdown.offsetParent !== null;' +
        '  const input = doc.querySelector("input.search-input");' +
        '  return {' +
        '    dropdownVisible: dropdownVisible,' +
        '    inputValue: input ? input.value : null' +
        '  };' +
        '})()'
      );
      console.log('  [DEBUG] 搜索前状态:', JSON.stringify(beforeSearch));

      const result = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
        '  const doc = iframe.contentWindow.document;' +
        '  const searchIcon = doc.querySelector(".icon-search");' +
        '  if (searchIcon) {' +
        '    searchIcon.click();' +
        '    return { success: true, method: "icon" };' +
        '  }' +
        '  return { error: "search icon not found" };' +
        '})()'
      );

      console.log('  [DEBUG] 搜索点击完成，等待1500ms...');
      await this.sleep(1500);

      console.log('  [DEBUG] 搜索后检查下拉状态...');
      const afterSearch = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return { error: "no iframe" };' +
        '  const doc = iframe.contentWindow.document;' +
        '  const dropdown = doc.querySelector(".search-result-C");' +
        '  const dropdownVisible = dropdown && dropdown.offsetParent !== null;' +
        '  const input = doc.querySelector("input.search-input");' +
        '  let dropdownInfo = { visible: dropdownVisible };' +
        '  if (dropdownVisible && dropdown) {' +
        '    const items = dropdown.querySelectorAll(".search-result-item");' +
        '    dropdownInfo.itemCount = items.length;' +
        '  }' +
        '  return {' +
        '    dropdownInfo: dropdownInfo,' +
        '    inputValue: input ? input.value : null' +
        '  };' +
        '})()'
      );
      console.log('  [DEBUG] 搜索后状态:', JSON.stringify(afterSearch));

      console.log('✅ 搜索已执行');
      return result;
    } catch (e) {
      console.log('  执行搜索时出错:', e.message);
      return { error: e.message };
    }
  }

  async getResults() {
    console.log('📋 获取搜索结果...');
    try {
      const results = await this.evaluate(
        '(function() {' +
        '  const iframe = document.querySelector("iframe");' +
        '  if (!iframe || !iframe.contentWindow) return [];' +
        '  const doc = iframe.contentWindow.document;' +
        '  const cards = doc.querySelectorAll(".geek-info-card");' +
        '  const list = [];' +
        '  cards.forEach(function(card, idx) {' +
        '    const nameEl = card.querySelector(".name");' +
        '    const infoEl = card.querySelector(".info");' +
        '    const expectEl = card.querySelector(".expect-salary");' +
        '    const name = nameEl ? nameEl.textContent.trim() : "";' +
        '    const info = infoEl ? infoEl.textContent.trim() : "";' +
        '    const expect = expectEl ? expectEl.textContent.trim() : "";' +
        '    list.push({' +
        '      index: idx + 1,' +
        '      name: name,' +
        '      info: info,' +
        '      expect: expect' +
        '    });' +
        '  });' +
        '  return list;' +
        '})()'
      );
      
      console.log('✅ 找到 ' + results.length + ' 个候选人');
      results.slice(0, 10).forEach(function(r) {
        console.log('  ' + r.index + '. ' + r.name + ' - ' + r.expect + ' - ' + (r.info ? r.info.substring(0, 30) : ''));
      });
      
      return results;
    } catch (e) {
      console.log('  获取结果时出错:', e.message);
      return [];
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      console.log('已断开连接');
    }
  }
}
