import {
    applyPKOverrides,
    computeCalibration,
    getActivePKParams,
    isPlausibleBirthYear,
    isPlausibleBodyWeightKG,
    runSimulation,
} from '../domain/engine';
import type { EngineInput, EngineOutput } from './engineProtocol';
import { projectEngineScreen } from './engineScreen';
import type { EngineTaskCache } from './engineTaskCache';

/** Entire synchronous operation belongs to one worker turn, including closure evaluation. */
export function executeEngineTask(input: EngineInput, cache?: EngineTaskCache): EngineOutput {
    if (typeof document !== 'undefined') throw new Error('Model tasks require a worker.');
    if (
        !input ||
        !Array.isArray(input.events) ||
        !Array.isArray(input.labs) ||
        !Number.isSafeInteger(input.nowMs) ||
        input.nowMs <= 0 ||
        !isPlausibleBodyWeightKG(input.weightKG) ||
        (input.birthYear !== null && !isPlausibleBirthYear(input.birthYear)) ||
        !Array.isArray(input.sampleTimesH) ||
        input.sampleTimesH.some(t => typeof t !== 'number' || !Number.isFinite(t)) ||
        !['off', 'ekf', 'ou_kalman', 'mipd', 'bayes', 'mcmc'].includes(input.calibrationMethod) ||
        !['forward', 'retrospective'].includes(input.historyMode) ||
        (input.pkParams !== null && (typeof input.pkParams !== 'object' || Array.isArray(input.pkParams))) ||
        (input.screen !== undefined &&
            (!input.screen ||
                !Number.isSafeInteger(input.screen.nowMs) ||
                input.screen.nowMs <= 0 ||
                (input.screen.regimens !== null && !Array.isArray(input.screen.regimens))))
    )
        throw new Error('Invalid model task.');
    const originalParams = getActivePKParams();
    const originalClock = Date.now;
    try {
        Date.now = () => input.nowMs;
        applyPKOverrides(input.pkParams);
        const prepared = input.screen && cache ? cache.prepare(input) : null;
        const simulation = prepared
            ? prepared.simulation
            : runSimulation(input.events, input.weightKG, input.birthYear);
        const fitted = prepared
            ? prepared.calibration
            : computeCalibration(
                  simulation,
                  input.events,
                  input.weightKG,
                  input.labs,
                  input.calibrationMethod,
                  input.historyMode,
                  input.birthYear,
              );
        const { factorFn, factorSdFn, ...calibration } = fitted;
        return {
            simulation,
            calibration,
            sampleTimesH: [...input.sampleTimesH],
            factors: input.sampleTimesH.map(factorFn),
            factorSDs: factorSdFn ? input.sampleTimesH.map(factorSdFn) : null,
            ...(input.screen ? { screen: projectEngineScreen(input, simulation, fitted, cache?.screen) } : {}),
        };
    } catch {
        throw new Error('Model computation failed.');
    } finally {
        applyPKOverrides(originalParams);
        Date.now = originalClock;
    }
}
