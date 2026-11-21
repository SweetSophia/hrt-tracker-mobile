export interface ProbeRequest {
    runId: string;
    scenario: 'capabilities' | 'engine' | 'crypto' | 'sqlite-batch' | 'sqlite-key';
    phase: 'prepare' | 'verify' | 'cleanup';
}

export interface ProbeReport extends ProbeRequest {
    outcome: 'pass' | 'fail' | 'ready';
    checks: Record<string, boolean>;
    metricsMs: Record<string, number>;
    versions: Record<string, string>;
    errorCode?: string;
}
