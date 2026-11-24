import { useCallback, useEffect, useRef, useState } from 'react';
import type { AndroidUpdatePort, AndroidUpdateState } from '../platform/contracts/androidUpdates';

type UserAction = 'check' | 'toggle' | 'dismiss' | 'openInAbout' | 'openInNotice';

export function useAndroidUpdates(port: AndroidUpdatePort | undefined) {
    const [state, setState] = useState<AndroidUpdateState | null>(null);
    const [checked, setChecked] = useState(false);
    const [pending, setPending] = useState<UserAction | null>(null);
    const [failure, setFailure] = useState<UserAction | null>(null);
    const userBusy = useRef(false);
    const queue = useRef(Promise.resolve());

    // Publish snapshots in order when a foreground event and a Settings action overlap.
    const enqueue = useCallback((task: () => Promise<void>) => {
        const result = queue.current.then(task);
        queue.current = result.catch(() => undefined);
        return result;
    }, []);

    useEffect(() => {
        if (!port) return;
        let mounted = true;
        let checkingOnOpen = false;
        const publish = async (read: () => Promise<AndroidUpdateState>) => {
            if (!mounted) return;
            const snapshot = await read();
            if (mounted) setState(snapshot);
        };
        // Also read the local snapshot when the first automatic check is offline or slow.
        void enqueue(() => publish(port.getState)).catch(() => undefined);
        const stop = port.listenForForeground(() => {
            if (checkingOnOpen) return;
            checkingOnOpen = true;
            void enqueue(() => publish(port.checkOnOpen))
                .catch(() => undefined)
                .finally(() => {
                    checkingOnOpen = false;
                });
        });
        return () => {
            mounted = false;
            stop();
        };
    }, [enqueue, port]);

    if (!port) return undefined;

    const run = (action: UserAction, task: () => Promise<void>) => {
        if (userBusy.current) return;
        userBusy.current = true;
        setPending(action);
        setFailure(null);
        void enqueue(task)
            .catch(() => setFailure(action))
            .finally(() => {
                userBusy.current = false;
                setPending(null);
            });
    };

    return {
        state,
        checked,
        pending,
        failure,
        noticeVersion:
            state?.automatic && pending !== 'toggle' && state.availableVersion !== state.dismissedVersion
                ? state.availableVersion
                : null,
        checkNow: () =>
            run('check', async () => {
                setChecked(false);
                setState(await port.checkNow());
                setChecked(true);
            }),
        setAutomatic: (enabled: boolean) => run('toggle', async () => setState(await port.setAutomatic(enabled))),
        dismiss: (version: string) => run('dismiss', async () => setState(await port.dismiss(version))),
        openRelease: (version: string, from: 'about' | 'notice') =>
            run(from === 'about' ? 'openInAbout' : 'openInNotice', () => port.openRelease(version)),
    };
}

export type AndroidUpdates = NonNullable<ReturnType<typeof useAndroidUpdates>>;
