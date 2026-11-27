import { expect, test } from '@playwright/test';
import { baseStorage, nowHours, seedStorage } from '../helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const languages = [
    {
        lang: 'en',
        settings: 'Settings',
        general: /^General\b/,
        supplies: 'Supplies',
        addSupply: 'Add supply',
        drug: 'Drug',
        amount: /^Amount /,
        confirm: 'Add',
        routes: {
            sc: 'Estradiol subcutaneous injection',
            nasal: 'Estradiol nasal spray',
            pellet: 'Estradiol pellet',
        },
    },
    {
        lang: 'de',
        settings: 'Einstellungen',
        general: /^Allgemein\b/,
        supplies: 'Vorrat',
        addSupply: 'Vorrat hinzufügen',
        drug: 'Medikament',
        amount: /^Menge /,
        confirm: 'Hinzufügen',
        routes: {
            sc: 'Estradiol zur subkutanen Injektion',
            nasal: 'Estradiol als Nasenspray',
            pellet: 'Estradiol als Pellet',
        },
    },
];

for (const copy of languages) {
    test(`Supplies names routes inferred from the dose log in ${copy.lang}`, async ({ page, context }) => {
        const now = nowHours();
        const events = Object.keys(copy.routes).flatMap(route =>
            [15, 8, 1].map(daysAgo => ({
                id: `${route}-${daysAgo}`,
                route,
                ester: 'E2',
                doseMG: 1,
                timeH: now - daysAgo * 24,
                extras: {},
            })),
        );
        await seedStorage(context, baseStorage({ 'hrt-lang': copy.lang, 'hrt-events': JSON.stringify(events) }));
        await page.goto('/');
        await page.getByRole('button', { name: copy.settings, exact: true }).click();
        await page.getByRole('button', { name: copy.general }).click();
        await page.getByRole('button', { name: copy.supplies, exact: true }).click();
        await page.getByRole('button', { name: copy.addSupply, exact: true }).click();
        await page.getByRole('button', { name: new RegExp(`^${copy.drug} `) }).click();

        const list = page.getByRole('listbox', { name: copy.drug, exact: true });
        for (const label of Object.values(copy.routes)) {
            await expect(list.getByText(label, { exact: true })).toBeVisible();
        }

        await list.getByText(copy.routes.nasal, { exact: true }).click();
        await page.getByRole('spinbutton', { name: copy.amount }).fill('3');
        await page.getByRole('button', { name: copy.confirm, exact: true }).click();
        await expect(page.getByRole('button', { name: copy.addSupply, exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: new RegExp(`^${copy.routes.nasal} `) })).toBeVisible();
    });

    test(`Overview distinguishes saved plan entries for the same drug in ${copy.lang}`, async ({ page, context }) => {
        const plan = Object.keys(copy.routes).map(route => ({
            id: route,
            route,
            ester: 'E2',
            doseMG: 1,
            extras: {},
            everyDays: 7,
            timesPerDay: 1,
        }));
        await seedStorage(context, baseStorage({ 'hrt-lang': copy.lang, 'hrt-plan': JSON.stringify(plan) }));
        await page.goto('/');

        for (const label of Object.values(copy.routes)) {
            await expect(page.getByText(label, { exact: true })).toBeVisible();
        }
    });
}
