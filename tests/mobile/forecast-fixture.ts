import { DEFAULT_PK_PARAMS, Ester, Route } from '../../src/domain/engine';
import { detectRegimens } from '../../src/utils/regimen';
import type { ForecastTaskInput } from '../../src/application/engineProtocol';
import { NOW_H } from '../../mobile/probe/reference';

export const forecastTaskInput = (masc = false): ForecastTaskInput => {
    const events = [6, 30, 54].map((age, i) => ({
        id: `synthetic-forecast-${i}`,
        route: masc ? Route.injection : Route.oral,
        ester: masc ? Ester.TE : Ester.E2,
        doseMG: masc ? 50 : 2,
        timeH: NOW_H - age,
        extras: {},
    }));
    return {
        nowMs: NOW_H * 3_600_000,
        request: {
            input: {
                events,
                weight: 70,
                birthYear: null,
                labResults: [],
                calibrationMethod: 'off',
                calibrationHistoryMode: 'forward',
                isTransmasc: masc,
                nowH: NOW_H,
                horizonH: 2 * 7 * 24,
                target: masc ? { low: 300, high: 1000 } : { low: 100, high: 200 },
                fitErrPct: null,
            },
            regimens: detectRegimens(events, NOW_H),
            pkParams: { ...DEFAULT_PK_PARAMS, e2_oral_bio: 0.08 },
            plans: [
                {
                    id: 'synthetic-a',
                    spec: {
                        route: masc ? Route.injection : Route.oral,
                        ester: masc ? Ester.TE : Ester.E2,
                        doseMG: masc ? 50 : 2,
                        intervalH: 24,
                        startH: NOW_H + 6,
                        replace: true,
                        extras: {},
                    },
                },
                { id: 'synthetic-empty', spec: null },
            ],
        },
    };
};
