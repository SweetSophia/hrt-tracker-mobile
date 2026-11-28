import type { DoseEvent } from '../domain/engine';

export function doseModelFields({ route, ester, doseMG, timeH, extras }: DoseEvent) {
    return [route, ester, doseMG, timeH, Object.entries(extras ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))];
}

/** Include every PK extra for generated prediction doses. */
export function predictionDoseKey(doses: DoseEvent[]): string {
    return JSON.stringify(doses.map(doseModelFields));
}
