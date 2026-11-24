import { expect, test, type Page } from '@playwright/test';

interface UpdateFixture {
    attempts: number;
    opened: string[];
    foreground: () => void;
    setRelease: (version: string | null) => void;
    failCheck: () => void;
    failDismiss: () => void;
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
        let release: string | null = null;
        let networkFailure = false;
        let dismissFailure = false;
        const state = {
            installedVersion: '1.1.0',
            automatic: localStorage.getItem('fixture-auto-update') === 'true',
            availableVersion: localStorage.getItem('fixture-available-update'),
            dismissedVersion: localStorage.getItem('fixture-dismissed-update'),
        };
        const fixture: UpdateFixture = {
            attempts: 0,
            opened: [],
            foreground: () => foregroundListeners.forEach(listener => listener()),
            setRelease: version => (release = version),
            failCheck: () => (networkFailure = true),
            failDismiss: () => (dismissFailure = true),
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
                            state.automatic = options.enabled;
                            localStorage.setItem('fixture-auto-update', String(state.automatic));
                            break;
                        case 'checkOnOpen':
                            if (!state.automatic) break;
                            // The real daily limit is exercised by the Android unit tests.
                            if (release === null) break;
                        // Fall through to respond with the available release for this foreground event.
                        case 'checkNow':
                            fixture.attempts++;
                            if (networkFailure) {
                                networkFailure = false;
                                throw new Error('Synthetic network failure');
                            }
                            state.availableVersion = release;
                            if (release) localStorage.setItem('fixture-available-update', release);
                            else localStorage.removeItem('fixture-available-update');
                            break;
                        case 'dismiss':
                            if (dismissFailure) {
                                dismissFailure = false;
                                throw new Error('Synthetic dismissal failure');
                            }
                            state.dismissedVersion = options.version;
                            localStorage.setItem('fixture-dismissed-update', options.version);
                            break;
                        case 'openRelease':
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

const openForeground = (page: Page, version: string) =>
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
        updateFixture.setRelease(null);
        updateFixture.failCheck();
    });
    await check.click();
    await expect(page.getByText('Couldn’t check for updates. Try again.')).toBeVisible();
    await check.click();
    await expect(page.getByText('You’re up to date.')).toBeVisible();
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
