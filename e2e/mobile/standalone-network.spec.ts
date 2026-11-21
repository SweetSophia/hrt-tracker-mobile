import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage } from '../helpers';

for (const seeded of [false, true]) {
    test(`standalone startup and resume with ${seeded ? 'dormant credentials' : 'empty account storage'}`, async ({
        page,
        context,
    }) => {
        const protectedValues = seeded
            ? {
                  auth_token: 'SYNTHETIC-NOT-A-REAL-TOKEN',
                  auth_user: JSON.stringify({ id: 'synthetic', username: 'synthetic', isAdmin: true }),
                  enc_key: 'SYNTHETIC-NOT-A-REAL-KEY',
                  'hrt-usynthetic-events': '[{"id":"synthetic-feminizing-sentinel"}]',
                  'hrt-usynthetic-masc-events': '[{"id":"synthetic-masculinizing-sentinel"}]',
              }
            : {};
        await seedStorage(context, baseStorage({ ...protectedValues, 'app-auto-backup': 'true' }));
        const requests: string[] = [];
        const sockets: string[] = [];
        const attempts: string[] = [];
        await page.exposeFunction('recordNetworkAttempt', (url: string) => attempts.push(url));
        page.on('request', request => requests.push(request.url()));
        page.on('websocket', socket => sockets.push(socket.url()));
        await page.addInitScript(() => {
            const record = (input: unknown) =>
                void (
                    window as unknown as { recordNetworkAttempt: (url: string) => Promise<void> }
                ).recordNetworkAttempt(input instanceof Request ? input.url : String(input));
            const originalFetch = window.fetch;
            window.fetch = function (input, init) {
                record(input);
                return originalFetch.call(this, input, init);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = new Proxy(originalOpen, {
                apply(target, receiver, args) {
                    record(args[1]);
                    return Reflect.apply(target, receiver, args);
                },
            });
            const originalBeacon = navigator.sendBeacon;
            navigator.sendBeacon = function (url, data) {
                record(url);
                return originalBeacon.call(this, url, data);
            };
            window.WebSocket = new Proxy(window.WebSocket, {
                construct(target, args) {
                    record(args[0]);
                    return Reflect.construct(target, args);
                },
            });
            document.addEventListener('securitypolicyviolation', event => record(`CSP:${event.blockedURI}`));
        });
        await page.clock.install();
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveCount(0);
        await page.clock.fastForward('31:00');
        await page.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: /HRT mode/i }).click();
        await page.getByRole('button', { name: /Masculinizing HRT/i }).click();
        await page.clock.fastForward('31:00');
        await page.reload();
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        const state = await page.evaluate(
            keys => ({
                values: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
            }),
            Object.keys(protectedValues),
        );
        expect(state.values).toEqual(protectedValues);
        expect(attempts).toEqual([]);
        expect(sockets).toEqual([]);
        expect(
            requests.filter(url => {
                const parsed = new URL(url);
                return (
                    parsed.origin !== 'http://127.0.0.1:4174' ||
                    !/^\/$|^\/assets\/|^\/(pwa-|favicon|fonts\/)/.test(parsed.pathname)
                );
            }),
        ).toEqual([]);
        expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    });
}
