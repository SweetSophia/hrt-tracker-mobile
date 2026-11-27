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
    type PlanFixture,
    type TemplateFixture,
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
    timelineTitle: 'Verlauf der Dosen',
    planTitle: 'Medikationsplan',
    planAdd: 'Medikament hinzufügen',
    planQRoute: 'Wie verabreichst du es?',
    forecastEntry: 'Was-wäre-wenn',
    forecastCurrent: 'Aktuell',
    forecastRoute: 'Verabreichungsart',
    labAdd: 'Laborwert hinzufügen',
    labE2: 'Estradiolwert',
    addDose: 'Dosis hinzufügen',
    save: 'Speichern',
    templateLoad: 'Vorlage laden',
    delete: 'Löschen',
    keep: 'Behalten',
    doseDeleteConfirm: 'Diesen Eintrag löschen?',
    labDeleteConfirm: 'Diesen Laborwert löschen?',
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
    // Width alone can hold while one word still breaks across lines, so each
    // word of the heading must render as a single line box. Wrapping between
    // words is fine; a range around a split word reports two boxes.
    const linesPerWord = await heading.evaluate(el => {
        const node = el.firstChild;
        if (node?.nodeType !== Node.TEXT_NODE) return [];
        return Array.from((node.textContent ?? '').matchAll(/\S+/g), ({ 0: word, index }) => {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + word.length);
            return new Set(Array.from(range.getClientRects(), rect => rect.top)).size;
        });
    });
    expect(linesPerWord).toEqual(de.timelineTitle.split(' ').map(() => 1));
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
    await expect(page.locator('[data-event-id]').getByText('2,50 mg', { exact: true })).toBeVisible();
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
    await expect(cleanPage.locator('[data-event-id]').getByText('2,50 mg', { exact: true })).toBeVisible();
    await bottomNav(cleanPage).getByRole('button', { name: de.labs, exact: true }).tap();
    await expect(cleanPage.getByText('1,5 pg/mL').first()).toBeVisible();

    await clean.close();
});

test('the German plan and forecast read 2,5 mg alle 3,5 Tage', async ({ page, context }) => {
    const plan: PlanFixture = {
        id: 'de-plan-1',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        extras: {},
        everyDays: 3.5,
        timesPerDay: 1,
    };
    const dose: DoseEventFixture = {
        id: 'de-plan-dose',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        timeH: nowHours() - 1,
        extras: {},
        updatedAt: stamp(),
    };
    await seedStorage(
        context,
        baseStorage({
            'hrt-lang': 'de',
            'hrt-plan': JSON.stringify([plan]),
            'hrt-events': JSON.stringify([dose]),
        }),
    );
    await page.goto('/');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    // The plan row writes its dose and rhythm in the app's de-DE formatting:
    // 2,5 mg every 3,5 days, never the point decimals of the stored numbers.
    await page.getByRole('button', { name: de.planTitle, exact: true }).tap();
    await expect(page.getByRole('button', { name: /^Medikationsplan\s*,\s*Zurück$/ })).toBeVisible();
    const regimenLabel = 'Estradiolvalerat 2,5 mg zur Injektion';
    await expect(page.getByText(regimenLabel, { exact: true })).toBeVisible();
    await expect(page.getByText('Alle 3,5 Tage', { exact: true })).toBeVisible();

    // A route is a choice, so the wizard names each form on its own
    // ("Injektion"), not in the sentence form the summary keeps.
    await page.getByRole('button', { name: de.planAdd, exact: true }).tap();
    await expect(page.getByRole('heading', { name: de.planQRoute, exact: true })).toBeVisible();
    const routeRows = page.locator('button[aria-pressed]');
    for (const form of ['Injektion', 'Gel', 'Pflaster']) {
        await expect(routeRows.filter({ has: page.getByText(form, { exact: true }) }), form).toHaveCount(1);
    }

    // The forecast's current regimen states the same numbers through its own
    // interval path.
    await bottomNav(page).getByRole('button', { name: de.home, exact: true }).tap();
    await page.getByRole('button', { name: de.forecastEntry, exact: true }).tap();
    await expect(page.getByRole('button', { name: /^Was-wäre-wenn\s*,\s*Zurück$/ })).toBeVisible();
    const currentRegimen = page.locator('section').filter({ has: page.getByText(de.forecastCurrent, { exact: true }) });
    await expect(currentRegimen.getByText(regimenLabel, { exact: true })).toBeVisible();
    await expect(currentRegimen.getByText('alle 3,5 Tage', { exact: true })).toBeVisible();

    // The forecast's own route choice is a standalone button, and it names
    // the form on its own as well.
    await expect(page.getByRole('button', { name: new RegExp('^' + de.forecastRoute) })).toHaveText('Injektion');
});

test('an unsupported saved language falls back to English in Forecast and Labs', async ({ page, context }) => {
    const dose: DoseEventFixture = {
        id: 'unsupported-language-dose',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        timeH: nowHours() - 1,
        extras: {},
        updatedAt: stamp(),
    };
    await seedStorage(
        context,
        baseStorage({ 'hrt-lang': 'unsupported-language', 'hrt-events': JSON.stringify([dose]) }),
    );
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'What-if', exact: true }).tap();
    await expect(page.getByRole('button', { name: /^What-if\s*,\s*Back$/ })).toBeVisible();
    await bottomNav(page).getByRole('button', { name: 'Labs', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Lab results', exact: true })).toBeVisible();
});

test('a fractional German dose template shows 2,5 mg and loads with a comma', async ({ page, context }) => {
    const template: TemplateFixture = {
        id: 'de-template-1',
        name: 'Abenddosis',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        extras: {},
        createdAt: stamp(),
        updatedAt: stamp(),
    };
    await seedStorage(context, baseStorage({ 'hrt-lang': 'de', 'hrt-dose-templates': JSON.stringify([template]) }));
    await page.goto('/');
    await expect(bottomNav(page).getByRole('button', { name: de.home, exact: true })).toBeVisible();

    await bottomNav(page).getByRole('button', { name: de.history, exact: true }).tap();
    await page.getByRole('button', { name: de.addDose, exact: true }).first().tap();
    const doseForm = page.locator('.disclosure[data-open="true"] form');
    await doseForm.getByRole('button', { name: de.templateLoad, exact: true }).tap();

    // The menu summary keeps the stored precision: 2,5 mg, never 2,50 mg.
    const row = doseForm.locator('button').filter({ hasText: 'Abenddosis' });
    await expect(row).toContainText('2,5 mg');
    await row.tap();

    // Loading puts the comma decimal back into the dose field.
    await expect(doseForm.getByLabel('Dosis (mg)', { exact: true })).toHaveValue('2,5');
});

test('German dose and lab delete prompts can be dismissed without deleting', async ({ page, context }) => {
    const dose: DoseEventFixture = {
        id: 'de-delete-dose',
        route: 'injection',
        ester: 'EV',
        doseMG: 2.5,
        timeH: nowHours() - 1,
        extras: {},
        updatedAt: stamp(),
    };
    const lab: LabFixture = {
        id: 'de-delete-lab',
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

    // The dose prompt names the record with its German decimal; keeping it
    // leaves the row in place.
    await bottomNav(page).getByRole('button', { name: de.history, exact: true }).tap();
    const doseRow = page.locator('[data-event-id]').filter({ hasText: '2,50 mg' });
    await doseRow.getByRole('button').first().tap();
    await doseRow.locator('.disclosure[data-open="true"]').getByRole('button', { name: de.delete, exact: true }).tap();
    const prompt = page.locator('[data-prompt="confirm"]');
    await expect(prompt).toContainText(de.doseDeleteConfirm);
    await expect(prompt).toContainText('2,5 mg');
    await confirmDialog(page, de.keep);
    await expect(prompt).toHaveCount(0);
    await expect(doseRow.getByText('2,50 mg', { exact: true })).toBeVisible();

    // The lab prompt behaves the same, and both records stay stored.
    await bottomNav(page).getByRole('button', { name: de.labs, exact: true }).tap();
    await page.getByRole('button', { name: /1,5 pg\/mL/ }).tap();
    await page.getByRole('button', { name: de.delete, exact: true }).tap();
    await expect(prompt).toContainText(de.labDeleteConfirm);
    await expect(prompt).toContainText('1,5 pg/mL');
    await confirmDialog(page, de.keep);
    await expect(prompt).toHaveCount(0);
    await expect(page.getByText('1,5 pg/mL').first()).toBeVisible();
    await expect.poll(async () => (await storedEvents(page)).length).toBe(1);
    await expect.poll(async () => (await storedLabs(page)).length).toBe(1);
});
