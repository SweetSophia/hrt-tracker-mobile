import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackOwners } from '../../src/application/backNavigation';
import {
    parseLaunchAction,
    type LaunchAction,
    type LauncherShortcutPort,
} from '../../src/platform/contracts/launchActions';
import { connectLaunchActions, getLauncherShortcutPort } from '../../src/platform/launcherShortcuts';

const mocks = vi.hoisted(() => ({
    getBuildTarget: vi.fn(),
    getPlatform: vi.fn(),
    isPluginAvailable: vi.fn(),
    addListener: vi.fn(),
    remove: vi.fn(async () => {}),
    publishAddDose: vi.fn(async () => {}),
}));

vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.addListener } }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: mocks.getPlatform, isPluginAvailable: mocks.isPluginAvailable },
    registerPlugin: () => ({ publishAddDose: mocks.publishAddDose }),
}));
vi.mock('../../src/platform/runtime', () => ({ getBuildTarget: mocks.getBuildTarget }));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBuildTarget.mockReturnValue('mobile');
    mocks.getPlatform.mockReturnValue('android');
    mocks.isPluginAvailable.mockReturnValue(true);
    mocks.addListener.mockResolvedValue({ remove: mocks.remove });
});

describe('Android launcher shortcuts', () => {
    it('accepts the exact add dose URI only', () => {
        expect(parseLaunchAction('hrttracker://add-dose')).toBe('add-dose');
        for (const url of [
            'hrttracker://add-dose/',
            'hrttracker://add-dose?amount=1',
            'hrttracker://add-dose#extra',
            'hrttracker://user@add-dose',
            'hrttracker://ADD-DOSE',
            'hrttracker://labs',
            'https://localhost/add-dose',
            '',
        ]) {
            expect(parseLaunchAction(url)).toBeNull();
        }
    });

    it('uses one appUrlOpen subscription and publishes only the label', async () => {
        const listener = vi.fn();
        const port = getLauncherShortcutPort()!;
        const remove = await port.listenForLaunchActions(listener);
        expect(mocks.addListener).toHaveBeenCalledExactlyOnceWith('appUrlOpen', expect.any(Function));
        const notify = mocks.addListener.mock.calls[0][1];
        notify({ url: 'hrttracker://add-dose#extra' });
        notify({ url: 'hrttracker://add-dose' });
        expect(listener).toHaveBeenCalledExactlyOnceWith('add-dose');
        await remove();
        expect(mocks.remove).toHaveBeenCalledOnce();

        await port.publishAddDoseShortcut('Dosis hinzufügen');
        expect(mocks.isPluginAvailable).toHaveBeenCalledWith('HrtLauncherShortcut');
        expect(mocks.publishAddDose).toHaveBeenCalledExactlyOnceWith({ label: 'Dosis hinzufügen' });
    });

    it.each([
        ['web', 'android', true],
        ['mobile', 'ios', true],
        ['mobile', 'android', false],
    ])('leaves launch actions disabled for %s on %s with native support %s', (build, platform, native) => {
        mocks.getBuildTarget.mockReturnValue(build);
        mocks.getPlatform.mockReturnValue(platform);
        mocks.isPluginAvailable.mockReturnValue(native);
        expect(getLauncherShortcutPort()).toBeNull();
        expect(mocks.addListener).not.toHaveBeenCalled();
        expect(mocks.publishAddDose).not.toHaveBeenCalled();
    });

    it('disposes a late listener once and ignores its pending callbacks', async () => {
        let finish!: (remove: () => Promise<void>) => void;
        let notify!: (action: LaunchAction) => void;
        const remove = vi.fn(async () => {});
        const handler = vi.fn();
        const report = vi.fn();
        const port: LauncherShortcutPort = {
            listenForLaunchActions(listener) {
                notify = listener;
                return new Promise(resolve => {
                    finish = resolve;
                });
            },
            publishAddDoseShortcut: mocks.publishAddDose,
        };
        const disconnect = connectLaunchActions(port, handler, report);
        await Promise.resolve();
        notify('add-dose');
        expect(handler).toHaveBeenCalledExactlyOnceWith('add-dose');
        disconnect();
        disconnect();
        notify('add-dose');
        expect(handler).toHaveBeenCalledOnce();
        finish(remove);
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
        expect(report).not.toHaveBeenCalled();
    });

    it('skips registration for a synchronously discarded effect so the retained launch reaches its replacement', async () => {
        const port = getLauncherShortcutPort()!;
        const handler = vi.fn();
        const report = vi.fn();
        connectLaunchActions(port, handler, report)();
        const disconnect = connectLaunchActions(port, handler, report);
        await Promise.resolve();
        expect(mocks.addListener).toHaveBeenCalledOnce();
        const notify = mocks.addListener.mock.calls[0][1];
        notify({ url: 'hrttracker://add-dose' });
        expect(handler).toHaveBeenCalledExactlyOnceWith('add-dose');
        disconnect();
        await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
    });
});

it('checks for a Back owner without invoking it', () => {
    const owners = new BackOwners();
    const editor = vi.fn();
    expect(owners.hasActiveOwner()).toBe(false);
    const unregister = owners.register(10, editor);
    expect(owners.hasActiveOwner()).toBe(true);
    expect(editor).not.toHaveBeenCalled();
    unregister();
    expect(owners.hasActiveOwner()).toBe(false);
});
