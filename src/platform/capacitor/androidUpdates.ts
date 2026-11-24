import { App, type AppState } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AndroidUpdatePort, AndroidUpdateState } from '../contracts/androidUpdates';

const PLUGIN = 'HrtReleaseUpdates';

type UpdateBridge = Pick<AndroidUpdatePort, 'getState' | 'checkNow' | 'checkOnOpen'> & {
    setAutomatic(options: { enabled: boolean }): Promise<AndroidUpdateState>;
    dismiss(options: { version: string }): Promise<AndroidUpdateState>;
    openRelease(options: { version: string }): Promise<void>;
};

export function createAndroidUpdates(): AndroidUpdatePort | undefined {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable(PLUGIN))
        return;

    const bridge = registerPlugin<UpdateBridge>(PLUGIN);
    return {
        getState: () => bridge.getState(),
        setAutomatic: enabled => bridge.setAutomatic({ enabled }),
        checkNow: () => bridge.checkNow(),
        checkOnOpen: () => bridge.checkOnOpen(),
        dismiss: version => bridge.dismiss({ version }),
        openRelease: version => bridge.openRelease({ version }),
        listenForForeground(listener) {
            let disposed = false;
            const onState = ({ isActive }: AppState) => {
                if (isActive && !disposed) listener();
            };
            const handle = App.addListener('appStateChange', onState);
            // The first resume can precede installation of the React listener.
            void handle
                .then(() => (disposed ? { isActive: false } : App.getState()))
                .then(onState)
                .catch(() => undefined);
            return () => {
                disposed = true;
                void handle.then(subscription => subscription.remove()).catch(() => undefined);
            };
        },
    };
}
