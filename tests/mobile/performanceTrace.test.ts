import { expect, it } from 'vitest';
import { ScreenPerformanceTrace } from '../../mobile/storageQualification/performanceTrace';
const post = (t: ScreenPerformanceTrace) => t.post(10, 1, 7, 43, 'mcmc');
const receive = (t: ScreenPerformanceTrace) => t.received(80, 1, 7, 100_300, 102_000);
it('records all four intervals through two ready frames, including the final heartbeat tail', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    t.tick(5);
    post(t);
    t.started(20, 1, 7);
    t.tick(25);
    receive(t);
    expect(t.read().metrics).toBeNull();
    expect(t.presented(100, 1, 7, true)).toBe(false);
    expect(t.read().metrics).toBeNull();
    expect(t.presented(120, 1, 7, true)).toBe(true);
    expect(t.read()).toMatchObject({
        phase: 'complete',
        workerId: 1,
        requestId: 7,
        events: 43,
        samples: 100_300,
        screenSamples: 102_000,
        frames: 2,
    });
    expect(t.read().metrics).toEqual({
        actionToPostMs: 10,
        postToStartedMs: 10,
        startedToResultMs: 60,
        resultToFrameMs: 40,
        totalMs: 120,
        ticks: 2,
        workerTicks: 1,
        maxGapMs: 95,
    });
});
it('does not borrow earlier action ticks as progress during the measured worker job', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    t.tick(5);
    post(t);
    t.started(20, 1, 7);
    receive(t);
    t.presented(100, 1, 7, true);
    t.presented(120, 1, 7, true);
    expect(t.read().metrics).toMatchObject({ ticks: 1, workerTicks: 0, maxGapMs: 115 });
});
it('cannot finish at a mailbox, before a result, with stale callbacks or with a pending presentation', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    post(t);
    expect(t.presented(11, 1, 7, true)).toBe(false);
    t.started(20, 1, 7);
    expect(t.received(25, 2, 7, 100_300, 102_000)).toBe(false);
    expect(t.received(25, 1, 8, 100_300, 102_000)).toBe(false);
    receive(t);
    expect(t.read().phase).toBe('rendering');
    t.presented(90, 1, 7, true);
    t.presented(95, 1, 7, false);
    expect(t.presented(100, 1, 7, true)).toBe(false);
    expect(t.presented(105, 2, 7, true)).toBe(false);
    expect(t.read().metrics).toBeNull();
    expect(t.presented(110, 1, 7, true)).toBe(true);
});
it('never lets a replaced or failed job complete an ambiguous measurement', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    post(t);
    t.started(20, 1, 7);
    t.post(25, 2, 8, 43, 'mcmc');
    expect(t.read().phase).toBe('failed');
    receive(t);
    t.presented(100, 1, 7, true);
    t.presented(120, 1, 7, true);
    expect(t.read().metrics).toBeNull();
    t.begin(200);
    t.post(210, 3, 9, 43, 'mcmc');
    t.fail();
    expect(t.read().phase).toBe('failed');
});
it.each([NaN, Infinity, -1])('rejects invalid or backwards timestamps %s', now => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    t.post(now, 1, 7, 43, 'mcmc');
    expect(t.read().phase).toBe('failed');
    expect(t.read().metrics).toBeNull();
});
it('returns independent scalar snapshots and ignores callbacks after completion', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    post(t);
    t.started(20, 1, 7);
    receive(t);
    t.presented(100, 1, 7, true);
    t.presented(120, 1, 7, true);
    const first = t.read();
    first.metrics!.totalMs = 0;
    t.tick(1000);
    t.fail();
    expect(t.read().phase).toBe('complete');
    expect(t.read().metrics!.totalMs).toBe(120);
    expect(structuredClone(t.read())).toEqual(t.read());
});

it('coalesces an explicitly cancelled ordinary request without borrowing its heartbeat or result', () => {
    const t = new ScreenPerformanceTrace();
    t.begin(0);
    post(t);
    t.started(20, 1, 7);
    t.tick(25);
    expect(t.cancel(26, 99, 7)).toBe(false);
    expect(t.cancel(30, 1, 7)).toBe(true);
    expect(t.read()).toMatchObject({ phase: 'preparing', attempts: 1, discardedAttempts: 1 });
    t.post(40, 2, 8, 43, 'mcmc');
    t.started(50, 2, 8);
    expect(t.received(80, 1, 7, 100_300, 102_000)).toBe(false);
    t.received(90, 2, 8, 100_300, 102_000);
    t.presented(100, 2, 8, true);
    t.presented(120, 2, 8, true);
    expect(t.read()).toMatchObject({ phase: 'complete', attempts: 2, discardedAttempts: 1 });
    expect(t.read().metrics).toEqual({
        actionToPostMs: 40,
        postToStartedMs: 10,
        startedToResultMs: 40,
        resultToFrameMs: 30,
        totalMs: 120,
        ticks: 1,
        workerTicks: 0,
        maxGapMs: 95,
    });
});
