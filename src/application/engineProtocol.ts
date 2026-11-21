import type {
    CalibrationHistoryMode,
    CalibrationMethod,
    CalibrationResult,
    DoseEvent,
    LabResult,
    PKCustomParams,
    SimulationResult,
} from '../domain/engine';
import type { Regimen } from '../utils/regimen';

export interface EngineScreenRequest {
    /** Readout clock; distinct from the memoized baseline simulation clock. */
    nowMs: number;
    /** null disables prediction; an empty array means no detected regimen. */
    regimens: Regimen[] | null;
}
export interface EngineScreenOutput {
    nowMs: number;
    simulationAhead: SimulationResult | null;
    sampleTimesH: number[];
    factors: number[];
    factorSDs: number[] | null;
}

export interface EngineInput {
    events: DoseEvent[];
    weightKG: number;
    birthYear: number | null;
    pkParams: PKCustomParams | null;
    labs: LabResult[];
    calibrationMethod: CalibrationMethod;
    historyMode: CalibrationHistoryMode;
    nowMs: number;
    sampleTimesH: number[];
    screen?: EngineScreenRequest;
}
export interface EngineOutput {
    simulation: SimulationResult | null;
    calibration: Omit<CalibrationResult, 'factorFn' | 'factorSdFn'>;
    sampleTimesH: number[];
    factors: number[];
    factorSDs: number[] | null;
    screen?: EngineScreenOutput;
}
export type EngineRequest = { version: 1; kind: 'calculate'; id: number; input: EngineInput };
export type EngineResponse =
    | { version: 1; kind: 'started'; id: number }
    | { version: 1; kind: 'result'; id: number; output: EngineOutput }
    | { version: 1; kind: 'error'; id: number };

/** Additive task kinds preserve the calculate-only foundation aliases above. */
export interface ForecastTaskInput {
    request: import('./forecastProjection').ForecastRequest;
    nowMs: number;
}
export type ForecastEngineRequest = { version: 1; kind: 'forecast'; id: number; input: ForecastTaskInput };
export type ForecastEngineResponse = {
    version: 1;
    kind: 'forecast-result';
    id: number;
    output: import('./forecastProjection').ForecastProjection;
};
export type DemoEngineRequest = { version: 1; kind: 'demo'; id: number; input: import('./demoProtocol').DemoTaskInput };
export type DemoEngineResponse = {
    version: 1;
    kind: 'demo-result';
    id: number;
    output: import('./demoProtocol').DemoOutput;
};
export type EngineWorkerRequest = EngineRequest | ForecastEngineRequest | DemoEngineRequest;
export type EngineWorkerResponse = EngineResponse | ForecastEngineResponse | DemoEngineResponse;
