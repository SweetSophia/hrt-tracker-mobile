import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { upgradeOverlay } from '../../scripts/mobile/build-upgrade-fixtures.mjs';

const html =
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src self"><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>';

it('loads a distinct executed canary while preserving the ordinary HTML and its CSP order', () => {
    for (const stage of [1, 2]) {
        const result = upgradeOverlay(html, stage);
        const window = {};
        runInNewContext(result.script, { window });
        expect(window).toHaveProperty('__hrtUpgradeAssetVersion', stage);
        const insertion = '<script src="/assets/__hrt_upgrade_canary__.js"></script>';
        expect(result.html.replace(insertion, '')).toBe(html);
        expect(result.html.indexOf('Content-Security-Policy')).toBeLessThan(result.html.indexOf(insertion));
        expect(result.html.indexOf(insertion)).toBeLessThan(result.html.indexOf('</head>'));
    }
    expect(upgradeOverlay(html, 1).script).not.toBe(upgradeOverlay(html, 2).script);
});

it('refuses unsupported stages, missing or late CSP, malformed heads and an already patched input', () => {
    for (const stage of [0, 3, '1', NaN, null]) expect(() => upgradeOverlay(html, stage)).toThrow();
    for (const invalid of [
        html.replace('</head>', ''),
        html.replace('Content-Security-Policy', 'not-a-policy'),
        html.replace('<head>', '<head><script src="/too-early.js"></script>'),
        upgradeOverlay(html, 1).html,
    ])
        expect(() => upgradeOverlay(invalid, 1)).toThrow();
});
