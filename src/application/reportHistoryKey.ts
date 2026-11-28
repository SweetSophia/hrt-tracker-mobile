import { Route } from '../domain/types';
import type { EngineInput } from './engineProtocol';
import { doseModelFields } from './predictionDoseKey';

type ReportHistory = Pick<
    EngineInput,
    'events' | 'labs' | 'weightKG' | 'birthYear' | 'pkParams' | 'calibrationMethod' | 'historyMode'
>;

/** Inputs that can change the PDF's curve. The screens still require their exact worker request. */
export function reportHistoryKey({
    events,
    labs,
    weightKG,
    birthYear,
    pkParams,
    calibrationMethod,
    historyMode,
}: ReportHistory): string {
    return JSON.stringify([
        weightKG,
        birthYear,
        pkParams,
        calibrationMethod,
        historyMode,
        events.map(event => [
            ...doseModelFields(event),
            // Recorded removals can identify a particular application.
            event.route === Route.patchApply ? event.id : null,
            event.route === Route.patchRemove ? event.patchApplicationId : null,
        ]),
        labs.map(({ timeH, concValue, unit, assay }) => [timeH, concValue, unit, assay]),
    ]);
}
