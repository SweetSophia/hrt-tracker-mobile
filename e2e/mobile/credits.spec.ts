import { expect, test } from '@playwright/test';
import { TRANSLATIONS } from '../../src/i18n/translations';
import { baseStorage, confirmDialog, seedStorage } from '../helpers';

const mobileRepo = 'https://github.com/SweetSophia/hrt-tracker-mobile';
const webRepo = 'https://github.com/xunxunProjects/Oyama-s-HRT-Tracker';

test('mobile About and Credits identify both projects and their contributor links', async ({ page, context }) => {
    const externalLinks: string[] = [];
    await page.exposeFunction('recordExternalLink', (url: string) => externalLinks.push(url));
    await page.addInitScript(() => {
        const fixture = window as unknown as { recordExternalLink: (url: string) => void };
        window.open = url => {
            fixture.recordExternalLink(String(url));
            return null;
        };
    });
    await seedStorage(context, baseStorage());
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'App updates' })).toHaveCount(0);
    await page.getByRole('button', { name: 'GitHub repository', exact: true }).click();
    await confirmDialog(page, 'OK');
    await expect.poll(() => externalLinks).toEqual([mobileRepo]);

    await page.getByRole('button', { name: 'Credits', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Original work', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Oyama's HRT Tracker Developers", exact: true })).toBeVisible();
    for (const contributor of ['SmirnovaOyama', 'fantuanmtf', 'LaoZhong-Mihari']) {
        await expect(page.getByRole('button', { name: new RegExp('^' + contributor) })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Mobile HRT Tracker Developers', exact: true })).toBeVisible();
    const maintainer = page.getByRole('button', { name: /^SweetSophia/ });
    const avatar = maintainer.locator('img');
    await expect(avatar).toHaveAttribute('src', /sweetsophia-avatar.*\.webp$/);
    await expect(avatar).toHaveClass(/\brounded-full\b/);
    await expect.poll(() => avatar.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await maintainer.click();
    await expect(page.getByText(/Maintainer of the Mobile Phone HRT Tracker/)).toBeVisible();
    await expect(page.getByText('Android porting', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /GitHub @SweetSophia/ })).toHaveAttribute(
        'href',
        'https://github.com/SweetSophia',
    );
    const repositoryLink = page.getByRole('link', { name: /^Mobile GitHub repository/ });
    await expect(repositoryLink).toHaveText(/SweetSophia\/hrt-tracker-mobile/);
    await expect(repositoryLink).toHaveAttribute('href', mobileRepo);
    await expect(page.getByRole('heading', { name: 'Join us', exact: true })).toBeVisible();
    for (const [name, repo] of [
        ["Oyama's HRT Tracker (web)", webRepo],
        ['Mobile HRT Tracker (Android)', mobileRepo],
    ]) {
        const section = page.getByRole('region', { name, exact: true });
        await expect(section.getByRole('link', { name: 'Contributing guide' })).toHaveAttribute(
            'href',
            `${repo}/blob/main/CONTRIBUTING.md`,
        );
        await expect(section.getByRole('link', { name: 'Open an issue' })).toHaveAttribute(
            'href',
            `${repo}/issues/new/choose`,
        );
    }
});

test('mobile credit additions use the selected language', async ({ page, context }) => {
    const text = TRANSLATIONS.zh;
    await seedStorage(context, baseStorage({ 'hrt-lang': 'zh' }));
    await page.goto('/');
    await page.getByRole('button', { name: text['nav.settings'], exact: true }).click();
    await page.getByRole('tab', { name: text['settings.group.about'], exact: true }).click();
    await page.getByRole('button', { name: text['mobileCredits.title'], exact: true }).click();
    const team = page.getByRole('region', { name: text['mobileCredits.mobile_developers'] });
    await expect(team).toHaveAttribute('lang', 'zh');
    await team.getByRole('button', { name: /^SweetSophia/ }).click();
    await expect(team.getByText(text['mobileCredits.bio'], { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: text['mobileCredits.join'], exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Original work', exact: true })).toBeVisible();
});
