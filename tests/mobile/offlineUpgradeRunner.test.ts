import { expect, it } from 'vitest';
import {
    parseUpgradePhase,
    validateUpgradeRun,
    withNetworkState,
} from '../../scripts/mobile/run-native-offline-upgrade.mjs';

const phases = ['offlineFirstLaunch', 'seedUpgradeState', 'upgradedOffline', 'upgradedOnline'];
const reports = () =>
    phases.map((phase, i) => ({
        phase,
        outcome: 'pass',
        pid: 100 + i,
        uid: 10222,
        firstInstallTime: 1000,
        lastUpdateTime: i < 2 ? 1000 : 2000,
        versionCode: i < 2 ? 1 : 2,
        canaryVersion: i < 2 ? 1 : 2,
        signerSha256: 'a'.repeat(64),
        online: i % 2 === 1,
        webViewOnline: true,
        earlyObserver: true,
        localOrigin: true,
        noServiceWorker: true,
        ordinaryPluginsOnly: true,
        automaticAttempts: 0,
        observedDocuments: i === 3 ? 2 : 1,
        ...(i > 0 ? { fixtureSha256: 'b'.repeat(64), cacheSentinelPresent: true } : {}),
    }));
const output = (r: Record<string, unknown>) =>
    `INSTRUMENTATION_STATUS: upgrade_report=${JSON.stringify(r)}\nINSTRUMENTATION_STATUS_CODE: 2\n` +
    `INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.network.OfflineUpgradeTest\nINSTRUMENTATION_STATUS: test=${r.phase}\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
const runs = () =>
    reports().map((r, i) => ({
        ...parseUpgradePhase(output(r), r.phase),
        forcedStopBefore: true,
        processGoneBefore: true,
        upgradedInPlaceBefore: i === 2,
    }));

it('rejects incomplete JUnit and wrong or missing offline/upgrade evidence', () => {
    for (const [i, r] of reports().entries()) {
        expect(parseUpgradePhase(output(r), r.phase).cases).toHaveLength(1);
        for (const key of Object.keys(r)) {
            const missing: Record<string, unknown> = { ...r };
            delete missing[key];
            expect(() => parseUpgradePhase(output(missing), r.phase), key).toThrow();
        }
        for (const change of [
            { outcome: 'fail' },
            { pid: 0 },
            { uid: 1.5 },
            { firstInstallTime: -1 },
            { lastUpdateTime: 999 },
            { signerSha256: 'A'.repeat(64) },
            { versionCode: 3 },
            { canaryVersion: i < 2 ? 2 : 1 },
            { online: !r.online },
            { webViewOnline: 'true' },
            { earlyObserver: false },
            { localOrigin: false },
            { noServiceWorker: false },
            { ordinaryPluginsOnly: false },
            { automaticAttempts: 1 },
            { observedDocuments: 3 },
            ...(i > 0 ? [{ fixtureSha256: 'bad' }, { cacheSentinelPresent: 'false' }] : []),
            ...(i === 1 ? [{ cacheSentinelPresent: false }] : []),
        ])
            expect(() => parseUpgradePhase(output({ ...r, ...change }), r.phase)).toThrow();
        for (const invalid of [
            '',
            output(r) + output(r),
            output(r).replace('OK (1 test)', 'FAILURES!!!'),
            output(r).replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
            output(r).replace('network.OfflineUpgradeTest', 'network.OtherTest'),
        ])
            expect(() => parseUpgradePhase(invalid, r.phase)).toThrow();
    }
    const offline = { ...reports()[0], webViewOnline: false };
    expect(parseUpgradePhase(output(offline), offline.phase).report.webViewOnline).toBe(false);
    expect(() => parseUpgradePhase(output(reports()[0]), 'unknown')).toThrow();
});

it('records cache loss separately without treating it as retained state', () => {
    for (const r of reports().slice(2)) {
        const observed = parseUpgradePhase(output({ ...r, cacheSentinelPresent: false }), r.phase);
        expect(observed.report.cacheSentinelPresent).toBe(false);
    }
});

it('requires a real replacement with stable identity, fixtures and a newer version', () => {
    expect(validateUpgradeRun(runs())).toHaveLength(4);
    for (const invalid of [runs().slice(1), runs().reverse(), [...runs(), runs()[0]]])
        expect(() => validateUpgradeRun(invalid)).toThrow();
    for (const mutate of [
        (r: ReturnType<typeof runs>) => {
            r[2].forcedStopBefore = false;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].processGoneBefore = false;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].upgradedInPlaceBefore = false;
        },
        (r: ReturnType<typeof runs>) => {
            r[1].upgradedInPlaceBefore = true;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.pid = r[1].report.pid;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.uid++;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.firstInstallTime++;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.lastUpdateTime = 1000;
        },
        (r: ReturnType<typeof runs>) => {
            r[3].report.lastUpdateTime++;
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.signerSha256 = 'c'.repeat(64);
        },
        (r: ReturnType<typeof runs>) => {
            r[2].report.fixtureSha256 = 'c'.repeat(64);
        },
    ]) {
        const r = runs();
        mutate(r);
        expect(() => validateUpgradeRun(r)).toThrow();
    }
});

function networkFake(failRestore = false) {
    const state: Record<string, string> = { airplane_mode_on: '0', wifi_on: '1', mobile_data: '1' };
    const adb = async (...args: string[]) => {
        if (args[1] === 'settings') return state[args[4]];
        if (args[1] === 'cmd') state.airplane_mode_on = args[4] === 'enable' ? '1' : '0';
        else if (args[1] === 'svc') {
            if (failRestore && args[2] === 'wifi' && args[3] === 'enable') throw new Error('Wi-Fi restoration failed');
            state[args[2] === 'wifi' ? 'wifi_on' : 'mobile_data'] = args[3] === 'enable' ? '1' : '0';
        } else throw new Error('Unexpected network command');
        return '';
    };
    return { state, adb };
}
it('restores original network settings after a failed test body', async () => {
    const { state, adb } = networkFake();
    const trace: Record<string, unknown> = {};
    await expect(
        withNetworkState(
            adb,
            async (setOnline: (value: boolean) => Promise<void>) => {
                await setOnline(false);
                expect(state).toEqual({ airplane_mode_on: '1', wifi_on: '0', mobile_data: '0' });
                throw new Error('Deliberate native failure');
            },
            trace,
        ),
    ).rejects.toThrow('Deliberate native failure');
    expect(state).toEqual({ airplane_mode_on: '0', wifi_on: '1', mobile_data: '1' });
    expect(trace.networkRestored).toBe(true);
});
it('fails restoration honestly and still tries the remaining radio', async () => {
    const { state, adb } = networkFake(true);
    const trace: Record<string, unknown> = {};
    await expect(
        withNetworkState(adb, async (setOnline: (value: boolean) => Promise<void>) => setOnline(false), trace),
    ).rejects.toThrow('restore');
    expect(trace.networkRestored).toBe(false);
    expect(state.mobile_data).toBe('1');
});
