import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { decryptData } from '../src/domain/crypto';
import type { FileSaveResult } from '../src/platform/contracts/files';
import type { ExportFilesFixture } from './fixtures/export-files';
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
        () => page.getByRole('button', { name: /Export PDF file/ }).click(),
        `hrt-report-${DATE}.pdf`,
        testInfo,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString()).toContain('(HRT Tracker report)');
    expect(pdf.toString()).toContain('(95 pg/ml)');
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
