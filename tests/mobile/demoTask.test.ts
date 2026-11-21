import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import golden from './fixtures/demo-baseline.json';
import { executeDemoTask } from '../../src/application/demoTask';
import { DemoProjectionCache } from '../../src/application/demoProjection';
import { validDemoOutput } from '../../src/application/demoOutput';
import type { DemoTaskInput } from '../../src/application/demoProtocol';
import * as engine from '../../src/domain/engine';

const task = (name = 'intro-false-false') =>
    structuredClone(golden.cases.find(c => c.name === name)!.task) as DemoTaskInput;
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    engine.applyPKOverrides(null);
});
// The source commit pins the inputs. The model commit records the reviewed
// upstream engine that produced the digests and sampled readouts.
it.each(golden.cases)('$name matches the complete rendered projection', fixture => {
    const input = structuredClone(fixture.task) as DemoTaskInput;
    const result = executeDemoTask(input, new DemoProjectionCache());
    expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe(fixture.sha256);
    expect(result.value).toMatchObject(fixture.readout);
    expect(structuredClone(result)).toStrictEqual(result);
    expect(validDemoOutput(result, input.request)).toBe(true);
});
it('restores the captured profile and clock after a private numerical failure', () => {
    const input = task('sandbox-custom-injection:EV');
    engine.applyPKOverrides({ ...engine.DEFAULT_PK_PARAMS, e2_oral_bio: 0.06 });
    const before = engine.getActivePKParams();
    const clock = Date.now;
    vi.spyOn(engine, 'computePkSandbox').mockImplementationOnce(() => {
        expect(Date.now()).toBe(input.nowMs);
        expect(engine.getActivePKParams().e2_oral_bio).toBe(0.08);
        throw new Error('synthetic private record');
    });
    expect(() => executeDemoTask(input)).toThrow('Model computation failed.');
    expect(Date.now).toBe(clock);
    expect(engine.getActivePKParams()).toEqual(before);
});
it('rejects invalid clocks and unsafe task variants before numerical work', () => {
    const inputs: unknown[] = [
        { ...task(), nowMs: NaN },
        { ...task(), pkParams: [] },
        { ...task(), request: { kind: 'unknown' } },
        { ...task('model-false-injection'), request: { ...task('model-false-injection').request, everyH: 0 } },
        { ...task('cal-mcmc'), request: { ...task('cal-mcmc').request, inputs: { method: 'mcmc', count: 0 } } },
        { ...task(), request: { kind: 'sandbox', modelId: 'unknown', inputs: {} } },
    ];
    for (const input of inputs) expect(() => executeDemoTask(input as DemoTaskInput)).toThrow('Invalid demo task.');
    vi.stubGlobal('document', {});
    expect(() => executeDemoTask(task())).toThrow('Model tasks require a worker.');
});
it('rejects wrong variants, incomplete sample arrays and nonfinite rendered metadata', () => {
    for (const name of ['intro-false-false', 'model-false-injection', 'cal-mcmc', 'sandbox-oral:E2']) {
        const input = task(name);
        const output = executeDemoTask(input);
        expect(validDemoOutput({ ...output, kind: 'unknown' }, input.request)).toBe(false);
        const malformed = structuredClone(output);
        if (malformed.kind === 'onboarding') malformed.value!.modelD = 7 as unknown as string;
        if (malformed.kind === 'model-guide') malformed.value.single.values.pop();
        if (malformed.kind === 'calibration-guide') malformed.value!.atLab = Infinity;
        if (malformed.kind === 'sandbox') malformed.value.derivation[0].tex = [7 as unknown as string];
        expect(validDemoOutput(malformed, input.request)).toBe(false);
    }
});
it('keeps source anchor samples across later clocks and profile-sensitive cache entries', () => {
    const cache = new DemoProjectionCache();
    for (const name of ['model-false-injection', 'cal-mcmc']) {
        const input = task(name);
        const first = executeDemoTask(input, cache);
        expect(executeDemoTask({ ...input, nowMs: input.nowMs + 1000 }, cache)).toEqual(first);
        const changed = { ...input, pkParams: { ...engine.DEFAULT_PK_PARAMS, e2_kClearInj: 0.02 } };
        expect(executeDemoTask(changed, cache)).not.toEqual(first);
    }
});
it('rejects missing or duplicated sandbox derivation steps', () => {
    const input = task('sandbox-oral:E2');
    for (const duplicate of [false, true]) {
        const out = executeDemoTask(input);
        if (out.kind !== 'sandbox') throw new Error('wrong test fixture');
        if (duplicate) out.value.derivation[1].key = out.value.derivation[0].key;
        else out.value.derivation.pop();
        expect(validDemoOutput(out, input.request)).toBe(false);
    }
});
it('rejects an onboarding path with invalid coordinate pairs', () => {
    const input = task();
    const out = executeDemoTask(input);
    if (out.kind !== 'onboarding' || !out.value) throw new Error('wrong test fixture');
    out.value.modelD = 'M0 0' + 'Lbad '.repeat(224);
    expect(validDemoOutput(out, input.request)).toBe(false);
});
it('accepts the real sandbox default objects without JSON dropping their optional undefined fields', () => {
    for (const model of engine.PK_SANDBOX_MODELS) {
        const input: DemoTaskInput = {
            nowMs: 1736899061500,
            pkParams: null,
            request: { kind: 'sandbox', modelId: model.id, inputs: structuredClone(model.defaultInputs) },
        };
        const actual = executeDemoTask(input);
        expect(actual.kind).toBe('sandbox');
        const baseline = golden.cases.find(f => f.name === 'sandbox-' + model.id)!;
        expect(createHash('sha256').update(JSON.stringify(actual)).digest('hex')).toBe(baseline.sha256);
        expect(validDemoOutput(actual, input.request)).toBe(true);
        expect(structuredClone(actual)).toStrictEqual(actual);
    }
});
