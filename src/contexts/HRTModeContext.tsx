import React, { createContext, useContext } from 'react';
import { useDevicePreference } from './RecordsContext';
import { HRTMode } from '../../logic';

interface HRTModeContextValue {
    mode: HRTMode;
    setMode: (m: HRTMode) => void;
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
