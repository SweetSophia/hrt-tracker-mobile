import type { PKCustomParams } from '../domain/engine';
import type { CurveData } from './demos/onboarding';
import type { ModelGuideRequest, ModelGuideProjection } from './demos/modelGuide';
import type { CalibrationGuideRequest, CalibrationGuideProjection } from './demos/calibrationGuide';
import type { SandboxRequest, SandboxProjection } from './demos/sandbox';
export type DemoRequest =
    | { kind: 'onboarding'; isTransmasc: boolean; anchorMs: number }
    | ModelGuideRequest
    | CalibrationGuideRequest
    | SandboxRequest;
export interface DemoTaskInput {
    request: DemoRequest;
    nowMs: number;
    pkParams: PKCustomParams | null;
}
export interface DemoValueMap {
    onboarding: CurveData | null;
    'model-guide': ModelGuideProjection;
    'calibration-guide': CalibrationGuideProjection;
    sandbox: SandboxProjection;
}
export type DemoKind = keyof DemoValueMap;
export type DemoOutput = { [K in DemoKind]: { kind: K; value: DemoValueMap[K] } }[DemoKind];
export type DemoCompute = (request: DemoRequest, options?: { signal?: AbortSignal }) => Promise<DemoOutput>;
