// Phase windows come from performance.mark startTime values, in JS milliseconds.
// Task clipping and CPU samples use the trace clock, in microseconds.
// The two clocks and the native phase metrics must agree within 0.1ms.
// Nested task wall time is a union, and sample counts are not CPU time.

const PHASES = ['action', 'post', 'started', 'result', 'frame'];
const WINDOW_KEYS = ['actionToPostMs', 'postToStartedMs', 'startedToResultMs', 'resultToFrameMs', 'totalMs'];
const DELIVERY_WINDOWS = [
    'releaseToCallbackMs',
    'callbackToReadMs',
    'readToAcceptedMs',
    'acceptedToFrameMs',
    'releaseToFrameMs',
];
const TASK_NAMES = new Set(['ThreadControllerImpl::RunTask', 'RunTask']);
const TIMELINE_NAMES = new Set([
    'FunctionCall',
    'EvaluateScript',
    'HandlePostMessage',
    'UpdateLayoutTree',
    'Layout',
    'PrePaint',
    'Paint',
    'MinorGC',
    'MajorGC',
    'FireAnimationFrame',
]);
const MARKER_NAME = new RegExp(
    '^hrt[.]renderer[.](action|post|started|result|cancel|frame)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$',
);
const CLOCK_TOLERANCE_MS = 0.1;
// CDP Profiler.Profile timeDeltas are signed integers. The probe's -10us
// worker steps are not a cutoff. Deltas are added, not clamped. The running
// microsecond clock must stay finite and exact within the safe-integer range.
// Non-main profiles are linked by pid and profile id and are not walked.

const fail = message => {
    throw new Error(message);
};

const finite = value => typeof value === 'number' && Number.isFinite(value);
const safeInt = value => Number.isSafeInteger(value);
const near = (left, right) => Math.abs(left - right) <= CLOCK_TOLERANCE_MS + 1e-6;
const textOrder = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const readCapture = capture => {
    if (
        !capture ||
        capture.complete !== true ||
        capture.dataLossOccurred !== false ||
        !Array.isArray(capture.traceEvents)
    )
        fail('Incomplete renderer capture');
    if (capture.traceEvents.some(event => !event || typeof event !== 'object')) fail('Incomplete renderer capture');
    return capture.traceEvents;
};

const readMeasurement = measurement => {
    const trace = measurement && measurement.trace;
    const metrics = trace && trace.metrics;
    const nonnegative = value => finite(value) && value >= 0;
    const positive = value => safeInt(value) && value > 0;
    const summed = metrics ? WINDOW_KEYS.slice(0, 4).reduce((total, key) => total + metrics[key], 0) : Number.NaN;
    if (
        !measurement ||
        measurement.outcome !== 'pass' ||
        measurement.measurementOnly !== true ||
        measurement.performanceAccepted !== false ||
        !trace ||
        trace.phase !== 'complete' ||
        !positive(trace.workerId) ||
        !positive(trace.requestId) ||
        !positive(trace.attempts) ||
        !safeInt(trace.discardedAttempts) ||
        trace.discardedAttempts < 0 ||
        trace.attempts !== trace.discardedAttempts + 1 ||
        !metrics ||
        WINDOW_KEYS.some(key => !nonnegative(metrics[key])) ||
        !(metrics.totalMs > 0) ||
        Math.abs(summed - metrics.totalMs) > 0.001
    )
        fail('Renderer measurement cannot be analysed');
    return {
        workerId: trace.workerId,
        requestId: trace.requestId,
        samples: trace.samples,
        screenSamples: trace.screenSamples,
        metrics,
    };
};

const markerIdentity = name => {
    if (typeof name !== 'string') return null;
    const match = MARKER_NAME.exec(name);
    if (!match) return null;
    const workerId = Number(match[2]);
    const requestId = Number(match[3]);
    if (!safeInt(workerId) || !safeInt(requestId)) return null;
    return { phase: match[1], workerId, requestId };
};

const markerClock = event => {
    const startTime = event.args && event.args.data && event.args.data.startTime;
    if (
        event.ph !== 'I' ||
        event.cat !== 'blink.user_timing' ||
        !safeInt(event.pid) ||
        !safeInt(event.tid) ||
        !finite(event.ts) ||
        !finite(startTime)
    )
        return null;
    return { startTime, ts: event.ts, pid: event.pid, tid: event.tid };
};

const selectMarkers = (events, selected) => {
    const grouped = { action: [], post: [], started: [], result: [], frame: [] };
    for (const event of events) {
        const identity = markerIdentity(event.name);
        if (!identity) continue;
        const finalIds = identity.workerId === selected.workerId && identity.requestId === selected.requestId;
        if (identity.phase === 'cancel' && finalIds) fail('Final renderer attempt was cancelled');
        if (identity.phase === 'cancel' || (!finalIds && identity.phase !== 'action')) continue;
        const clock = markerClock(event);
        if (!clock || (identity.phase === 'action' && (identity.workerId !== 0 || identity.requestId !== 0)))
            fail('Renderer markers are missing or duplicated');
        grouped[identity.phase].push(clock);
    }
    if (PHASES.some(phase => grouped[phase].length !== 1)) fail('Renderer markers are missing or duplicated');
    const ordered = PHASES.map(phase => grouped[phase][0]);
    if (ordered.some(marker => marker.pid !== ordered[0].pid || marker.tid !== ordered[0].tid))
        fail('Renderer markers are not on one thread');
    for (let index = 1; index < ordered.length; index += 1) {
        if (
            ordered[index].startTime < ordered[index - 1].startTime ||
            ordered[index].ts < ordered[index - 1].ts ||
            (index >= 3 &&
                (ordered[index].startTime === ordered[index - 1].startTime ||
                    ordered[index].ts === ordered[index - 1].ts))
        )
            fail('Renderer markers are out of order');
    }
    return {
        action: ordered[0],
        post: ordered[1],
        started: ordered[2],
        result: ordered[3],
        frame: ordered[4],
        pid: ordered[0].pid,
        tid: ordered[0].tid,
    };
};

const assertRendererThread = (events, markers) => {
    const names = new Set();
    for (const event of events) {
        if (event.name !== 'thread_name' || event.ph !== 'M' || event.pid !== markers.pid || event.tid !== markers.tid)
            continue;
        if (!event.args || typeof event.args.name !== 'string') fail('Renderer thread is not CrRendererMain');
        names.add(event.args.name);
    }
    if (names.size !== 1 || !names.has('CrRendererMain')) fail('Renderer thread is not CrRendererMain');
};

const phaseWindows = (markers, metrics) => {
    const windows = {
        actionToPostMs: markers.post.startTime - markers.action.startTime,
        postToStartedMs: markers.started.startTime - markers.post.startTime,
        startedToResultMs: markers.result.startTime - markers.started.startTime,
        resultToFrameMs: markers.frame.startTime - markers.result.startTime,
        totalMs: markers.frame.startTime - markers.action.startTime,
    };
    const traced = {
        actionToPostMs: (markers.post.ts - markers.action.ts) / 1000,
        postToStartedMs: (markers.started.ts - markers.post.ts) / 1000,
        startedToResultMs: (markers.result.ts - markers.started.ts) / 1000,
        resultToFrameMs: (markers.frame.ts - markers.result.ts) / 1000,
        totalMs: (markers.frame.ts - markers.action.ts) / 1000,
    };
    for (const key of WINDOW_KEYS) {
        if (!near(windows[key], metrics[key]) || !near(windows[key], traced[key]))
            fail('Renderer phase metrics do not match marker clocks');
    }
    return windows;
};

const unionMicroseconds = intervals => {
    const sorted = intervals.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let total = 0;
    let start = null;
    let end = null;
    for (const [lo, hi] of sorted) {
        if (start === null) {
            start = lo;
            end = hi;
            continue;
        }
        if (lo > end) {
            total += end - start;
            start = lo;
            end = hi;
        } else if (hi > end) end = hi;
    }
    if (start !== null) total += end - start;
    return total;
};

// Per-name spans overlap each other and the enclosing RunTask union.
const collectTimeline = (events, markers) => {
    const grouped = new Map();
    for (const event of events) {
        if (
            !TIMELINE_NAMES.has(event.name) ||
            event.ph !== 'X' ||
            event.pid !== markers.pid ||
            event.tid !== markers.tid ||
            !event.cat?.split(',').includes('devtools.timeline')
        )
            continue;
        if (!finite(event.ts) || !finite(event.dur) || event.dur < 0) fail('Renderer timeline span is malformed');
        const start = Math.max(event.ts, markers.action.ts),
            end = Math.min(event.ts + event.dur, markers.frame.ts);
        if (end <= start) continue;
        const spans = grouped.get(event.name) ?? [];
        spans.push([start, end]);
        grouped.set(event.name, spans);
    }
    return [...grouped.entries()]
        .map(([name, spans]) => ({ name, wallMs: unionMicroseconds(spans) / 1000 }))
        .sort((left, right) => right.wallMs - left.wallMs || textOrder(left.name, right.name));
};

const collectTasks = (events, markers, replyWindow) => {
    const clipped = [];
    for (const event of events) {
        if (!TASK_NAMES.has(event.name) || event.ph !== 'X' || event.pid !== markers.pid || event.tid !== markers.tid)
            continue;
        const categories =
            typeof event.cat === 'string'
                ? event.cat
                      .split(',')
                      .map(name => name.trim())
                      .filter(Boolean)
                : [];
        if (!finite(event.ts) || !finite(event.dur) || event.dur < 0 || categories.length === 0)
            fail('Renderer main-thread task is malformed');
        const start = Math.max(event.ts, markers.action.ts);
        const end = Math.min(event.ts + event.dur, markers.frame.ts);
        if (end <= start) continue;
        clipped.push({ name: event.name, start, end, categories });
    }
    if (clipped.length === 0) fail('Renderer main-thread task coverage is missing');
    if (replyWindow) {
        const toleranceUs = CLOCK_TOLERANCE_MS * 1000;
        const { start, end } = replyWindow;
        const coversReply = clipped.some(task => {
            // Require an actual intersection before allowing endpoint tolerance.
            const overlap = Math.min(task.end, end) - Math.max(task.start, start);
            const intersects = start === end ? overlap === 0 : overlap > 0;
            return intersects && task.start <= start + toleranceUs && task.end >= end - toleranceUs;
        });
        if (!coversReply) fail('Renderer delivery comparison reply task is missing');
    }
    const categoryIntervals = new Map();
    for (const item of clipped) {
        for (const name of item.categories) {
            const intervals = categoryIntervals.get(name) ?? [];
            intervals.push([item.start, item.end]);
            categoryIntervals.set(name, intervals);
        }
    }
    return {
        busyWallMs: unionMicroseconds(clipped.map(item => [item.start, item.end])) / 1000,
        timeline: collectTimeline(events, markers),
        largest: clipped
            .map(item => ({
                name: item.name,
                startOffsetMs: (item.start - markers.action.ts) / 1000,
                wallMs: (item.end - item.start) / 1000,
            }))
            .sort(
                (left, right) =>
                    right.wallMs - left.wallMs ||
                    left.startOffsetMs - right.startOffsetMs ||
                    textOrder(left.name, right.name),
            )
            .slice(0, 10),
        categories: [...categoryIntervals.entries()]
            .map(([name, intervals]) => ({ name, wallMs: unionMicroseconds(intervals) / 1000 }))
            .sort((left, right) => right.wallMs - left.wallMs || textOrder(left.name, right.name)),
    };
};

const profileId = (pid, id) => String(pid) + ':' + typeof id + ':' + String(id);
const usableId = id => typeof id === 'string' || typeof id === 'number';

const readProfile = event => {
    const startTime = event.args && event.args.data && event.args.data.startTime;
    if (event.ph !== 'P' || !usableId(event.id) || !safeInt(event.pid) || !safeInt(event.tid) || !finite(startTime))
        return null;
    return { id: event.id, pid: event.pid, tid: event.tid, startTime, chunks: [] };
};

const callFrame = frame => {
    if (!frame || typeof frame !== 'object') return null;
    const functionName = frame.functionName === undefined ? '' : frame.functionName;
    const url = frame.url === undefined ? '' : frame.url;
    const lineNumber = frame.lineNumber === undefined ? null : frame.lineNumber;
    const columnNumber = frame.columnNumber === undefined ? null : frame.columnNumber;
    if (typeof functionName !== 'string' || typeof url !== 'string') return null;
    if (lineNumber !== null && (!finite(lineNumber) || lineNumber < 0)) return null;
    if (columnNumber !== null && (!finite(columnNumber) || columnNumber < 0)) return null;
    return { functionName, url, lineNumber, columnNumber };
};

const readChunk = event => {
    if (event.ph !== 'P' || !usableId(event.id) || !safeInt(event.pid) || !safeInt(event.tid)) return null;
    const data = (event.args && event.args.data) || {};
    const cpu = data.cpuProfile || {};
    if (cpu.nodes !== undefined && !Array.isArray(cpu.nodes)) return null;
    const samples = cpu.samples;
    const deltas = data.timeDeltas;
    if (samples !== undefined || deltas !== undefined) {
        if (!Array.isArray(samples) || !Array.isArray(deltas) || samples.length !== deltas.length)
            fail('Renderer CPU profile deltas do not match samples');
    }
    return {
        id: event.id,
        pid: event.pid,
        tid: event.tid,
        nodes: cpu.nodes || [],
        samples: samples || [],
        deltas: deltas || [],
    };
};

const rememberNode = (nodes, raw) => {
    if (!raw || !safeInt(raw.id)) fail('Renderer CPU profile node is malformed');
    const frame = callFrame(raw.callFrame);
    const parent = raw.parent === undefined ? null : raw.parent;
    if (!frame || (parent !== null && !safeInt(parent))) fail('Renderer CPU profile node is malformed');
    const stored = { parent, ...frame };
    const existing = nodes.get(raw.id);
    if (
        existing &&
        (existing.parent !== stored.parent ||
            existing.functionName !== stored.functionName ||
            existing.url !== stored.url ||
            existing.lineNumber !== stored.lineNumber ||
            existing.columnNumber !== stored.columnNumber)
    )
        fail('Renderer CPU profile node is malformed');
    if (!existing) nodes.set(raw.id, stored);
};

const assertAcyclic = nodes => {
    for (const node of nodes.values()) {
        if (node.parent !== null && !nodes.has(node.parent)) fail('Renderer CPU profile node is malformed');
    }
    const settled = new Set();
    for (const id of nodes.keys()) {
        const path = new Set();
        let cursor = id;
        while (cursor !== null) {
            if (path.has(cursor)) fail('Renderer CPU profile node is malformed');
            if (settled.has(cursor)) break;
            path.add(cursor);
            cursor = nodes.get(cursor).parent;
        }
        for (const seen of path) settled.add(seen);
    }
};

const phaseOf = (time, markers) => {
    if (time < markers.post.ts) return 'actionToPost';
    if (time < markers.started.ts) return 'postToStarted';
    if (time < markers.result.ts) return 'startedToResult';
    return 'resultToFrame';
};

const walkProfile = (profile, markers) => {
    const nodes = new Map();
    for (const chunk of profile.chunks) for (const node of chunk.nodes) rememberNode(nodes, node);
    assertAcyclic(nodes);
    const byPhase = { actionToPost: 0, postToStarted: 0, startedToResult: 0, resultToFrame: 0 };
    const leaves = new Map();
    let time = profile.startTime;
    let samples = 0;
    for (const chunk of profile.chunks) {
        for (let index = 0; index < chunk.samples.length; index += 1) {
            const delta = chunk.deltas[index];
            const sample = chunk.samples[index];
            if (!safeInt(delta)) fail('Renderer CPU profile deltas do not match samples');
            if (!safeInt(sample)) fail('Renderer CPU profile sample is unknown');
            const next = time + delta;
            if (!Number.isFinite(next) || Math.abs(next) > Number.MAX_SAFE_INTEGER || (safeInt(time) && !safeInt(next)))
                fail('Renderer CPU profile deltas do not match samples');
            time = next;
            const node = nodes.get(sample);
            if (!node) fail('Renderer CPU profile sample is unknown');
            if (time < markers.action.ts || time > markers.frame.ts) continue;
            const phase = phaseOf(time, markers);
            byPhase[phase] += 1;
            samples += 1;
            const key = [node.functionName, node.url, node.lineNumber, node.columnNumber].join('\u0000');
            const leaf = leaves.get(key) ?? {
                functionName: node.functionName,
                url: node.url,
                lineNumber: node.lineNumber,
                columnNumber: node.columnNumber,
                samples: 0,
            };
            leaf.samples += 1;
            leaves.set(key, leaf);
        }
    }
    return {
        samples,
        byPhase,
        topFrames: [...leaves.values()].sort(
            (left, right) =>
                right.samples - left.samples ||
                textOrder(left.functionName, right.functionName) ||
                textOrder(left.url, right.url) ||
                (left.lineNumber ?? -1) - (right.lineNumber ?? -1) ||
                (left.columnNumber ?? -1) - (right.columnNumber ?? -1),
        ),
    };
};

const collectCpu = (events, markers) => {
    const profiles = new Map();
    const chunks = [];
    for (const event of events) {
        if (event.name === 'Profile') {
            const profile = readProfile(event);
            if (!profile) fail('Renderer CPU profile is missing or malformed');
            const key = profileId(profile.pid, profile.id);
            if (profiles.has(key)) fail('Renderer CPU profile is missing or malformed');
            profiles.set(key, profile);
        } else if (event.name === 'ProfileChunk') {
            const chunk = readChunk(event);
            if (!chunk) fail('Renderer CPU profile chunk is orphaned or malformed');
            chunks.push(chunk);
        }
    }
    for (const chunk of chunks) {
        const profile = profiles.get(profileId(chunk.pid, chunk.id));
        if (!profile) fail('Renderer CPU profile chunk is orphaned or malformed');
        profile.chunks.push(chunk);
    }
    const main = [...profiles.values()].filter(profile => profile.pid === markers.pid && profile.tid === markers.tid);
    if (main.length !== 1) fail('Renderer CPU profile is missing or malformed');
    const counted = walkProfile(main[0], markers);
    if (counted.samples === 0) fail('Renderer main-thread CPU samples are missing');
    return counted;
};

// Every non-null runSimulation result has these buffers. Aliases share one
// transferred buffer, but each name remains in the serialized reply metadata.
const baselineBuffers = [
    ['timeH'],
    ['concPGmL'],
    ['concPGmL_E2'],
    ['concPGmL_CPA'],
    ['concPGmL_BICA'],
    ['concNGdL_T'],
    ['concNGdL_T_free'],
    ['concPGmL_E2_free'],
    ['concPGmL_E2_bioavailable'],
    ['muscleM', 'bodyCompM'],
    ['visceralFat', 'bodyCompFVisc'],
    ['ldl', 'lipidLDL'],
    ['vteRisk'],
];

function minimumTransferableMetadataBytes(id, hasPrediction) {
    // report() substitutes null for each transferred view. This omits optional fields
    // and uses the shortest scalar values for the capped-history output.
    const factors = { sampleTimesH: null, factors: null, factorSDs: null };
    const simulation = { ...Object.fromEntries(baselineBuffers.flat().map(key => [key, null])), auc: 0 };
    const output = {
        simulation,
        calibration: { method: 'mcmc', scale: 0, kMul: 0, halfLifeDeltaPct: 0, n: 0, fitErrPct: 0, points: [] },
        ...factors,
        screen: { nowMs: 1, simulationAhead: hasPrediction ? simulation : null, ...factors },
    };
    return Buffer.byteLength(JSON.stringify({ kind: 'delivery', id, mode: 'transferable', output }));
}

const validDeliverySize = (comparison, { requestId: id, samples, screenSamples }) => {
    const { mode, outputBytes, replyBytes, transferredBytes } = comparison;
    if (!safeInt(outputBytes) || outputBytes <= 0 || !safeInt(replyBytes) || replyBytes <= 0) return false;
    if (mode === 'transferable') {
        if (!safeInt(samples) || samples <= 0 || !safeInt(screenSamples) || screenSamples < samples) return false;
        // The ordinary hook requests no extra times and the baseline includes all dose times.
        // At the qualification clocks, the 150-hour lab matches a dose and the
        // 650-, 480-, 50-, and 24-hour labs match the baseline's post-dose samples.
        // The 300-hour lab and the screen clock can add at most two other times.
        const extraPredictionTimes = screenSamples - samples - 2;
        // A non-null prediction uses runSimulation's minimum 2,000-point grid.
        const minimumPredictionSamples = extraPredictionTimes > 0 ? Math.max(2_000, extraPredictionTimes) : 0;
        // projectEngineScreen maps the union into a separate factor array.
        const minimumBufferBytes =
            (baselineBuffers.length * (samples + minimumPredictionSamples) + 2 * screenSamples) *
            Float64Array.BYTES_PER_ELEMENT;
        return (
            safeInt(transferredBytes) &&
            transferredBytes >= minimumBufferBytes &&
            transferredBytes % Float64Array.BYTES_PER_ELEMENT === 0 &&
            replyBytes - transferredBytes >= minimumTransferableMetadataBytes(id, minimumPredictionSamples > 0)
        );
    }
    if (Object.hasOwn(comparison, 'transferredBytes')) return false;
    if (mode === 'worker') return replyBytes > outputBytes;
    if (mode === 'preloaded') {
        return (
            replyBytes < outputBytes && replyBytes === Buffer.byteLength(JSON.stringify({ kind: 'delivery', id, mode }))
        );
    }
    if (mode === 'direct') {
        const envelopeBytes = Buffer.byteLength(JSON.stringify({ kind: 'delivery', id, mode, output: null })) - 4;
        return replyBytes - outputBytes === envelopeBytes;
    }
    return false;
};

const collectDeliveryComparison = (events, selected, markers, comparison) => {
    const metrics = comparison?.metrics;
    if (
        comparison?.sameOutput !== true ||
        !validDeliverySize(comparison, selected) ||
        !metrics ||
        DELIVERY_WINDOWS.some(key => !finite(metrics[key]) || metrics[key] < 0) ||
        metrics.releaseToFrameMs <= 0
    )
        fail('Invalid renderer delivery comparison');

    const delivery = ['release', 'callback', 'read', 'accept'].map(phase => {
        const name = 'hrt.renderer.delivery-' + phase + '.' + selected.workerId + '.' + selected.requestId;
        const matching = events.filter(event => event.name === name);
        const clock = matching.length === 1 ? markerClock(matching[0]) : null;
        if (!clock || clock.pid !== markers.pid || clock.tid !== markers.tid)
            fail('Missing, duplicate or foreign renderer delivery comparison marker');
        return clock;
    });
    const [release, callback, read, accept] = delivery;
    const ordered = [markers.started, release, callback, read, markers.result, accept, markers.frame];
    if (
        ordered.some(
            (clock, i) => i > 0 && (clock.startTime < ordered[i - 1].startTime || clock.ts < ordered[i - 1].ts),
        )
    )
        fail('Renderer delivery comparison markers are out of order');

    const boundaries = [...delivery, markers.frame];
    for (const [i, key] of DELIVERY_WINDOWS.entries()) {
        const from = i === 4 ? release : boundaries[i];
        const to = i === 4 ? markers.frame : boundaries[i + 1];
        const userTime = to.startTime - from.startTime;
        const traceTime = (to.ts - from.ts) / 1000;
        if (!near(metrics[key], userTime) || !near(metrics[key], traceTime) || !near(userTime, traceTime))
            fail('Renderer delivery comparison clocks disagree');
    }
    const sum = DELIVERY_WINDOWS.slice(0, 4).reduce((total, key) => total + metrics[key], 0);
    if (Math.abs(metrics.releaseToFrameMs - sum) > 0.001) fail('Renderer delivery comparison metrics do not sum');
    const mainThreadTasks = collectTasks(
        events,
        { ...markers, action: release },
        { start: callback.ts, end: accept.ts },
    );
    return { ...comparison, mainThreadTasks };
};

export function analyseRendererTrace(capture, measurement) {
    const events = readCapture(capture);
    const selected = readMeasurement(measurement);
    const markers = selectMarkers(events, selected);
    assertRendererThread(events, markers);
    const windows = phaseWindows(markers, selected.metrics);
    return {
        measurementOnly: true,
        performanceAccepted: false,
        renderer: { pid: markers.pid, tid: markers.tid },
        selected: { workerId: selected.workerId, requestId: selected.requestId },
        windows,
        mainThreadTasks: collectTasks(events, markers),
        cpu: collectCpu(events, markers),
        ...(Object.hasOwn(measurement, 'deliveryComparison')
            ? {
                  deliveryComparison: collectDeliveryComparison(
                      events,
                      selected,
                      markers,
                      measurement.deliveryComparison,
                  ),
              }
            : {}),
    };
}
