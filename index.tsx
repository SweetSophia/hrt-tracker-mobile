import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import App from './src/App';
import { watchForAppUpdates } from './src/utils/swUpdate';
import { preventPinchZoom } from './src/utils/preventPinchZoom';
import { watchInputMode } from './src/utils/inputMode';
import { createApplicationRuntime } from './src/application/bootstrap';
import { RuntimeProvider } from './src/contexts/RecordsContext';
import { getBuildTarget } from './src/platform/runtime';
import { TRANSLATIONS, type Lang } from './src/i18n/translations';

function recoveryLanguage(): Lang {
    const { languages, language } = navigator;
    for (const locale of languages?.length ? languages : [language]) {
        const [primary, ...subtags] = locale.toLowerCase().split('-');
        if (primary === 'zh') {
            if (subtags.includes('hant')) return 'zh-TW';
            if (subtags.includes('hans')) return 'zh';
            return subtags.some(tag => ['tw', 'hk', 'mo'].includes(tag)) ? 'zh-TW' : 'zh';
        }
        if (Object.prototype.hasOwnProperty.call(TRANSLATIONS, primary)) return primary as Lang;
    }
    return 'en';
}

if (getBuildTarget() === 'web') watchForAppUpdates();
if (__HRT_MOBILE_PROBE__) void import('./mobile/probe/entry');
preventPinchZoom();
watchInputMode();

// Opened by the developer simulator (pages/Simulator.tsx): lay out as a touch
// screen would, which a frame can't otherwise ask the browser to pretend.
if (new URLSearchParams(window.location.search).get('sim') === 'touch') {
    document.documentElement.setAttribute('data-sim-touch', '');
}

/**
 * Interrupted browser record batches leave a journal. Recover
 * before React mounts, so no component ever reads a half-replaced store. If
 * recovery itself fails, show a blocking screen rather than render data that
 * may be partial.
 */
const container = document.getElementById('root');
if (container) {
    void (async () => {
        try {
            const runtime = await createApplicationRuntime(localStorage, window.location.origin, navigator.locks);
            if (__HRT_STORAGE_QUALIFICATION__) {
                const { installStorageQualification } = await import('./mobile/storageQualification/entry');
                installStorageQualification(runtime);
            }
            const root = createRoot(container);
            root.render(
                <React.StrictMode>
                    <RuntimeProvider value={runtime}>
                        <App />
                    </RuntimeProvider>
                </React.StrictMode>,
            );
        } catch (err) {
            const language = __HRT_NATIVE_RECORDS__ ? recoveryLanguage() : 'en';
            const nativeCopy = __HRT_NATIVE_RECORDS__ ? TRANSLATIONS[language] : undefined;
            if (nativeCopy) console.error('Native record initialization failed');
            else console.error('Local record initialization failed:', err);
            const panel = document.createElement('main');
            if (nativeCopy) panel.lang = language;
            panel.style.cssText = nativeCopy
                ? 'max-width:34rem;margin:0 auto;padding:12vh 1.5rem 1.5rem;font:16px/1.5 system-ui,sans-serif;'
                : 'max-width:34rem;margin:12vh auto;padding:1.5rem;font:16px/1.5 system-ui,sans-serif;color:#222;';
            const title = document.createElement('h1');
            title.style.cssText = 'font-size:1.25rem;margin:0 0 .75rem;';
            title.textContent = nativeCopy?.['storage.startup_title'] ?? 'Could not open local records';
            const detail = document.createElement('p');
            detail.style.cssText = 'margin:0 0 1rem;';
            detail.textContent =
                nativeCopy?.['storage.startup_detail'] ??
                'Local storage could not be opened or recovered. Your records have not been replaced with empty data. Reload to try again.';
            panel.appendChild(title);
            panel.appendChild(detail);
            if (nativeCopy) {
                const backup = document.createElement('p');
                backup.textContent = nativeCopy['storage.startup_backup'];
                panel.appendChild(backup);
            }
            const reload = document.createElement('button');
            reload.textContent = nativeCopy?.['storage.startup_retry'] ?? 'Reload';
            if (nativeCopy) reload.className = 'btn-primary mt-3 h-auto min-h-11 py-2';
            else reload.style.cssText = 'padding:.5rem 1rem;font:inherit;cursor:pointer;';
            reload.addEventListener('click', () => window.location.reload());
            panel.appendChild(reload);
            container.replaceChildren(panel);
        }
    })();
}
