import { App } from '@capacitor/app';
import type { BackPort } from '../contracts/lifecycle';

export const androidBackPort: BackPort = {
    async listenBack(listener) {
        const handle = await App.addListener('backButton', listener);
        return () => handle.remove();
    },
    leaveRoot: () => App.minimizeApp(),
};
