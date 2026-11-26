import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseStorage, seedStorage, type DoseEventFixture } from '../helpers';

test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });

const views = [
    { tab: 'История', title: 'История доз', add: 'Добавить дозу' },
    { tab: 'Анализы', title: 'Результаты анализов', add: 'Добавить результат анализа' },
] as const;

async function openView(page: Page, view: (typeof views)[number]) {
    await page.locator('.bottom-nav').getByRole('button', { name: view.tab, exact: true }).tap();
    const heading = page.getByRole('heading', { name: view.title, exact: true });
    await expect(heading).toBeVisible();
    return { heading, header: page.locator('.glass-bar').filter({ has: heading }) };
}

async function enlargeText(page: Page) {
    // Exercise reflow at twice the base rem size. The installed preview uses Android font scaling.
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
}

async function expectFullText(locator: Locator) {
    await expect
        .poll(() => locator.evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1))
        .toBe(true);
}

async function expectTouchSize(button: Locator) {
    await expect
        .poll(() =>
            button.evaluate(el => {
                const { width, height } = el.getBoundingClientRect();
                return Math.min(width, height);
            }),
        )
        .toBeGreaterThanOrEqual(48);
}

test.beforeEach(async ({ page, context }) => {
    const day = new Date();
    day.setDate(day.getDate() - 2);
    day.setHours(18, 0, 0, 0);
    const events: DoseEventFixture[] = Array.from({ length: 18 }, (_, index) => ({
        id: `layout-dose-${index}`,
        route: 'oral',
        ester: 'EV',
        timeH: day.getTime() / 3_600_000 - index / 2,
        doseMG: 1,
        extras: {},
    }));
    await seedStorage(
        context,
        baseStorage({
            'hrt-lang': 'ru',
            'hrt-events': JSON.stringify(events),
            'hrt-lab-results': JSON.stringify([
                { id: 'layout-lab', timeH: day.getTime() / 3_600_000 + 3, concValue: 31.5, unit: 'pmol/l' },
            ]),
        }),
    );
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches), 'Expected a coarse pointer').toBe(
        true,
    );
});

for (const view of views) {
    test(`${view.tab} fits its heading and action at enlarged text size`, async ({ page }) => {
        const { heading, header } = await openView(page, view);
        await enlargeText(page);
        const add = header.getByRole('button', { name: view.add, exact: true });
        await expectFullText(heading);
        await expect
            .poll(() =>
                add.evaluate(button => {
                    const bounds = button.getBoundingClientRect();
                    const label = [...button.querySelectorAll('[data-shown="true"]')].find(el =>
                        el.textContent?.trim(),
                    );
                    if (!label) return false;
                    const range = document.createRange();
                    range.selectNodeContents(label);
                    return [...range.getClientRects()].every(
                        rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
                    );
                }),
            )
            .toBe(true);
        await expectTouchSize(add);
        const addWidth = await add.evaluate(el => el.getBoundingClientRect().width);
        const panelId = await add.getAttribute('aria-controls');
        expect(panelId).toBeTruthy();
        const panel = page.locator(`[id=${JSON.stringify(panelId)}]`);
        await expect(panel).toHaveAttribute('data-open', 'false');
        await add.tap();
        await expect(panel).toHaveAttribute('data-open', 'true');
        const cancel = header.getByRole('button', { name: 'Отмена', exact: true });
        await expectTouchSize(cancel);
        await expect.poll(() => cancel.evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(addWidth);
        await cancel.tap();
        await expect(panel).toHaveAttribute('data-open', 'false');
        await expect(add).toBeVisible();
    });
}

test('the outgoing Add label does not wrap into Cancel during the crossfade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const { header } = await openView(page, views[1]);
    await enlargeText(page);
    await header.getByRole('button', { name: views[1].add, exact: true }).tap();
    const outgoing = header.locator('.swap-label-wrap > [data-shown="false"]').filter({ hasText: views[1].add });
    await expect(outgoing).toHaveCSS('white-space', 'nowrap');
});

test('History follows the actual sticky header when it grows', async ({ page }) => {
    const { header } = await openView(page, views[0]);
    const day = page.locator('.main-view [data-held]').first();
    await page.locator('.main-view').evaluate(el => (el.scrollTop = 230));

    const distance = () =>
        day.evaluate(el => {
            const bar = el.closest('.main-view')?.querySelector('.glass-bar');
            return Math.abs(el.getBoundingClientRect().top - (bar?.getBoundingClientRect().bottom ?? Infinity));
        });
    await expect.poll(distance).toBeLessThan(2);
    await expect(day).toHaveAttribute('data-held', 'true');

    // A live size change exercises the sticky offset even if a font stays on
    // one line in the current locale.
    await header.evaluate(el => (el.style.paddingBlockEnd = '28px'));
    await expect.poll(distance).toBeLessThan(2);
    await expect(day).toHaveAttribute('data-held', 'true');
});

test('the date and model comparison fit inside a lab row at enlarged text size', async ({ page }) => {
    await openView(page, views[1]);
    await enlargeText(page);
    const row = page.getByRole('button', { name: /^31\.5 pmol\/L/ });
    const model = row.getByText(/Исходная модель \d/);
    await expect(model).toBeVisible();
    await expectFullText(row);
    await expect
        .poll(() =>
            model.evaluate(el => {
                const line = el.parentElement?.parentElement;
                const badge = el.nextElementSibling;
                if (!badge || !line) return Infinity;
                return Math.abs(line.getBoundingClientRect().right - badge.getBoundingClientRect().right);
            }),
        )
        .toBeLessThan(2);
});

test('large bottom labels stay inside four independently tappable tabs', async ({ page }) => {
    await openView(page, views[0]);
    await enlargeText(page);
    const nav = page.locator('.bottom-nav');
    const tabs = nav.getByRole('button');
    await expect(tabs).toHaveCount(4);
    await expect
        .poll(() =>
            nav.evaluate(el => {
                const outer = el.getBoundingClientRect();
                const tabs = [...el.querySelectorAll('button')];
                const measuredHeight = getComputedStyle(el).getPropertyValue('--nav-h');
                return (
                    measuredHeight === `${Math.round(outer.height)}px` &&
                    tabs.every((button, index) => {
                        const rect = button.getBoundingClientRect();
                        const label = button.lastElementChild;
                        return (
                            rect.left >= outer.left &&
                            rect.right <= outer.right &&
                            (!index || tabs[index - 1].getBoundingClientRect().right <= rect.left) &&
                            rect.width >= 48 &&
                            rect.height >= 48 &&
                            !!label &&
                            label.scrollWidth <= label.clientWidth + 1
                        );
                    })
                );
            }),
        )
        .toBe(true);
    await nav.getByRole('button', { name: 'Анализы', exact: true }).tap();
    await expect(page.getByRole('heading', { name: 'Результаты анализов', exact: true })).toBeVisible();
});

test('the logging forms give separate touch targets to their footer actions', async ({ page }) => {
    const lab = await openView(page, views[1]);
    await lab.header.getByRole('button', { name: views[1].add, exact: true }).tap();
    const panel = page.locator('.main-view .disclosure[data-open="true"]').first();
    const estradiol = panel.getByRole('textbox', { name: 'Уровень эстрадиола' });
    await estradiol.fill('32,5');
    const labSave = panel.getByRole('button', { name: 'Сохранить', exact: true });
    const labCancel = panel.getByRole('button', { name: 'Отмена', exact: true });
    await expectTouchSize(labSave);
    await expectTouchSize(labCancel);
    await labCancel.tap();
    await expect(lab.header.getByRole('button', { name: views[1].add, exact: true })).toBeVisible();

    await openView(page, views[0]);
    const row = page.locator('[data-event-id="layout-dose-2"]');
    const rowButton = row.locator(':scope > button');
    await rowButton.tap();
    const doseForm = row.locator('form');
    const doseSave = doseForm.getByRole('button', { name: 'Сохранить', exact: true });
    const doseCancel = doseForm.getByRole('button', { name: 'Отмена', exact: true }).filter({ hasText: /^Отмена$/ });
    await expectTouchSize(doseSave);
    await expectTouchSize(doseCancel);
    await expectTouchSize(doseForm.getByRole('button', { name: 'Удалить', exact: true }));
    await doseCancel.tap();
    await expect(rowButton).toBeFocused();
});

test('saving an edited dose brings it below the enlarged History header and date', async ({ page }) => {
    await openView(page, views[0]);
    await enlargeText(page);
    const row = page.locator('[data-event-id="layout-dose-8"]');
    const rowButton = row.locator(':scope > button');
    await rowButton.tap();
    const form = row.locator('form');
    await form.getByRole('textbox', { name: 'Доза (мг)' }).fill('2');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).tap();
    await expect(form).toHaveCount(0);
    await expect(rowButton).toContainText('2.00 mg');
    await expect(rowButton).toBeFocused();
    await expect
        .poll(() =>
            rowButton.evaluate(button => {
                const date = button.closest('.main-view')?.querySelector('[data-held]');
                const nav = document.querySelector('.bottom-nav');
                if (!date || !nav) return false;
                const row = button.getBoundingClientRect();
                const dateBottom = date.getBoundingClientRect().bottom;
                const navTop = nav.getBoundingClientRect().top;
                return row.top >= dateBottom - 1 && row.top < navTop;
            }),
        )
        .toBe(true);
});
