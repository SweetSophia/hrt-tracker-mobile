import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reserveEvidence } from './backup-evidence.mjs';
import {
    instrumentationCases,
    qualificationAdbArgs,
    validateQualificationEnvironment,
} from './run-native-storage-qualification.mjs';

const CLASS = 'org.askarys.hrttracker.storage.DocumentUiTest';
const NAMES = ['sharedPdfRendersAndOpensExternally', 'systemDownloadsRoundTrip', 'systemCancellationAllowsRetry'];
const VIEWER = 'com.google.android.apps.docs';
const exactNames = values => JSON.stringify([...values].sort()) === JSON.stringify([...NAMES].sort());
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

function assertPng(value) {
    if (typeof value !== 'string' || value.length > 600_000) throw new Error('Missing or oversized image evidence');
    const bytes = Buffer.from(value, 'base64');
    if (
        bytes.length < 45 ||
        bytes.toString('base64') !== value ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082'
    )
        throw new Error('Malformed PNG evidence');
}

export function parseDocumentUiReports(output) {
    const cases = instrumentationCases(output);
    if (!exactNames(cases.map(item => item.name)) || cases.some(item => item.className !== CLASS))
        throw new Error('Missing, extra or unknown system document UI cases');
    const reports = [...output.matchAll(/^INSTRUMENTATION_STATUS: document_ui_report=(.*)$/gm)].map(match =>
        JSON.parse(match[1]),
    );
    if (
        !exactNames(reports.map(item => item?.test)) ||
        reports.some(item => item.outcome !== 'pass' || item.cleaned !== true)
    )
        throw new Error('Missing or invalid system document UI reports');
    const pdf = reports.find(item => item.test === NAMES[0]);
    if (
        pdf.pages !== 1 ||
        !positive(pdf.pdfBytes) ||
        !digest(pdf.pdfSha256) ||
        pdf.textVerified !== true ||
        pdf.temporaryPdfRemoved !== true ||
        pdf.viewerOpened !== true ||
        pdf.viewerPackage !== VIEWER
    )
        throw new Error('Missing PDF or external viewer verification');
    assertPng(pdf.renderPng);
    assertPng(pdf.viewerPng);
    const transport = reports.find(item => item.test === NAMES[1]);
    if (
        transport.exactBytes !== true ||
        !Array.isArray(transport.formats) ||
        JSON.stringify(transport.formats.map(item => item.extension).sort()) !==
            JSON.stringify(['csv', 'ics', 'json']) ||
        transport.formats.some(item => !positive(item.bytes) || !digest(item.sha256))
    )
        throw new Error('Missing exact document transport evidence');
    const cancellation = reports.find(item => item.test === NAMES[2]);
    if (cancellation.saveCancelled !== true || cancellation.pickCancelled !== true || cancellation.retryExact !== true)
        throw new Error('Missing cancellation or retry verification');
    return { cases, reports };
}

async function main() {
    const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
    qualificationAdbArgs(values.serial, []);
    if (!values.output) throw new Error('Use --serial emulator-PORT --output PATH_PREFIX');
    const evidence = reserveEvidence(values.output);
    const exec = promisify(execFile);
    const adb = async (...args) =>
        (
            await exec('adb', qualificationAdbArgs(values.serial, args), {
                encoding: 'utf8',
                timeout: 240_000,
                maxBuffer: 8 * 1024 * 1024,
            })
        ).stdout;
    const report = { serial: values.serial, outcome: 'fail' };
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
            throw new Error('PDF text qualification requires API 35+');
        report.abi = (await adb('shell', 'getprop', 'ro.product.cpu.abi')).trim();
        if (!(await adb('shell', 'pm', 'path', VIEWER)).startsWith('package:'))
            throw new Error('This qualification requires the preinstalled Google Drive PDF viewer');
        const viewer = await adb('shell', 'dumpsys', 'package', VIEWER);
        report.viewerVersion = /versionName=(\S+)/.exec(viewer)?.[1];
        if (!report.viewerVersion) throw new Error('Missing external viewer version');
        for (const apk of [
            'storageQualification/app-storageQualification.apk',
            'androidTest/storageQualification/app-storageQualification-androidTest.apk',
        ]) {
            const path = fileURLToPath(new URL(`../../android/app/build/outputs/apk/${apk}`, import.meta.url));
            if (!(await adb('install', '-r', path)).includes('Success'))
                throw new Error('Qualification APK install failed');
        }
        started = true;
        output = await adb(
            'shell',
            'am',
            'instrument',
            '-w',
            '-r',
            '-e',
            'class',
            CLASS,
            `${app}.test/androidx.test.runner.AndroidJUnitRunner`,
        );
        Object.assign(report, parseDocumentUiReports(output));
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        evidence.write(
            'xml',
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                `<testsuite name="system-documents ${escape(report.avd)} ${escape(values.serial)} ${report.pageSize}-byte-page" tests="3" failures="0" skipped="0">\n` +
                report.cases
                    .map(item => `  <testcase classname="${escape(item.className)}" name="${escape(item.name)}"/>`)
                    .join('\n') +
                '\n</testsuite>\n',
        );
        report.outcome = 'pass';
    } catch (error) {
        report.error = String(error.message);
        if (error.stdout) output += error.stdout;
        if (started) {
            try {
                await adb('shell', 'am', 'force-stop', app);
            } catch {
                report.stopFailed = true;
            }
        }
        throw error;
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
    main().catch(error => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    });
}
