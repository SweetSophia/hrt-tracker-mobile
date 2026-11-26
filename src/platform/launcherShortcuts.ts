import { Capacitor } from '@capacitor/core';
import { androidLauncherShortcutPort, LAUNCHER_SHORTCUT_PLUGIN } from './capacitor/launcherShortcuts';
import type { LaunchAction, LauncherShortcutPort } from './contracts/launchActions';
import { getBuildTarget } from './runtime';

export const getLauncherShortcutPort = (): LauncherShortcutPort | null =>
    getBuildTarget() === 'mobile' &&
    Capacitor.getPlatform() === 'android' &&
    Capacitor.isPluginAvailable(LAUNCHER_SHORTCUT_PLUGIN)
        ? androidLauncherShortcutPort
        : null;

export function connectLaunchActions(
    port: LauncherShortcutPort,
    handler: (action: LaunchAction) => void,
    reportError: (error: unknown) => void,
): () => void {
    let stopped = false;
    // An abandoned effect must not claim the retained cold-start action.
    const registration = Promise.resolve().then(() => {
        if (stopped) return;
        return port.listenForLaunchActions(action => {
            if (!stopped) handler(action);
        });
    });
    void registration.catch(reportError);

    return () => {
        if (stopped) return;
        stopped = true;
        void registration
            .then(
                remove => remove?.(),
                () => undefined,
            )
            .catch(reportError);
    };
}
