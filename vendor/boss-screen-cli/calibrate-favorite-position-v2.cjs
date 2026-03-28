#!/usr/bin/env node
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) {
        const key = arg.slice(2);
        acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
    }
    return acc;
}, {});

const debugPort = Number.parseInt(args.port || '9222', 10);
const outputFile = path.resolve(args.output || path.join(process.cwd(), 'favorite-calibration.json'));
const timeoutMsRaw = args['timeout-ms'] || args.timeoutMs || args.timeout || '60000';
const timeoutMs = Number.isFinite(Number.parseInt(timeoutMsRaw, 10))
    ? Math.max(5000, Number.parseInt(timeoutMsRaw, 10))
    : 60000;

console.log('\x1b[36m========================================\x1b[0m');
console.log('\x1b[36mFavorite Button Calibration Tool\x1b[0m');
console.log('\x1b[36m========================================\x1b[0m');
console.log();

class TabClient {
    constructor(tab) {
        this.tab = tab;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
    }

    async connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        await this.close();
        const ws = new WebSocket(this.tab.webSocketDebuggerUrl);
        this.ws = ws;

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        ws.on('message', (data) => {
            let msg = null;
            try {
                msg = JSON.parse(data);
            } catch {
                return;
            }
            if (!msg || typeof msg.id !== 'number') return;
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            pending.resolve(msg);
        });

        ws.on('close', () => {
            for (const pending of this.pending.values()) {
                pending.resolve({ error: { message: 'WebSocket closed' } });
            }
            this.pending.clear();
        });
    }

    async send(method, params) {
        await this.connect();
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return { error: { message: 'WebSocket not open' } };
        }

        const id = this.msgId++;
        const payload = JSON.stringify({ id, method, params });
        return await new Promise((resolve) => {
            this.pending.set(id, { resolve });
            try {
                ws.send(payload);
            } catch (e) {
                this.pending.delete(id);
                resolve({ error: { message: e.message } });
            }
        });
    }

    async evaluate(expression) {
        const msg = await this.send('Runtime.evaluate', { expression, returnByValue: true });
        if (msg.error) {
            return { ok: false, error: msg.error.message || 'Runtime.evaluate failed' };
        }
        if (msg.result && msg.result.exceptionDetails) {
            return {
                ok: false,
                error: (msg.result.exceptionDetails.exception && msg.result.exceptionDetails.exception.description)
                    || 'Runtime.evaluate exception'
            };
        }
        return {
            ok: true,
            value: msg.result && msg.result.result ? msg.result.result.value : undefined
        };
    }

    async close() {
        for (const pending of this.pending.values()) {
            pending.resolve({ error: { message: 'Tab client closed' } });
        }
        this.pending.clear();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            await new Promise((resolve) => {
                this.ws.once('close', resolve);
                this.ws.close();
                setTimeout(resolve, 200);
            });
        }
        this.ws = null;
    }
}

async function listBossTabs() {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) {
        throw new Error(`DevTools endpoint returned ${response.status}`);
    }
    const data = await response.json();
    const tabs = Array.isArray(data) ? data : [];
    return tabs.filter((tab) => tab
        && tab.type === 'page'
        && typeof tab.url === 'string'
        && tab.url.includes('zhipin.com')
        && typeof tab.webSocketDebuggerUrl === 'string'
    );
}

function pickPrimaryBossTab(tabs) {
    return (
        tabs.find((tab) => tab.url.includes('/web/chat/search'))
        || tabs.find((tab) => tab.url.includes('/web/geek/'))
        || tabs[0]
    );
}

async function syncBossClients(clientMap) {
    const tabs = await listBossTabs();
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));

    for (const [id, client] of clientMap.entries()) {
        if (!byId.has(id)) {
            await client.close();
            clientMap.delete(id);
        } else {
            client.tab = byId.get(id);
        }
    }

    for (const tab of tabs) {
        if (!clientMap.has(tab.id)) {
            clientMap.set(tab.id, new TabClient(tab));
        }
    }

    return tabs;
}

async function main() {
    let tabs = [];
    try {
        tabs = await listBossTabs();
    } catch (e) {
        console.log('\x1b[31mFailed to connect to Chrome DevTools: ' + e.message + '\x1b[0m');
        process.exit(1);
    }

    const bossTab = pickPrimaryBossTab(tabs);
    if (!bossTab) {
        console.log('\x1b[31mBOSS page not found!\x1b[0m');
        process.exit(1);
    }

    console.log('\x1b[32mFound: ' + bossTab.title + '\x1b[0m');
    console.log('\x1b[90mURL: ' + bossTab.url + '\x1b[0m');

    const clients = new Map();
    await syncBossClients(clients);

    const primaryClient = clients.get(bossTab.id);
    if (!primaryClient) {
        console.log('\x1b[31mUnable to attach to BOSS tab target.\x1b[0m');
        process.exit(1);
    }
    await primaryClient.connect();
    console.log('\x1b[32mConnected!\x1b[0m');

    const setupListenerJs = `(function() {
    window.__calibrationData = window.__calibrationData || null;
    window.__calibrationMeta = window.__calibrationMeta || {
        attachedCount: 0
    };

    function isUsableCanvas(canvas) {
        if (!canvas) return false;
        var rect = canvas.getBoundingClientRect();
        if (!rect || rect.width < 8 || rect.height < 8) return false;
        var style = window.getComputedStyle ? window.getComputedStyle(canvas) : null;
        if (!style) return true;
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (Number(style.opacity || '1') <= 0) return false;
        return true;
    }

    function findFavoriteContainer(target) {
        var node = target;
        while (node && node !== document) {
            if (node.matches) {
                if (
                    node.matches('div.interested')
                    || node.matches('.interested')
                    || node.matches('[aria-label*="收藏"]')
                    || node.matches('[aria-label*="取消收藏"]')
                ) {
                    return node;
                }
            }
            node = node.parentNode;
        }
        return null;
    }

    function captureClick(e, source, iframeEl, anchorEl) {
        if (window.__calibrationData && window.__calibrationData.clicked) return;
        var absClientX = e.clientX;
        var absClientY = e.clientY;
        if (iframeEl) {
            var iframeRect = iframeEl.getBoundingClientRect();
            absClientX = iframeRect.left + e.clientX;
            absClientY = iframeRect.top + e.clientY;
        }
        var target = anchorEl || e.target;
        var targetRect = null;
        if (target && target.getBoundingClientRect) {
            targetRect = target.getBoundingClientRect();
        }
        var relX = targetRect ? (e.clientX - targetRect.left) : e.clientX;
        var relY = targetRect ? (e.clientY - targetRect.top) : e.clientY;
        var label = '';
        try {
            label = target && target.getAttribute ? (target.getAttribute('aria-label') || '') : '';
        } catch (ignore) {}
        window.__calibrationData = {
            clicked: true,
            pageX: absClientX + (window.scrollX || 0),
            pageY: absClientY + (window.scrollY || 0),
            clientX: absClientX,
            clientY: absClientY,
            canvasX: relX,
            canvasY: relY,
            source: source,
            ariaLabel: label,
            pageUrl: window.location.href
        };
    }

    function attachCanvas(canvas, source, iframeEl) {
        if (!canvas || canvas.__bossCalibrationListenerAttached) return false;
        canvas.__bossCalibrationListenerAttached = true;
        var onCanvasInteract = function(e) {
            captureClick(e, source, iframeEl, null);
        };
        canvas.addEventListener('pointerdown', onCanvasInteract, { once: true, capture: true });
        canvas.addEventListener('mousedown', onCanvasInteract, { once: true, capture: true });
        canvas.addEventListener('click', onCanvasInteract, { once: true, capture: true });
        window.__calibrationMeta.attachedCount += 1;
        return true;
    }

    function attachDocument(doc, source, iframeEl, favoriteOnly) {
        if (!doc || doc.__bossCalibrationDocListenerAttached) return false;
        doc.__bossCalibrationDocListenerAttached = true;
        var onDocInteract = function(e) {
            var favoriteNode = findFavoriteContainer(e.target);
            if (favoriteOnly && !favoriteNode) return;
            captureClick(e, source, iframeEl, favoriteNode || null);
        };
        doc.addEventListener('pointerdown', onDocInteract, true);
        doc.addEventListener('mousedown', onDocInteract, true);
        doc.addEventListener('click', onDocInteract, true);
        window.__calibrationMeta.attachedCount += 1;
        return true;
    }

    var attached = 0;
    var canvasCount = 0;
    var crossOriginBlocked = 0;

    if (attachDocument(document, 'main-doc', null, true)) attached++;

    var mainCanvases = document.querySelectorAll('canvas');
    canvasCount += mainCanvases.length;
    for (var m = 0; m < mainCanvases.length; m++) {
        if (isUsableCanvas(mainCanvases[m])) {
            if (attachCanvas(mainCanvases[m], 'main-canvas', null)) attached++;
        }
    }

    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        var src = (iframe.getAttribute('src') || '').toLowerCase();
        var isResumeFrame = src.indexOf('c-resume') >= 0 || src.indexOf('resume') >= 0 || src.indexOf('geek') >= 0;
        if (!isResumeFrame) {
            continue;
        }
        try {
            var iframeDoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (!iframeDoc) continue;
            if (attachDocument(iframeDoc, 'iframe-doc', iframe, true)) attached++;
            var canvases = iframeDoc.querySelectorAll('canvas');
            canvasCount += canvases.length;
            for (var c = 0; c < canvases.length; c++) {
                if (isUsableCanvas(canvases[c])) {
                    if (attachCanvas(canvases[c], 'iframe-canvas', iframe)) attached++;
                }
            }
        } catch (e) {
            crossOriginBlocked += 1;
        }
    }

    return {
        success: attached > 0 || window.__calibrationMeta.attachedCount > 0,
        listenerAttached: attached > 0 || window.__calibrationMeta.attachedCount > 0,
        attachedNow: attached,
        attachedTotal: window.__calibrationMeta.attachedCount,
        canvasCount: canvasCount,
        iframeCount: iframes.length,
        crossOriginBlocked: crossOriginBlocked
    };
})()`;

    const listenerDeadline = Date.now() + timeoutMs;
    let listenerReady = false;
    let listenerTab = null;
    let listenerStats = null;

    console.log('\x1b[36mWaiting for candidate detail page/canvas (up to ' + Math.round(timeoutMs / 1000) + ' seconds)...\x1b[0m');
    while (Date.now() < listenerDeadline && !listenerReady) {
        try {
            tabs = await syncBossClients(clients);
        } catch (e) {
            await new Promise(r => setTimeout(r, 500));
            process.stdout.write('\x1b[90m.\x1b[0m');
            continue;
        }

        for (const tab of tabs) {
            const client = clients.get(tab.id);
            if (!client) continue;
            const result = await client.evaluate(setupListenerJs);
            if (!result.ok || !result.value) continue;
            const val = result.value;
            if (val.success) {
                listenerReady = true;
                listenerTab = tab;
                listenerStats = val;
                break;
            }
        }

        if (listenerReady) {
            break;
        }

        await new Promise(r => setTimeout(r, 500));
        process.stdout.write('\x1b[90m.\x1b[0m');
    }

    if (!listenerReady) {
        console.log();
        console.log('\x1b[31mFailed to find candidate detail page/canvas within ' + Math.round(timeoutMs / 1000) + ' seconds.\x1b[0m');
        console.log('\x1b[33mPlease open a candidate detail page and try calibration again.\x1b[0m');
        for (const client of clients.values()) {
            await client.close();
        }
        process.exit(1);
    }

    console.log('\x1b[32mClick listener added (canvas/DOM)!\x1b[0m');
    if (listenerTab) {
        console.log('\x1b[90mListening tab: ' + listenerTab.url + '\x1b[0m');
    }
    if (listenerStats) {
        console.log('\x1b[90mListener stats: attached=' + listenerStats.attachedTotal
            + ', canvas=' + listenerStats.canvasCount
            + ', iframes=' + listenerStats.iframeCount
            + ', crossOriginBlocked=' + listenerStats.crossOriginBlocked + '\x1b[0m');
    }

    console.log();
    console.log('\x1b[33m========================================\x1b[0m');
    console.log('\x1b[33mCALIBRATION MODE - Click the FAVORITE BUTTON now!\x1b[0m');
    console.log('\x1b[33m========================================\x1b[0m');
    console.log();
    console.log('\x1b[36mMonitoring for ' + Math.round(timeoutMs / 1000) + ' seconds...\x1b[0m');
    console.log();

    const checkJs = `(function() {
    if (window.__calibrationData && window.__calibrationData.clicked) {
        var data = window.__calibrationData;
        window.__calibrationData = null;
        return { clicked: true, position: data };
    }
    return { clicked: false };
})()`;

    const endTime = Date.now() + timeoutMs;
    let clickResult = null;

    while (Date.now() < endTime && !clickResult) {
        try {
            tabs = await syncBossClients(clients);
        } catch {
            await new Promise(r => setTimeout(r, 300));
            process.stdout.write('\x1b[90m.\x1b[0m');
            continue;
        }

        for (const tab of tabs) {
            const client = clients.get(tab.id);
            if (!client) continue;
            const checkResult = await client.evaluate(checkJs);
            if (!checkResult.ok || !checkResult.value) continue;
            const val = checkResult.value;
            if (val.clicked) {
                clickResult = val.position;
                clickResult.detectedTabUrl = tab.url;
                break;
            }
        }

        if (clickResult) {
            break;
        }

        await new Promise(r => setTimeout(r, 300));
        process.stdout.write('\x1b[90m.\x1b[0m');
    }

    if (clickResult) {
        console.log();
        console.log();
        console.log('\x1b[32m========================================\x1b[0m');
        console.log('\x1b[32mCLICK CAPTURED!\x1b[0m');
        console.log('\x1b[32m========================================\x1b[0m');
        console.log();
        console.log('\x1b[37m  pageX: ' + clickResult.pageX + '\x1b[0m');
        console.log('\x1b[37m  pageY: ' + clickResult.pageY + '\x1b[0m');
        console.log('\x1b[37m  canvasX: ' + clickResult.canvasX + '\x1b[0m');
        console.log('\x1b[37m  canvasY: ' + clickResult.canvasY + '\x1b[0m');
        if (clickResult.source) {
            console.log('\x1b[37m  source: ' + clickResult.source + '\x1b[0m');
        }
        if (clickResult.detectedTabUrl) {
            console.log('\x1b[37m  tab: ' + clickResult.detectedTabUrl + '\x1b[0m');
        }

        const calibration = {
            timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
            favoritePosition: {
                pageX: clickResult.pageX,
                pageY: clickResult.pageY,
                canvasX: clickResult.canvasX,
                canvasY: clickResult.canvasY
            },
            source: clickResult.source || 'unknown',
            pageUrl: clickResult.pageUrl || clickResult.detectedTabUrl || ''
        };

        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(calibration, null, 2), 'utf8');
        console.log();
        console.log('\x1b[32mCalibration saved to: ' + outputFile + '\x1b[0m');
    } else {
        console.log();
        console.log();
        console.log('\x1b[31mNo click detected within ' + Math.round(timeoutMs / 1000) + ' seconds.\x1b[0m');
    }

    for (const client of clients.values()) {
        await client.close();
    }
    console.log();
    console.log('\x1b[36mDone.\x1b[0m');
}

main().catch(err => {
    console.error('\x1b[31mError: ' + err.message + '\x1b[0m');
    process.exit(1);
});
