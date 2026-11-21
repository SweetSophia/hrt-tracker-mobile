import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApplicationRuntime } from '../../src/application/runtime';
import { RuntimeProvider } from '../../src/contexts/RecordsContext';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { DialogProvider } from '../../src/contexts/DialogContext';
import ShareSettings from '../../src/pages/ShareSettings';

/** Test host only: standalone navigation deliberately excludes connected sharing. */
export function installContentQualification(runtime: ApplicationRuntime) {
    let root: Root | undefined;
    let host: HTMLElement | undefined;
    const unmount = () => {
        root?.unmount();
        host?.remove();
        root = undefined;
        host = undefined;
    };
    Object.assign(window, {
        __hrtContentQualification: {
            language: async (language: 'en' | 'zh') => {
                if (language !== 'en' && language !== 'zh') throw new Error('Unsupported qualification language');
                if (!(await runtime.setPreference('hrt-lang', language))) throw new Error('Language setup failed');
                return 'ready';
            },
            mountShare: () => {
                unmount();
                host = document.createElement('div');
                host.id = 'content-qualification-host';
                document.body.appendChild(host);
                root = createRoot(host);
                root.render(
                    <RuntimeProvider value={runtime}>
                        <LanguageProvider>
                            <DialogProvider>
                                <ShareSettings
                                    onBack={unmount}
                                    authToken="synthetic-content-qualification"
                                    mode="transfem"
                                    events={[]}
                                    simulation={null}
                                    calibrationFn={() => 1}
                                />
                            </DialogProvider>
                        </LanguageProvider>
                    </RuntimeProvider>,
                );
            },
            unmountShare: unmount,
        },
    });
}
