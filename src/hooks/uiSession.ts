import type { NavigationSession, ViewKey } from './useAppNavigation';

export type EncryptedExport = { readonly status: 'saving' } | { readonly status: 'saved'; readonly password: string };

/** The current export lives in memory until this screen or the offline app closes. */
export class EncryptedExportSession {
    private result: EncryptedExport | undefined;
    private listeners = new Set<() => void>();

    getSnapshot = () => this.result;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    replace(expected: EncryptedExport | undefined, result?: EncryptedExport) {
        if (this.result !== expected) return false;
        this.result = result;
        for (const listener of this.listeners) listener();
        return true;
    }
}

/** In-memory UI state retained across screen and record-boundary remounts. */
export class UiSession {
    readonly offlineExport = new EncryptedExportSession();
    private navigation: NavigationSession | null = null;
    private onboardingStep = 0;
    private afterSignIn: ViewKey | null = null;
    getNavigation() {
        return this.navigation;
    }
    setNavigation(value: NavigationSession) {
        this.navigation = value;
    }
    getOnboardingStep() {
        return this.onboardingStep;
    }
    setOnboardingStep(value: number) {
        this.onboardingStep = value;
    }
    getAfterSignIn() {
        return this.afterSignIn;
    }
    setAfterSignIn(value: ViewKey | null) {
        this.afterSignIn = value;
    }
}
