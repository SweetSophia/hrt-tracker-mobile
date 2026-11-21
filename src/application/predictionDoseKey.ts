import type { DoseEvent } from '../domain/engine';

/** Include every PK extra; identifiers and other record metadata do not affect a curve. */
export function predictionDoseKey(doses: DoseEvent[]): string {
    return JSON.stringify(
        doses.map(({ route, ester, doseMG, timeH, extras }) => [
            route,
            ester,
            doseMG,
            timeH,
            Object.entries(extras).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ]),
    );
}
