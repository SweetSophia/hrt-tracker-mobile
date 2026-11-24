import { expect, test, type Page } from '@playwright/test';

type CheckPhase = 'fetch' | 'reply';

interface UpdateFixture {
    attempts: number;
    opened: string[];
    foreground: () => void;
    setRelease: (version: string | null) => void;
    failCheck: (code?: string) => void;
    failDismiss: () => void;
    holdNextCheck: (phase: CheckPhase) => void;
    finishCheck: () => void;
}

const about = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'App updates' })).toBeVisible();
};

test.use({ locale: 'en-US' });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const pluginMethods = (name: string, names: string[]) => ({
            name,
            methods: names.map(name => ({ name, rtype: 'promise' })),
        });
        localStorage.setItem('app-onboarded', 'true');
        const foregroundListeners = new Map<string, () => void>();
        let nextListener = 0;
        let release: string | null | undefined;
        let checkFailure: string | null = null;
        let dismissFailure = false;
        let checkGate: { phase: CheckPhase; wait: Promise<void> } | undefined;
        let releaseGate: (() => void) | undefined;
        const state = {
            revision: 0,
            installedVersion: '1.1.0',
            automatic: localStorage.getItem('fixture-auto-update') === 'true',
            availableVersion: localStorage.getItem('fixture-available-update'),
            dismissedVersion: localStorage.getItem('fixture-dismissed-update'),
        };
        const components = (version: string) => {
            if (!/^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})$/.test(version)) return null;
            const numbers = version.split('.').map(Number);
            return numbers.every(number => number <= 2_147_483_647) ? numbers : null;
        };
        const installed = state.installedVersion.split('.').map(Number);
        const isNewer = (version: number[]) => {
            const firstDifference = version.findIndex((number, index) => number !== installed[index]);
            return firstDifference >= 0 && version[firstDifference] > installed[firstDifference];
        };
        const setCachedRelease = (version: string | null) => {
            if (state.availableVersion === version) return;
            state.availableVersion = version;
            state.revision++;
            if (version) localStorage.setItem('fixture-available-update', version);
            else localStorage.removeItem('fixture-available-update');
        };
        const fixture: UpdateFixture = {
            attempts: 0,
            opened: [],
            foreground: () => foregroundListeners.forEach(listener => listener()),
            setRelease: version => (release = version),
            failCheck: (code = 'UPDATE_CHECK_UNAVAILABLE') => (checkFailure = code),
            failDismiss: () => (dismissFailure = true),
            holdNextCheck: phase => {
                const wait = new Promise<void>(resolve => {
                    releaseGate = resolve;
                });
                checkGate = { phase, wait };
            },
            finishCheck: () => {
                releaseGate?.();
                releaseGate = undefined;
            },
        };
        Object.assign(window, {
            androidBridge: {},
            updateFixture: fixture,
            Capacitor: {
                PluginHeaders: [
                    {
                        name: 'App',
                        methods: [
                            { name: 'addListener', rtype: 'callback' },
                            { name: 'removeListener', rtype: 'promise' },
                            { name: 'getState', rtype: 'promise' },
                        ],
                    },
                    pluginMethods('HrtNativeStorage', ['execute']),
                    pluginMethods('HrtNativeDocuments', ['pick', 'save']),
                    pluginMethods('HrtReleaseUpdates', [
                        'getState',
                        'setAutomatic',
                        'checkNow',
                        'checkOnOpen',
                        'dismiss',
                        'openRelease',
                    ]),
                ],
                nativeCallback: (
                    plugin: string,
                    method: string,
                    options: { eventName: string },
                    callback: (event: { isActive: boolean }) => void,
                ) => {
                    if (plugin !== 'App' || method !== 'addListener') throw new Error('Unexpected callback');
                    const id = String(++nextListener);
                    if (options.eventName === 'appStateChange')
                        foregroundListeners.set(id, () => callback({ isActive: true }));
                    return id;
                },
                nativePromise: async (
                    plugin: string,
                    method: string,
                    options: {
                        callbackId: string;
                        enabled: boolean;
                        operation: string;
                        payload: string;
                        version: string;
                    },
                ) => {
                    if (plugin === 'App' && method === 'getState') return { isActive: true };
                    if (plugin === 'App' && method === 'removeListener')
                        return foregroundListeners.delete(options.callbackId);
                    if (plugin === 'HrtNativeStorage' && method === 'execute') {
                        const { namespace } = JSON.parse(options.payload);
                        if (options.operation === 'initialize') return { version: 1, payload: '{"backend":"offline"}' };
                        if (options.operation === 'read') {
                            const entries =
                                namespace === 'device-preferences:v1'
                                    ? { 'hrt-mode': 'transfem' }
                                    : namespace === 'preferences:v1'
                                      ? { 'hrt-lang': 'en' }
                                      : {};
                            return { version: 1, payload: JSON.stringify({ revision: 0, entries }) };
                        }
                    }
                    if (plugin !== 'HrtReleaseUpdates') throw new Error('Unexpected bridge call');
                    switch (method) {
                        case 'setAutomatic':
                            if (state.automatic !== options.enabled) {
                                state.automatic = options.enabled;
                                state.revision++;
                                localStorage.setItem('fixture-auto-update', String(state.automatic));
                            }
                            break;
                        case 'checkOnOpen':
                        case 'checkNow': {
                            // Android tests cover the persistent 24-hour limit.
                            if (method === 'checkOnOpen' && (!state.automatic || release === undefined))
                                return { outcome: 'skipped', state: { ...state } };
                            fixture.attempts++;
                            state.revision++; // Each admitted check records a new attempt time.
                            const gate = checkGate;
                            const offered = release;
                            const failure = checkFailure;
                            checkGate = undefined;
                            checkFailure = null;
                            if (gate?.phase === 'fetch') await gate.wait;
                            if (failure) throw Object.assign(new Error('Synthetic check failure'), { code: failure });
                            const version = offered ? components(offered) : null;
                            if (version) setCachedRelease(isNewer(version) ? (offered ?? null) : null);
                            const response = {
                                outcome: version ? 'checked' : 'noRelease',
                                state: { ...state },
                            };
                            // The native reply and local preference replies are sent on separate workers.
                            if (gate?.phase === 'reply') await gate.wait;
                            return response;
                        }
                        case 'dismiss':
                            if (options.version !== state.availableVersion || dismissFailure) {
                                dismissFailure = false;
                                throw new Error('Synthetic dismissal failure');
                            }
                            if (state.dismissedVersion !== options.version) {
                                state.dismissedVersion = options.version;
                                state.revision++;
                                localStorage.setItem('fixture-dismissed-update', options.version);
                            }
                            break;
                        case 'openRelease':
                            if (options.version !== state.availableVersion) throw new Error('Synthetic open failure');
                            fixture.opened.push(options.version);
                            return;
                        case 'getState':
                            break;
                        default:
                            throw new Error('Unexpected update call');
                    }
                    return { ...state };
                },
            },
        });
    });
});

const openForeground = (page: Page, version: string | null) =>
    page.evaluate(version => {
        const { updateFixture } = window as unknown as { updateFixture: UpdateFixture };
        updateFixture.setRelease(version);
        updateFixture.foreground();
    }, version);

test('manual checks work with automatic checks off and can be retried', async ({ page }) => {
    await page.goto('/');
    await about(page);
    const check = page.getByRole('button', { name: 'Check for updates', exact: true });
    await expect(page.getByText('1.1.0', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatically check for updates' })).not.toBeChecked();
    await openForeground(page, '1.2.0');
    await page.evaluate(() => {
        const { updateFixture } = window as unknown as { updateFixture: UpdateFixture };
        if (updateFixture.attempts !== 0) throw new Error('An automatic check was attempted without consent');
        updateFixture.setRelease('1.0.9');
        updateFixture.failCheck();
    });
    await check.click();
    await expect(page.getByText('Couldn’t check for updates. Try again.')).toBeVisible();
    await check.click();
    await expect(page.getByText('You’re up to date.')).toBeVisible();
    await page.evaluate(() => {
        (window as unknown as { updateFixture: UpdateFixture }).updateFixture.failCheck('UPDATE_CATALOG_TOO_LARGE');
    });
    await check.click();
    await expect(page.getByText('The release list is too large to check here. See GitHub for updates.')).toBeVisible();
    await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.setRelease('1.2'));
    await check.click();
    await expect(page.getByText('No stable Android release found.')).toBeVisible();
    await page.evaluate(() =>
        (window as unknown as { updateFixture: UpdateFixture }).updateFixture.setRelease('1.2.0'),
    );
    await check.click();
    await expect(page.getByText('HRT Tracker 1.2.0 is available.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Later', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'View release', exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.opened))
        .toEqual(['1.2.0']);
});

test('a foreground notice respects consent and dismissal across reloads', async ({ page }) => {
    await page.goto('/');
    await about(page);
    const toggle = page.getByRole('switch', { name: 'Automatically check for updates' });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await openForeground(page, '1.2.0');
    const later = page.getByRole('button', { name: 'Later', exact: true });
    await expect(later).toBeVisible();
    const check = page.getByRole('button', { name: 'Check for updates', exact: true });
    await page.evaluate(() =>
        (window as unknown as { updateFixture: UpdateFixture }).updateFixture.holdNextCheck('fetch'),
    );
    await openForeground(page, null);
    await expect(check).toBeDisabled();
    await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.finishCheck());
    await expect(check).toBeEnabled();
    await expect(later).toBeVisible();
    await expect(page.getByText('HRT Tracker 1.2.0 is available.')).toHaveCount(2);
    await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.failDismiss());
    await later.click();
    await expect(page.getByText('Couldn’t dismiss this notice. Try again.')).toBeVisible();
    await later.click();
    await expect(later).toHaveCount(0);
    await page.reload();
    await about(page);
    await expect(toggle).toBeChecked();
    await expect(page.getByText('HRT Tracker 1.2.0 is available.')).toBeVisible();
    await expect(later).toHaveCount(0);
    await openForeground(page, '1.3.0');
    await expect(later).toBeVisible();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(later).toHaveCount(0);
});

const pendingWindows = [
    ['fetch', 'a held fetch leaves local update controls responsive'],
    ['reply', 'an older bridge reply cannot undo consent or restore a dismissed notice'],
] as const;

for (const [phase, title] of pendingWindows) {
    test(title, async ({ page }) => {
        await page.goto('/');
        await about(page);
        const toggle = page.getByRole('switch', { name: 'Automatically check for updates' });
        const later = page.getByRole('button', { name: 'Later', exact: true });
        const check = page.getByRole('button', { name: 'Check for updates', exact: true });
        await toggle.click();
        await expect(toggle).toBeChecked();
        await openForeground(page, '1.2.0');
        await expect(later).toBeVisible();
        await page.evaluate(
            phase => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.holdNextCheck(phase),
            phase,
        );
        await check.click();
        await expect(page.getByText('Checking for updates…')).toBeVisible();
        await expect(check).toHaveAttribute('disabled', '');
        await expect(later).toBeEnabled();
        await page.getByRole('button', { name: 'View release', exact: true }).first().click();
        await expect
            .poll(() =>
                page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.opened),
            )
            .toEqual(['1.2.0']);
        await later.click();
        await expect(later).toHaveCount(0);
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.finishCheck());
        await expect(check).toBeEnabled();
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(later).toHaveCount(0);
    });
}

test('a settled foreground check supersedes the previous manual result', async ({ page }) => {
    await page.goto('/');
    await about(page);
    const check = page.getByRole('button', { name: 'Check for updates', exact: true });
    const toggle = page.getByRole('switch', { name: 'Automatically check for updates' });
    const current = page.getByText('You’re up to date.');
    const error = page.getByText('Couldn’t check for updates. Try again.');

    await page.evaluate(() =>
        (window as unknown as { updateFixture: UpdateFixture }).updateFixture.setRelease('1.1.0'),
    );
    await check.click();
    await expect(current).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.evaluate(() => {
        const { updateFixture } = window as unknown as { updateFixture: UpdateFixture };
        updateFixture.failCheck();
        updateFixture.holdNextCheck('fetch');
        updateFixture.foreground();
    });
    await expect(check).toBeDisabled();
    await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.finishCheck());
    await expect(check).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'App updates' })).toBeVisible();
    await expect(current).toHaveCount(0);
    await expect(error).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { updateFixture: UpdateFixture }).updateFixture.failCheck());
    await check.click();
    await expect(error).toBeVisible();
    await openForeground(page, '1.1.0');
    await expect(current).toBeVisible();
    await expect(error).toHaveCount(0);
    await openForeground(page, null);
    await expect(page.getByText('No stable Android release found.')).toBeVisible();
    await openForeground(page, '1.2.0');
    await expect(page.getByText('HRT Tracker 1.2.0 is available.')).toHaveCount(2);
});
