export interface AndroidUpdateState {
    installedVersion: string;
    automatic: boolean;
    availableVersion: string | null;
    dismissedVersion: string | null;
}

export interface AndroidUpdatePort {
    getState(): Promise<AndroidUpdateState>;
    setAutomatic(enabled: boolean): Promise<AndroidUpdateState>;
    checkNow(): Promise<AndroidUpdateState>;
    checkOnOpen(): Promise<AndroidUpdateState>;
    dismiss(version: string): Promise<AndroidUpdateState>;
    openRelease(version: string): Promise<void>;
    listenForForeground(listener: () => void): () => void;
}
