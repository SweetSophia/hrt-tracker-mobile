import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), adb: vi.fn(), close: vi.fn(), expose: vi.fn() }));
vi.mock('../../scripts/mobile/webview-connection.mjs', () => ({ openPrototypeWebView: mocks.connect }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.adb }));
vi.mock('@playwright/test', () => ({ expect: vi.fn() }));
const originalArgs = process.argv;
let stored: Map<string, string>;

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    stored = new Map();
    vi.stubGlobal('localStorage', {
        get length() {
            return stored.size;
        },
        key: (index: number) => [...stored.keys()][index] ?? null,
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
    });
    mocks.expose.mockRejectedValue(new Error('STOP_AFTER_PREFLIGHT'));
    mocks.connect.mockResolvedValue({
        page: {
            evaluate: async (fn: () => unknown) => fn(),
            exposeFunction: mocks.expose,
        },
        close: mocks.close,
    });
    process.argv = ['node', 'run-webview-checks.mjs', '--serial', 'emulator-5582', '--output', '/tmp/unused.json'];
});

afterEach(() => {
    process.argv = originalArgs;
    vi.unstubAllGlobals();
});
const run = () => import('../../scripts/mobile/run-webview-checks.mjs');

it('refuses a physical serial before opening the app', async () => {
    process.argv[3] = 'physical-phone';
    await expect(run()).rejects.toThrow(/dedicated emulator/);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.adb).not.toHaveBeenCalled();
});

it.each(['hrt-events', 'hrt-masc-events', 'hrt-uother-lab-results', 'auth_token', 'auth_user', 'enc_key'])(
    'refuses unmarked existing %s without changing any stored value',
    async key => {
        stored.set(key, 'SYNTHETIC-EXISTING-DATA');
        stored.set('hrt-mode', 'transmasc');
        const before = [...stored];
        await expect(run()).rejects.toThrow(/Refusing to seed/);
        expect([...stored]).toEqual(before);
        expect(mocks.expose).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledTimes(1);
    },
);

it('allows the empty arrays written by fresh app startup', async () => {
    stored.set('hrt-events', '[]');
    stored.set('hrt-lab-results', '[]');
    await expect(run()).rejects.toThrow('STOP_AFTER_PREFLIGHT');
    expect(mocks.expose).toHaveBeenCalledTimes(1);
});

it('closes the connection even when airplane-mode restoration fails', async () => {
    process.argv.push('--offline');
    mocks.adb.mockImplementation(() => {
        throw new Error('RADIO_RESTORE_FAILED');
    });
    await expect(run()).rejects.toThrow('RADIO_RESTORE_FAILED');
    expect(mocks.close).toHaveBeenCalledTimes(1);
});
