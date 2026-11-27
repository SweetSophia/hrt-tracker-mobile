import { useEffect, useLayoutEffect, useRef } from 'react';
import type { LaunchAction } from '../platform/contracts/launchActions';
import { connectLaunchActions, getLauncherShortcutPort } from '../platform/launcherShortcuts';

let activeEditors = 0;

/** Keep an active editor in place when the launcher shortcut arrives. */
export function useLauncherShortcutBlocker(active: boolean) {
    useLayoutEffect(() => {
        if (!active) return;
        activeEditors++;
        return () => {
            activeEditors--;
        };
    }, [active]);
}

export const hasLauncherShortcutBlocker = () => activeEditors > 0;

/** Subscribe even during onboarding so an early intent is consumed there. */
export function useLauncherShortcut(label: string | null, onAction: (action: LaunchAction) => void) {
    const latest = useRef(onAction);
    useLayoutEffect(() => {
        latest.current = onAction;
    }, [onAction]);

    useEffect(() => {
        const port = getLauncherShortcutPort();
        if (!port) return;
        return connectLaunchActions(
            port,
            action => latest.current(action),
            () => console.warn('Unable to listen for Android launcher actions'),
        );
    }, []);

    useEffect(() => {
        const port = getLauncherShortcutPort();
        if (!port || label === null) return;
        let stopped = false;
        void Promise.resolve()
            .then(() => {
                if (!stopped) return port.publishAddDoseShortcut(label);
            })
            .catch(() => console.warn('Unable to publish the Android Add dose shortcut'));
        return () => {
            stopped = true;
        };
    }, [label]);
}
