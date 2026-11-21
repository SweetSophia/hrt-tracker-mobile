import type { ForecastProjection, ForecastRequest } from './forecastProjection';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const array = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);
const pair = (v: unknown) => array(v, 2);
function scenario(v: unknown): boolean {
    if (v === null) return true;
    if (!object(v) || !object(v.series) || !Array.isArray(v.series.timeH) || !object(v.stats)) return false;
    const size = v.series.timeH.length;
    if (
        !array(v.series.timeH, size) ||
        !array(v.series.value, size) ||
        !['trough', 'peak', 'average'].every(k => finite((v.stats as Record<string, unknown>)[k])) ||
        (v.stats.inRange !== null && (!finite(v.stats.inRange) || v.stats.inRange < 0 || v.stats.inRange > 1)) ||
        !['statFromH', 'statToH', 'steadyFromH', 'runs'].every(k => finite(v[k])) ||
        !Number.isSafeInteger(v.runs) ||
        (v.runs as number) < 0 ||
        (v.steadyAfterH !== null && !finite(v.steadyAfterH))
    )
        return false;
    if (v.band !== null) {
        if (!object(v.band) || !Array.isArray(v.band.timeH)) return false;
        const n = v.band.timeH.length;
        if (!array(v.band.timeH, n) || !array(v.band.lo, n) || !array(v.band.hi, n)) return false;
    }
    if (
        v.range !== null &&
        (!object(v.range) || !['trough', 'peak', 'average'].every(k => pair((v.range as Record<string, unknown>)[k])))
    )
        return false;
    return true;
}

/** Only complete, clone-safe batches for exactly these plan IDs may reach the UI. */
export function validForecastOutput(value: unknown, request: ForecastRequest): value is ForecastProjection {
    if (!object(value) || !scenario(value.current) || !object(value.results)) return false;
    const ids = Object.keys(value.results);
    return (
        ids.length === request.plans.length &&
        request.plans.every(
            p =>
                Object.hasOwn(value.results as object, p.id) &&
                (p.spec === null
                    ? (value.results as Record<string, unknown>)[p.id] === null
                    : scenario((value.results as Record<string, unknown>)[p.id])),
        )
    );
}
