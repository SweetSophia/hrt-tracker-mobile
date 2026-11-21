import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import { cappedMcmcInput } from '../../mobile/storageQualification/longHistoryFixture';
import { packEngineOutput, unpackEngineOutput } from '../../mobile/storageQualification/transferableEngineOutput';
import { executeEngineTask } from '../../src/application/engineTask';

const nowMs = 1_800_000_000_000;

it('transfers the real capped calculation and reconstructs exact numeric tables', () => {
    const input = cappedMcmcInput(nowMs);
    const output = executeEngineTask({ ...input, screen: { nowMs, regimens: [] } });
    expect(output.simulation!.timeH.length).toBeGreaterThanOrEqual(100_000);
    const { wire, transfer } = packEngineOutput(output);
    const expectedBytes = transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    expect(expectedBytes).toBeGreaterThan(800_000);
    const cloned = structuredClone(wire, { transfer });
    expect(transfer.every(buffer => buffer.byteLength === 0)).toBe(true);
    const restored = unpackEngineOutput(cloned);
    expect(restored.transferredBytes).toBe(expectedBytes);
    assert.deepStrictEqual(restored.output, output);
    assert.equal(JSON.stringify(restored.output), JSON.stringify(output));
}, 15_000);

const short = () => executeEngineTask({ ...cappedMcmcInput(nowMs), events: [], labs: [], sampleTimesH: [] });

it('preserves optional shapes, column aliases and signed zero', () => {
    const output = short();
    const aliased = [-0, 1 + Number.EPSILON];
    output.sampleTimesH = output.factors = aliased;
    output.simulation = {
        timeH: aliased,
        concPGmL: aliased,
        concPGmL_E2: aliased,
        concPGmL_CPA: [0, 0],
        concPGmL_BICA: [0, 0],
        concNGdL_T: [0, 0],
        shbgNM: aliased,
        auc: -0,
    };
    output.screen = {
        nowMs,
        simulationAhead: output.simulation,
        sampleTimesH: aliased,
        factors: [1, 1],
        factorSDs: aliased,
    };
    const { wire, transfer } = packEngineOutput(output);
    const { output: restored } = unpackEngineOutput(structuredClone(wire, { transfer }));
    assert.deepStrictEqual(restored, output);
    expect(restored.sampleTimesH).toBe(restored.simulation!.timeH);
    expect(restored.screen!.simulationAhead!.shbgNM).toBe(restored.screen!.factorSDs);
    expect(Object.is(restored.factors[0], -0)).toBe(true);
    expect(restored.factorSDs).toBeNull();
    const absent = short();
    const packed = packEngineOutput(absent);
    const restoredAbsent = unpackEngineOutput(structuredClone(packed.wire, { transfer: packed.transfer })).output;
    assert.deepStrictEqual(restoredAbsent, absent);
    expect(Object.hasOwn(restoredAbsent, 'screen')).toBe(false);
});

it.each(['plain array', 'sliced view', 'detached view'] as const)('rejects a %s in a transferred column', kind => {
    const pack = packEngineOutput({ ...short(), factors: [1, 2] });
    const { wire, transfer } = pack;
    if (kind === 'detached view') {
        structuredClone(wire, { transfer });
        expect(() => unpackEngineOutput(wire)).toThrow();
    } else {
        const factors = kind === 'plain array' ? [1, 2] : new Float64Array(4).subarray(1, 3);
        expect(() => unpackEngineOutput({ ...wire, factors })).toThrow();
    }
});
