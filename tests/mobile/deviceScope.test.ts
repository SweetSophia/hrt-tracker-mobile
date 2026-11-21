import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ adb: vi.fn(), connect: vi.fn(), close: vi.fn(), waitForURL: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.adb }));
vi.mock('playwright', () => ({ chromium: { connectOverCDP: mocks.connect } }));
import { openPrototypeWebView } from '../../scripts/mobile/webview-connection.mjs';

beforeEach(() => {
    vi.resetAllMocks();
    mocks.adb.mockImplementation((_command, args: string[]) => {
        expect(args.slice(0, 2)).toEqual(['-s', 'selected-device']);
        if (args.includes('pidof')) return '123\n';
        if (args.includes('/proc/net/unix')) return '@webview_devtools_remote_123\n';
        if (args.includes('tcp:0')) return '43210\n';
        return '';
    });
    mocks.connect.mockResolvedValue({
        contexts: () => [{ pages: () => [{ waitForURL: mocks.waitForURL }] }],
        isConnected: () => true,
        close: mocks.close,
    });
});

it('opens only the selected process socket and removes only its own forwarding', async () => {
    const connection = await openPrototypeWebView('selected-device');
    expect(mocks.connect).toHaveBeenCalledWith('ws://127.0.0.1:43210/devtools/browser', expect.any(Object));
    expect(mocks.adb.mock.calls.some(([, args]) => args.includes('devices'))).toBe(false);
    await connection.close();
    await connection.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.adb).toHaveBeenLastCalledWith(
        'adb',
        ['-s', 'selected-device', 'forward', '--remove', 'tcp:43210'],
        expect.any(Object),
    );
});

it('removes its forward when CDP connection fails without selecting another device', async () => {
    mocks.connect.mockRejectedValue(new Error('connection failed'));
    await expect(openPrototypeWebView('selected-device')).rejects.toThrow('connection failed');
    expect(mocks.adb).toHaveBeenLastCalledWith(
        'adb',
        ['-s', 'selected-device', 'forward', '--remove', 'tcp:43210'],
        expect.any(Object),
    );
});

it('requires an explicit serial before invoking adb', async () => {
    await expect(openPrototypeWebView('')).rejects.toThrow(/serial/);
    expect(mocks.adb).not.toHaveBeenCalled();
});
