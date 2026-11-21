import { expect, it, vi } from 'vitest';
import { BackOwners, connectBackNavigation } from '../../src/application/backNavigation';

it('consumes one highest priority owner, newest first, and unregisters idempotently', () => {
    const owners = new BackOwners();
    const form = vi.fn(),
        first = vi.fn(),
        latest = vi.fn();
    owners.register(10, form);
    const removeFirst = owners.register(20, first);
    const removeLatest = owners.register(20, latest);
    expect(owners.handle()).toBe(true);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(form).not.toHaveBeenCalled();
    removeLatest();
    removeLatest();
    owners.handle();
    expect(first).toHaveBeenCalledOnce();
    removeFirst();
    owners.handle();
    expect(form).toHaveBeenCalledOnce();
});

it('does not fall through to navigation if an owner throws', async () => {
    const owners = new BackOwners();
    owners.register(10, () => {
        throw new Error('owner failed');
    });
    let back!: () => void;
    const leaveRoot = vi.fn();
    const report = vi.fn();
    const navigate = vi.fn(() => false);
    const disconnect = connectBackNavigation(
        {
            listenBack: async cb => {
                back = cb;
                return async () => {};
            },
            leaveRoot,
        },
        owners,
        navigate,
        report,
    );
    back();
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(leaveRoot).not.toHaveBeenCalled();
    disconnect();
});

it('uses app navigation before root departure and consumes rapid root actions', async () => {
    let back!: () => void, finish!: () => void;
    let canNavigate = true;
    const leaveRoot = vi.fn(
        () =>
            new Promise<void>(resolve => {
                finish = resolve;
            }),
    );
    const disconnect = connectBackNavigation(
        {
            listenBack: async cb => {
                back = cb;
                return async () => {};
            },
            leaveRoot,
        },
        new BackOwners(),
        () => canNavigate,
        vi.fn(),
    );
    back();
    expect(leaveRoot).not.toHaveBeenCalled();
    canNavigate = false;
    back();
    back();
    expect(leaveRoot).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    back();
    expect(leaveRoot).toHaveBeenCalledTimes(2);
    finish();
    disconnect();
});

it('removes a late listener after unmount and ignores callbacks from it', async () => {
    let back!: () => void, complete!: (remove: () => Promise<void>) => void;
    const remove = vi.fn(async () => {}),
        navigate = vi.fn(() => false),
        leaveRoot = vi.fn();
    const disconnect = connectBackNavigation(
        {
            listenBack: cb => {
                back = cb;
                return new Promise(resolve => {
                    complete = resolve;
                });
            },
            leaveRoot,
        },
        new BackOwners(),
        navigate,
        vi.fn(),
    );
    disconnect();
    disconnect();
    complete(remove);
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    back();
    expect(navigate).not.toHaveBeenCalled();
    expect(leaveRoot).not.toHaveBeenCalled();
});

it('reports registration and removal failures without unhandled rejections', async () => {
    const report = vi.fn();
    connectBackNavigation(
        {
            listenBack: async () => {
                throw new Error('registration');
            },
            leaveRoot: vi.fn(),
        },
        new BackOwners(),
        () => false,
        report,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledOnce();
    const disconnect = connectBackNavigation(
        {
            listenBack: async () => async () => {
                throw new Error('removal');
            },
            leaveRoot: vi.fn(),
        },
        new BackOwners(),
        () => false,
        report,
    );
    await Promise.resolve();
    disconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
});
