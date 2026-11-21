import { expect, it } from 'vitest';
import { cappedMcmcInput } from '../../mobile/storageQualification/longHistoryFixture';
import { mcmcInput } from '../../mobile/storageQualification/engineWorker';
import { getActivePKParams } from '../../src/domain/engine';
const NOW = 1_800_000_000_000;
it('retains the existing mixed-route calibration fixture and adds one capped-grid anchor', () => {
    const source = mcmcInput(),
        before = getActivePKParams(),
        clock = Date.now;
    const input = cappedMcmcInput(NOW);
    expect(input.events).toHaveLength(43);
    expect(input.labs).toHaveLength(6);
    expect(input.calibrationMethod).toBe('mcmc');
    expect(input.nowMs).toBe(NOW);
    expect(input.sampleTimesH).toEqual([NOW / 3_600_000]);
    const delta = (NOW - source.nowMs) / 3_600_000;
    for (let i = 0; i < source.events.length; i++)
        expect(input.events[i]).toEqual({ ...source.events[i], timeH: source.events[i].timeH + delta });
    for (let i = 0; i < source.labs.length; i++)
        expect(input.labs[i]).toEqual({ ...source.labs[i], timeH: source.labs[i].timeH + delta });
    expect(input.events.at(-1)?.id).toBe('synthetic-long-history-anchor');
    expect(input.events.at(-1)?.timeH).toBe(NOW / 3_600_000 - 110_000);
    expect(getActivePKParams()).toEqual(before);
    expect(Date.now).toBe(clock);
    expect(structuredClone(input)).toEqual(input);
});
it.each([NaN, Infinity, -1, 0, 1.5])('rejects an invalid captured fixture clock %s', now => {
    expect(() => cappedMcmcInput(now)).toThrow();
});
