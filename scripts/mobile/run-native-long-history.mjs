import { captureRendererTrace } from './renderer-cdp.mjs';
import { analyseRendererTrace } from './renderer-trace.mjs';
import { runInterruptionCommand } from './screen-interruption.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const CLASS = 'org.askarys.hrttracker.storage.LongHistoryPerformanceTest';
const CHECKS = ['ordinaryHook', 'cappedGrid', 'settledPresentation', 'workerProgress', 'snapshotStable', 'phaseOrder'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parseLongHistoryReport(output) {
    const cases = instrumentationCases(output);
    if (cases.length !== 1 || cases[0].className !== CLASS || cases[0].name !== 'ordinaryCappedHistory')
        throw new Error('Missing or unexpected long-history case');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: long_history_report=(.*)$/gm)].map(m =>
        JSON.parse(m[1]),
    );
    const r = reports[0],
        t = r?.trace,
        m = t?.metrics,
        c = r?.checks;
    const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
    if (
        reports.length !== 1 ||
        r.outcome !== 'pass' ||
        r.measurementOnly !== true ||
        r.performanceAccepted !== false ||
        r.snapshotUnchanged !== true ||
        r.localOrigin !== true ||
        !digest(r.beforeHash) ||
        r.beforeHash !== r.afterHash ||
        !c ||
        Object.keys(c).length !== CHECKS.length ||
        CHECKS.some(key => c[key] !== true) ||
        !t ||
        t.phase !== 'complete' ||
        t.frames !== 2 ||
        !positiveInteger(t.attempts) ||
        !Number.isSafeInteger(t.discardedAttempts) ||
        t.discardedAttempts < 0 ||
        t.attempts !== t.discardedAttempts + 1 ||
        t.method !== 'mcmc' ||
        t.events !== 43 ||
        !positiveInteger(t.workerId) ||
        !positiveInteger(t.requestId) ||
        !positiveInteger(t.samples) ||
        t.samples < 100000 ||
        t.samples > 100518 ||
        !positiveInteger(t.screenSamples) ||
        t.screenSamples < t.samples ||
        !m ||
        !['actionToPostMs', 'postToStartedMs', 'startedToResultMs', 'resultToFrameMs', 'totalMs', 'maxGapMs'].every(
            key => nonnegative(m[key]),
        ) ||
        m.startedToResultMs <= 0 ||
        m.resultToFrameMs <= 0 ||
        m.totalMs <= 0 ||
        m.maxGapMs > m.totalMs ||
        !positiveInteger(m.ticks) ||
        !positiveInteger(m.workerTicks) ||
        m.workerTicks > m.ticks ||
        Math.abs(m.actionToPostMs + m.postToStartedMs + m.startedToResultMs + m.resultToFrameMs - m.totalMs) > 0.001
    )
        throw new Error('Incomplete long-history measurement evidence');
    return { cases, reports };
}

/** Passing XML requires both the real native case and, when requested, its drained trace. */
export function writeLongHistoryEvidence(report, output, { profiled = false, capture, deliveryMode } = {}, evidence) {
    const accepted = parseLongHistoryReport(output);
    if (profiled ? accepted.reports[0].rendererProfile !== true : accepted.reports[0].rendererProfile === true)
        throw new Error('Unmatched renderer profiling mode');
    const native = accepted.reports[0];
    if (
        deliveryMode === undefined
            ? Object.hasOwn(native, 'deliveryComparison')
            : !profiled || native.deliveryComparison?.mode !== deliveryMode
    )
        throw new Error('Unmatched delivery comparison mode');
    const analysis = profiled ? analyseRendererTrace(capture, native) : undefined;
    Object.assign(report, accepted);
    if (analysis) report.rendererProfile = analysis;
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    evidence.write(
        'xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
            `<testsuite name="android-long-history ${escape(report.avd)} ${escape(report.serial)} ${report.pageSize}-byte-page" tests="1" failures="0" skipped="0">\n` +
            report.cases
                .map(item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`)
                .join('\n') +
            '\n</testsuite>\n',
    );
}

const commandOutput = error => (error.stdout ?? '') + (error.stderr ?? '');

async function main(signal) {
    const { values } = parseArgs({
        options: {
            serial: { type: 'string' },
            output: { type: 'string' },
            'negative-control': { type: 'string' },
            'renderer-profile': { type: 'boolean' },
            'delivery-mode': { type: 'string' },
            'renderer-profile-control': { type: 'string' },
        },
    });
    qualificationAdbArgs(values.serial, []);
    if (values['negative-control'] && !['heartbeat', 'pending-ui'].includes(values['negative-control']))
        throw new Error('Unknown worker negative control');
    const deliveryMode = values['delivery-mode'];
    if (
        deliveryMode !== undefined &&
        (!values['renderer-profile'] || !['worker', 'preloaded', 'direct', 'transferable'].includes(deliveryMode))
    )
        throw new Error('Use --delivery-mode worker|preloaded|direct|transferable with --renderer-profile');
    const drop = values['renderer-profile-control'];
    if (
        drop !== undefined &&
        (!values['renderer-profile'] ||
            !['missing-frame', 'missing-cpu', 'missing-delivery'].includes(drop) ||
            (drop === 'missing-delivery' && deliveryMode === undefined))
    )
        throw new Error('Invalid renderer profile control');
    if (values['renderer-profile'] && values['negative-control'])
        throw new Error('Use default controls without profiling');
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output, values['renderer-profile'] ? ['trace.json'] : []);
    const runAdb = (args, timeout, commandSignal) =>
        runInterruptionCommand('adb', qualificationAdbArgs(values.serial, args), timeout, commandSignal);
    const adb = (...args) => runAdb(args, 240_000, signal);
    // Cleanup must still run after the measurement or host signal has cancelled the work.
    const profileAdb = (...args) => runAdb(args, 5000);
    const report = {
        serial: values.serial,
        outcome: 'fail',
        negativeControl: values['negative-control'] ?? null,
        rendererProfileControl: drop ?? null,
        ...(deliveryMode ? { deliveryMode } : {}),
    };
    let capture,
        nativeFailure,
        traceWritten = false;
    let output = '',
        started = false;
    const app = 'org.askarys.hrttracker.spike.storagequalification';
    try {
        if ((await adb('get-state')).trim() !== 'device') throw new Error('Selected emulator is not ready');
        report.avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0];
        report.pageSize = Number((await adb('shell', 'getconf', 'PAGE_SIZE')).trim());
        validateQualificationEnvironment(report.avd, report.pageSize);
        report.api = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim());
        if (!Number.isSafeInteger(report.api) || report.api < 35)
            throw new Error('Engine-worker qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        report.apks = [];
        for (const apk of [
            'storageQualification/app-storageQualification.apk',
            'androidTest/storageQualification/app-storageQualification-androidTest.apk',
        ]) {
            const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${apk}`, import.meta.url));
            report.apks.push({ path: apk, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
            if (!(await adb('install', '-r', path)).includes('Success'))
                throw new Error('Qualification APK install failed');
        }
        started = true;
        const instrumentArgs = [
            'shell',
            'am',
            'instrument',
            '-w',
            '-r',
            '-e',
            'class',
            CLASS,
            ...(values['negative-control'] ? ['-e', 'negativeControl', values['negative-control']] : []),
            ...(values['renderer-profile'] ? ['-e', 'rendererProfile', 'true'] : []),
            ...(deliveryMode ? ['-e', 'deliveryMode', deliveryMode] : []),
            `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
        ];
        if (values['renderer-profile']) {
            // An old ready page must never satisfy the fresh native driver's handshake.
            await adb('shell', 'am', 'force-stop', app);
            const abort = new AbortController();
            const profileSignal = AbortSignal.any([signal, abort.signal]);
            const profiling = captureRendererTrace({ adb: profileAdb, signal: profileSignal });
            const instrumentation = runAdb(instrumentArgs, 240_000, profileSignal);
            try {
                [output, capture] = await Promise.all([instrumentation, profiling]);
            } catch (error) {
                abort.abort();
                const [native, renderer] = await Promise.allSettled([instrumentation, profiling]);
                if (native.status === 'fulfilled') output = native.value;
                else nativeFailure = native.reason;
                if (renderer.status === 'fulfilled') capture = renderer.value;
                else {
                    capture = renderer.reason.capture;
                    if (renderer.reason.forwardCleanupError) {
                        report.forwardCleanupError = renderer.reason.forwardCleanupError.message;
                    }
                }
                throw error;
            }
            if (drop) {
                const excluded = {
                    'missing-frame': /^hrt[.]renderer[.]frame[.]/,
                    'missing-cpu': /^ProfileChunk$/,
                    'missing-delivery': /^hrt[.]renderer[.]delivery-release[.]/,
                }[drop];
                capture = {
                    ...capture,
                    negativeControl: drop,
                    traceEvents: capture.traceEvents.filter(event => !excluded.test(event.name)),
                };
            }
            evidence.write('trace.json', JSON.stringify(capture));
            traceWritten = true;
        } else output = await adb(...instrumentArgs);
        signal.throwIfAborted();
        writeLongHistoryEvidence(
            report,
            output,
            { profiled: values['renderer-profile'], capture, deliveryMode },
            evidence,
        );
        report.outcome = 'pass';
    } catch (error) {
        const failure = signal.aborted ? signal.reason : error;
        report.error = String(failure.message);
        if (nativeFailure && nativeFailure !== error) output += commandOutput(nativeFailure);
        output += commandOutput(error);
        if (started) {
            try {
                await profileAdb('shell', 'am', 'force-stop', app);
            } catch {
                report.stopFailed = true;
            }
        }
        if (capture && !traceWritten) evidence.write('trace.json', JSON.stringify(capture));
        throw failure;
    } finally {
        try {
            evidence.write('log', output);
            evidence.write('json', JSON.stringify(report, null, 2) + '\n');
        } finally {
            evidence.close();
        }
    }
    process.stdout.write(
        JSON.stringify({ outcome: report.outcome, serial: values.serial, cases: report.cases.length }) + '\n',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const shutdown = new AbortController();
    const onInterrupt = () => shutdown.abort(new Error('Interrupted by SIGINT'));
    const onTerminate = () => shutdown.abort(new Error('Interrupted by SIGTERM'));
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    main(shutdown.signal)
        .catch(error => {
            process.stderr.write(String(error.stack ?? error) + '\n');
            process.exitCode = 1;
        })
        .finally(() => {
            process.off('SIGINT', onInterrupt);
            process.off('SIGTERM', onTerminate);
        });
}
