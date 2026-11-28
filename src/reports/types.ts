import type { DoseEvent, HRTMode, LabResult, SimulationResult } from '../../logic';

export type ReportHormone = 'E2' | 'T';
export interface ReportRecords {
    events: readonly DoseEvent[];
    labResults: readonly LabResult[];
}
export interface ReportSelection {
    range: '30' | '90' | 'all' | 'custom';
    from: string;
    to: string;
    hormones: readonly ReportHormone[];
    /** null includes every medication, including ones added while the options are open. */
    medications: readonly string[] | null;
    bothModes: boolean;
    measuredGraph: boolean;
    estimatedGraph: boolean;
}
export interface ReportChart {
    kind: 'measured' | 'estimated';
    hormone: ReportHormone;
    unit: 'pg/mL' | 'ng/dL';
    points: { timeH: number; value: number }[];
}
export interface ReportEstimateSource {
    mode: HRTMode;
    events: readonly DoseEvent[];
    simulation: SimulationResult;
    calibrationFn: (timeH: number) => number;
    nowH: number;
}
export interface PreparedReport {
    events: DoseEvent[];
    labResults: LabResult[];
    selection: ReportSelection;
    /** Inclusive local calendar dates, or null for an unrestricted bound. */
    from: string | null;
    to: string | null;
    invalidRange: boolean;
    charts: (ReportChart & { domain: [number, number] })[];
}
