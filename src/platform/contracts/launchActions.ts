export type LaunchAction = 'add-dose';

export function parseLaunchAction(url: string): LaunchAction | null {
    return url === 'hrttracker://add-dose' ? 'add-dose' : null;
}

export interface LauncherShortcutPort {
    listenForLaunchActions(handler: (action: LaunchAction) => void): Promise<() => Promise<void>>;
    publishAddDoseShortcut(label: string): Promise<void>;
}
