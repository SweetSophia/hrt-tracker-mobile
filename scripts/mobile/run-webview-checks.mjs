/* global window, document, XMLHttpRequest */
import { openPrototypeWebView } from './webview-connection.mjs';
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        serial: { type: 'string' },
        output: { type: 'string' },
        offline: { type: 'boolean', default: false },
        ordinary: { type: 'boolean', default: false },
    },
});
if (!values.serial || !values.output) throw new Error('Use --serial emulator-NUMBER --output NEW_FILE [--offline]');
if (!/^emulator-\d+$/.test(values.serial))
    throw new Error('Synthetic fixture smoke checks require a dedicated emulator; use non-seeding checks on phones');
const pkg = 'org.askarys.hrttracker.spike';
const adb = (...args) => execFileSync('adb', ['-s', values.serial, ...args], { encoding: 'utf8', timeout: 30_000 });
const checks = {};
const requests = [];
const attempts = [];
let page;
let connection;
const connect = async () => {
    await connection?.close();
    connection = await openPrototypeWebView(values.serial);
    return connection.page;
};
try {
    page = await connect();
    // Check before installing any script that writes settings or synthetic
    // records. Fresh app startup creates empty arrays, which contain no data.
    await page.evaluate(() => {
        if (localStorage.getItem('feasibility-fixture') === '1') return;
        const credentials = ['auth_token', 'auth_user', 'enc_key'];
        const hasCredentials = credentials.some(key => localStorage.getItem(key) !== null);
        const hasRecords = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
            .filter(
                key =>
                    key?.startsWith('hrt-') &&
                    /-(events|lab-results|dose-templates|quick-doses|supplies|plan)$/.test(key),
            )
            .some(key => localStorage.getItem(key) !== '[]');
        if (hasCredentials || hasRecords)
            throw new Error('Refusing to seed existing prototype data; use a disposable emulator profile');
    });
    await page.exposeFunction('recordProbeNetwork', url => attempts.push(url));
    page.on('request', request => requests.push(request.url()));
    page.on('websocket', socket => attempts.push(socket.url()));
    await page.addInitScript(() => {
        const record = input => void window.recordProbeNetwork(input instanceof Request ? input.url : String(input));
        const fetch = window.fetch;
        window.fetch = function (input, init) {
            record(input);
            return fetch.call(this, input, init);
        };
        XMLHttpRequest.prototype.open = new Proxy(XMLHttpRequest.prototype.open, {
            apply(target, receiver, args) {
                record(args[1]);
                return Reflect.apply(target, receiver, args);
            },
        });
        navigator.sendBeacon = new Proxy(navigator.sendBeacon, {
            apply(target, receiver, args) {
                record(args[0]);
                return Reflect.apply(target, receiver, args);
            },
        });
        window.WebSocket = new Proxy(window.WebSocket, {
            construct(target, args) {
                record(args[0]);
                return Reflect.construct(target, args);
            },
        });
        document.addEventListener('securitypolicyviolation', event => record(`CSP:${event.blockedURI}`));
        // Repeated runs must start in the first mode before switching to the
        // second. This init script is not installed on the cold-start page.
        localStorage.setItem('hrt-mode', 'transfem');
        if (!localStorage.getItem('feasibility-fixture')) {
            const dose = (id, ester, doseMG) => ({
                id,
                route: 'injection',
                ester,
                doseMG,
                timeH: Date.now() / 3_600_000 - 24,
                extras: {},
            });
            for (const [key, value] of Object.entries({
                'app-onboarded': 'true',
                'hrt-lang': 'en',
                'app-auto-backup': 'true',
                'hrt-cal-method': 'ekf',
                auth_token: 'SYNTHETIC-TOKEN',
                auth_user: JSON.stringify({ id: 'synthetic', username: 'synthetic' }),
                enc_key: 'SYNTHETIC-KEY',
                'hrt-events': JSON.stringify([dose('synthetic-f', 'EV', 4)]),
                'hrt-masc-events': JSON.stringify([dose('synthetic-m', 'TE', 50)]),
                'hrt-usynthetic-events': '[{"id":"dormant-sentinel"}]',
                'feasibility-fixture': '1',
            }))
                localStorage.setItem(key, value);
        }
    });
    await page.clock.install();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    if (values.ordinary) {
        checks.noProbe = await page.evaluate(() => !('__hrtProbe' in window));
        checks.noSQLitePlugin = await page.evaluate(() => !window.Capacitor.isPluginAvailable('CapacitorSQLite'));
        expect(checks.noProbe && checks.noSQLitePlugin).toBe(true);
    }
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
    await expect(page.locator('svg.tabular-nums')).toBeVisible();
    await page.clock.fastForward('31:00');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const general = page.getByRole('button', { name: /^General/ });
    if (await general.isVisible()) await general.click();
    await page.getByRole('button', { name: /HRT mode/i }).click();
    await page.getByRole('button', { name: /Masculinizing HRT/i }).click();
    await expect(page.getByRole('button', { name: /Masculinizing HRT/i })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hrt-mode'))).toBe('transmasc');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.locator('svg.tabular-nums')).toBeVisible();
    checks.bothModeCharts = true;
    await page.clock.fastForward('31:00');
    const isForeground = () =>
        /(?:topResumedActivity|mResumedActivity).*org\.askarys\.hrttracker\.spike/.test(
            adb('shell', 'dumpsys', 'activity', 'activities'),
        );
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await expect.poll(isForeground).toBe(false);
    adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
    await expect.poll(isForeground).toBe(true);
    checks.nativeBackgroundResume = true;
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const unacceptable = url => {
        const parsed = new URL(url, 'https://localhost');
        return parsed.origin !== 'https://localhost' || parsed.pathname.startsWith('/api');
    };
    expect(requests.filter(unacceptable)).toEqual([]);
    expect(attempts).toEqual([]);
    const automaticApiOrExternalCount = requests.filter(unacceptable).length + attempts.length;
    checks.noAutomaticNetwork = true;
    checks.noServiceWorker = await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length === 0,
    );
    const csp = await page.evaluate(async () => {
        const blocked = [];
        document.addEventListener('securitypolicyviolation', event => blocked.push(event.blockedURI));
        const inline = document.createElement('script');
        inline.textContent = 'window.__untrustedExecuted=true';
        document.head.append(inline);
        const external = document.createElement('script');
        external.src = 'https://example.invalid/untrusted.js';
        document.head.append(external);
        await new Promise(resolve => setTimeout(resolve, 100));
        return { blocked, executed: '__untrustedExecuted' in window };
    });
    checks.cspInline = !csp.executed && csp.blocked.includes('inline');
    checks.cspExternal = csp.blocked.some(value => value.startsWith('https://example.invalid'));
    checks.credentialsUntouched = await page.evaluate(
        () =>
            localStorage.getItem('auth_token') === 'SYNTHETIC-TOKEN' &&
            localStorage.getItem('hrt-usynthetic-events') === '[{"id":"dormant-sentinel"}]',
    );
    if (values.offline) adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
    checks.modeBeforeRestart = await page.evaluate(() => localStorage.getItem('hrt-mode') === 'transmasc');
    adb('shell', 'am', 'force-stop', pkg);
    page = await connect();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('svg.tabular-nums')).toBeVisible();
    checks.coldRestart = await page.evaluate(
        () =>
            localStorage.getItem('hrt-mode') === 'transmasc' &&
            JSON.parse(localStorage.getItem('hrt-masc-events'))[0].id === 'synthetic-m',
    );
    if (values.offline)
        checks.airplaneColdStart = adb('shell', 'settings', 'get', 'global', 'airplane_mode_on').trim() === '1';
    writeFileSync(
        values.output.replace(/\.json$/, '') + '.png',
        execFileSync('adb', ['-s', values.serial, 'exec-out', 'screencap', '-p']),
    );
    const report = {
        checks,
        observations: {
            allowedRequestCount: requests.length,
            automaticApiOrExternalCount,
            networkObservationWindow:
                'instrumented reload through background/resume; excludes first cold-start requests',
            coldStartNetworkObserved: false,
            nativeBackgroundResume: checks.nativeBackgroundResume,
        },
        versions: {
            api: adb('shell', 'getprop', 'ro.build.version.sdk').trim(),
            userAgent: await page.evaluate(() => navigator.userAgent),
        },
    };
    writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    expect(Object.values(checks).every(Boolean)).toBe(true);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
    try {
        if (values.offline) adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
    } finally {
        await connection?.close();
    }
}
