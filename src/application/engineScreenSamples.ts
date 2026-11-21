import type { SimulationResult } from '../domain/engine';
import type { EngineInput } from './engineProtocol';

/** Every exact time queried by shared-model screen consumers, in deterministic order. */
export function screenSampleTimes(
    input: EngineInput,
    simulation: SimulationResult | null,
    ahead: SimulationResult | null,
): number[] {
    if (!input.screen) throw new Error('Invalid model screen.');
    return [
        ...new Set([
            ...input.sampleTimesH,
            ...(simulation?.timeH ?? []),
            ...(ahead?.timeH ?? []),
            ...input.events.map(event => event.timeH),
            ...input.labs.map(lab => lab.timeH),
            input.screen.nowMs / 3_600_000,
        ]),
    ];
}
