import { expect, it } from 'vitest';
import { cappedMcmcInput } from '../../mobile/storageQualification/longHistoryFixture';
import { analyseRendererTrace } from '../../scripts/mobile/renderer-trace.mjs';
import { executeEngineTask } from '../../src/application/engineTask';

// Synthetic events follow the probed Chromium schema (User Timing marks,
// toplevel RunTask, Profile on CrRendererMain, ProfileChunk on the V8 thread).
// They are not measurements of the capped-grid workload.
const PID = 5352;
const TID = 5370;
const PROFILER_TID = 5458;
const WORKER_TID = 5415;
const ACTION_MS = 1000;
const ACTION_TS = 2_001_000_000;

type TraceEvent = {
    name?: string;
    ph?: string;
    cat?: string;
    pid?: number;
    tid?: number;
    ts?: number;
    dur?: number;
    id?: string;
    s?: string;
    args?: {
        name?: string;
        data?: {
            startTime?: number;
            endTime?: number;
            timeDeltas?: number[];
            cpuProfile?: { nodes?: unknown[]; samples?: number[] };
        };
    };
};

type Measurement = {
    outcome: string;
    measurementOnly: boolean;
    performanceAccepted: boolean;
    trace: {
        phase: string;
        workerId: number;
        requestId: number;
        attempts: number;
        discardedAttempts: number;
        metrics: {
            actionToPostMs: number;
            postToStartedMs: number;
            startedToResultMs: number;
            resultToFrameMs: number;
            totalMs: number;
        };
    };
};

const marker = (phase: string, worker: number, request: number, startMs: number, tid = TID, pid = PID): TraceEvent => ({
    args: { data: { startTime: startMs } },
    cat: 'blink.user_timing',
    name: `hrt.renderer.${phase}.${worker}.${request}`,
    ph: 'I',
    pid,
    tid,
    ts: startMs * 1000 + (ACTION_TS - ACTION_MS * 1000),
    s: 't',
});

const task = (name: string, ts: number, dur: number, cat = 'toplevel', tid = TID, pid = PID): TraceEvent => ({
    name,
    ph: 'X',
    cat,
    ts,
    dur,
    pid,
    tid,
});

const thread = (name: string, tid: number, pid = PID): TraceEvent => ({
    name: 'thread_name',
    ph: 'M',
    cat: '__metadata',
    pid,
    tid,
    ts: 0,
    args: { name },
});

const call = (
    id: number,
    parent: number | undefined,
    functionName: string,
    url?: string,
    lineNumber?: number,
    columnNumber?: number,
) => ({
    id,
    ...(parent === undefined ? {} : { parent }),
    callFrame: {
        functionName,
        ...(url === undefined ? {} : { url }),
        ...(lineNumber === undefined ? {} : { lineNumber }),
        ...(columnNumber === undefined ? {} : { columnNumber }),
    },
});

const observation = () => {
    const nodes = [
        call(1, undefined, '(root)'),
        call(2, 1, 'busy', 'assets/app.js', 10, 2),
        call(4, 2, 'leaf', 'assets/chunk-abc.js', 80, 5),
        call(6, 1, 'outside', 'assets/outside.js', 3, 3),
    ];
    const laterNodes = [call(3, 1, 'other', 'assets/app.js', 0, 1), call(5, 1, 'anon')];
    const deltas = [500, 500, 10_000, 5_000, 15_000, 20_000, 10_000, 40_000, 20_000, 10_000];
    const samples = [6, 4, 4, 4, 2, 4, 5, 3, 4, 6];
    const capture = {
        complete: true,
        dataLossOccurred: false,
        traceEvents: [
            thread('CrRendererMain', TID),
            thread('v8:ProfEvntProc', PROFILER_TID),
            thread('DedicatedWorker thread', WORKER_TID),
            thread('CrBrowserMain', 5327, 5327),
            marker('action', 0, 0, ACTION_MS),
            marker('post', 1, 7, 1010),
            marker('started', 1, 7, 1020),
            marker('result', 1, 7, 1080),
            marker('frame', 1, 7, 1120),
            marker('post', 2, 8, 900),
            marker('started', 2, 8, 910),
            marker('result', 2, 8, 920),
            marker('cancel', 2, 8, 930),
            marker('frame', 2, 8, 940),
            task('ThreadControllerImpl::RunTask', ACTION_TS - 5_000, 50_000),
            task('ThreadControllerImpl::RunTask', ACTION_TS + 10_000, 20_000),
            task('ThreadControllerImpl::RunTask', ACTION_TS + 25_000, 20_000, 'devtools.timeline'),
            task('RunTask', ACTION_TS + 60_000, 10_000),
            task('ThreadControllerImpl::RunTask', ACTION_TS + 100_000, 40_000),
            task('ThreadControllerImpl::RunTask', ACTION_TS + 130_000, 50_000),
            task('ThreadControllerImpl::RunTask', ACTION_TS, 120_000, 'toplevel', 5327, 5327),
            task('V8.GC_MC_COMPLETE_SWEEPING', ACTION_TS + 45_000, 15_000),
            {
                name: 'Profile',
                ph: 'P',
                cat: 'disabled-by-default-v8.cpu_profiler',
                id: '0x2',
                pid: PID,
                tid: TID,
                ts: ACTION_TS - 1_000,
                args: { data: { startTime: ACTION_TS - 1_000 } },
            },
            {
                name: 'ProfileChunk',
                ph: 'P',
                cat: 'disabled-by-default-v8.cpu_profiler',
                id: '0x2',
                pid: PID,
                tid: PROFILER_TID,
                ts: 0,
                args: {
                    data: {
                        cpuProfile: { nodes, samples: samples.slice(0, 4) },
                        timeDeltas: deltas.slice(0, 4),
                    },
                },
            },
            {
                name: 'ProfileChunk',
                ph: 'P',
                cat: 'disabled-by-default-v8.cpu_profiler',
                id: '0x2',
                pid: PID,
                tid: PROFILER_TID,
                ts: 0,
                args: {
                    data: {
                        cpuProfile: { nodes: laterNodes, samples: samples.slice(4) },
                        timeDeltas: deltas.slice(4),
                    },
                },
            },
            {
                name: 'Profile',
                ph: 'P',
                cat: 'disabled-by-default-v8.cpu_profiler',
                id: '0x9',
                pid: PID,
                tid: WORKER_TID,
                ts: ACTION_TS,
                args: { data: { startTime: ACTION_TS } },
            },
            {
                name: 'ProfileChunk',
                ph: 'P',
                cat: 'disabled-by-default-v8.cpu_profiler',
                id: '0x9',
                pid: PID,
                tid: 5482,
                ts: 0,
                args: {
                    data: {
                        cpuProfile: {
                            nodes: [call(1, undefined, 'workerOnly', 'assets/worker.js', 1, 1)],
                            samples: Array.from({ length: 20 }, () => 1),
                        },
                        timeDeltas: Array.from({ length: 20 }, () => 1_000),
                    },
                },
            },
        ] as TraceEvent[],
    };
    const measurement: Measurement = {
        outcome: 'pass',
        measurementOnly: true,
        performanceAccepted: false,
        trace: {
            phase: 'complete',
            workerId: 1,
            requestId: 7,
            attempts: 2,
            discardedAttempts: 1,
            metrics: {
                actionToPostMs: 10,
                postToStartedMs: 10,
                startedToResultMs: 60,
                resultToFrameMs: 40,
                totalMs: 120,
            },
        },
    };
    return { capture, measurement };
};

const find = (events: TraceEvent[], name: string) => {
    const event = events.find(item => item.name === name);
    if (!event) throw new Error(`missing fixture event ${name}`);
    return event;
};

it('clips nested main-thread tasks and counts only the profiled renderer samples inside the marker window', () => {
    const { capture, measurement } = observation();
    const result = analyseRendererTrace(capture, measurement);
    expect(result).toEqual({
        measurementOnly: true,
        performanceAccepted: false,
        renderer: { pid: PID, tid: TID },
        selected: { workerId: 1, requestId: 7 },
        windows: {
            actionToPostMs: 10,
            postToStartedMs: 10,
            startedToResultMs: 60,
            resultToFrameMs: 40,
            totalMs: 120,
        },
        mainThreadTasks: {
            busyWallMs: 75,
            timeline: [],
            largest: [
                { name: 'ThreadControllerImpl::RunTask', startOffsetMs: 0, wallMs: 45 },
                { name: 'ThreadControllerImpl::RunTask', startOffsetMs: 10, wallMs: 20 },
                { name: 'ThreadControllerImpl::RunTask', startOffsetMs: 25, wallMs: 20 },
                { name: 'ThreadControllerImpl::RunTask', startOffsetMs: 100, wallMs: 20 },
                { name: 'RunTask', startOffsetMs: 60, wallMs: 10 },
            ],
            categories: [
                { name: 'toplevel', wallMs: 75 },
                { name: 'devtools.timeline', wallMs: 20 },
            ],
        },
        cpu: {
            samples: 8,
            byPhase: { actionToPost: 1, postToStarted: 2, startedToResult: 3, resultToFrame: 2 },
            topFrames: [
                { functionName: 'leaf', url: 'assets/chunk-abc.js', lineNumber: 80, columnNumber: 5, samples: 5 },
                { functionName: 'anon', url: '', lineNumber: null, columnNumber: null, samples: 1 },
                { functionName: 'busy', url: 'assets/app.js', lineNumber: 10, columnNumber: 2, samples: 1 },
                { functionName: 'other', url: 'assets/app.js', lineNumber: 0, columnNumber: 1, samples: 1 },
            ],
        },
    });
    expect(result.cpu.topFrames.map(frame => frame.functionName)).not.toEqual(
        expect.arrayContaining(['outside', 'workerOnly']),
    );
    expect(result.cpu.topFrames.reduce((sum, frame) => sum + frame.samples, 0)).toBe(result.cpu.samples);
});

it('keeps comma-separated categories nonexclusive when their intervals overlap the union', () => {
    const { capture, measurement } = observation();
    capture.traceEvents.push(task('RunTask', ACTION_TS + 70_000, 5_000, 'toplevel,blink.user_timing'));
    const result = analyseRendererTrace(capture, measurement);
    expect(result.mainThreadTasks.busyWallMs).toBe(80);
    expect(result.mainThreadTasks.categories).toEqual([
        { name: 'toplevel', wallMs: 80 },
        { name: 'devtools.timeline', wallMs: 20 },
        { name: 'blink.user_timing', wallMs: 5 },
    ]);
});

it('retains only the ten longest clipped main-thread tasks', () => {
    const { capture, measurement } = observation();
    capture.traceEvents = capture.traceEvents.filter(event => event.ph !== 'X');
    for (let wall = 1; wall <= 12; wall += 1) {
        capture.traceEvents.push(task('RunTask', ACTION_TS + (wall - 1) * 8_000, wall * 1_000));
    }
    const largest = analyseRendererTrace(capture, measurement).mainThreadTasks.largest;
    expect(largest).toHaveLength(10);
    expect(largest.map(item => item.wallMs)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(largest.map(item => item.startOffsetMs)).toEqual([88, 80, 72, 64, 56, 48, 40, 32, 24, 16]);
});

it('does not borrow a discarded attempt or a profiler-thread profile identity', () => {
    const missing = observation();
    missing.capture.traceEvents = missing.capture.traceEvents.filter(event => event.name !== 'hrt.renderer.post.1.7');
    expect(() => analyseRendererTrace(missing.capture, missing.measurement)).toThrow(/missing or duplicated/);

    const moved = observation();
    find(moved.capture.traceEvents, 'Profile').tid = PROFILER_TID;
    expect(() => analyseRendererTrace(moved.capture, moved.measurement)).toThrow(/CPU profile/);
});

it.each([
    [
        'a dropped capture',
        /Incomplete renderer capture/,
        (capture: { dataLossOccurred: boolean }) => {
            capture.dataLossOccurred = true;
        },
    ],
    [
        'an unfinished capture',
        /Incomplete renderer capture/,
        (capture: { complete: boolean }) => {
            capture.complete = false;
        },
    ],
    [
        'a capture without events',
        /Incomplete renderer capture/,
        (capture: { traceEvents: unknown }) => {
            capture.traceEvents = null;
        },
    ],
    [
        'a failed measurement',
        /cannot be analysed/,
        (_capture: unknown, measurement: Measurement) => {
            measurement.outcome = 'fail';
        },
    ],
    [
        'a performance-accepted measurement',
        /cannot be analysed/,
        (_capture: unknown, measurement: Measurement) => {
            measurement.performanceAccepted = true;
        },
    ],
    [
        'an unfinished trace phase',
        /cannot be analysed/,
        (_capture: unknown, measurement: Measurement) => {
            measurement.trace.phase = 'rendering';
        },
    ],
    [
        'an attempt count that hides a discarded job',
        /cannot be analysed/,
        (_capture: unknown, measurement: Measurement) => {
            measurement.trace.discardedAttempts = 0;
        },
    ],
    [
        'marker clocks more than 0.1ms from the native intervals',
        /marker clocks/,
        (_capture: unknown, measurement: Measurement) => {
            measurement.trace.metrics.actionToPostMs = 10.2;
            measurement.trace.metrics.postToStartedMs = 9.8;
        },
    ],
])('rejects %s', (_label, pattern, mutate) => {
    const { capture, measurement } = observation();
    mutate(capture, measurement);
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(pattern);
});

it('accepts native intervals on the 0.1ms clock-coherence boundary and still reports marker time', () => {
    const { capture, measurement } = observation();
    measurement.trace.metrics.actionToPostMs = 10.1;
    measurement.trace.metrics.postToStartedMs = 9.9;
    expect(analyseRendererTrace(capture, measurement).windows.actionToPostMs).toBe(10);
});

it('rejects duplicate, cancelled, reordered, cross-thread, and unnamed renderer markers', () => {
    const duplicate = observation();
    duplicate.capture.traceEvents.push(marker('post', 1, 7, 1010));
    expect(() => analyseRendererTrace(duplicate.capture, duplicate.measurement)).toThrow(/missing or duplicated/);

    const cancelled = observation();
    cancelled.capture.traceEvents.push(marker('cancel', 1, 7, 1090));
    expect(() => analyseRendererTrace(cancelled.capture, cancelled.measurement)).toThrow(/cancelled/);

    const ordered = observation();
    const started = find(ordered.capture.traceEvents, 'hrt.renderer.started.1.7');
    const result = find(ordered.capture.traceEvents, 'hrt.renderer.result.1.7');
    const startedClock = { startTime: started.args?.data?.startTime, ts: started.ts };
    started.args!.data!.startTime = result.args?.data?.startTime;
    started.ts = result.ts;
    result.args!.data!.startTime = startedClock.startTime;
    result.ts = startedClock.ts;
    expect(() => analyseRendererTrace(ordered.capture, ordered.measurement)).toThrow(/out of order/);

    const crossed = observation();
    find(crossed.capture.traceEvents, 'hrt.renderer.frame.1.7').tid = 5327;
    expect(() => analyseRendererTrace(crossed.capture, crossed.measurement)).toThrow(/not on one thread/);

    const unnamed = observation();
    find(unnamed.capture.traceEvents, 'thread_name').args!.name = 'CrBrowserMain';
    expect(() => analyseRendererTrace(unnamed.capture, unnamed.measurement)).toThrow(/CrRendererMain/);
});

it('rejects orphan chunks, unknown nodes, broken deltas, and samples that miss the window', () => {
    const orphan = observation();
    orphan.capture.traceEvents.push({
        name: 'ProfileChunk',
        ph: 'P',
        id: '0xdead',
        pid: PID,
        tid: PROFILER_TID,
        args: { data: { cpuProfile: { samples: [1] }, timeDeltas: [1] } },
    });
    expect(() => analyseRendererTrace(orphan.capture, orphan.measurement)).toThrow(/orphan/);

    const unknown = observation();
    const chunk = unknown.capture.traceEvents.find(event => event.name === 'ProfileChunk' && event.id === '0x2');
    chunk!.args!.data!.cpuProfile!.samples![0] = 99;
    expect(() => analyseRendererTrace(unknown.capture, unknown.measurement)).toThrow(/unknown/);

    const deltas = observation();
    const mismatch = deltas.capture.traceEvents.find(event => event.name === 'ProfileChunk' && event.id === '0x2');
    mismatch!.args!.data!.timeDeltas!.pop();
    expect(() => analyseRendererTrace(deltas.capture, deltas.measurement)).toThrow(/deltas/);

    const conflict = observation();
    const nodes = conflict.capture.traceEvents.find(event => event.name === 'ProfileChunk' && event.id === '0x2')!.args!
        .data!.cpuProfile!.nodes as { id: number }[];
    nodes.push(call(4, 1, 'different', 'assets/other.js', 1, 1));
    expect(() => analyseRendererTrace(conflict.capture, conflict.measurement)).toThrow(/node/);

    const parent = observation();
    const parentNodes = parent.capture.traceEvents.find(event => event.name === 'ProfileChunk' && event.id === '0x2')!
        .args!.data!.cpuProfile!.nodes as unknown[];
    parentNodes.push(call(50, 49, 'dangling', 'assets/other.js', 1, 1));
    expect(() => analyseRendererTrace(parent.capture, parent.measurement)).toThrow(/node/);

    const outside = observation();
    for (const event of outside.capture.traceEvents) {
        if (event.name === 'ProfileChunk' && event.id === '0x2' && event.args?.data?.timeDeltas)
            event.args.data.timeDeltas = event.args.data.timeDeltas.map(() => 1);
    }
    expect(() => analyseRendererTrace(outside.capture, outside.measurement)).toThrow(/samples/);

    const missing = observation();
    for (const event of missing.capture.traceEvents) {
        if (event.name !== 'ProfileChunk' || event.id !== '0x2' || !event.args?.data) continue;
        delete event.args.data.cpuProfile?.samples;
        delete event.args.data.timeDeltas;
    }
    expect(() => analyseRendererTrace(missing.capture, missing.measurement)).toThrow(/samples/);
});
it('rejects a dropped final frame mark or a trace with no profile chunks', () => {
    const droppedFrame = observation();
    droppedFrame.capture.traceEvents = droppedFrame.capture.traceEvents.filter(
        event => event.name !== 'hrt.renderer.frame.1.7',
    );
    expect(() => analyseRendererTrace(droppedFrame.capture, droppedFrame.measurement)).toThrow(/missing or duplicated/);

    const droppedChunks = observation();
    droppedChunks.capture.traceEvents = droppedChunks.capture.traceEvents.filter(
        event => event.name !== 'ProfileChunk',
    );
    expect(() => analyseRendererTrace(droppedChunks.capture, droppedChunks.measurement)).toThrow(/samples|CPU profile/);
});
it('accepts worker ProfileChunk signed timeDeltas of -10us and -1us without reading their frames', () => {
    const { capture, measurement } = observation();
    const worker = capture.traceEvents.find(event => event.name === 'ProfileChunk' && event.id === '0x9');
    worker!.args!.data!.timeDeltas![0] = -10;
    worker!.args!.data!.timeDeltas![1] = -1;
    const frame = (
        worker!.args!.data!.cpuProfile!.nodes as { callFrame: { lineNumber?: number; columnNumber?: number } }[]
    )[0].callFrame;
    frame.lineNumber = -1;
    frame.columnNumber = -1;
    capture.traceEvents.push({
        name: 'ProfileChunk',
        ph: 'P',
        id: '0x9',
        pid: PID,
        tid: 5482,
        args: { data: { endTime: ACTION_TS + 50_000 } },
    });
    expect(analyseRendererTrace(capture, measurement).cpu.samples).toBe(8);
});

it('reconstructs a -1us main-thread timeDelta instead of clamping it or rejecting it', () => {
    const { capture, measurement } = observation();
    const chunks = capture.traceEvents.filter(event => event.name === 'ProfileChunk' && event.id === '0x2');
    chunks[0].args!.data!.timeDeltas![3] = -1;
    chunks[1].args!.data!.timeDeltas![0] = 20_001;
    expect(analyseRendererTrace(capture, measurement).cpu.byPhase).toEqual({
        actionToPost: 2,
        postToStarted: 1,
        startedToResult: 3,
        resultToFrame: 2,
    });
});

it('accepts a main-thread step of -11us and rejects a non-integer or inexact clock', () => {
    const moved = observation();
    const chunks = moved.capture.traceEvents.filter(event => event.name === 'ProfileChunk' && event.id === '0x2');
    chunks[0].args!.data!.timeDeltas![3] = -11;
    chunks[1].args!.data!.timeDeltas![0] = 20_011;
    expect(analyseRendererTrace(moved.capture, moved.measurement).cpu.byPhase).toEqual({
        actionToPost: 2,
        postToStarted: 1,
        startedToResult: 3,
        resultToFrame: 2,
    });

    const fractional = observation();
    fractional.capture.traceEvents.find(
        event => event.name === 'ProfileChunk' && event.id === '0x2',
    )!.args!.data!.timeDeltas![3] = 1.5;
    expect(() => analyseRendererTrace(fractional.capture, fractional.measurement)).toThrow(/deltas/);

    const overflow = observation();
    overflow.capture.traceEvents.find(
        event => event.name === 'ProfileChunk' && event.id === '0x2',
    )!.args!.data!.timeDeltas![0] = Number.MAX_SAFE_INTEGER;
    expect(() => analyseRendererTrace(overflow.capture, overflow.measurement)).toThrow(/deltas/);
});

it('reports clipped nonexclusive timeline spans without adding nested work to task occupancy', () => {
    const { capture, measurement } = observation();
    capture.traceEvents.push(
        task('FunctionCall', ACTION_TS - 10_000, 30_000, 'devtools.timeline'),
        task('FunctionCall', ACTION_TS + 10_000, 20_000, 'devtools.timeline'),
        task('Layout', ACTION_TS + 15_000, 10_000, 'devtools.timeline'),
        task('Paint', ACTION_TS + 110_000, 20_000, 'devtools.timeline'),
        task('FunctionCall', ACTION_TS, 120_000, 'devtools.timeline', WORKER_TID),
    );
    const result = analyseRendererTrace(capture, measurement);
    expect(result.mainThreadTasks.busyWallMs).toBe(75);
    expect(result.mainThreadTasks.timeline).toEqual([
        { name: 'FunctionCall', wallMs: 30 },
        { name: 'Layout', wallMs: 10 },
        { name: 'Paint', wallMs: 10 },
    ]);
});
it('retains valid zero preparation and dispatch intervals from the captured clock', () => {
    const { capture, measurement } = observation();
    for (const phase of ['post', 'started']) {
        const mark = capture.traceEvents.find(event => event.name === `hrt.renderer.${phase}.1.7`)!;
        mark.ts = ACTION_TS;
        mark.args!.data!.startTime = ACTION_MS;
    }
    Object.assign(measurement.trace.metrics, { actionToPostMs: 0, postToStartedMs: 0, startedToResultMs: 80 });
    const result = analyseRendererTrace(capture, measurement);
    expect(result.windows).toMatchObject({
        actionToPostMs: 0,
        postToStartedMs: 0,
        startedToResultMs: 80,
        totalMs: 120,
    });
});

function comparisonObservation() {
    const { capture, measurement } = observation();
    const replyTask = task('RunTask', ACTION_TS + 69_000, 20_000);
    capture.traceEvents.push(
        replyTask,
        marker('delivery-release', 1, 7, 1060),
        marker('delivery-callback', 1, 7, 1070),
        marker('delivery-read', 1, 7, 1079),
        marker('delivery-accept', 1, 7, 1087),
    );
    const deliveryComparison = {
        mode: 'worker',
        sameOutput: true,
        outputBytes: 1_500_000,
        replyBytes: 1_500_054,
        metrics: {
            releaseToCallbackMs: 10,
            callbackToReadMs: 9,
            readToAcceptedMs: 8,
            acceptedToFrameMs: 33,
            releaseToFrameMs: 60,
        },
    };
    return { capture, replyTask, measurement: { ...measurement, deliveryComparison } };
}

it('compares the selected release-to-frame window while retaining the ordinary analysis', () => {
    const { capture, measurement } = comparisonObservation();
    const result = analyseRendererTrace(capture, measurement);
    expect(result.mainThreadTasks.largest[0].wallMs).toBe(45);
    expect(result.deliveryComparison).toMatchObject({
        ...measurement.deliveryComparison,
        mainThreadTasks: {
            busyWallMs: 49,
            largest: [
                { name: 'RunTask', startOffsetMs: 9, wallMs: 20 },
                { name: 'ThreadControllerImpl::RunTask', startOffsetMs: 40, wallMs: 20 },
                { name: 'RunTask', startOffsetMs: 0, wallMs: 10 },
            ],
        },
    });
});

it('requires the exact envelope size for an unstaged direct reply', () => {
    const { capture, measurement } = comparisonObservation();
    Object.assign(measurement.deliveryComparison, { mode: 'direct', replyBytes: 1_500_052 });
    expect(analyseRendererTrace(capture, measurement).deliveryComparison.mode).toBe('direct');
    measurement.deliveryComparison.replyBytes++;
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);
});

it.each([
    { screenSamples: 100_002, bufferFloor: 12_000_032, metadataFloor: 634 },
    { screenSamples: 100_003, bufferFloor: 12_208_048, metadataFloor: 939 },
    { screenSamples: 103_177, bufferFloor: 12_381_032, metadataFloor: 939 },
])(
    'checks the exact transferable floors at $screenSamples screen samples',
    ({ screenSamples, bufferFloor, metadataFloor }) => {
        const { capture, measurement } = comparisonObservation();
        Object.assign(measurement.trace, { samples: 100_000, screenSamples });
        const comparison = Object.assign(measurement.deliveryComparison, {
            mode: 'transferable',
            transferredBytes: bufferFloor,
            replyBytes: bufferFloor + metadataFloor,
        });
        expect(analyseRendererTrace(capture, measurement).deliveryComparison.transferredBytes).toBe(bufferFloor);
        for (const bad of [0, bufferFloor - 8, bufferFloor + 1]) {
            comparison.transferredBytes = bad;
            comparison.replyBytes = bad + metadataFloor;
            expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);
        }
        comparison.transferredBytes = bufferFloor;
        comparison.replyBytes = bufferFloor + metadataFloor - 1;
        expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);
    },
);

it('requires prediction evidence beyond the capped fixture’s non-prediction screen union', () => {
    const nowMs = 1_800_000_000_000;
    const output = executeEngineTask({
        ...cappedMcmcInput(nowMs),
        sampleTimesH: [],
        screen: { nowMs: nowMs + 60_000, regimens: null },
    });
    const baselineTimes = output.simulation!.timeH;
    const screen = output.screen!;
    expect(screen.simulationAhead).toBeNull();
    expect(screen.sampleTimesH.length - baselineTimes.length).toBe(2);

    const { capture, measurement } = comparisonObservation();
    const samples = baselineTimes.length;
    const screenSamples = screen.sampleTimesH.length + 1;
    Object.assign(measurement.trace, { samples, screenSamples });
    const withoutPrediction = (13 * samples + 2 * screenSamples) * 8;
    const comparison = Object.assign(measurement.deliveryComparison, {
        mode: 'transferable',
        transferredBytes: withoutPrediction,
        replyBytes: withoutPrediction + 939,
    });
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);

    const withPrediction = withoutPrediction + 13 * 2_000 * 8;
    comparison.transferredBytes = withPrediction;
    comparison.replyBytes = withPrediction + 634;
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);
    comparison.replyBytes = withPrediction + 939;
    expect(analyseRendererTrace(capture, measurement).deliveryComparison.transferredBytes).toBe(withPrediction);
}, 15_000);

it.each([
    'missing',
    'duplicate',
    'foreign thread',
    'out of order',
    'wrong clock',
    'unequal result',
    'full payload in preloaded reply',
])('rejects %s comparison evidence', failure => {
    const { capture, measurement } = comparisonObservation();
    const phase = 'hrt.renderer.delivery-callback.1.7';
    const event = find(capture.traceEvents, phase);
    if (failure === 'missing') capture.traceEvents = capture.traceEvents.filter(item => item !== event);
    if (failure === 'duplicate') capture.traceEvents.push({ ...event });
    if (failure === 'foreign thread') event.tid = WORKER_TID;
    if (failure === 'out of order') Object.assign(event, marker('delivery-callback', 1, 7, 1059));
    if (failure === 'wrong clock') event.ts += 1000;
    if (failure === 'unequal result') measurement.deliveryComparison.sameOutput = false;
    if (failure === 'full payload in preloaded reply') measurement.deliveryComparison.mode = 'preloaded';
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(/delivery comparison/i);
});

it('rejects comparison evidence after just the reply task is removed', () => {
    const { capture, measurement, replyTask } = comparisonObservation();
    capture.traceEvents = capture.traceEvents.filter(event => event !== replyTask);
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(
        'Renderer delivery comparison reply task is missing',
    );
});

it('rejects opposite clock drift even when each clock agrees with the native metric', () => {
    const { capture, measurement } = comparisonObservation();
    const callback = find(capture.traceEvents, 'hrt.renderer.delivery-callback.1.7');
    callback.ts -= 90;
    callback.args.data.startTime += 0.09;
    expect(() => analyseRendererTrace(capture, measurement)).toThrow('Renderer delivery comparison clocks disagree');
});

it('derives the preloaded reply size from the selected two-digit request id', () => {
    const { capture, measurement } = comparisonObservation();
    measurement.trace.requestId = 17;
    for (const event of capture.traceEvents) {
        if (event.name?.startsWith('hrt.renderer.') && event.name.endsWith('.1.7'))
            event.name = event.name.slice(0, -1) + '17';
    }
    measurement.deliveryComparison.mode = 'preloaded';
    measurement.deliveryComparison.replyBytes = 46;
    expect(analyseRendererTrace(capture, measurement).deliveryComparison.replyBytes).toBe(46);
    for (const size of [45, measurement.deliveryComparison.outputBytes - 1]) {
        measurement.deliveryComparison.replyBytes = size;
        expect(() => analyseRendererTrace(capture, measurement)).toThrow('Invalid renderer delivery comparison');
    }
});

it.each([
    { callback: 1079.98, read: 1079.99, accept: 1080.03 },
    { callback: 1080, read: 1080, accept: 1080 },
])('rejects a task ending before a short reply window at $callback ms', ({ callback, read, accept }) => {
    const { capture, measurement, replyTask } = comparisonObservation();
    for (const [phase, time] of Object.entries({ callback, read, accept })) {
        const name = 'delivery-' + phase;
        Object.assign(find(capture.traceEvents, 'hrt.renderer.' + name + '.1.7'), marker(name, 1, 7, time));
    }
    measurement.deliveryComparison.metrics = {
        releaseToCallbackMs: callback - 1060,
        callbackToReadMs: read - callback,
        readToAcceptedMs: accept - read,
        acceptedToFrameMs: 1120 - accept,
        releaseToFrameMs: 60,
    };
    capture.traceEvents = capture.traceEvents.filter(event => event !== replyTask);
    capture.traceEvents.push(task('RunTask', ACTION_TS + 79_000, 940));
    expect(() => analyseRendererTrace(capture, measurement)).toThrow(
        'Renderer delivery comparison reply task is missing',
    );

    capture.traceEvents.push(task('RunTask', ACTION_TS + 79_990, 30));
    expect(analyseRendererTrace(capture, measurement).deliveryComparison.mode).toBe('worker');
});
