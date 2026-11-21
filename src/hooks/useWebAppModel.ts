import { useMemo } from 'react';
import { computeCalibration, runSimulation } from '../domain/engine';
import type { SimulationResult } from '../domain/engine';
import { dosesAhead } from '../utils/regimen';
import type { AppModelInput, AppModelState } from './appModelTypes';
import { predictionDoseKey } from '../application/predictionDoseKey';

const retryModel = () => undefined;
/** Preserve the upstream web model and its unrestricted calibration closures. */
export function useWebAppModel(input: AppModelInput): AppModelState {
    const {
        events,
        weightKG,
        birthYear,
        pkParams,
        labs,
        calibrationMethod,
        historyMode,
        regimens,
        withPrediction,
        nowMs,
    } = input;
    const simulation = useMemo<SimulationResult | null>(
        () => (events.length ? runSimulation(events, weightKG, birthYear) : null),
        // Overrides are installed by useAppData for remaining synchronous model consumers.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [events, weightKG, birthYear, pkParams],
    );
    const doses = useMemo(() => {
        if (!withPrediction || !simulation?.timeH.length) return [];
        return dosesAhead(regimens, nowMs / 3_600_000, simulation.timeH[simulation.timeH.length - 1]);
    }, [withPrediction, simulation, regimens, nowMs]);
    const dosesKey = predictionDoseKey(doses);
    const simulationAhead = useMemo<SimulationResult | null>(() => {
        if (!doses.length) return null;
        const fromH = Math.min(...doses.map(e => e.timeH)) - 120 * 24;
        return runSimulation([...events.filter(e => e.timeH >= fromH), ...doses], weightKG, birthYear);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dosesKey, events, weightKG, birthYear, pkParams]);
    const calibration = useMemo(
        () => computeCalibration(simulation, events, weightKG, labs, calibrationMethod, historyMode, birthYear),
        [simulation, events, weightKG, birthYear, labs, calibrationMethod, historyMode],
    );
    return { simulation, simulationAhead, calibration, modelStatus: 'ready', retryModel };
}
