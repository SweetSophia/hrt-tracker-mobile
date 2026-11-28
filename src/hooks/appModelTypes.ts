import type { DemoCompute } from '../application/demoProtocol';
import type { CalibrationHistoryMode, CalibrationMethod, DoseEvent, LabResult, PKCustomParams } from '../domain/engine';
import type { ForecastCompute } from '../application/forecastProjection';
import type { AppModelView } from '../application/appModelView';
import type { RecordScope } from '../records/scope';
import type { Regimen } from '../utils/regimen';

export type AppModelStatus = 'pending' | 'ready' | 'error';
export interface AppModelInput {
    scope: RecordScope;
    events: DoseEvent[];
    weightKG: number;
    birthYear: number | null;
    labs: LabResult[];
    pkParams: PKCustomParams | null;
    calibrationMethod: CalibrationMethod;
    historyMode: CalibrationHistoryMode;
    regimens: Regimen[];
    withPrediction: boolean;
    nowMs: number;
}
export interface AppModelState extends AppModelView {
    modelStatus: AppModelStatus;
    /** Completed worker view for reports when only the screen projection is updating. */
    reportModel?: AppModelView;
    retryModel(): void;
    runForecast?: ForecastCompute;
    runDemo?: DemoCompute;
}
