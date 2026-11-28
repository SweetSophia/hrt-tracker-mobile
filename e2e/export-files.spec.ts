import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decryptData } from '../src/domain/crypto';
import type { FileSaveResult } from '../src/platform/contracts/files';
import type { ExportFilesFixture } from './fixtures/export-files';
import { reportText } from '../tests/helpers/reportText';
import {
    assertNoCredentials,
    baseStorage,
    confirmDialog,
    dismissAlert,
    gotoApp,
    registerUser,
    SYNTHETIC_PASSWORD,
    openExport,
    seedStorage,
    type BundleFixture,
} from './helpers';

test.use({ timezoneId: 'UTC' });
const DATE = '2026-01-02';
const NOW = `${DATE}T12:00:00.000Z`;
const at = Date.parse('2026-01-01T10:00:00Z');
const dose = {
    id: 'synthetic-fem',
    route: 'injection',
    ester: 'EV',
    doseMG: 1,
    timeH: Date.parse('2026-01-01T08:00:00Z') / 3600000,
    extras: {},
    updatedAt: at,
};
const mascDose = { ...dose, id: 'synthetic-masc', ester: 'TC', doseMG: 2 };
const lab = { id: 'synthetic-lab', timeH: dose.timeH + 1, concValue: 95, unit: 'pg/ml', updatedAt: at };
const template = {
    ...dose,
    id: 'synthetic-template',
    name: '週末 Café 🏳️‍⚧️',
    createdAt: at,
};
const plan = {
    id: 'synthetic-plan',
    route: 'injection',
    ester: 'EV',
    doseMG: 1,
    extras: {},
    everyDays: 7,
    timesPerDay: 1,
};
const storage = (extra: Record<string, string> = {}) =>
    baseStorage({
        'hrt-events': JSON.stringify([dose]),
        'hrt-masc-events': JSON.stringify([mascDose]),
        'hrt-lab-results': JSON.stringify([lab]),
        'hrt-dose-templates': JSON.stringify([template]),
        'hrt-plan': JSON.stringify([plan]),
        'hrt-weight': '72',
        'app-theme': 'light',
        login_device_passes: JSON.stringify({ synthetic: 'SECRET-DEVICE-PASS' }),
        ...extra,
    });

async function download(page: Page, action: () => Promise<unknown>, name: string, testInfo: TestInfo) {
    const promise = page.waitForEvent('download');
    await action();
    const result = await promise;
    expect(result.suggestedFilename()).toBe(name);
    const path = testInfo.outputPath(name);
    await result.saveAs(path);
    expect(await result.failure()).toBeNull();
    return readFile(path);
}

async function openFixture(page: Page, offline = false) {
    await page.goto('/e2e/fixtures/export-files.html' + (offline ? '?offline' : ''));
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}

async function pendingSave(page: Page) {
    await expect.poll(() => page.evaluate(() => window.__exportFilesFixture.pending())).toBe(1);
    return page.evaluate(() => window.__exportFilesFixture.requests.at(-1)!);
}

async function settle(page: Page, result: FileSaveResult | 'reject') {
    await page.evaluate(outcome => window.__exportFilesFixture.settle(outcome), result);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

function watchPrivateErrors(page: Page) {
    const messages: string[] = [];
    page.on('console', message => messages.push(message.text()));
    page.on('pageerror', error => messages.push(error.message));
    return async () => {
        expect(messages.join('\n')).not.toContain('SYNTHETIC-EXPORT-ERROR-PRIVATE-SENTINEL');
        await expect(page.locator('body')).not.toContainText('SYNTHETIC-EXPORT-ERROR-PRIVATE-SENTINEL');
    };
}

test('real browser downloads preserve JSON, encrypted JSON, complete backup, CSV and PDF', async ({
    page,
    context,
}, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, storage());
    await gotoApp(page);
    await openExport(page);

    const plain = await download(
        page,
        () => page.getByRole('button', { name: /Export JSON file/ }).click(),
        `hrt-dosages-${DATE}.json`,
        testInfo,
    );
    const payload = JSON.parse(plain.toString('utf8'));
    expect(payload.meta).toEqual({ version: 2, exportedAt: NOW });
    expect(payload.events).toEqual([dose]);
    expect(payload.labResults).toEqual([lab]);
    expect(payload.doseTemplates[0].name).toBe(template.name);
    expect(payload.modes.transmasc.events).toEqual([mascDose]);
    assertNoCredentials(payload);

    await page.getByRole('button', { name: /^JSON \(/ }).click();
    const encrypted = await download(
        page,
        () => page.getByRole('button', { name: 'Export encrypted file', exact: true }).click(),
        `hrt-dosages-encrypted-${DATE}.json`,
        testInfo,
    );
    await expect(page.getByText('Encryption password', { exact: true })).toBeVisible();
    const password = await page.locator('.select-all').innerText();
    expect(JSON.parse(encrypted.toString()).encrypted).toBe(true);
    expect(await decryptData(encrypted.toString(), password)).toBe(plain.toString());
    await page.getByRole('button', { name: 'OK', exact: true }).click();

    const complete = await download(
        page,
        async () => {
            await page.getByRole('button', { name: /Complete backup/ }).click();
            await confirmDialog(page, 'Download');
        },
        `hrt-complete-backup-${DATE}.json`,
        testInfo,
    );
    const bundle = JSON.parse(complete.toString('utf8')) as BundleFixture;
    expect(bundle.format).toBe('oyama-hrt-complete-backup');
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.modes.transfem.events).toEqual([dose]);
    expect(bundle.modes.transmasc.events).toEqual([mascDose]);
    expect(bundle.modes.transfem.doseTemplates?.[0].name).toBe(template.name);
    expect(bundle.modes.transfem.plan).toEqual([plan]);
    expect(bundle.preferences['app-theme']).toBe('light');
    assertNoCredentials(bundle);

    const csv = await download(
        page,
        () => page.getByRole('button', { name: /Export CSV file/ }).click(),
        `hrt-data-${DATE}.csv`,
        testInfo,
    );
    expect(csv.toString('utf8')).toBe(
        'Type,Date,Item,Value,Unit,Route/ester\nDose,Jan 1,Estradiol,1,mg,injection - EV\nLab,Jan 1,Estradiol,95,pg/ml,-',
    );
    const pdf = await download(
        page,
        async () => {
            // The PDF row opens the report options; the file is written from there.
            await page.getByRole('button', { name: /Choose what to include/ }).click();
            await page.getByRole('button', { name: /^Save PDF/ }).click();
        },
        `hrt-report-${DATE}.pdf`,
        testInfo,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = reportText(pdf);
    expect(text).toContain('95');
    expect(text).toContain('Estradiol');
});

test('real browser downloads preserve plan ICS', async ({ page, context }, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, storage());
    await gotoApp(page);
    await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
    const ics = await download(
        page,
        () => page.getByRole('button', { name: /Remind me in my calendar/ }).click(),
        'oyama-plan.ics',
        testInfo,
    );
    expect(ics.toString()).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(ics.toString()).toContain('UID:plan-synthetic-plan-0@oyama-tracker\r\n');
    expect(ics.toString()).toContain('DTSTAMP:20260102T120000Z\r\n');
    expect(ics.toString()).toContain('DTSTART:20260108T080000\r\n');
    expect(ics.toString()).toContain('RRULE:FREQ=DAILY;INTERVAL=7\r\n');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Calendar download requested.');
    await page.screenshot({ path: testInfo.outputPath('calendar-download-requested.png'), animations: 'disabled' });
});

for (const outcome of ['cancelled', 'reject', 'saved', 'download-requested'] as const) {
    test(`encrypted export waits for ${outcome} before exposing a new password`, async ({ page, context }) => {
        await page.clock.setFixedTime(NOW);
        await seedStorage(context, storage());
        const checkErrors = watchPrivateErrors(page);
        await openFixture(page);
        await openExport(page);
        await page.getByRole('button', { name: /^JSON \(/ }).click();
        await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
        const request = await pendingSave(page);
        expect(request.name).toBe(`hrt-dosages-encrypted-${DATE}.json`);
        expect(request.mimeType).toBe('application/json');
        const passwordTitle = page.getByText('Encryption password', { exact: true });
        await expect(passwordTitle).toBeHidden();
        await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
        await settle(page, outcome);
        if (outcome === 'saved' || outcome === 'download-requested') await expect(passwordTitle).toBeVisible();
        else await expect(passwordTitle).toBeHidden();
        if (outcome === 'reject') {
            await expect(page.locator('[data-prompt="alert"]')).toContainText('Could not export the file.');
        } else await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
        await checkErrors();
    });

    test(`calendar export handles ${outcome} without premature success`, async ({ page, context }, testInfo) => {
        await page.clock.setFixedTime(NOW);
        await seedStorage(context, storage());
        const checkErrors = watchPrivateErrors(page);
        await openFixture(page);
        await page.getByRole('button', { name: 'Medication plan', exact: true }).click();
        await page.getByRole('button', { name: /Remind me in my calendar/ }).click();
        const request = await pendingSave(page);
        expect(request.name).toBe('oyama-plan.ics');
        expect(request.mimeType).toBe('text/calendar;charset=utf-8');
        expect(new TextDecoder().decode(Uint8Array.from(request.bytes))).toContain('BEGIN:VCALENDAR');
        const alert = page.locator('[data-prompt="alert"]');
        await expect(alert).toHaveCount(0);
        await settle(page, outcome);
        if (outcome === 'cancelled') await expect(alert).toHaveCount(0);
        if (outcome === 'reject') {
            await expect(alert).toContainText('Could not export the file.');
            await page.screenshot({ path: testInfo.outputPath('calendar-save-error.png'), animations: 'disabled' });
        }
        if (outcome === 'saved') await expect(alert).toContainText('Open the file you just saved');
        if (outcome === 'download-requested') await expect(alert).toContainText('Calendar download requested.');
        await checkErrors();
    });
}

test('complete backup builds at confirmation and shows skipped records only after delivery', async ({
    page,
    context,
}) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, storage({ 'hrt-masc-events': JSON.stringify([{ id: 'bad', route: 'not-a-route' }]) }));
    await openFixture(page);
    await openExport(page);
    await page.getByRole('button', { name: /Complete backup/ }).click();
    await expect(page.locator('[data-prompt="confirm"]')).toBeVisible();
    expect(await page.evaluate(() => window.__exportFilesFixture.requests)).toEqual([]);
    expect(await page.evaluate(() => window.__exportFilesFixture.setTheme('dark'))).toBe(true);
    await confirmDialog(page, 'Download');
    const request = await pendingSave(page);
    expect(request.name).toBe(`hrt-complete-backup-${DATE}.json`);
    expect(request.mimeType).toBe('application/json');
    const bundle = JSON.parse(new TextDecoder().decode(Uint8Array.from(request.bytes))) as BundleFixture;
    expect(bundle.preferences['app-theme']).toBe('dark');
    expect(bundle.modes.transmasc.events).toEqual([]);
    await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
    await settle(page, 'cancelled');
    await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
    // Prove the fixture exercises the warning path, not merely a clean backup.
    await page.getByRole('button', { name: /Complete backup/ }).click();
    await confirmDialog(page, 'Download');
    await pendingSave(page);
    await settle(page, 'saved');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('1 records');
});

async function switchToMasculinizing(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: /HRT mode/ }).click();
    await page.getByRole('button', { name: /^Masculinizing HRT/ }).click();
    await expect(page.getByRole('button', { name: /^Masculinizing HRT/ })).toHaveAttribute('aria-pressed', 'true');
}

test('a pending encrypted save keeps its password available after leaving the export page', async ({
    page,
    context,
}) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, storage());
    await openFixture(page, true);
    await openExport(page);

    const encryptedRow = page.getByRole('button', { name: /^JSON \(/ });
    await encryptedRow.click();
    const exportButton = page.getByRole('button', { name: 'Export encrypted file', exact: true });
    await exportButton.click();
    const request = await pendingSave(page);
    await expect(exportButton).toBeFocused();
    await expect(exportButton).toBeDisabled();
    // Enter exercises the row's UI handler even if the disclosure is aria-disabled.
    await encryptedRow.press('Enter');
    await expect(encryptedRow).toHaveAttribute('aria-expanded', 'true');
    await expect(exportButton).toBeDisabled();
    // Mode switching also remounts the record screen boundary.
    await switchToMasculinizing(page);
    await openExport(page);
    await expect(encryptedRow).toHaveAttribute('aria-expanded', 'true');
    await expect(exportButton).toBeDisabled();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dose history', exact: true })).toBeVisible();
    await settle(page, 'saved');
    await openExport(page);

    const heading = page.getByRole('heading', { name: 'Encryption password', exact: true });
    await expect(heading).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Your encryption password is ready.' })).toHaveCount(1);
    await expect(exportButton).toBeHidden();
    const password = await page.locator('.select-all').innerText();
    const encrypted = new TextDecoder().decode(Uint8Array.from(request.bytes));
    expect(JSON.parse(encrypted).encrypted).toBe(true);
    expect(JSON.parse((await decryptData(encrypted, password))!).events).toEqual([dose]);

    await encryptedRow.press('Enter');
    await expect(page.locator('.select-all')).toHaveText(password);
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(heading).toBeHidden();
    await expect(encryptedRow).toBeFocused();
    await encryptedRow.click();
    await expect(exportButton).toBeEnabled();
});

async function submitSignIn(page: Page, username: string) {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByPlaceholder('Enter username', { exact: true }).fill(username);
    await page.getByPlaceholder('Enter password', { exact: true }).fill(SYNTHETIC_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signOut(page: Page) {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await confirmDialog(page, 'Sign out');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
}

async function startEncryptedExport(page: Page) {
    await openExport(page);
    await page.getByRole('button', { name: /^JSON \(/ }).click();
    await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
    return pendingSave(page);
}

type EncryptionGate = { ready: boolean; release: () => void; finishBack?: () => void };
type ExportTestWindow = Window & { encryptionGate: EncryptionGate };

async function holdEncryption(page: Page) {
    await page.evaluate(() => {
        const original = crypto.subtle.encrypt.bind(crypto.subtle);
        let release!: () => void;
        const hold = new Promise<void>(resolve => {
            release = resolve;
        });
        const gate: EncryptionGate = { ready: false, release };
        (window as unknown as ExportTestWindow).encryptionGate = gate;
        crypto.subtle.encrypt = async (...args) => {
            const result = await original(...args);
            gate.ready = true;
            await hold;
            return result;
        };
    });
}

async function releaseEncryption(page: Page) {
    await page.evaluate(() => {
        (window as unknown as ExportTestWindow).encryptionGate.release();
        return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
}

for (const backLands of [true, false]) {
    const title = backLands
        ? 'browser Back cancels delivery while the export page is still mounted'
        : 'browser export can retry after a dropped Back';
    test(title, async ({ page, context }) => {
        if (!backLands) await page.clock.install();
        await seedStorage(context, storage());
        await openFixture(page);
        await holdEncryption(page);
        await page.evaluate(() => {
            const gate = (window as unknown as ExportTestWindow).encryptionGate;
            const go = history.go;
            history.go = (delta?: number) => {
                gate.finishBack = () => {
                    history.go = go;
                    go.call(history, delta);
                };
            };
        });
        await openExport(page);
        await page.getByRole('button', { name: /^JSON \(/ }).click();
        await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
        await expect
            .poll(() => page.evaluate(() => (window as unknown as ExportTestWindow).encryptionGate.ready))
            .toBe(true);
        const back = page.getByRole('button', { name: /^Export data.*Back$/ });
        await back.click();
        await expect
            .poll(() => page.evaluate(() => typeof (window as unknown as ExportTestWindow).encryptionGate.finishBack))
            .toBe('function');
        await expect(back).toBeVisible();
        if (!backLands) await page.clock.fastForward(1100);
        await releaseEncryption(page);
        await expect(back).toBeVisible();
        expect(await page.evaluate(() => window.__exportFilesFixture.requests)).toEqual([]);
        if (backLands) {
            await page.evaluate(() => (window as unknown as ExportTestWindow).encryptionGate.finishBack!());
            await expect(page.getByRole('tab', { name: 'Data management', exact: true })).toBeVisible();
        } else {
            await expect(back).toBeVisible();
            await page.getByRole('button', { name: 'Export encrypted file', exact: true }).click();
            const request = await pendingSave(page);
            await settle(page, 'saved');
            await expect(page.getByRole('heading', { name: 'Encryption password', exact: true })).toBeVisible();
            const password = await page.locator('.select-all').innerText();
            const encrypted = new TextDecoder().decode(Uint8Array.from(request.bytes));
            expect(JSON.parse(encrypted).encrypted).toBe(true);
            expect(JSON.parse((await decryptData(encrypted, password))!).events).toEqual([dose]);
        }
    });
}

type TransitionTestWindow = ExportTestWindow & { commitViewUpdates: (() => void)[] };

test('overlapping browser Back and Forward cannot export from the outgoing form', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedStorage(context, storage());
    await openFixture(page);
    await holdEncryption(page);
    await openExport(page);
    await page.getByRole('button', { name: /^JSON \(/ }).click();

    await page.evaluate(() => {
        const updates: (() => void)[] = [];
        (window as unknown as TransitionTestWindow).commitViewUpdates = updates;
        Object.defineProperty(document, 'startViewTransition', {
            configurable: true,
            value: (update: () => void) => ({
                finished: new Promise<void>(resolve => {
                    updates.push(() => {
                        update();
                        resolve();
                    });
                }),
            }),
        });
    });
    const queuedUpdates = () =>
        page.evaluate(() => (window as unknown as TransitionTestWindow).commitViewUpdates.length);
    await page.evaluate(() => history.back());
    await expect.poll(queuedUpdates).toBe(1);
    await page.evaluate(() => history.forward());
    await expect.poll(queuedUpdates).toBe(2);

    const save = page.getByRole('button', { name: 'Export encrypted file', exact: true });
    await save.click();
    await expect
        .poll(() =>
            save.evaluate(button => {
                const gate = (window as unknown as TransitionTestWindow).encryptionGate;
                return gate.ready || button.getAttribute('aria-busy') !== 'true';
            }),
        )
        .toBe(true);
    await releaseEncryption(page);
    expect(await queuedUpdates()).toBe(2);
    expect(await page.evaluate(() => window.__exportFilesFixture.requests.length)).toBe(0);

    await page.evaluate(() => (window as unknown as TransitionTestWindow).commitViewUpdates.shift()!());
    await expect(page.getByRole('tab', { name: 'Data management', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as TransitionTestWindow).commitViewUpdates.shift()!());
    await expect(page.getByRole('button', { name: /^Export data.*Back$/ })).toBeVisible();
    await page.getByRole('button', { name: /^JSON \(/ }).click();
    await save.click();
    await pendingSave(page);
    await settle(page, 'cancelled');
    await expect(save).toBeEnabled();
});

test('browser sign-in keeps guest records separate after leaving a completed export', async ({
    page,
    context,
    request,
}) => {
    const account = await registerUser(request, 'exportguest');
    await seedStorage(
        context,
        storage({ login_device_passes: JSON.stringify({ [account.user.username]: account.devicePass }) }),
    );
    await openFixture(page);
    await startEncryptedExport(page);
    await settle(page, 'saved');
    await expect(page.getByRole('heading', { name: 'Encryption password', exact: true })).toBeVisible();

    await submitSignIn(page, account.user.username);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await openExport(page);
    await expect(page.getByText('Encryption password', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: /^JSON \(/ })).toBeHidden();
    expect(await page.evaluate(key => localStorage.getItem(key), `hrt-u${account.user.id}-events`)).toBeNull();
    await signOut(page);
    await openExport(page);
    await expect(page.getByText('Encryption password', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: /^JSON \(/ })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('hrt-events'))).toBe(JSON.stringify([dose]));
});

test('a completed encrypted save leaves focus on a separate backup warning', async ({ page, context }) => {
    await seedStorage(context, storage());
    await openFixture(page, true);
    await startEncryptedExport(page);
    await page.getByRole('button', { name: /Complete backup/ }).click();
    const keep = page.getByRole('button', { name: 'Keep it', exact: true });
    await expect(keep).toBeFocused();
    await settle(page, 'saved');
    await expect(page.getByRole('heading', { name: 'Encryption password', exact: true })).toBeVisible();
    await expect(keep).toBeFocused();
});

for (const emptyMode of [false, true]) {
    const outcome = emptyMode ? 'hands focus to Complete backup in an empty mode' : 'keeps the reopened form usable';
    test(`a custom-password export ${outcome} after saving`, async ({ page, context }) => {
        await seedStorage(context, storage(emptyMode ? { 'hrt-masc-events': '[]' } : {}));
        await openFixture(page, true);
        await openExport(page);
        const row = page.getByRole('button', { name: /^JSON \(/ });
        const save = page.getByRole('button', { name: 'Export encrypted file', exact: true });
        await row.click();
        await page.locator('input[name="export-encryption-password"]').fill(SYNTHETIC_PASSWORD);
        await save.click();
        const request = await pendingSave(page);
        if (emptyMode) await switchToMasculinizing(page);
        else {
            await page.getByRole('button', { name: 'History', exact: true }).click();
            await expect(page.getByRole('heading', { name: 'Dose history', exact: true })).toBeVisible();
        }
        await openExport(page);
        await save.focus();
        await expect(save).toBeFocused();
        await expect(save).toBeDisabled();
        await settle(page, 'saved');
        if (emptyMode) {
            await expect(row).toBeHidden();
            await expect(page.getByRole('button', { name: /^Complete backup/ })).toBeFocused();
        } else {
            await expect(save).toBeEnabled();
            await expect(save).toBeFocused();
        }
        await expect(page.getByRole('heading', { name: 'Encryption password', exact: true })).toBeHidden();
        const encrypted = new TextDecoder().decode(Uint8Array.from(request.bytes));
        expect(JSON.parse(encrypted).encrypted).toBe(true);
        expect(JSON.parse((await decryptData(encrypted, SYNTHETIC_PASSWORD))!).events).toEqual([dose]);
    });
}

for (const format of ['JSON', 'CSV', 'PDF', 'complete'] as const) {
    test(`${format} save rejection is handled without leaking adapter errors`, async ({ page, context }) => {
        await page.clock.setFixedTime(NOW);
        await seedStorage(context, storage());
        const checkErrors = watchPrivateErrors(page);
        await openFixture(page);
        await openExport(page);
        if (format === 'complete') {
            await page.getByRole('button', { name: /Complete backup/ }).click();
            await confirmDialog(page, 'Download');
        } else if (format === 'PDF') {
            // The PDF row opens the report options; the file is written from there.
            await page.getByRole('button', { name: /Choose what to include/ }).click();
            await page.getByRole('button', { name: /^Save PDF/ }).click();
        } else await page.getByRole('button', { name: new RegExp(`Export ${format} file`) }).click();
        const request: ExportFilesFixture['requests'][number] = await pendingSave(page);
        const mime = {
            JSON: 'application/json',
            CSV: 'text/csv;charset=utf-8;',
            PDF: 'application/pdf',
            complete: 'application/json',
        };
        expect(request.mimeType).toBe(mime[format]);
        await settle(page, 'reject');
        await expect(page.locator('[data-prompt="alert"]')).toContainText('Could not export the file.');
        await checkErrors();
        await dismissAlert(page);
    });
}

// --- The custom PDF report -------------------------------------------------

/**
 * One estradiol dose and one estradiol lab in the current mode, and one
 * testosterone dose and one testosterone lab in the other mode. The lab values
 * are distinctive, so a report that carries the wrong record says so in the
 * text of the file itself and not only in the preview.
 */
const reportDose = {
    id: 'synthetic-report-fem',
    route: 'injection',
    ester: 'EV',
    doseMG: 1.25,
    timeH: Date.parse('2026-01-01T08:00:00Z') / 3600000,
    extras: {},
    updatedAt: at,
};
const reportMascDose = { ...reportDose, id: 'synthetic-report-masc', ester: 'TC', doseMG: 2.5 };
const reportLab = {
    id: 'synthetic-report-lab',
    timeH: reportDose.timeH + 1,
    concValue: 95,
    unit: 'pg/ml',
    updatedAt: at,
};
const reportMascLab = {
    id: 'synthetic-report-masc-lab',
    timeH: reportDose.timeH + 1,
    concValue: 437,
    unit: 'ng/dl',
    updatedAt: at,
};

const reportStorage = (extra: Record<string, string> = {}) =>
    baseStorage({
        'hrt-events': JSON.stringify([reportDose]),
        'hrt-masc-events': JSON.stringify([reportMascDose]),
        'hrt-lab-results': JSON.stringify([reportLab]),
        'hrt-masc-lab-results': JSON.stringify([reportMascLab]),
        'hrt-weight': '72',
        'app-theme': 'light',
        ...extra,
    });

/** The report's options, opened from the PDF row in Settings. */
async function openReport(page: Page) {
    await openExport(page);
    await page.getByRole('button', { name: /Choose what to include/ }).click();
    await expect(page.getByRole('heading', { name: 'Report preview' })).toBeVisible();
}

/** Pick a date range from the options list, the way a person does. */
async function chooseRange(page: Page, option: string | RegExp) {
    const trigger = page.getByRole('button', { name: /^Date range/ });
    await trigger.click();
    const list = page.getByRole('listbox', { name: 'Date range', exact: true });
    await expect(list).toBeVisible();
    await list.getByRole('option', { name: option }).click();
    // The list folds away only when its line is pressed again.
    await trigger.click();
}

/**
 * The counts the preview shows, read from the page rather than recomputed.
 *
 * A range that cannot be shown has no counts to read: the preview shows the
 * validation instead, so this answers null rather than a number of zero.
 */
async function counts(page: Page): Promise<{ doses: number; labs: number } | null> {
    const line = page
        .locator('p')
        .filter({ hasText: /^Dose entries:/ })
        .first();
    if ((await line.count()) === 0) return null;
    const text = await line.innerText();
    const match = /Dose entries:\s*(\d+)\s*·\s*Lab results:\s*(\d+)/.exec(text);
    if (!match) throw new Error('Unexpected counts line: ' + text);
    return { doses: Number(match[1]), labs: Number(match[2]) };
}

/** The counts the preview settles on. */
async function expectCounts(page: Page, expected: { doses: number; labs: number }) {
    await expect.poll(() => counts(page)).toEqual(expected);
}

/** The checkbox for one medication, found by the label the app gives it. */
async function medicationChoice(page: Page, drug: 'Estradiol' | 'Testosterone') {
    const group = page.getByRole('group', { name: 'Medications' });
    const names = await group
        .getByRole('checkbox')
        .evaluateAll(nodes =>
            nodes.map(node => (node.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim()),
        );
    const index = names.findIndex(name => name !== 'All medications' && name.startsWith(drug));
    if (index < 0) throw new Error(`No ${drug} medication among: ${names.join(' | ')}`);
    return group.getByRole('checkbox').nth(index);
}

const saveReportButton = (page: Page) => page.getByRole('button', { name: /^Save PDF/ });
const bothModesChoice = (page: Page) => page.getByRole('checkbox', { name: 'Include records from both HRT modes' });
const measuredChoice = (page: Page) => page.getByRole('checkbox', { name: 'Measured lab results' });
const estimatedChoice = (page: Page) => page.getByRole('checkbox', { name: 'Estimated hormone level' });

test('the report opens on the current mode and the past 90 days', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await expect(page.getByRole('button', { name: /^Date range/ })).toContainText('Last 90 days');
    await expect(bothModesChoice(page)).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Estradiol', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Testosterone', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'All medications', exact: true })).toBeChecked();
    await expect(measuredChoice(page)).not.toBeChecked();
    await expect(estimatedChoice(page)).not.toBeChecked();
    await expect(page.locator('p').filter({ hasText: /^Dose entries:/ })).toHaveCount(1);
    await expectCounts(page, { doses: 1, labs: 1 });
    await expect(saveReportButton(page)).toBeEnabled();
});

test('the saved PDF carries the selected records and leaves the other mode out', async ({
    page,
    context,
}, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await expectCounts(page, { doses: 1, labs: 1 });
    const pdf = await download(page, () => saveReportButton(page).click(), `hrt-report-${DATE}.pdf`, testInfo);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = reportText(pdf);
    expect(text).toContain('95');
    expect(text).toContain('Estradiol');
    // The other mode was never asked for, so its lab is not in the file.
    expect(text).not.toContain('437');
});

test('including both HRT modes brings the other mode into the report', async ({ page, context }, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await bothModesChoice(page).check();
    await expectCounts(page, { doses: 2, labs: 2 });
    // Every medication on offer, and the one that takes them all.
    await expect(page.getByRole('group', { name: 'Medications' }).getByRole('checkbox')).toHaveCount(3);

    const pdf = await download(page, () => saveReportButton(page).click(), `hrt-report-${DATE}.pdf`, testInfo);
    const text = reportText(pdf);
    expect(text).toContain('95');
    expect(text).toContain('437');
});

test('an empty current mode can still include the other mode records', async ({ page, context }, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage({ 'hrt-events': '[]', 'hrt-lab-results': '[]' }));
    await gotoApp(page);
    await openReport(page);

    await expectCounts(page, { doses: 0, labs: 0 });
    await expect(page.getByText('No records or graphs match your selection.')).toBeVisible();
    await expect(saveReportButton(page)).toBeDisabled();

    await bothModesChoice(page).check();
    await expectCounts(page, { doses: 1, labs: 1 });
    await expect(saveReportButton(page)).toBeEnabled();

    const pdf = await download(page, () => saveReportButton(page).click(), `hrt-report-${DATE}.pdf`, testInfo);
    expect(reportText(pdf)).toContain('437');
});

test('the hormone and the medication filter narrow the report on their own', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await bothModesChoice(page).check();
    await expectCounts(page, { doses: 2, labs: 2 });

    // The hormone filter reaches the labs, and only the labs.
    await page.getByRole('checkbox', { name: 'Estradiol', exact: true }).uncheck();
    await expectCounts(page, { doses: 2, labs: 1 });

    await page.getByRole('checkbox', { name: 'Estradiol', exact: true }).check();
    // The medication filter reaches the doses, and only the doses.
    const estradiolMedication = await medicationChoice(page, 'Estradiol');
    await estradiolMedication.uncheck();
    await expectCounts(page, { doses: 1, labs: 2 });
});

test('a custom date range includes both ends and refuses a backwards range', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await chooseRange(page, 'Custom dates');
    const from = page.getByLabel('From', { exact: true });
    const to = page.getByLabel('To', { exact: true });
    await from.fill('2026-01-01');
    await to.fill('2026-01-01');
    // The one day the records fall on is inside the range, at both of its ends.
    await expectCounts(page, { doses: 1, labs: 1 });

    // A day that starts after the records leaves them out.
    await to.fill('2026-01-02');
    await from.fill('2026-01-02');
    await expectCounts(page, { doses: 0, labs: 0 });

    await from.fill('2026-01-05');
    await to.fill('2026-01-01');
    await expect(page.getByText('Choose a valid start and end date.')).toBeVisible();
    await expect(saveReportButton(page)).toBeDisabled();

    await from.fill('2026-01-01');
    await to.fill('2026-01-06');
    await expect(page.getByText('Choose a valid start and end date.')).toHaveCount(0);
    await expectCounts(page, { doses: 1, labs: 1 });
    await expect(saveReportButton(page)).toBeEnabled();
});

test('the measured and the estimated graph are separate opt-ins', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    await expect(measuredChoice(page)).not.toBeChecked();
    await expect(estimatedChoice(page)).not.toBeChecked();

    await measuredChoice(page).check();
    await expect(estimatedChoice(page)).not.toBeChecked();
    await expect(page.getByText('No matching lab results can be graphed.')).toHaveCount(0);
    await expect(saveReportButton(page)).toBeEnabled();

    await estimatedChoice(page).check();
    await expect(page.getByText('No hormone estimate is available for these dates and selections.')).toHaveCount(0);
    await expect(saveReportButton(page)).toBeEnabled();
    // A graph is a picture of the records, not another record: the counts hold.
    await expectCounts(page, { doses: 1, labs: 1 });
});

test('a graph with nothing to show stops the save', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage({ 'hrt-lab-results': '[]' }));
    await gotoApp(page);
    await openReport(page);

    await measuredChoice(page).check();
    await expect(page.getByText('No matching lab results can be graphed.')).toBeVisible();
    await expect(saveReportButton(page)).toBeDisabled();

    await measuredChoice(page).uncheck();
    await expect(page.getByText('No matching lab results can be graphed.')).toHaveCount(0);
    await expect(saveReportButton(page)).toBeEnabled();
});

test('a cancelled save leaves the options ready for another try', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await openFixture(page);
    await openReport(page);

    await saveReportButton(page).click();
    const request = await pendingSave(page);
    expect(request.mimeType).toBe('application/pdf');
    await settle(page, 'cancelled');
    await expect(page.locator('[data-prompt="alert"]')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'PDF saved.' })).toHaveCount(0);
    await expect(saveReportButton(page)).toBeEnabled();

    await saveReportButton(page).click();
    await pendingSave(page);
    await settle(page, 'saved');
    await expect(page.getByRole('status').filter({ hasText: 'PDF saved.' })).toHaveCount(1);
});

test('a rejected save says so without leaking the adapter error', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    const checkErrors = watchPrivateErrors(page);
    await openFixture(page);
    await openReport(page);

    await saveReportButton(page).click();
    await pendingSave(page);
    await settle(page, 'reject');
    await expect(page.locator('[data-prompt="alert"]')).toContainText('Could not export the file.');
    await checkErrors();
    await dismissAlert(page);
    await expect(saveReportButton(page)).toBeEnabled();

    // The report can be saved again after the failure.
    await saveReportButton(page).click();
    await pendingSave(page);
    await settle(page, 'saved');
    await expect(page.getByRole('status').filter({ hasText: 'PDF saved.' })).toHaveCount(1);
});

const SCOPE_ERROR = "Couldn't read the other mode's records. Clear this option to save only the current mode.";

test('the report keeps its choices when the panel is folded and opened again', async ({ page, context }) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    const row = page.getByRole('button', { name: /Choose what to include/ });
    const trigger = page.getByRole('button', { name: /^Date range/ });

    // A custom range, and the date list left open on purpose.
    await chooseRange(page, 'Custom dates');
    await page.getByLabel('From', { exact: true }).fill('2026-01-01');
    await page.getByLabel('To', { exact: true }).fill('2026-01-06');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await bothModesChoice(page).check();
    await expectCounts(page, { doses: 2, labs: 2 });

    // Fold the panel away with the date list still open.
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');

    const panelId = await row.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeHidden();

    // Open it again: the choices are still there, and the date list is closed.
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toContainText('Custom dates');
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-01-01');
    await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-01-06');
    await expect(bothModesChoice(page)).toBeChecked();
    await expectCounts(page, { doses: 2, labs: 2 });
});

test('a corrupt other mode keeps the current mode in the preview and waits for the scope to be dropped', async ({
    page,
    context,
}) => {
    await page.clock.setFixedTime(NOW);
    // The other mode's lab results are not a list, so they cannot be read.
    await seedStorage(context, reportStorage({ 'hrt-masc-lab-results': '{"not":"an array"}' }));
    await gotoApp(page);
    await openReport(page);

    await bothModesChoice(page).check();

    // The current mode's records are still in the preview.
    await expectCounts(page, { doses: 1, labs: 1 });
    await expect(page.getByRole('alert').filter({ hasText: SCOPE_ERROR })).toBeVisible();
    await expect(bothModesChoice(page)).toHaveAccessibleDescription(SCOPE_ERROR);
    // Nothing is written while the scope that cannot be read is still asked for.
    await expect(saveReportButton(page)).toBeDisabled();

    // The scope has to be dropped on purpose before the report can be saved.
    await bothModesChoice(page).uncheck();
    await expect(page.getByText(SCOPE_ERROR)).toBeHidden();
    await expectCounts(page, { doses: 1, labs: 1 });
    await expect(saveReportButton(page)).toBeEnabled();
});

test('the report options fit a narrow phone screen', async ({ page, context }, testInfo) => {
    await page.clock.setFixedTime(NOW);
    await seedStorage(context, reportStorage());
    await gotoApp(page);
    await openReport(page);

    // The narrowest width the app draws for, with the type set large.
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.4'));

    // The custom dates are the part of the form a phone has the least room for.
    await chooseRange(page, 'Custom dates');
    await page.getByLabel('From', { exact: true }).fill('2026-01-01');
    await page.getByLabel('To', { exact: true }).fill('2026-01-06');
    await page.getByRole('button', { name: /^Date range/ }).evaluate(el => el.scrollIntoView({ block: 'start' }));

    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();
    // Nothing in the page may reach past the edge of the screen.
    const overflow = await page.evaluate(() => {
        const view = document.querySelector('.main-view') as HTMLElement | null;
        return { scrollWidth: view?.scrollWidth ?? 0, clientWidth: view?.clientWidth ?? 0 };
    });
    expect(overflow.clientWidth).toBeGreaterThan(0);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const path = testInfo.outputPath('report-options-narrow.png');
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach('report-options-narrow', { path, contentType: 'image/png' });
});
