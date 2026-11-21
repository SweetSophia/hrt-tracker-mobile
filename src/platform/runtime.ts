import { Capacitor } from '@capacitor/core';

// Vitest's existing plain-module suite has no Vite app defines and remains
// a web consumer. Both production build targets always supply this define.
export const getBuildTarget = (): 'web' | 'mobile' =>
    typeof __HRT_BUILD_TARGET__ === 'undefined' ? 'web' : __HRT_BUILD_TARGET__;

export const getRuntimeKind = (): 'web' | 'capacitor' => (Capacitor.isNativePlatform() ? 'capacitor' : 'web');

export const getCapabilities = () => ({
    remoteBackend: getBuildTarget() === 'web',
    nativeFiles: false,
    nativeRecords: typeof __HRT_NATIVE_RECORDS__ !== 'undefined' && __HRT_NATIVE_RECORDS__,
});
