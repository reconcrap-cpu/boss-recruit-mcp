#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) {
        const key = arg.slice(2);
        acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
    }
    return acc;
}, {});

const baseUrl = args.baseurl || args.baseUrl;
const apiKey = args.apikey || args.apiKey;
const model = args.model;
const criteria = args.criteria;
const targetCount = parseInt(args.target || args.targetCount || '10');
const configFile = args.config || 'favorite-calibration.json';
const outputCsv = args.output || `筛选结果_${Date.now()}.csv`;

if (!baseUrl || !apiKey || !model || !criteria || !targetCount) {
    console.error('Usage: node boss-cli.js --baseurl <url> --apikey <key> --model <model> --criteria <criteria> --targetCount <n> [--config <file>] [--output <csv>]');
    process.exit(1);
}

function loadCalibration() {
    if (!fs.existsSync(configFile)) {
        console.error(`错误: 校准文件不存在: ${configFile}`);
        console.error('请先运行校准脚本');
        process.exit(1);
    }
    const content = fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(content);
    return data.favoritePosition;
}

async function getChromeTab() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json/list', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const tabs = JSON.parse(data);
                const bossTab = tabs.find(t => t.url && t.url.includes('zhipin.com'));
                if (bossTab) resolve(bossTab);
                else reject(new Error('未找到BOSS直聘页面'));
            });
        }).on('error', reject);
    });
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

    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 's') {
            saveRequested = true;
        } else if (key.ctrl && key.name === 'c') {
            console.log('\n收到中断信号 (Ctrl+C)...');
            console.log('正在保存当前进度...');
            if (saveProgressToCsv(passedCandidates, outputCsv)) {
                console.log(`已保存 ${passedCandidates.length} 条结果到: ${outputCsv}`);
            }
            process.exit(0);
        }
    });

    return () => {
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
    };
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

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: strictPrompt }],
                temperature: 0.1,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API请求失败: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();

        if (data.error) {
            throw new Error(`API错误: ${data.error.message}`);
        }

        const content = data.choices[0].message.content;

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
    console.log(`已加载校准坐标: pageX=${pos.pageX}, pageY=${pos.pageY}`);
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
    console.log('快捷键: Ctrl+S 保存当前进度 | Ctrl+C 保存并退出');
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

    const checkAndHandleSave = setupSaveSignalHandler(passedCandidates, outputCsv);

    while (processedCount < targetCount) {
        console.log('');
        console.log('----------------------------------------');
        console.log(`处理进度: ${processedCount}/${targetCount} 已通过 ${passedCandidates.length} 人 未确认收藏 ${uncertainFavoriteCount} 人`);

        const processedKeysArray = Array.from(processedCardKeys);
        const findCardExpr = jsFindNextUnprocessedCard + '(' + currentCardIndex + ',' + JSON.stringify(processedKeysArray) + ')';
        const nextCardRaw = await cdp.send('Runtime.evaluate', { expression: findCardExpr, returnByValue: true });
        const nextCard = parseResult(nextCardRaw);

        checkAndHandleSave();


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
                    continue;
                }
            }
        } else {
            console.log(`  无法获取卡片坐标，使用JS点击: ${cardPos?.error || 'unknown'}`);
            const clickResultRaw = await cdp.send('Runtime.evaluate', { expression: jsClickCard(nextCard.index), returnByValue: true });
            const clickResult = parseResult(clickResultRaw);
            if (!clickResult || !clickResult.success) {
                console.log(`  点击失败: ${clickResult ? clickResult.error : 'CDP timeout'}`);
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
            continue;
        }
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
            await closeResumePage(cdp);
            await sleep(humanDelay(800, 200));
            continue;
        }

        console.log(`  姓名: ${candidateInfo.name || '未知'}`);
        console.log(`  学校: ${candidateInfo.school || '未知'}`);
        console.log(`  公司: ${candidateInfo.company || '未知'}`);

        console.log('  调用LLM评估...');
        const prompt = `你是一位专业的HR招聘助手，请根据以下筛选标准分析候选人简历，判断是否匹配。\n\n筛选标准:\n${criteria}\n\n简历内容:\n${candidateInfo.resumeText}\n\n请仔细分析简历，返回以下格式的JSON（必须是有效的JSON格式，不要包含任何其他内容）：\n{\n    "passed": true或false,\n    "reason": "通过或不通过的具体原因",\n    "summary": "简历摘要"\n}`;

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

                    let waitResult = null;
                    for (let wait = 0; wait < 5; wait++) {
                        await sleep(humanDelay(500, 150));
                        if (favoriteActionResult) {
                            waitResult = favoriteActionResult;
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
            console.log(`  LLM调用失败: ${e.message}`);
        }

        await closeResumePage(cdp);
        await sleep(humanDelay(800, 200));

        consecutiveCount++;

        if (Math.random() < 0.1) {
            const shortBreak = 5000 + Math.random() * 10000;
            console.log('');
            console.log(`[随机休息] 10%概率触发，休息 ${Math.round(shortBreak/1000)} 秒...`);
            for (let i = 0; i < shortBreak; i += 1000) {
                checkAndHandleSave();
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
                checkAndHandleSave();
                await sleep(1000);
            }
            consecutiveCount = 0;
            restThreshold = 30 + Math.floor(Math.random() * 11);
            console.log('休息结束，继续筛选...');
        }

        if (processedCount >= targetCount * 3) {
            console.log('警告: 已处理超过目标数量3倍，强制结束');
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
    cdp.close();

    console.log('');
    console.log('========================================');
    console.log('筛选完成!');
    console.log('========================================');
    console.log('处理结果:');
    console.log(`  已处理: ${processedCount} 人`);
    console.log(`  通过筛选: ${passedCandidates.length} 人`);
    console.log(`  目标人数: ${targetCount} 人`);
    console.log('');
    console.log('Done.');
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
