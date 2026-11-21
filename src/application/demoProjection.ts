import { applyPKOverrides, getActivePKParams } from '../domain/engine';
import type { DemoTaskInput, DemoOutput } from './demoProtocol';
import { projectOnboarding } from './demos/onboarding';
import { projectModelGuide } from './demos/modelGuide';
import { projectCalibrationGuide } from './demos/calibrationGuide';
import { projectSandbox } from './demos/sandbox';
import { clock, DemoProjectionCache } from './demos/cache';
export { DemoProjectionCache } from './demos/cache';
/** The existing web calculations, evaluated under one captured profile/clock. */
export function projectDemo(input: DemoTaskInput, cache = new DemoProjectionCache()): DemoOutput {
    const before = getActivePKParams();
    return clock(input.nowMs, () => {
        try {
            applyPKOverrides(input.pkParams);
            const r = input.request,
                profileKey = JSON.stringify(input.pkParams);
            switch (r.kind) {
                case 'onboarding':
                    return { kind: r.kind, value: clock(r.anchorMs, () => projectOnboarding(r.isTransmasc)) };
                case 'model-guide':
                    return { kind: r.kind, value: projectModelGuide(r, cache, profileKey) };
                case 'calibration-guide':
                    return { kind: r.kind, value: projectCalibrationGuide(r, cache, profileKey) };
                case 'sandbox':
                    return { kind: r.kind, value: projectSandbox(r) };
            }
        } finally {
            applyPKOverrides(before);
        }
    });
}
