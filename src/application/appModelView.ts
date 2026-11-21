import type { CalibrationResult, SimulationResult } from '../domain/engine';
import type { EngineOutput } from './engineProtocol';

export interface AppModelView {
    simulation: SimulationResult | null;
    simulationAhead: SimulationResult | null;
    calibration: CalibrationResult;
    /** Set only for the finite mobile factor view; the web chart keeps its clock. */
    modelNowMs?: number;
}

/** Screen-only view: unsupported times fail instead of approximating a calibration factor. */
export function screenModelView(output: EngineOutput): AppModelView {
    const screen = output.screen;
    const invalid = () => new Error('Invalid model screen.');
    if (
        !screen ||
        !Number.isSafeInteger(screen.nowMs) ||
        screen.nowMs <= 0 ||
        screen.sampleTimesH.length !== screen.factors.length ||
        (screen.factorSDs !== null && screen.factorSDs.length !== screen.sampleTimesH.length)
    )
        throw invalid();
    const factors = new Map<number, number>();
    const deviations = new Map<number, number>();
    for (let i = 0; i < screen.sampleTimesH.length; i++) {
        const time = screen.sampleTimesH[i];
        const factor = screen.factors[i];
        if (!Number.isFinite(time) || !Number.isFinite(factor) || factors.has(time)) throw invalid();
        factors.set(time, factor);
        if (screen.factorSDs) {
            if (!Number.isFinite(screen.factorSDs[i])) throw invalid();
            deviations.set(time, screen.factorSDs[i]);
        }
    }
    if (!factors.has(screen.nowMs / 3_600_000) || output.calibration.points.some(p => !factors.has(p.timeH)))
        throw invalid();
    const at = (values: Map<number, number>) => (timeH: number) => {
        const value = values.get(timeH);
        if (value === undefined) throw new Error('Model sample unavailable.');
        return value;
    };
    return {
        simulation: output.simulation,
        simulationAhead: screen.simulationAhead,
        modelNowMs: screen.nowMs,
        calibration: {
            ...output.calibration,
            factorFn: at(factors),
            ...(screen.factorSDs ? { factorSdFn: at(deviations) } : {}),
        },
    };
}
