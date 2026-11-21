import { expect, test, type Page } from '@playwright/test';
import { seedStorage } from '../helpers';
import { observeWorkers, seed, resultCount } from './worker-fixture';
import { installDemoReference } from './demo-reference';
import { DEFAULT_PK_PARAMS } from '../../src/domain/engine';
import type { DemoKind } from '../../src/application/demoProtocol';
export async function about(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const tab = page.getByRole('tab', { name: 'About', exact: true });
    await tab
        .or(page.getByRole('button', { name: /^About/ }))
        .first()
        .click();
}
export async function openDemo(page: Page, kind: DemoKind) {
    if (kind === 'calibration-guide') {
        await page.getByRole('button', { name: 'Labs', exact: true }).click();
        await page.getByRole('button', { name: /Calibration/ }).click();
        await page.getByRole('button', { name: 'How these methods work', exact: true }).click();
        await expect(page.locator('#cal-guide-level')).toBeVisible();
    } else {
        await about(page);
        if (kind === 'model-guide') {
            await page.getByRole('button', { name: 'Model explanation', exact: true }).click();
            await expect(page.getByRole('heading', { name: 'One dose', exact: true })).toBeVisible();
        }
        if (kind === 'sandbox') {
            await page.getByRole('button', { name: 'Model demos', exact: true }).click();
            await page.getByRole('tab', { name: 'Single dose', exact: true }).click();
            await expect(page.locator('#pk-calc-dose')).toBeVisible();
        }
        if (kind === 'onboarding') {
            await page.getByRole('button', { name: 'Show the intro again', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
        }
    }
}
for (const kind of ['model-guide', 'calibration-guide', 'sandbox', 'onboarding'] as const) {
    test(`ordinary ${kind} uses the shared demo worker and exact projection`, async ({ page, context }) => {
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        await seedStorage(context, {
            ...seed(),
            'hrt-pk-params': JSON.stringify({ ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 }),
        });
        await observeWorkers(page);
        await installDemoReference(page);
        await page.goto('/');
        await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
        await openDemo(page, kind);
        await expect
            .poll(() =>
                page.evaluate(
                    k => window.screenWorkerTest.demoResults.filter(r => r.input.request.kind === k).length,
                    kind,
                ),
            )
            .toBeGreaterThan(0);
        const observed = await page.evaluate(
            k => window.screenWorkerTest.demoResults.find(r => r.input.request.kind === k)!,
            kind,
        );
        expect(observed.workerId).toBe(await page.evaluate(() => window.screenWorkerTest.modelWorkerIds.at(-1)));
        expect(observed.input.pkParams!.e2_oral_bio).toBe(0.08);
        const expected = await page.evaluate(input => window.DemoReference.projectDemo(input), observed.input);
        expect(observed.output).toEqual(expected);
        await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
        expect(errors).toEqual([]);
    });
}

const range = async (page: Page, id: string, value: number) => {
    await page.locator(id).evaluate((node, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, String(v));
        node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
};
const lastModel = (page: Page) =>
    page.evaluate(() => window.screenWorkerTest.demoResults.filter(r => r.input.request.kind === 'model-guide').at(-1));
const lastRequest = (page: Page, kind: DemoKind) =>
    page.evaluate(k => window.screenWorkerTest.demoRequests.filter(r => r.request.kind === k).at(-1), kind);
for (const kind of ['model-guide', 'onboarding'] as const) {
    test(`ordinary ${kind} keeps the transmasc projection`, async ({ page, context }) => {
        await seedStorage(context, { ...seed(), 'hrt-mode': 'transmasc' });
        await observeWorkers(page);
        await installDemoReference(page);
        await page.goto('/');
        await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
        await openDemo(page, kind);
        await expect
            .poll(() =>
                page.evaluate(k => window.screenWorkerTest.demoResults.some(r => r.input.request.kind === k), kind),
            )
            .toBe(true);
        const r = await page.evaluate(
            k => window.screenWorkerTest.demoResults.find(r => r.input.request.kind === k)!,
            kind,
        );
        expect(r.input.request.kind === kind && r.input.request.isTransmasc).toBe(true);
        expect(r.output).toEqual(await page.evaluate(input => window.DemoReference.projectDemo(input), r.input));
    });
}

test('held demo edits keep every model control live and hide obsolete output', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { holdDemo: true });
    await page.goto('/');
    await expect.poll(() => resultCount(page)).toBeGreaterThan(0);
    await openDemo(page, 'model-guide');
    await expect.poll(() => lastRequest(page, 'model-guide')).not.toBeUndefined();
    await expect(page.locator('svg[role="img"]')).toHaveCount(0);
    await expect(page.locator('#model-doc-lab')).toBeVisible();
    await range(page, '#model-doc-dose', 7);
    await range(page, '#model-doc-lab', 1.1);
    await expect
        .poll(async () => {
            const t = await lastRequest(page, 'model-guide');
            return t?.request.kind === 'model-guide' ? t.request.dose : 0;
        })
        .toBe(7);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect
        .poll(async () => {
            const r = await lastModel(page);
            return r?.input.request.kind === 'model-guide' ? r.input.request.labRatio : 0;
        })
        .toBe(1.1);
    await expect(page.locator('#model-doc-dose')).toHaveValue('7');
    await expect(page.locator('#model-doc-lab')).toHaveValue('1.1');
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect(page.locator('svg[role="img"]')).toHaveCount(3);
});

test('a held former-mode educational response cannot publish in the next scope', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { holdDemo: true });
    await page.goto('/');
    await openDemo(page, 'model-guide');
    await expect.poll(() => lastRequest(page, 'model-guide')).not.toBeUndefined();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: /HRT mode/ }).click();
    await page.getByRole('button', { name: /Masculinizing HRT/ }).click();
    await expect
        .poll(() => page.evaluate(() => window.screenWorkerTest.requests.at(-1)?.input.events[0]?.id))
        .toBe('synthetic-m');
    await openDemo(page, 'model-guide');
    await expect
        .poll(async () => {
            const t = await lastRequest(page, 'model-guide');
            return t?.request.kind === 'model-guide' ? t.request.isTransmasc : false;
        })
        .toBe(true);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect.poll(() => page.evaluate(() => window.screenWorkerTest.demoResults.length)).toBeGreaterThan(0);
    expect(
        await page.evaluate(() =>
            window.screenWorkerTest.demoResults.every(
                r => r.input.request.kind === 'model-guide' && r.input.request.isTransmasc,
            ),
        ),
    ).toBe(true);
});

test('leaving the sandbox tab cancels its held computation without publishing it later', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { holdDemo: true });
    await page.goto('/');
    await openDemo(page, 'sandbox');
    await expect.poll(() => lastRequest(page, 'sandbox')).not.toBeUndefined();
    const initialDose = await page.locator('#pk-calc-dose').inputValue();
    await page.locator('#pk-calc-dose').fill('7');
    await page.getByRole('tab', { name: 'Level curve', exact: true }).click();
    await expect(page.locator('#pk-calc-dose')).toHaveCount(0);
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect(page.locator('.pk-tex')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Single dose', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(() => window.screenWorkerTest.demoResults.some(r => r.input.request.kind === 'sandbox')),
        )
        .toBe(true);
    await expect(page.locator('#pk-calc-dose')).toHaveValue(initialDose);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
});

test('model source clocks stay separate when edits cross an hour', async ({ page, context }) => {
    await page.clock.setFixedTime(new Date('2025-01-14T12:17:41.500Z'));
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.goto('/');
    await openDemo(page, 'model-guide');
    await expect.poll(() => lastModel(page)).not.toBeUndefined();
    const first = (await lastModel(page))!;
    if (first.input.request.kind !== 'model-guide') throw new Error('wrong fixture');
    await page.clock.setFixedTime(new Date('2025-01-14T14:17:41.500Z'));
    await range(page, '#model-doc-lab', 1.2);
    await expect
        .poll(async () => {
            const r = await lastModel(page);
            return r?.input.request.kind === 'model-guide' ? r.input.request.labRatio : 0;
        })
        .toBe(1.2);
    const lab = (await lastModel(page))!;
    if (
        lab.input.request.kind !== 'model-guide' ||
        lab.output.kind !== 'model-guide' ||
        first.output.kind !== 'model-guide'
    )
        throw new Error('wrong fixture');
    expect(lab.input.request.singleNowMs).toBe(first.input.request.singleNowMs);
    expect(lab.input.request.repeatedNowMs).toBe(first.input.request.repeatedNowMs);
    expect(lab.output.value.single).toEqual(first.output.value.single);
    await page.getByRole('tab', { name: '10 d', exact: true }).click();
    await expect
        .poll(async () => {
            const r = await lastModel(page);
            return r?.input.request.kind === 'model-guide' ? r.input.request.everyH : 0;
        })
        .toBe(240);
    const spacing = (await lastModel(page))!;
    if (spacing.input.request.kind !== 'model-guide') throw new Error('wrong fixture');
    expect(spacing.input.request.singleNowMs).toBe(first.input.request.singleNowMs);
    expect(spacing.input.request.repeatedNowMs).toBeGreaterThan(first.input.request.repeatedNowMs);
});

test('calibration demo failure and retry retain sliders and settle the status', async ({ page, context }, info) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await seedStorage(context, seed());
    await observeWorkers(page);
    await page.goto('/');
    await openDemo(page, 'calibration-guide');
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window.screenWorkerTest.failDemo = true));
    await range(page, '#cal-guide-level', 2);
    await range(page, '#cal-guide-count', 6);
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect(page.locator('#cal-guide-level')).toHaveValue('2');
    await expect(page.locator('#cal-guide-count')).toHaveValue('6');
    await expect(page.locator('svg[role="img"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('demo-phone-error.png') });
    await page.evaluate(() => {
        window.screenWorkerTest.failDemo = false;
        window.screenWorkerTest.holdDemo = true;
    });
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).click();
    await expect(page.getByText('Updating estimates…', { exact: true })).toBeVisible();
    await expect(page.locator('#cal-guide-level')).toBeEnabled();
    await page.evaluate(() => window.screenWorkerTest.release());
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await expect(page.locator('svg[role="img"]')).toHaveCount(1);
    await expect(page.locator('#cal-guide-count')).toHaveValue('6');
    await page.screenshot({ path: info.outputPath('demo-phone-ready.png') });
});

test('failed intro illustration leaves progression available and retries locally', async ({ page, context }) => {
    await seedStorage(context, seed());
    await observeWorkers(page, { failDemo: true });
    await page.goto('/');
    await openDemo(page, 'onboarding');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'How it works', exact: true })).toBeVisible();
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await page.evaluate(() => (window.screenWorkerTest.failDemo = false));
    await page.getByRole('button', { name: 'Retry estimates', exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(() => window.screenWorkerTest.demoResults.some(r => r.input.request.kind === 'onboarding')),
        )
        .toBe(true);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect(page.locator('svg circle.oc-pop')).toHaveCount(8);
});

test('educational work remains available after the record model fails', async ({ page, context }) => {
    await seedStorage(context, { ...seed(), 'hrt-cal-method': 'mcmc' });
    await observeWorkers(page, { failMethod: 'mcmc' });
    await page.goto('/');
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toBeVisible();
    await openDemo(page, 'model-guide');
    await expect
        .poll(() =>
            page.evaluate(() => window.screenWorkerTest.demoResults.some(r => r.input.request.kind === 'model-guide')),
        )
        .toBe(true);
    await expect(page.locator('svg[role="img"]')).toHaveCount(3);
    await expect(page.getByText('Estimates could not be calculated. Your records are still available.')).toHaveCount(0);
    await expect(page.getByText('Updating estimates…', { exact: true })).toHaveCount(0);
    await expect(page.locator('#model-doc-lab')).toBeEnabled();
});
