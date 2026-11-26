import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
    baseStorage,
    confirmDialog,
    dismissAlert,
    gotoApp,
    nowHours,
    readStorage,
    seedStorage,
    stamp,
    type BundleFixture,
    type DoseEventFixture,
    type LabFixture,
} from '../helpers';

/**
 * Stage 3 German language regression. The browser stays en-US while the app
 * speaks German (hrt-lang: 'de'), so every date and comma decimal below is
 * produced by the app's own de-DE formatting, never by the browser's locale.
 */

test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, locale: 'en-US', reducedMotion: 'reduce' });

// The exact pack strings the app must render for this path.
const de = {
    general: 'Allgemein',
    dataCat: 'Datenverwaltung',
    home: 'Übersicht',
    history: 'Verlauf',
    labs: 'Laborwerte',
    settings: 'Einstellungen',
    welcomeTitle: 'Hallo!',
    next: 'Weiter',
    skip: 'Überspringen',
    timelineTitle: 'Dosierungsverlauf',
    labAdd: 'Laborwert hinzufügen',
    labE2: 'Estradiolwert',
    addDose: 'Dosis hinzufügen',
    save: 'Speichern',
    langRow: 'Sprache',
    exportData: 'Daten exportieren',
    completeBackup: 'Vollständige Sicherung',
    downloadConfirm: 'Unverschlüsselte Sicherung herunterladen?',
    download: 'Herunterladen',
} as const;

const en = {
    general: 'General',
    dataCat: 'Data management',
    home: 'Overview',
    settings: 'Settings',
    langRow: 'Language',
} as const;

const bottomNav = (page: Page) => page.locator('.bottom-nav');

const storedEvents = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-events') ?? '[]')) as Promise<DoseEventFixture[]>;

const storedLabs = (page: Page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hrt-lab-results') ?? '[]')) as Promise<LabFixture[]>;

/** The app's de-DE day heading, e.g. 26. Nov. 2026. */
const dayLabel = (d: Date) => d.toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: 'numeric' });

/** The app's de-DE date next to a lab row, e.g. 26. Nov. */
const shortDate = (d: Date) => d.toLocaleDateString('de-DE', { month: 'short', day: 'numeric' });

const expectFullText = (locator: Locator) =>
    expect.poll(() => locator.evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);

const expectTouchSize = (button: Locator) =>
    expect
        .poll(() =>
            button.evaluate(el => {
                const { width, height } = el.getBoundingClientRect();
                return Math.min(width, height);
            }),
        )
        .toBeGreaterThanOrEqual(48);

/**
 * The narrow Settings layout opens as a category list whose buttons name the
 * category plus its hint; a returning Settings reopens inside the saved
 * category instead. Both routes end at the language row.
 */
async function openLanguageRow(page: Page, labels: typeof de | typeof en): Promise<void> {
    await bottomNav(page).getByRole('button', { name: labels.settings, exact: true }).tap();
    const category = page.getByRole('button', { name: new RegExp('^' + labels.general) });
    const row = page.getByRole('button', { name: new RegExp('^' + labels.langRow) });
    await expect(category.or(row).first()).toBeVisible();
    if (await category.isVisible()) await category.tap();
    await row.tap();
}

/** The complete-backup export flow with German labels and the narrow layout. */
async function downloadGermanCompleteBackup(page: Page): Promise<BundleFixture> {
    await bottomNav(page).getByRole('button', { name: de.settings, exact: true }).tap();
    const category = page.getByRole('button', { name: new RegExp('^' + de.dataCat) });
    const exportRow = page.getByRole('button', { name: de.exportData, exact: true });
    await expect(category.or(exportRow).first()).toBeVisible();
    if (await category.isVisible()) await category.tap();
    await exportRow.tap();
    const row = page.getByRole('button', { name: new RegExp(de.completeBackup) });
    await expect(row).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await row.tap();
    const dialog = page.locator('[data-prompt="confirm"]');
    await expect(dialog).toContainText(de.downloadConfirm);
    await confirmDialog(page, de.download);
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error('complete backup download has no path');
    return JSON.parse(await readFile(path, 'utf8')) as BundleFixture;
}

/**
 * The complete-backup merge flow with English labels, for the clean context
 * that receives the German export. Same narrow layout as the German path.
 */
async function pasteEnglishCompleteBackup(page: Page, text: string): Promise<void> {
    await bottomNav(page).getByRole('button', { name: en.settings, exact: true }).tap();
    const category = page.getByRole('button', { name: new RegExp('^' + en.dataCat) });
    const importRow = page.getByRole('button', { name: 'Import data', exact: true });
    await expect(category.or(importRow).first()).toBeVisible();
    if (await category.isVisible()) await category.tap();
    await importRow.tap();
    await page.getByRole('button', { name: /Paste JSON text/ }).tap();
    const box = page.getByPlaceholder('Paste JSON content here...');
    await expect(box).toBeVisible();
    await box.fill(text);
    await page.getByRole('button', { name: 'Import', exact: true }).tap();
}

test('fresh onboarding picks Deutsch and the app comes up in German', async ({ page }) => {
    // No seeded state at all: the intro's first step is the language list, so
    // tapping Deutsch is the primary UI path onto a German app.
    await page.goto('/');
    await page.getByRole('button', { name: 'Deutsch', exact: true }).tap();
    await expect(page.getByRole('heading', { name: de.welcomeTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: de.next, exact: true })).toBeVisible();

    await page.getByRole('button', { name: de.skip, exact: true }).tap();
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
    expect(await page.evaluate(() => localStorage.getItem('hrt-lang'))).toBe('de');
    expect(await page.evaluate(() => localStorage.getItem('app-onboarded'))).toBe('true');
});

test('Settings switches between Deutsch and English and the choice survives reload', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-lang': 'de' }));
    await page.goto('/');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    await openLanguageRow(page, de);
    await page.getByRole('button', { name: 'English', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(bottomNav(page).getByRole('button', { name: en.home, exact: true })).toBeVisible();

    // English back to German.
    await openLanguageRow(page, en);
    await page.getByRole('button', { name: 'Deutsch', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');

    // Simulate large text at a narrow viewport. The installed build exercises
    // Android system font scaling separately.
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
    await bottomNav(page).getByRole('button', { name: de.history, exact: true }).tap();
    const heading = page.getByRole('heading', { name: de.timelineTitle, exact: true });
    await expect(heading).toBeVisible();
    await expectFullText(heading);
    const header = page.locator('.glass-bar').filter({ has: heading });
    await expectTouchSize(header.getByRole('button', { name: de.addDose, exact: true }));
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    // The choice persists across a browser reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('hrt-lang'))).toBe('de');
});

test('German records keep comma decimals and de-DE dates across reload', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-lang': 'de' }));
    await page.goto('/');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    // A dose typed as 2,5 in an en-US browser must store the number and
    // render its day under the app's de-DE formatting.
    await bottomNav(page).getByRole('button', { name: de.history, exact: true }).tap();
    await expect(page.getByRole('heading', { name: de.timelineTitle, exact: true })).toBeVisible();
    await page.getByRole('button', { name: de.addDose, exact: true }).first().tap();
    const doseForm = page.locator('.disclosure[data-open="true"] form');
    const doseInput = doseForm.getByLabel('Dosis (mg)', { exact: true });
    await doseInput.fill('');
    await doseInput.focus();
    await page.keyboard.insertText('2,5');
    await doseForm.getByRole('button', { name: de.save, exact: true }).tap();
    await expect.poll(async () => (await storedEvents(page))[0]?.doseMG).toBe(2.5);
    const [dose] = await storedEvents(page);
    const doseDate = dayLabel(new Date(dose.timeH * 3_600_000));
    await expect(page.getByText(doseDate, { exact: true })).toBeVisible();
    await expect(page.locator('[data-event-id]').getByText('2,50 mg', { exact: true })).toBeVisible();

    // A lab value with a comma decimal and an explicit clinical unit.
    await bottomNav(page).getByRole('button', { name: de.labs, exact: true }).tap();
    await expect(page.getByRole('heading', { name: de.labs, exact: true })).toBeVisible();
    await page.getByRole('button', { name: de.labAdd, exact: true }).first().tap();
    const labForm = page.locator('.main-view .disclosure[data-open="true"]');
    // The field input, not the unit tablist that shares its accessible name.
    const estradiol = labForm.getByLabel(de.labE2).and(page.locator('input'));
    await estradiol.fill('');
    await estradiol.focus();
    await page.keyboard.insertText('1,5');
    await labForm.getByRole('tab', { name: 'pg/mL', exact: true }).tap();
    await labForm.getByRole('button', { name: de.save, exact: true }).tap();
    await expect.poll(async () => (await storedLabs(page))[0]?.concValue).toBe(1.5);
    const [lab] = await storedLabs(page);
    const labDate = shortDate(new Date(lab.timeH * 3_600_000));
    expect(lab.unit).toBe('pg/ml');
    await expect(page.getByText('1,5 pg/mL').first()).toBeVisible();
    await expect(page.getByText(labDate).first()).toBeVisible();

    // Both records remain available after reload.
    await page.reload();
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();
    await bottomNav(page).getByRole('button', { name: de.history, exact: true }).tap();
    await expect(page.getByText(doseDate, { exact: true })).toBeVisible();
    await bottomNav(page).getByRole('button', { name: de.labs, exact: true }).tap();
    await expect(page.getByText('1,5 pg/mL').first()).toBeVisible();
    await expect(page.getByText(labDate).first()).toBeVisible();
});

test('a complete backup exported in German restores hrt-lang and records into a clean English context', async ({
    page,
    context,
    browser,
}) => {
    const dose: DoseEventFixture = {
        id: 'de-dose-1',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        timeH: nowHours() - 1,
        extras: {},
        updatedAt: stamp(),
    };
    const lab: LabFixture = {
        id: 'de-lab-1',
        timeH: nowHours() - 2,
        concValue: 1.5,
        unit: 'pg/ml',
        updatedAt: stamp(),
    };
    await seedStorage(
        context,
        baseStorage({
            'hrt-lang': 'de',
            'hrt-events': JSON.stringify([dose]),
            'hrt-lab-results': JSON.stringify([lab]),
        }),
    );
    await page.goto('/');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    const bundle = await downloadGermanCompleteBackup(page);
    expect(bundle.format).toBe('oyama-hrt-complete-backup');
    expect(bundle.preferences['hrt-lang']).toBe('de');
    expect(bundle.modes.transfem.events).toEqual([dose]);
    expect(bundle.modes.transfem.labResults).toEqual([lab]);

    // Restore into a clean English browser context. Matching the backup's
    // calibration keeps the merge to a single confirmation.
    const clean = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        locale: 'en-US',
        viewport: { width: 360, height: 800 },
        hasTouch: true,
        reducedMotion: 'reduce',
    });
    await seedStorage(
        clean,
        baseStorage({
            'hrt-cal-method': String(bundle.calibration.method),
            'hrt-cal-history-mode': String(bundle.calibration.historyMode),
        }),
    );
    const cleanPage = await clean.newPage();
    await gotoApp(cleanPage);
    await pasteEnglishCompleteBackup(cleanPage, JSON.stringify(bundle));
    await confirmDialog(cleanPage, 'Merge');
    await dismissAlert(cleanPage);

    // The imported German preference drives the clean context's storage, UI,
    // and records.
    await expect.poll(async () => await readStorage(cleanPage, 'hrt-lang')).toBe('de');
    expect(await readStorage<DoseEventFixture[]>(cleanPage, 'hrt-events')).toEqual([dose]);
    expect(await readStorage<LabFixture[]>(cleanPage, 'hrt-lab-results')).toEqual([lab]);
    await expect(cleanPage.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(bottomNav(cleanPage).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    // And it survives a reload: the records render with German dates again.
    await cleanPage.reload();
    await expect(cleanPage.locator('html')).toHaveAttribute('lang', 'de-DE');
    await bottomNav(cleanPage).getByRole('button', { name: de.history, exact: true }).tap();
    const restored = (await readStorage<DoseEventFixture[]>(cleanPage, 'hrt-events')) ?? [];
    await expect(cleanPage.getByText(dayLabel(new Date(restored[0].timeH * 3_600_000))).first()).toBeVisible();
    await bottomNav(cleanPage).getByRole('button', { name: de.labs, exact: true }).tap();
    await expect(cleanPage.getByText('1,5 pg/mL').first()).toBeVisible();

    await clean.close();
});
