import { useCallback, useEffect, useRef, useState } from 'react';
import type { AndroidUpdatePort, AndroidUpdateState } from '../platform/contracts/androidUpdates';

type LocalAction = 'toggle' | 'dismiss' | 'openInAbout' | 'openInNotice';
type CheckFeedback = 'checked' | 'noRelease' | 'failed';

export function useAndroidUpdates(port: AndroidUpdatePort | undefined) {
    const [state, setState] = useState<AndroidUpdateState | null>(null);
    const [checking, setChecking] = useState(false);
    const [checkFeedback, setCheckFeedback] = useState<CheckFeedback | null>(null);
    const [pending, setPending] = useState<LocalAction | null>(null);
    const [failure, setFailure] = useState<LocalAction | null>(null);
    const latestState = useRef<AndroidUpdateState | null>(null);
    const checkBusy = useRef(false);
    const localBusy = useRef(false);

    const publish = useCallback((snapshot: AndroidUpdateState) => {
        // A delayed network reply can predate a dismissal or a consent change.
        if (latestState.current && latestState.current.revision >= snapshot.revision) return;
        latestState.current = snapshot;
        setState(snapshot);
    }, []);

    const check = useCallback(
        async (automatic: boolean) => {
            if (!port || checkBusy.current || (automatic && latestState.current?.automatic === false)) return;
            checkBusy.current = true;
            setChecking(true);
            try {
                const result = await (automatic ? port.checkOnOpen() : port.checkNow());
                publish(result.state);
                if (result.outcome !== 'skipped') setCheckFeedback(automatic ? null : result.outcome);
            } catch {
                setCheckFeedback(automatic ? null : 'failed');
            } finally {
                checkBusy.current = false;
                setChecking(false);
            }
        },
        [port, publish],
    );

    useEffect(() => {
        if (!port) return;
        let mounted = true;
        void port
            .getState()
            .then(snapshot => {
                if (mounted) publish(snapshot);
            })
            .catch(() => undefined);
        const stop = port.listenForForeground(() => void check(true));
        return () => {
            mounted = false;
            stop();
        };
    }, [check, port, publish]);

    if (!port) return undefined;

    const runLocal = async (action: LocalAction, task: () => Promise<void>) => {
        if (localBusy.current) return;
        localBusy.current = true;
        setPending(action);
        setFailure(null);
        try {
            await task();
        } catch {
            setFailure(action);
        } finally {
            localBusy.current = false;
            setPending(null);
        }
    };

    return {
        state,
        checking,
        checkFeedback,
        pending,
        failure,
        noticeVersion:
            state?.automatic && pending !== 'toggle' && state.availableVersion !== state.dismissedVersion
                ? state.availableVersion
                : null,
        checkNow: () => void check(false),
        setAutomatic: (enabled: boolean) => runLocal('toggle', async () => publish(await port.setAutomatic(enabled))),
        dismiss: (version: string) => runLocal('dismiss', async () => publish(await port.dismiss(version))),
        openRelease: (version: string, from: 'about' | 'notice') =>
            runLocal(from === 'about' ? 'openInAbout' : 'openInNotice', () => port.openRelease(version)),
    };
}

export type AndroidUpdates = NonNullable<ReturnType<typeof useAndroidUpdates>>;
