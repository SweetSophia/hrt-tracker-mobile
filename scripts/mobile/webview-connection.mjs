import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// Android.devices() (and launchServer's serial filter) initializes every
// connected device. Forward only this app's socket on the explicit serial.
export async function openPrototypeWebView(serial) {
    if (!serial) throw new Error('An explicit device serial is required');
    const pkg = 'org.askarys.hrttracker.spike';
    const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 });
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
    const pid = adb('shell', 'pidof', pkg).trim();
    if (!/^\d+$/.test(pid)) throw new Error('Expected one prototype process');
    const socket = `webview_devtools_remote_${pid}`;
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
        ready = adb('shell', 'cat', '/proc/net/unix')
            .split('\n')
            .some(line => line.trim().endsWith(`@${socket}`));
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('Prototype WebView socket did not appear');
    const port = adb('forward', 'tcp:0', `localabstract:${socket}`).trim();
    if (!/^\d+$/.test(port)) throw new Error('Invalid forwarded port');
    let browser;
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        try {
            if (browser?.isConnected()) await browser.close();
        } finally {
            adb('forward', '--remove', `tcp:${port}`);
        }
    };
    try {
        browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/devtools/browser`, {
            timeout: 30_000,
            noDefaults: true,
        });
        const context = browser.contexts()[0];
        if (!context) throw new Error('Prototype WebView context unavailable');
        const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 30_000 }));
        await page.waitForURL(url => url.origin === 'https://localhost', { timeout: 30_000 });
        return { page, close };
    } catch (error) {
        await close();
        throw error;
    }
}
