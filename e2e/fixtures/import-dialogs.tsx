import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { createWebRuntime } from '../../src/application/runtime';
import { RuntimeProvider } from '../../src/contexts/RecordsContext';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { DialogProvider, useDialog } from '../../src/contexts/DialogContext';
import ImportSection from '../../src/components/ImportSection';

// Real providers and ImportSection; only the caller's confirmable operation is synthetic.
// This test entry is never imported by a production entry.
const counts = { cancelled: 0, confirmed: 0 };
let closeOld: () => void = () => {};
Object.assign(window, { __importDialogCounts: counts });
const runtime = await createWebRuntime(localStorage, window.location.origin, navigator.locks);
function Harness() {
    const { showDialog } = useDialog();
    const importFile = () =>
        new Promise<boolean>(resolve => {
            closeOld = showDialog(
                'confirm',
                'Synthetic import preview',
                () => {
                    counts.confirmed++;
                    resolve(true);
                },
                {
                    onCancel: () => {
                        counts.cancelled++;
                        resolve(false);
                    },
                },
            );
        });
    return (
        <main data-prompt-area>
            <ImportSection onImportJson={importFile} onReplaceJson={importFile} />
            <button onClick={() => showDialog('alert', 'Unrelated operation message')}>Unrelated prompt</button>
            <button onClick={() => closeOld()}>Dismiss old prompt</button>
            <button
                onClick={() => {
                    closeOld = showDialog(
                        'confirm',
                        'Reentrant confirmation',
                        () => {
                            counts.confirmed++;
                        },
                        {
                            onCancel: () => {
                                counts.cancelled++;
                                showDialog('alert', 'Cancellation follow-up');
                            },
                        },
                    );
                }}
            >
                Reentrant confirmation
            </button>
            <button
                onClick={() =>
                    showDialog('alert', 'Alert with callback', () => {
                        counts.confirmed++;
                    })
                }
            >
                Alert with callback
            </button>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <RuntimeProvider value={runtime}>
            <LanguageProvider>
                <DialogProvider>
                    <Harness />
                </DialogProvider>
            </LanguageProvider>
        </RuntimeProvider>
    </React.StrictMode>,
);
