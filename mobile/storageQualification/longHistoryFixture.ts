import type { EngineInput } from '../../src/application/engineProtocol';
import { Ester, Route } from '../../src/domain/engine';
import { mcmcInput } from './engineWorker';

/** Synthetic setup only; construct before opening the measured admission window. */
export function cappedMcmcInput(nowMs: number): EngineInput {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('Invalid fixture clock.');
    const source = mcmcInput();
    const delta = (nowMs - source.nowMs) / 3_600_000;
    return {
        ...source,
        nowMs,
        sampleTimesH: source.sampleTimesH.map(time => time + delta),
        events: [
            ...source.events.map(event => ({ ...event, timeH: event.timeH + delta })),
            {
                id: 'synthetic-long-history-anchor',
                route: Route.injection,
                ester: Ester.EV,
                doseMG: 4,
                timeH: nowMs / 3_600_000 - 110_000,
                extras: {},
            },
        ],
        labs: source.labs.map(lab => ({ ...lab, timeH: lab.timeH + delta })),
    };
}
