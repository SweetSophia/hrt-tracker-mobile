import { App } from '@capacitor/app';
import { getBuildTarget, getCapabilities, getRuntimeKind } from '../../src/platform/runtime';
import {
    aesGcmDecrypt,
    aesGcmEncrypt,
    pbkdf2Sha256,
    randomBytes,
    setCryptoFallbackForTests,
} from '../../src/utils/cryptoCompat';
import { decompressGzipWithLimit, pipeThrough } from '../../src/services/boundedDecompression';
import { engineProbe } from './engine';
import { storageProbe } from './storage';
import type { ProbeReport, ProbeRequest } from './contracts';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

async function cryptoProbe(): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {};
    const enc = new TextEncoder();
    const input = enc.encode('SYNTHETIC-FEASIBILITY-NO-HEALTH-DATA');
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const aad = enc.encode('synthetic:probe');
    checks.random = !same(randomBytes(32), randomBytes(32));
    const native = await aesGcmEncrypt(key, iv, input, aad);
    try {
        setCryptoFallbackForTests(true);
        checks.nativeToFallback = same(await aesGcmDecrypt(key, iv, native, aad), input);
        const fallback = await aesGcmEncrypt(key, iv, input, aad);
        setCryptoFallbackForTests(false);
        checks.fallbackToNative = same(await aesGcmDecrypt(key, iv, fallback, aad), input);
        for (const fallback of [false, true]) {
            setCryptoFallbackForTests(fallback);
            const derived = await pbkdf2Sha256(enc.encode('passwd'), enc.encode('salt'), 1, 64);
            checks[`pbkdf2${fallback ? 'Fallback' : 'Native'}`] =
                Array.from(derived, b => b.toString(16).padStart(2, '0')).join('') ===
                '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783';
        }
    } finally {
        setCryptoFallbackForTests(false);
    }
    const compressed = await pipeThrough(input, new CompressionStream('gzip'));
    checks.gzip = same(await decompressGzipWithLimit(compressed, 1024), input);
    return checks;
}

let running = false;
export async function runProbe(request: ProbeRequest): Promise<ProbeReport> {
    const report: ProbeReport = {
        ...request,
        outcome: 'fail',
        checks: {},
        metricsMs: {},
        versions: { userAgent: navigator.userAgent, build: getBuildTarget(), runtime: getRuntimeKind() },
    };
    if (running) return { ...report, errorCode: 'PROBE_BUSY' };
    running = true;
    try {
        if (request.scenario === 'capabilities') {
            const info = await App.getInfo();
            report.versions.app = info.version;
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            report.checks = {
                nativeBridge: info.id === 'org.askarys.hrttracker.spike',
                secureContext: window.isSecureContext,
                webCrypto: !!crypto.subtle,
                compression: typeof CompressionStream === 'function',
                fileInput: fileInput.type === 'file' && typeof FileReader === 'function',
                standalone: !getCapabilities().remoteBackend,
                bundledOrigin: location.origin === 'https://localhost',
                noServiceWorker: (await navigator.serviceWorker.getRegistrations()).length === 0,
            };
        } else if (request.scenario === 'engine') Object.assign(report, await engineProbe());
        else if (request.scenario === 'crypto') report.checks = await cryptoProbe();
        else {
            const storage = await storageProbe(request);
            Object.assign(report.checks, storage.checks);
            Object.assign(report.versions, storage.versions);
            report.outcome = storage.outcome;
        }
        report.outcome =
            Object.keys(report.checks).length > 0 && Object.values(report.checks).every(Boolean)
                ? report.outcome === 'ready'
                    ? 'ready'
                    : 'pass'
                : 'fail';
    } catch (error) {
        report.errorCode =
            error instanceof Error && /^SQLITE_PROBE_[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED';
    } finally {
        running = false;
    }
    return report;
}

Object.assign(window, { __hrtProbe: { run: runProbe } });
