import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ApplicationRuntime, DeviceKey, PortableKey } from '../application/runtime';
import { useAuth } from './AuthContext';
import { useHRTMode } from './HRTModeContext';
import { useTranslation } from './LanguageContext';

const RuntimeContext = createContext<ApplicationRuntime | null>(null);
export const RuntimeProvider = RuntimeContext.Provider;
export function useApplicationRuntime() {
    const runtime = useContext(RuntimeContext);
    if (!runtime) throw new Error('Application runtime is not initialized');
    return runtime;
}
export function useRecordController() {
    const { controller } = useApplicationRuntime();
    const state = useSyncExternalStore(controller.subscribe, controller.getState);
    return { controller, state };
}
export function usePortablePreference<T>(key: PortableKey, parse: (raw: string | undefined) => T) {
    const runtime = useApplicationRuntime();
    const state = useSyncExternalStore(runtime.subscribe, runtime.getState);
    return [parse(state.preferences[key]), (value: T) => runtime.setPreference(key, String(value))] as const;
}
export function useDevicePreference<T>(key: DeviceKey, parse: (raw: string | undefined) => T) {
    const runtime = useApplicationRuntime();
    const state = useSyncExternalStore(runtime.subscribe, runtime.getState);
    return [parse(state.device[key]), (value: T) => runtime.setDevice(key, String(value))] as const;
}
export function RecordBoundary({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    const { mode } = useHRTMode();
    const runtime = useApplicationRuntime();
    const { controller, state } = useRecordController();
    const { t } = useTranslation();
    const owner = user?.id ?? 'local';
    const matching =
        state.status !== 'idle' &&
        state.scope.owner === owner &&
        state.scope.mode === mode &&
        state.scope.backend === runtime.backend;
    useEffect(() => {
        void controller.activate({ backend: runtime.backend, owner, mode }).catch(() => undefined);
    }, [controller, runtime.backend, owner, mode]);
    if (!matching || state.status !== 'ready')
        return (
            <main className="max-w-xl mx-auto p-6" role="status">
                <p>{t(state.status === 'error' ? 'storage.open_failed' : 'storage.loading')}</p>
                {state.status === 'error' && (
                    <button
                        className="btn-secondary mt-4"
                        onClick={() => {
                            void controller.refresh().catch(() => undefined);
                        }}
                    >
                        {t('storage.retry')}
                    </button>
                )}
            </main>
        );
    return <>{children}</>;
}
export function StorageStatus() {
    const runtime = useApplicationRuntime();
    const device = useSyncExternalStore(runtime.subscribe, runtime.getState);
    const { controller, state } = useRecordController();
    const { t } = useTranslation();
    if (!(state.status === 'ready' && state.error) && !device.error) return null;
    return (
        <div role="alert" className="p-4 text-[var(--danger)] border-b border-[var(--border)]">
            <p>{t('storage.save_failed')}</p>
            <button
                className="btn-secondary mt-2"
                onClick={() => {
                    void controller.refresh().catch(() => undefined);
                }}
            >
                {t('storage.retry')}
            </button>
        </div>
    );
}

/** Secondary readers see only the currently confirmed account, never raw storage. */
export function useRecordReader() {
    const { controller } = useApplicationRuntime();
    return React.useMemo(
        () => ({
            getItem(key: string): string | null {
                const state = controller.getState();
                if (state.status !== 'ready') return null;
                for (const snapshot of Object.values(state.snapshots))
                    if (Object.hasOwn(snapshot.entries, key)) return snapshot.entries[key];
                return null;
            },
        }),
        [controller],
    );
}
