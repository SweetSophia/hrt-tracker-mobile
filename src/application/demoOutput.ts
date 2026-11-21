import type { DemoOutput, DemoRequest } from './demoProtocol';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const array = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(finite);
const numbers = (v: Record<string, unknown>, keys: string[]) => keys.every(k => finite(v[k]));
const points = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every(p => object(p) && numbers(p, ['x', 'y']));
const path = (v: unknown) => {
    if (typeof v !== 'string') return false;
    const parts = v.match(/[ML][^ML]+/g);
    return (
        !!parts &&
        parts.length === 225 &&
        parts.join('') === v &&
        parts.every(
            (p, i) =>
                p[0] === (i === 0 ? 'M' : 'L') &&
                /^[ML]-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(p) &&
                p
                    .slice(1)
                    .split(' ')
                    .every(n => Number.isFinite(Number(n))),
        )
    );
};
const steps = ['dose', 'vd', 'f', 'params', 'conversion', 'peak', 'thresholds'];
/** Accept only a complete rendered projection for the matching task variant. */
export function validDemoOutput(output: unknown, request: DemoRequest): output is DemoOutput {
    if (!object(output) || output.kind !== request.kind) return false;
    const v = output.value;
    if (v === null) return request.kind === 'onboarding' || request.kind === 'calibration-guide';
    if (!object(v)) return false;
    switch (request.kind) {
        case 'onboarding':
            return (
                v.unit === (request.isTransmasc ? 'ng/dL' : 'pg/mL') &&
                array(v.doseX, 8) &&
                path(v.modelD) &&
                path(v.calD) &&
                points(v.labs, 2)
            );
        case 'model-guide': {
            const s = v.single,
                r = v.repeated,
                c = v.calibrated;
            return (
                object(s) &&
                array(s.values, 240) &&
                numbers(s, ['peak', 'peakH']) &&
                object(r) &&
                array(r.values, 240) &&
                numbers(r, ['spanH', 'count', 'lo', 'hi', 'mean']) &&
                Number.isSafeInteger(r.count) &&
                Number(r.count) > 0 &&
                (c === null ||
                    (object(c) && array(c.values, 240) && numbers(c, ['obs', 'scale', 'labX', 'yMax', 'spanH'])))
            );
        }
        case 'calibration-guide':
            return (
                Array.isArray(v.series) &&
                v.series.length === 4 &&
                v.series.every(
                    s =>
                        object(s) &&
                        array(s.values, 280) &&
                        (s.ghost === undefined || typeof s.ghost === 'boolean') &&
                        (s.edge === undefined || typeof s.edge === 'boolean') &&
                        (s.fillTo === undefined ||
                            (Number.isSafeInteger(s.fillTo) && Number(s.fillTo) >= 0 && Number(s.fillTo) < 4)),
                ) &&
                points(v.labs, request.inputs.count) &&
                array(v.doses, 12) &&
                numbers(v, ['atLab', 'halfLife']) &&
                (v.fit === null || finite(v.fit))
            );
        case 'sandbox':
            return (
                object(v.peak) &&
                numbers(v.peak, ['value', 'timeH']) &&
                (v.timeBelow200H === null || finite(v.timeBelow200H)) &&
                (v.timeBelow100H === null || finite(v.timeBelow100H)) &&
                Array.isArray(v.derivation) &&
                v.derivation.length === steps.length &&
                new Set(v.derivation.map(d => (object(d) ? d.key : null))).size === steps.length &&
                v.derivation.every(
                    d =>
                        object(d) &&
                        typeof d.key === 'string' &&
                        steps.includes(d.key) &&
                        typeof d.title === 'string' &&
                        typeof d.formula === 'string' &&
                        (d.result === undefined || typeof d.result === 'string') &&
                        Array.isArray(d.tex) &&
                        d.tex.length > 0 &&
                        d.tex.every(t => typeof t === 'string'),
                )
            );
    }
}
