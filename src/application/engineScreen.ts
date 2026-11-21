import { runSimulation } from '../domain/engine';
import type { CalibrationResult, SimulationResult } from '../domain/engine';
import { dosesAhead } from '../utils/regimen';
import type { EngineInput, EngineScreenOutput } from './engineProtocol';
import { screenSampleTimes } from './engineScreenSamples';
import { predictionDoseKey } from './predictionDoseKey';

export interface EngineScreenCache {
    prediction?: { key: string; simulation: SimulationResult | null };
}

/** Caller owns the active PK parameters and baseline clock for this worker turn. */
export function projectEngineScreen(
    input: EngineInput,
    simulation: SimulationResult | null,
    calibration: CalibrationResult,
    cache?: EngineScreenCache,
): EngineScreenOutput {
    if (typeof document !== 'undefined') throw new Error('Model tasks require a worker.');
    const screen = input.screen;
    if (!screen) throw new Error('Invalid model screen.');
    let simulationAhead: SimulationResult | null = null;
    if (screen.regimens && simulation?.timeH.length) {
        const doses = dosesAhead(
            screen.regimens,
            screen.nowMs / 3_600_000,
            simulation.timeH[simulation.timeH.length - 1],
        );
        if (doses.length) {
            const dosesKey = predictionDoseKey(doses);
            const key = JSON.stringify([
                input.events,
                input.weightKG,
                input.birthYear,
                input.pkParams,
                input.nowMs,
                dosesKey,
            ]);
            if (cache?.prediction?.key === key) simulationAhead = cache.prediction.simulation;
            else {
                const fromH = Math.min(...doses.map(e => e.timeH)) - 120 * 24;
                const clock = Date.now;
                try {
                    Date.now = () => screen.nowMs;
                    simulationAhead = runSimulation(
                        [...input.events.filter(e => e.timeH >= fromH), ...doses],
                        input.weightKG,
                        input.birthYear,
                    );
                } finally {
                    Date.now = clock;
                }
                if (cache) cache.prediction = { key, simulation: simulationAhead };
            }
        } else if (cache) cache.prediction = undefined;
    } else if (cache) cache.prediction = undefined;
    const sampleTimesH = screenSampleTimes(input, simulation, simulationAhead);
    return {
        nowMs: screen.nowMs,
        simulationAhead,
        sampleTimesH,
        factors: sampleTimesH.map(calibration.factorFn),
        factorSDs: calibration.factorSdFn ? sampleTimesH.map(calibration.factorSdFn) : null,
    };
}
