import { execFile } from 'node:child_process';

const CLASS = 'org.askarys.hrttracker.storage.ScreenMigrationTest';
const PHASE = 'pendingRestartSeed';

/** A waiting boundary is not a passed JUnit result. Never accept normal teardown. */
export function parsePendingPreview(output, afterStop = false) {
    if (
        /^INSTRUMENTATION_STATUS_CODE: (?:0|-\d+)\s*$/m.test(output) ||
        /^OK \(|FAILURES|INSTRUMENTATION_STATUS: stack=/m.test(output) ||
        (!afterStop && /^INSTRUMENTATION_(?:CODE|RESULT|FAILED):/m.test(output))
    )
        throw new Error('Pending seed completed or failed before interruption');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: screen_boundary=(.*)\r?\n/gm)];
    if (!reports.length) return undefined;
    if (reports.length !== 1) throw new Error('Duplicate pending-preview boundary');
    const report = JSON.parse(reports[0][1]);
    const classes = [...output.matchAll(/^INSTRUMENTATION_STATUS: class=(.*)$/gm)].map(x => x[1].trim());
    const tests = [...output.matchAll(/^INSTRUMENTATION_STATUS: test=(.*)$/gm)].map(x => x[1].trim());
    if (
        JSON.stringify(classes) !== JSON.stringify([CLASS]) ||
        JSON.stringify(tests) !== JSON.stringify([PHASE]) ||
        report.phase !== PHASE ||
        report.outcome !== 'waiting' ||
        report.cleaned !== true ||
        report.previewOpen !== true ||
        report.unchanged !== true ||
        report.holdMillis !== 60000 ||
        !Number.isSafeInteger(report.pid) ||
        report.pid <= 0 ||
        typeof report.snapshotSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(report.snapshotSha256)
    )
        throw new Error('Incomplete live pending-preview boundary');
    return report;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Settle only after the timed command has closed, including timeout kill and reaping. */
export function runInterruptionCommand(command, args, timeoutMs = 5000, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        let result, failure;
        const child = execFile(
            command,
            args,
            { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
                result = stdout;
                if (error) failure = Object.assign(error, { stdout, stderr, pid: child.pid });
            },
        );
        // Kill the client but let execFile drain its output and wait for close.
        const abort = () => child.kill('SIGKILL');
        signal?.addEventListener('abort', abort, { once: true });
        child.once('close', () => {
            signal?.removeEventListener('abort', abort);
            if (failure) reject(failure);
            else resolve(result);
        });
    });
}

/** Stream a real child process; stop only at its live blocked boundary.
 * getPid/stop must use runInterruptionCommand so their deadlines also kill and reap ADB.
 */
export async function interruptPendingPreview(child, { getPid, stop, timeoutMs = 120000, stopTimeoutMs = 5000 }) {
    let output = '',
        closed = false,
        processError;
    const collect = chunk => {
        if (processError) return;
        output += chunk;
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) processError = new Error('Interruption output exceeded limit');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => {
        processError = error;
    });
    const ended = new Promise(resolve =>
        child.on('close', () => {
            closed = true;
            resolve();
        }),
    );
    const requireLive = () => {
        if (processError) throw processError;
        if (closed || child.exitCode !== null || child.signalCode !== null)
            throw new Error('Pending seed exited before forced stop');
        return parsePendingPreview(output);
    };
    try {
        const deadline = performance.now() + timeoutMs;
        let report;
        while (!(report = requireLive())) {
            if (performance.now() >= deadline) throw new Error('Live pending-preview boundary timed out');
            await pause(5);
        }
        const livePid = (await getPid(stopTimeoutMs)).trim();
        if (livePid !== String(report.pid)) throw new Error('Live app PID does not match pending boundary');
        requireLive(); // Reject teardown/output received while checking the device PID.
        await stop(stopTimeoutMs);
        const closeDeadline = performance.now() + stopTimeoutMs;
        while (!closed) {
            if (performance.now() >= closeDeadline) throw new Error('Instrumentation did not close after forced stop');
            await pause(5);
        }
        if (processError) throw processError;
        parsePendingPreview(output, true); // Still reject JUnit completion/failure even after the expected crash.
        if ((await getPid(stopTimeoutMs)).trim() !== '') throw new Error('App process survived forced stop');
        return {
            phase: PHASE,
            cases: [],
            report,
            interruption: {
                boundary: 'live unconfirmed replacement preview',
                livePid: report.pid,
                forceStopReturned: true,
                processGone: true,
            },
            output,
        };
    } catch (error) {
        error.instrumentationOutput = output;
        throw error;
    } finally {
        if (!closed) child.kill('SIGKILL');
        await ended;
    }
}
