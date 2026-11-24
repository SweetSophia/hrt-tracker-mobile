export interface AndroidUpdateState {
    revision: number;
    installedVersion: string;
    automatic: boolean;
    availableVersion: string | null;
    dismissedVersion: string | null;
}

export interface AndroidCheckResult {
    outcome: 'skipped' | 'checked' | 'noRelease';
    state: AndroidUpdateState;
}

export interface AndroidUpdatePort {
    getState(): Promise<AndroidUpdateState>;
    setAutomatic(enabled: boolean): Promise<AndroidUpdateState>;
    checkNow(): Promise<AndroidCheckResult>;
    checkOnOpen(): Promise<AndroidCheckResult>;
    dismiss(version: string): Promise<AndroidUpdateState>;
    openRelease(version: string): Promise<void>;
    listenForForeground(listener: () => void): () => void;
}
