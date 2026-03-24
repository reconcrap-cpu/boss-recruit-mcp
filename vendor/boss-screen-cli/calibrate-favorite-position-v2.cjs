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

console.log('\x1b[36m========================================\x1b[0m');
console.log('\x1b[36mFavorite Button Calibration Tool\x1b[0m');
console.log('\x1b[36m========================================\x1b[0m');
console.log();

async function main() {
    let tabs;
    try {
        const response = await fetch(`http://localhost:${debugPort}/json/list`);
        tabs = await response.json();
    } catch (e) {
        console.log('\x1b[31mFailed to connect to Chrome DevTools: ' + e.message + '\x1b[0m');
        process.exit(1);
    }

    const bossTab = tabs.find(tab => tab.url && tab.url.includes('zhipin.com'));
    if (!bossTab) {
        console.log('\x1b[31mBOSS page not found!\x1b[0m');
        process.exit(1);
    }

    console.log('\x1b[32mFound: ' + bossTab.title + '\x1b[0m');
    console.log('\x1b[90mURL: ' + bossTab.url + '\x1b[0m');

    const wsUrl = bossTab.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });
    console.log('\x1b[32mConnected!\x1b[0m');

    const js = `(function() {
    window.__calibrationData = null;

    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        if (iframe.src && iframe.src.includes('c-resume')) {
            try {
                var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                var canvases = iframeDoc.querySelectorAll('canvas');
                if (canvases.length > 0) {
                    var canvas = canvases[0];
                    canvas.addEventListener('click', function(e) {
                        window.__calibrationData = {
                            clicked: true,
                            pageX: e.pageX,
                            pageY: e.pageY,
                            clientX: e.clientX,
                            clientY: e.clientY,
                            canvasX: e.clientX - canvas.getBoundingClientRect().left,
                            canvasY: e.clientY - canvas.getBoundingClientRect().top
                        };
                    }, { once: true });
                    return { success: true, canvasId: canvas.id };
                }
            } catch (e) {
                return { success: false, error: e.message };
            }
            break;
        }
    }
    return { success: false, error: 'Canvas not found' };
})()`;

    let msgId = 1;

    function sendMessage(method, params) {
        return new Promise((resolve) => {
            const id = msgId++;
            const handler = (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.id === id) {
                        ws.off('message', handler);
                        resolve(msg);
                    }
                } catch (e) {}
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    const result = await sendMessage('Runtime.evaluate', { expression: js, returnByValue: true });

    if (result.result && result.result.result && result.result.result.value) {
        const val = result.result.result.value;
        if (val.success) {
            console.log('\x1b[32mClick listener added to canvas!\x1b[0m');
        } else {
            console.log('\x1b[31mFailed to add listener: ' + val.error + '\x1b[0m');
            ws.close();
            process.exit(1);
        }
    }

    console.log();
    console.log('\x1b[33m========================================\x1b[0m');
    console.log('\x1b[33mCALIBRATION MODE - Click the FAVORITE BUTTON now!\x1b[0m');
    console.log('\x1b[33m========================================\x1b[0m');
    console.log();
    console.log('\x1b[36mMonitoring for 30 seconds...\x1b[0m');
    console.log();

    const checkJs = `(function() {
    if (window.__calibrationData && window.__calibrationData.clicked) {
        var data = window.__calibrationData;
        window.__calibrationData = null;
        return { clicked: true, position: data };
    }
    return { clicked: false };
})()`;

    const endTime = Date.now() + 30000;
    let clickResult = null;

    while (Date.now() < endTime && ws.readyState === WebSocket.OPEN && !clickResult) {
        const checkResult = await sendMessage('Runtime.evaluate', { expression: checkJs, returnByValue: true });

        if (checkResult.result && checkResult.result.result && checkResult.result.result.value) {
            const val = checkResult.result.result.value;
            if (val.clicked) {
                clickResult = val.position;
                break;
            }
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

        const calibration = {
            timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
            favoritePosition: {
                pageX: clickResult.pageX,
                pageY: clickResult.pageY,
                canvasX: clickResult.canvasX,
                canvasY: clickResult.canvasY
            }
        };

        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(calibration, null, 2), 'utf8');
        console.log();
        console.log('\x1b[32mCalibration saved to: ' + outputFile + '\x1b[0m');
    } else {
        console.log();
        console.log();
        console.log('\x1b[31mNo click detected within 30 seconds.\x1b[0m');
    }

    ws.close();
    console.log();
    console.log('\x1b[36mDone.\x1b[0m');
}

main().catch(err => {
    console.error('\x1b[31mError: ' + err.message + '\x1b[0m');
    process.exit(1);
});
