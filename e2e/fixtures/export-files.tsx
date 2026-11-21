import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import App from '../../src/App';
import { ApplicationRuntime, createWebRuntime } from '../../src/application/runtime';
import { RuntimeProvider } from '../../src/contexts/RecordsContext';
import type { FileSavePort, FileSaveResult } from '../../src/platform/contracts/files';

// This entry point is served only by the test's Vite dev server. Production
// entries never import it or consult its controls.
export interface ExportFilesFixture {
    requests: { name: string; mimeType: string; bytes: number[] }[];
    pending: () => number;
    settle: (result: FileSaveResult | 'reject') => void;
    setTheme: (theme: string) => Promise<boolean>;
}

declare global {
    interface Window {
        __exportFilesFixture: ExportFilesFixture;
    }
}

const requests: ExportFilesFixture['requests'] = [];
const pending: { resolve: (result: FileSaveResult) => void; reject: (error: Error) => void }[] = [];
const files: FileSavePort = {
    save(request) {
        requests.push({ ...request, bytes: Array.from(request.bytes) });
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
};

// Exercise the offline app's export lifetime with a controllable file picker.
const backend = new URLSearchParams(location.search).has('offline') ? 'offline' : location.origin;
const base = await createWebRuntime(localStorage, backend, navigator.locks);
const runtime = new ApplicationRuntime(
    base.controller,
    base.backend,
    localStorage,
    { ...base.getState().device },
    base.hasPriorRecords,
    base.secrets,
    files,
);
window.__exportFilesFixture = {
    requests,
    pending: () => pending.length,
    settle(result) {
        const operation = pending.shift();
        if (!operation) throw new Error('No pending fixture save');
        if (result === 'reject') operation.reject(new Error('SYNTHETIC-EXPORT-ERROR-PRIVATE-SENTINEL'));
        else operation.resolve(result);
    },
    setTheme: theme => runtime.setPreference('app-theme', theme),
};

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <RuntimeProvider value={runtime}>
            <App />
        </RuntimeProvider>
    </React.StrictMode>,
);
