/* global window */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        serial: { type: 'string' },
        scenario: { type: 'string', default: 'capabilities' },
        phase: { type: 'string', default: 'verify' },
        output: { type: 'string' },
        abrupt: { type: 'boolean', default: false },
    },
});
if (
    !values.serial ||
    !['capabilities', 'engine', 'crypto', 'sqlite-batch', 'sqlite-key'].includes(values.scenario) ||
    !['prepare', 'verify', 'cleanup'].includes(values.phase)
) {
    throw new Error('Use --serial DEVICE --scenario NAME --phase prepare|verify|cleanup [--output FILE]');
}
const adb = (...args) =>
    execFileSync('adb', ['-s', values.serial, ...args], {
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
    });
if (adb('get-state').trim() !== 'device') throw new Error('Explicitly selected device is not ready');
const runId = randomUUID();
// Each invocation is a separate process. No app-data clearing or other packages.
adb('shell', 'am', 'force-stop', 'org.askarys.hrttracker.spike');
let report;
if (values.abrupt) {
    const { openPrototypeWebView } = await import('./webview-connection.mjs');
    let connection;
    try {
        connection = await openPrototypeWebView(values.serial);
        const { page } = connection;
        await page.waitForFunction(() => Boolean(window.__hrtProbe));
        report = await page.evaluate(request => window.__hrtProbe.run(request), {
            runId,
            scenario: values.scenario,
            phase: values.phase,
        });
        // Kill directly after the observed acknowledgement/checkpoint. No
        // ActivityScenario.close(), plugin close(), or grace-period delay.
        adb('shell', 'am', 'force-stop', 'org.askarys.hrttracker.spike');
    } finally {
        await connection?.close();
    }
} else {
    const output = adb(
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'class',
        'org.askarys.hrttracker.spike.ProbeBridgeTest#bundledProbeReturnsCheckedReport',
        '-e',
        'runId',
        runId,
        '-e',
        'scenario',
        values.scenario,
        '-e',
        'phase',
        values.phase,
        'org.askarys.hrttracker.spike.test/androidx.test.runner.AndroidJUnitRunner',
    );
    const line = output.split('\n').find(line => line.startsWith('INSTRUMENTATION_STATUS: probe='));
    if (!line || !/OK \(1 test\)/.test(output) || /FAILURES|INSTRUMENTATION_FAILED/.test(output))
        throw new Error(output);
    report = JSON.parse(line.slice('INSTRUMENTATION_STATUS: probe='.length));
}
if (
    report.runId !== runId ||
    report.scenario !== values.scenario ||
    report.phase !== values.phase ||
    !(report.outcome === 'pass' || (values.phase === 'prepare' && report.outcome === 'ready')) ||
    !Object.keys(report.checks).length ||
    !Object.values(report.checks).every(value => value === true)
)
    throw new Error('Invalid or failed probe report: ' + JSON.stringify(report));
report.versions.androidApi = adb('shell', 'getprop', 'ro.build.version.sdk').trim();
report.versions.transport = values.abrupt ? 'devtools-then-force-stop' : 'instrumentation';
report.versions.abi = adb('shell', 'getprop', 'ro.product.cpu.abi').trim();
report.versions.pageSize = adb('shell', 'getconf', 'PAGE_SIZE').trim();
report.versions.webView =
    adb('shell', 'dumpsys', 'webviewupdate')
        .split('\n')
        .find(line => line.includes('Current WebView package'))
        ?.trim() ?? 'unknown';
const json = JSON.stringify(report, null, 2) + '\n';
if (values.output) writeFileSync(values.output, json, { flag: 'wx' });
process.stdout.write(json);
