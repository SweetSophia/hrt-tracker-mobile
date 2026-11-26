import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage } from '../helpers';

/**
 * Stage 1 decimal entry for the gel plan wizard. The browser locale stays the
 * Playwright default (en-US); the application locale is Russian, so the shared
 * converter shows its result with a decimal comma while the wizard's dose
 * field is a type=number input that only accepts a dot.
 */

test.use({ locale: 'en-US' });

const ru = {
    plan: 'План приёма',
    route: 'Как вы его принимаете?',
    gel: 'Гель',
    next: 'Далее',
    dose: 'Сколько за раз?',
    site: 'Куда наносите?',
    converter: 'Пересчитать по упаковке',
    amount: 'Сколько использовано',
    fill: 'Подставить дозу',
} as const;

test('applying a converter result in Russian fills the dose so the wizard can proceed', async ({ page, context }) => {
    await seedStorage(context, baseStorage({ 'hrt-lang': 'ru' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: ru.plan, exact: true }).first().click();
    // An empty plan opens the wizard on the route step right away.
    await expect(page.getByRole('heading', { name: ru.route, exact: true })).toBeVisible();
    // The row's accessible name continues with the brand hint, so match loosely.
    await page.getByRole('button', { name: ru.gel }).click();
    await page.getByRole('button', { name: ru.next, exact: true }).click();

    const doseField = page.getByRole('spinbutton', { name: ru.dose });
    await expect(doseField).toBeVisible();
    await doseField.fill('');

    // Half an Oestrogel ruler is 0.75 mg; shown with the app's decimal comma.
    await page.getByRole('button', { name: ru.converter }).click();
    const amountField = page.getByLabel(ru.amount);
    const fill = page.getByRole('button', { name: ru.fill, exact: true });
    await amountField.fill('0,');
    await expect(amountField).not.toHaveAttribute('aria-invalid', 'true');
    await expect(fill).toBeDisabled();
    await amountField.blur();
    await expect(amountField).toHaveAttribute('aria-invalid', 'true');
    await amountField.fill('0,5');
    await expect(page.getByText('Эстрадиол: 0,75 mg')).toBeVisible();
    await fill.click();

    // The number input holds a dot decimal, so Next is enabled again.
    await expect(doseField).toHaveValue('0.75');
    await page.getByRole('button', { name: ru.next, exact: true }).click();
    await expect(page.getByRole('heading', { name: ru.site, exact: true })).toBeVisible();
});
