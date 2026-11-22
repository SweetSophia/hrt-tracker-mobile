import React, { createContext, useContext } from 'react';
import { useDevicePreference } from './RecordsContext';
import { HRTMode } from '../../logic';

interface HRTModeContextValue {
    mode: HRTMode;
    /**
     * `true` once the choice is durably saved; `false` on a failed write —
     * synchronously on the web, after the write attempt on a native build —
     * leaving `mode` at its last saved value. Callers that move the user on
     * must wait for it, like Onboarding's Next and Skip.
     */
    setMode: (m: HRTMode) => boolean | Promise<boolean>;
    isTransmasc: boolean;
}

const HRTModeContext = createContext<HRTModeContextValue | null>(null);

export const useHRTMode = (): HRTModeContextValue => {
    const ctx = useContext(HRTModeContext);
    if (!ctx) throw new Error('useHRTMode must be used within HRTModeProvider');
    return ctx;
};

const STORAGE_KEY = 'hrt-mode';

export const HRTModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [mode, setMode] = useDevicePreference<HRTMode>(STORAGE_KEY, raw =>
        raw === 'transmasc' ? 'transmasc' : 'transfem',
    );

    return (
        <HRTModeContext.Provider value={{ mode, setMode, isTransmasc: mode === 'transmasc' }}>
            {children}
        </HRTModeContext.Provider>
    );
};
