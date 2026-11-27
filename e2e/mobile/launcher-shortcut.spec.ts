import { expect, test, type Page } from '@playwright/test';
import { TRANSLATIONS } from '../../src/i18n/translations';
import { fill } from '../../src/utils/regimenText';
import { baseStorage, seedStorage, type DoseEventFixture, type LabFixture } from '../helpers';

/**
 * Stage 4 launcher shortcut, exercised through a bridge mock. The mock stands
 * in for the native bridge. The bundled mobile app runs its platform gate
 * and React interaction owners.
 *
 * The App plugin retains the intent that started the activity and delivers it
 * when the first appUrlOpen listener attaches, which is how a cold launch
 * arrives. Later intents arrive while the app is already running.
 */

type Harness = {
    /** A shortcut tap while the app is running. */
    open(url: string): void;
    /** The native Back key. */
    back(): void;
    /** How many times the app asked to leave the foreground. */
    leaves: number;
    /** Labels the app published for the Add dose shortcut, in order. */
    publications: string[];
    listeners(): number;
};

declare global {
    interface Window {
        __launchHarness: Harness;
    }
}

const open = (page: Page, url = 'hrttracker://add-dose') => page.evaluate(url => window.__launchHarness.open(url), url);
const back = (page: Page) => page.evaluate(() => window.__launchHarness.back());
const leaves = (page: Page) => page.evaluate(() => window.__launchHarness.leaves);
const publications = (page: Page) => page.evaluate(() => window.__launchHarness.publications);
const listenerCount = (page: Page) => page.evaluate(() => window.__launchHarness.listeners());

const events = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]')) as Promise<DoseEventFixture[]>;
const labs = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-lab-results') ?? '[]')) as Promise<LabFixture[]>;

/** The quick-add form itself, not any other open disclosure on the page. */
const doseForm = (page: Page) =>
    page.locator('.disclosure[data-open="true"] form').filter({ has: page.getByLabel('Dose (mg)', { exact: true }) });
const shortcutHint = (page: Page) =>
    page.getByRole('status').filter({
        hasText: fill(TRANSLATIONS.en['launcher.finish_current'], { action: TRANSLATIONS.en['btn.add'] }),
    });

// Pause before the shortcut starts its timer. Leave time for the browser round trip.
const pauseBeforeShortcut = async (page: Page) => page.clock.pauseAt(await page.evaluate(() => Date.now() + 10_000));

/** The bridge the bundled app sees. startup is delivered to the first appUrlOpen listener. */
function installBridge(startup: string | null) {
    const urlCallbacks = new Map<string, (event: unknown) => void>();
    const backCallbacks = new Map<string, (event: unknown) => void>();
    let id = 0;
    // One retained startup intent, consumed once: the activity opens the app a
    // second time (resume, later listener re-registration) without it.
    let pending = startup;
    const state: Harness = {
        publications: [],
        leaves: 0,
        listeners: () => urlCallbacks.size,
        open: url => {
            for (const callback of urlCallbacks.values()) callback({ url });
        },
        back: () => {
            for (const callback of backCallbacks.values()) callback({ canGoBack: true });
        },
    };
    Object.assign(window, {
        androidBridge: {},
        __launchHarness: state,
        Capacitor: {
            PluginHeaders: [
                {
                    name: 'App',
                    methods: [
                        { name: 'addListener', rtype: 'callback' },
                        { name: 'removeListener', rtype: 'promise' },
                        { name: 'minimizeApp', rtype: 'promise' },
                    ],
                },
                { name: 'HrtLauncherShortcut', methods: [{ name: 'publishAddDose', rtype: 'promise' }] },
            ],
            nativeCallback: (
                plugin: string,
                method: string,
                options: { eventName: string },
                callback: (event: unknown) => void,
            ) => {
                if (plugin !== 'App' || method !== 'addListener') throw new Error('Unexpected bridge call');
                const key = String(++id);
                if (options.eventName === 'appUrlOpen') {
                    urlCallbacks.set(key, callback);
                    // The retained startup intent belongs to the first listener only.
                    if (pending !== null) {
                        const url = pending;
                        pending = null;
                        callback({ url });
                    }
                } else if (options.eventName === 'backButton') {
                    backCallbacks.set(key, callback);
                } else {
                    throw new Error('Unexpected event');
                }
                return key;
            },
            nativePromise: async (plugin: string, method: string, options: { label?: string; callbackId?: string }) => {
                if (plugin === 'HrtLauncherShortcut' && method === 'publishAddDose') {
                    if (typeof options.label !== 'string' || Object.keys(options).length !== 1) {
                        throw new Error('Shortcut payload carries more than the label');
                    }
                    state.publications.push(options.label);
                    return;
                }
                if (plugin !== 'App') throw new Error('Unexpected plugin');
                if (method === 'removeListener' && options.callbackId) {
                    urlCallbacks.delete(options.callbackId);
                    backCallbacks.delete(options.callbackId);
                } else if (method === 'minimizeApp') {
                    state.leaves++;
                } else {
                    throw new Error('Unexpected method');
                }
            },
        },
    });
}

/** An onboarded launch. startup is the intent the activity was opened with. */
async function launch(page: Page, startup: string | null, extra: Record<string, string> = {}) {
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    await seedStorage(page.context(), baseStorage(extra));
    await page.addInitScript(installBridge, startup);
    await page.goto('/');
    await expect.poll(() => listenerCount(page)).toBe(1);
}

/** Finishes the intro, so the shortcut publication and actions can start. */
async function completeOnboarding(page: Page) {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}

test('a cold launch from the shortcut opens the Add dose form and saves one synthetic record', async ({ page }) => {
    await launch(page, 'hrttracker://add-dose');
    const form = doseForm(page);
    await expect(form).toBeVisible();
    expect(await events(page)).toEqual([]);

    await form.getByLabel('Dose (mg)', { exact: true }).fill('2');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await events(page)).toMatchObject([{ doseMG: 2 }]);
});

test('a shortcut while Settings is open routes to History and opens the form', async ({ page }) => {
    await launch(page, null);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: /Data management/ })).toBeVisible();

    await open(page);
    await expect(doseForm(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible();
    expect(await events(page)).toEqual([]);
});

test('a repeated shortcut keeps the typed draft and still saves nothing', async ({ page }) => {
    await launch(page, 'hrttracker://add-dose');
    const form = doseForm(page);
    const amount = form.getByLabel('Dose (mg)', { exact: true });
    await amount.fill('2.5');

    await open(page);
    await expect(amount).toHaveValue('2.5');
    expect(await events(page)).toEqual([]);

    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => events(page)).toMatchObject([{ doseMG: 2.5 }]);
});

test('a shortcut during a lab edit explains how to retry without interrupting the draft', async ({ page }) => {
    const lab: LabFixture = { id: 'shortcut-lab', timeH: Date.now() / 3600000 - 1, concValue: 123, unit: 'pmol/l' };
    await launch(page, null, { 'hrt-lab-results': JSON.stringify([lab]) });
    await page.getByRole('button', { name: 'Labs', exact: true }).click();
    const row = page.getByRole('button', { name: /^123 pmol/ });
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    const reading = row.locator('..').getByRole('textbox', { name: 'Estradiol level', exact: true });
    await expect(reading).toHaveValue('123');
    await reading.fill('124.5');

    await pauseBeforeShortcut(page);
    const pageTop = await page.locator('.main-view').evaluate(el => el.getBoundingClientRect().top);
    await open(page);
    await expect(shortcutHint(page)).toBeVisible();
    expect(await page.locator('.main-view').evaluate(el => el.getBoundingClientRect().top)).toBe(pageTop);
    const nav = page.locator('.bottom-nav');
    const navBottom = () => nav.evaluate(el => el.getBoundingClientRect().bottom);
    const bottomBeforeInset = await navBottom();
    const bottomInset = 36;
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: bottomInset } });
    await expect.poll(navBottom).toBe(bottomBeforeInset - bottomInset);
    await expect(nav).toBeInViewport({ ratio: 1 });
    await expect(shortcutHint(page)).toBeInViewport({ ratio: 1 });
    const noticeBottom = await shortcutHint(page).evaluate(el => el.getBoundingClientRect().bottom);
    const navTop = await nav.evaluate(el => el.getBoundingClientRect().top);
    expect(noticeBottom).toBeLessThan(navTop);
    await expect(reading).toHaveValue('124.5');
    await expect(reading).toBeFocused();
    await expect(doseForm(page)).toHaveCount(0);
    expect(await labs(page)).toMatchObject([{ concValue: 123 }]);
    expect(await events(page)).toEqual([]);

    await row.locator('..').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(shortcutHint(page)).toBeVisible();
    await open(page);
    await expect(doseForm(page)).toBeVisible();
    await expect(shortcutHint(page)).toHaveCount(0);
});

for (const { setting, label, draft } of [
    { setting: /^Weight\b/, label: 'Weight', draft: '73.5' },
    { setting: /^Age\b/, label: 'Year of birth', draft: '1990' },
    { setting: /^Edit parameters\b/, label: 'Estradiol benzoate (EB) formation fraction', draft: '0.75' },
]) {
    test(`a shortcut preserves the settings draft for ${label}`, async ({ page }) => {
        await launch(page, null, { 'hrt-age-beta': 'true' });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: /^General\b/ }).click();
        await page.getByRole('button', { name: setting }).click();
        const field = page.getByRole('spinbutton', { name: label, exact: true });
        const saved = await field.inputValue();
        await field.fill(draft);

        await pauseBeforeShortcut(page);
        await open(page);
        await expect(shortcutHint(page)).toBeVisible();
        await expect(field).toHaveValue(draft);
        await expect(field).toBeFocused();
        await expect(doseForm(page)).toHaveCount(0);
        expect(await events(page)).toEqual([]);

        await field.fill(saved);
        await field.blur();
        await open(page);
        await expect(doseForm(page)).toBeVisible();
    });
}

const backupDose: DoseEventFixture = {
    id: 'shortcut-backup',
    route: 'oral',
    ester: 'EV',
    doseMG: 2,
    timeH: Date.now() / 3600000 - 2,
    extras: {},
};

for (const { screen, row, placeholder, draft } of [
    {
        screen: 'Export data',
        row: /^JSON \(Encrypted\)/,
        placeholder: TRANSLATIONS.en['export.password_placeholder'],
        draft: 'synthetic password for the shortcut test',
    },
    {
        screen: 'Import data',
        row: /^Paste JSON text/,
        placeholder: TRANSLATIONS.en['import.paste_hint'],
        draft: '{"synthetic":',
    },
]) {
    test(`a shortcut preserves the backup draft in ${screen}`, async ({ page }) => {
        await launch(page, null, { 'hrt-events': JSON.stringify([backupDose]) });
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: /Data management/ }).click();
        await page.getByRole('button', { name: screen, exact: true }).click();
        const editor = page.getByRole('button', { name: row });
        await editor.click();
        const field = page.getByPlaceholder(placeholder, { exact: true });
        await field.fill(draft);

        await pauseBeforeShortcut(page);
        await open(page);
        await expect(shortcutHint(page)).toBeVisible();
        await expect(field).toHaveValue(draft);
        await expect(field).toBeFocused();
        await expect(doseForm(page)).toHaveCount(0);

        await editor.click();
        await expect(field).toHaveCount(0);
        await editor.click();
        await expect(field).toHaveValue('');
        await open(page);
        await expect(doseForm(page)).toBeVisible();
        expect(await events(page)).toMatchObject([backupDose]);
    });
}

test('a shortcut preserves a changed What-if dose and opens after the original dose is restored', async ({ page }) => {
    await launch(page, null, { 'hrt-events': JSON.stringify([backupDose]) });
    const forecast = page.getByRole('button', { name: 'What-if', exact: true });
    const amount = page.getByRole('spinbutton', { name: /Dose/ });
    await forecast.click();
    await expect(amount).toBeVisible();
    await open(page);
    await expect(doseForm(page)).toBeVisible();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await forecast.click();
    const originalDose = await amount.inputValue();
    await amount.fill('4.5');

    await pauseBeforeShortcut(page);
    await open(page);
    await expect(shortcutHint(page)).toBeVisible();
    await expect(amount).toHaveValue('4.5');
    await expect(amount).toBeFocused();
    await expect(doseForm(page)).toHaveCount(0);

    await amount.fill(originalDose);
    await open(page);
    await expect(doseForm(page)).toBeVisible();
    expect(await events(page)).toMatchObject([backupDose]);
});

test('a shortcut preserves a second What-if plan and opens when only an unchanged copy remains', async ({ page }) => {
    await launch(page, null, { 'hrt-events': JSON.stringify([backupDose]) });
    await page.getByRole('button', { name: 'What-if', exact: true }).click();
    await page.getByRole('button', { name: 'Add plan', exact: true }).click();

    await pauseBeforeShortcut(page);
    await open(page);
    await expect(shortcutHint(page)).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Plan B', exact: true })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Plan A', exact: true }).click();
    await page.getByRole('button', { name: 'Remove plan', exact: true }).click();
    await open(page);
    await expect(doseForm(page)).toBeVisible();
    expect(await events(page)).toMatchObject([backupDose]);
});

test('an Overview edit ignored during Back does not block the next shortcut', async ({ page }) => {
    const item = {
        id: 'shortcut-plan',
        route: 'oral',
        ester: 'EV',
        doseMG: 2,
        extras: {},
        everyDays: 1,
        timesPerDay: 1,
    };
    await launch(page, null, {
        'hrt-plan': JSON.stringify([item]),
    });
    await page.getByRole('button', { name: 'Took it', exact: true }).click();
    const edit = page.getByRole('button', { name: /Edit dose/ });
    const plan = page.getByRole('button', { name: 'Medication plan', exact: true });
    await edit.evaluate(
        (editButton, planButton) => {
            // Start Back before the Plan transition replaces the Overview controls.
            (planButton as HTMLButtonElement).click();
            window.__launchHarness.back();
            (editButton as HTMLButtonElement).click();
        },
        await plan.elementHandle(),
    );
    await expect.poll(() => page.evaluate(() => history.state?.view)).toBe('home');
    await expect(plan).toBeVisible();

    await open(page);
    await expect(doseForm(page)).toBeVisible();
    expect(await events(page)).toHaveLength(1);
});

test('a shortcut during a delete confirmation leaves the prompt in place', async ({ page }) => {
    const dose: DoseEventFixture = {
        id: 'shortcut-dose',
        route: 'oral',
        ester: 'EV',
        doseMG: 2,
        timeH: Date.now() / 3600000 - 2,
        extras: {},
    };
    await launch(page, null, { 'hrt-events': JSON.stringify([dose]) });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /2.00 mg/ }).click();
    const editor = page.locator('form').filter({ has: page.getByRole('button', { name: 'Delete', exact: true }) });
    await editor.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();

    await pauseBeforeShortcut(page);
    await open(page);
    await expect(shortcutHint(page)).toBeVisible();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    await expect(editor).toBeVisible();
    expect(await events(page)).toHaveLength(1);
});

test('Back and Cancel from the shortcut form return to History without a record', async ({ page }) => {
    await launch(page, 'hrttracker://add-dose');
    const form = doseForm(page);
    await form.getByLabel('Dose (mg)', { exact: true }).fill('3');

    await back(page);
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add dose', exact: true }).first()).toBeVisible();
    expect(await leaves(page)).toBe(0);
    expect(await events(page)).toEqual([]);

    await open(page);
    await doseForm(page).getByLabel('Dose (mg)', { exact: true }).fill('4');
    await page.locator('.glass-bar').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(doseForm(page)).toHaveCount(0);
    await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('heading', { name: 'Dose history', exact: true })).toBeVisible();
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);
});

test('an ordinary launch publishes the shortcut and opens nothing', async ({ page }) => {
    await launch(page, null);
    await expect.poll(() => publications(page)).toEqual(['Add dose']);
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);

    // Coming back to the foreground is not a shortcut tap: the startup intent
    // was consumed once, so a resume replays nothing and records nothing.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);
});

test('a URI the shortcut never sends opens nothing and writes nothing', async ({ page }) => {
    await launch(page, 'hrttracker://add-dose?amount=9');
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);

    for (const url of ['hrttracker://labs', 'hrttracker://add-dose/', 'https://example.test/add-dose']) {
        await open(page, url);
    }
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);
    expect(await publications(page)).toEqual(['Add dose']);
});

test('the published shortcut label follows the language chosen in the app', async ({ page }) => {
    await launch(page, null, { 'hrt-lang': 'de' });
    await expect.poll(() => publications(page)).toEqual(['Dosis hinzufügen']);

    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    const category = page.getByRole('button', { name: /^Allgemein/ });
    const row = page.getByRole('button', { name: /^Sprache/ });
    await expect(category.or(row).first()).toBeVisible();
    if (await category.isVisible()) await category.click();
    await row.click();
    await page.getByRole('button', { name: 'English', exact: true }).click();

    await expect.poll(() => publications(page)).toEqual(['Dosis hinzufügen', 'Add dose']);
    await open(page);
    await expect(doseForm(page).getByLabel('Dose (mg)', { exact: true })).toBeVisible();
});

test('a shortcut while onboarding is up leaves onboarding in place, then publishes once', async ({ page }) => {
    await launch(page, 'hrttracker://add-dose', { 'app-onboarded': 'false' });
    await expect(doseForm(page)).toHaveCount(0);
    expect(await publications(page)).toEqual([]);

    await completeOnboarding(page);
    await expect.poll(() => publications(page)).toEqual(['Add dose']);
    await expect(doseForm(page)).toHaveCount(0);
    expect(await events(page)).toEqual([]);
});
