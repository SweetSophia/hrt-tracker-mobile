import { expect, test } from '@playwright/test';
import { baseStorage, seedStorage, pasteAndImport } from '../helpers';

test('bundled CSP blocks inline and external scripts', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    await page.goto('/');
    const blocked = await page.evaluate(async () => {
        const violations: string[] = [];
        document.addEventListener('securitypolicyviolation', e => violations.push(e.blockedURI));
        const inline = document.createElement('script');
        inline.textContent = 'window.__untrustedExecuted=true';
        document.head.appendChild(inline);
        const external = document.createElement('script');
        external.src = 'https://example.invalid/untrusted.js';
        document.head.appendChild(external);
        await new Promise(resolve => setTimeout(resolve, 50));
        return { violations, executed: '__untrustedExecuted' in window };
    });
    expect(blocked.executed).toBe(false);
    expect(blocked.violations).toContain('inline');
    expect(blocked.violations.some(value => value.startsWith('https://example.invalid'))).toBe(true);
});

test('malformed and HTML-shaped imports do not execute or log raw parse errors', async ({ page, context }) => {
    await seedStorage(context, baseStorage());
    const errors: string[] = [];
    const dialogs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('dialog', async dialog => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
    });
    await page.goto('/');
    for (const payload of ['{bad json', '<img src=x onerror=alert(1)>', '</span><script>alert(1)</script>']) {
        await pasteAndImport(page, payload);
        await expect(page.locator('[data-prompt="alert"]')).toContainText('Import failed');
        await page.locator('[data-prompt="alert"]').getByRole('button', { name: 'OK', exact: true }).click();
    }
    expect(dialogs).toEqual([]);
    expect(errors.filter(message => message.includes('SyntaxError'))).toEqual([]);
    await expect(page.locator('img[src="x"], svg[onload]')).toHaveCount(0);
});
