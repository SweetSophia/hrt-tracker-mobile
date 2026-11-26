import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { parseLaunchAction, type LauncherShortcutPort } from '../contracts/launchActions';

export const LAUNCHER_SHORTCUT_PLUGIN = 'HrtLauncherShortcut';

const bridge = registerPlugin<{
    publishAddDose(options: { label: string }): Promise<void>;
}>(LAUNCHER_SHORTCUT_PLUGIN);

export const androidLauncherShortcutPort: LauncherShortcutPort = {
    async listenForLaunchActions(handler) {
        // The App plugin retains the cold-start intent until this listener attaches.
        const listener = await App.addListener('appUrlOpen', ({ url }) => {
            const action = parseLaunchAction(url);
            if (action) handler(action);
        });
        return () => listener.remove();
    },
    publishAddDoseShortcut: label => bridge.publishAddDose({ label }),
};
