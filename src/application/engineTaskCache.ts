import { computeCalibration, runSimulation } from '../domain/engine';
import type { CalibrationResult, SimulationResult } from '../domain/engine';
import type { EngineInput } from './engineProtocol';
import type { EngineScreenCache } from './engineScreen';

/** One worker's current fit; never persisted or shared across scope termination. */
export class EngineTaskCache {
    private baseline?: { key: string; simulation: SimulationResult | null };
    private fit?: { key: string; calibration: CalibrationResult };
    readonly screen: EngineScreenCache = {};

    /** Caller owns the serialized parameter/clock scope for calculation and evaluation. */
    prepare(input: EngineInput) {
        if (typeof document !== 'undefined') throw new Error('Model tasks require a worker.');
        const key = JSON.stringify([input.events, input.weightKG, input.birthYear, input.pkParams, input.nowMs]);
        if (this.baseline?.key !== key) {
            const simulation = runSimulation(input.events, input.weightKG, input.birthYear);
            this.baseline = { key, simulation };
            this.fit = undefined;
        }
        const fitKey = JSON.stringify([key, input.labs, input.calibrationMethod, input.historyMode]);
        if (this.fit?.key !== fitKey) {
            const calibration = computeCalibration(
                this.baseline.simulation,
                input.events,
                input.weightKG,
                input.labs,
                input.calibrationMethod,
                input.historyMode,
                input.birthYear,
            );
            this.fit = { key: fitKey, calibration };
        }
        return { simulation: this.baseline.simulation, calibration: this.fit.calibration };
    }
}
