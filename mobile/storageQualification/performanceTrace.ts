type Phase = 'idle' | 'preparing' | 'dispatching' | 'worker' | 'rendering' | 'complete' | 'failed';

/** Scalar-only trace: never clone, scan or hash a numerical result in its timed window. */
export class ScreenPerformanceTrace {
    private phase: Phase = 'idle';
    private action = 0;
    private postAt = 0;
    private startAt = 0;
    private resultAt = 0;
    private frameAt = 0;
    private latest = 0;
    private lastTick = 0;
    private ticks = 0;
    private workerTicks = 0;
    private maxGapMs = 0;
    private workerId = 0;
    private requestId = 0;
    private events = 0;
    private samples = 0;
    private screenSamples = 0;
    private method = '';
    private frames = 0;
    private attempts = 0;
    private discardedAttempts = 0;
    get active() {
        return this.phase !== 'idle' && this.phase !== 'complete' && this.phase !== 'failed';
    }
    begin(now: number): void {
        this.phase = 'preparing';
        this.action = this.latest = this.lastTick = now;
        this.postAt = this.startAt = this.resultAt = this.frameAt = 0;
        this.ticks = this.workerTicks = this.maxGapMs = this.frames = 0;
        this.workerId = this.requestId = this.events = this.samples = this.screenSamples = 0;
        this.method = '';
        this.attempts = this.discardedAttempts = 0;
        if (!Number.isFinite(now) || now < 0) this.fail();
    }
    private touch(now: number): boolean {
        if (!Number.isFinite(now) || now < this.latest) {
            this.fail();
            return false;
        }
        this.latest = now;
        return true;
    }
    private matches(worker: number, id: number): boolean {
        return this.workerId === worker && this.requestId === id;
    }
    post(now: number, worker: number, id: number, events: number, method: string): boolean {
        if (this.phase !== 'preparing') {
            if (this.active) this.fail();
            return false;
        }
        if (!this.touch(now)) return false;
        if (![worker, id, events].every(value => Number.isSafeInteger(value) && value > 0) || method !== 'mcmc') {
            this.fail();
            return false;
        }
        this.attempts++;
        this.workerTicks = 0;
        this.workerId = worker;
        this.requestId = id;
        this.events = events;
        this.method = method;
        this.postAt = now;
        this.phase = 'dispatching';
        return true;
    }
    cancel(now: number, worker: number, id: number): boolean {
        if (!this.active || this.phase === 'preparing' || !this.matches(worker, id) || !this.touch(now)) return false;
        this.discardedAttempts++;
        this.phase = 'preparing';
        this.workerId = this.requestId = this.workerTicks = this.frames = this.samples = this.screenSamples = 0;
        this.postAt = this.startAt = this.resultAt = this.frameAt = 0;
        this.method = '';
        return true;
    }
    started(now: number, worker: number, id: number): boolean {
        if (this.phase !== 'dispatching' || !this.matches(worker, id) || !this.touch(now)) return false;
        this.startAt = now;
        this.phase = 'worker';
        return true;
    }
    received(now: number, worker: number, id: number, samples: number, screenSamples: number): boolean {
        if (this.phase !== 'worker' || !this.matches(worker, id) || !this.touch(now)) return false;
        if (
            ![samples, screenSamples].every(value => Number.isSafeInteger(value) && value > 0) ||
            screenSamples < samples
        ) {
            this.fail();
            return false;
        }
        this.samples = samples;
        this.screenSamples = screenSamples;
        this.resultAt = now;
        this.phase = 'rendering';
        return true;
    }
    presented(now: number, worker: number, id: number, ready: boolean): boolean {
        if (this.phase !== 'rendering' || !this.matches(worker, id) || !this.touch(now)) return false;
        this.frames = ready ? this.frames + 1 : 0;
        if (this.frames < 2) return false;
        this.maxGapMs = Math.max(this.maxGapMs, now - this.lastTick);
        this.frameAt = now;
        this.phase = 'complete';
        return true;
    }
    tick(now: number): void {
        if (!this.active || !this.touch(now)) return;
        this.maxGapMs = Math.max(this.maxGapMs, now - this.lastTick);
        this.lastTick = now;
        this.ticks++;
        if (this.phase === 'worker') this.workerTicks++;
    }
    fail(): void {
        if (this.phase !== 'complete') this.phase = 'failed';
    }
    read() {
        return {
            phase: this.phase,
            attempts: this.attempts,
            discardedAttempts: this.discardedAttempts,
            workerId: this.workerId,
            requestId: this.requestId,
            events: this.events,
            method: this.method,
            samples: this.samples,
            screenSamples: this.screenSamples,
            frames: this.frames,
            metrics:
                this.phase === 'complete'
                    ? {
                          actionToPostMs: this.postAt - this.action,
                          postToStartedMs: this.startAt - this.postAt,
                          startedToResultMs: this.resultAt - this.startAt,
                          resultToFrameMs: this.frameAt - this.resultAt,
                          totalMs: this.frameAt - this.action,
                          ticks: this.ticks,
                          workerTicks: this.workerTicks,
                          maxGapMs: this.maxGapMs,
                      }
                    : null,
        };
    }
}
