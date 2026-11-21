import { Capacitor } from '@capacitor/core';
import type { BackPort } from './contracts/lifecycle';
import { getBuildTarget } from './runtime';
import { androidBackPort } from './capacitor/lifecycle';

/** Browser history remains browser-owned; iOS needs its own lifecycle qualification later. */
export const getBackPort = (): BackPort | null =>
    getBuildTarget() === 'mobile' && Capacitor.getPlatform() === 'android' ? androidBackPort : null;
