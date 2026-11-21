import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Explicit artifact gate: build/sync/assemble first. Missing outputs are failures.
const apk = 'android/app/build/outputs/apk/debug/app-debug.apk';
const files = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)],
    );
const unpack = (name: string) => execFileSync('unzip', ['-p', apk, name], { maxBuffer: 32 * 1024 * 1024 });
const names = () => execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8' }).trim().split('\n');

describe('ordinary mobile artifact', () => {
    it('packages every built asset byte for byte, with no stale application assets', () => {
        const built = files('dist-mobile');
        expect(built.length).toBeGreaterThan(10);
        const expected = built.map(path => path.replace(/^dist-mobile\//, 'assets/public/'));
        for (const [index, path] of built.entries())
            expect(unpack(expected[index]).equals(readFileSync(path)), path).toBe(true);
        const bundled = names().filter(name => name.startsWith('assets/public/assets/') && !name.endsWith('/'));
        expect(bundled.sort()).toEqual(expected.filter(name => name.startsWith('assets/public/assets/')).sort());
        const html = readFileSync('dist-mobile/index.html', 'utf8');
        const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) expect(expected).toContain(`assets/public${ref}`);
        expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    });

    it('contains no probes, SQLite candidate, or service worker', () => {
        const entries = names();
        expect(
            entries.filter(name => /(?:^|\/)(?:sw\.js|workbox-|registerSW|manifest\.webmanifest)/.test(name)),
        ).toEqual([]);
        expect(
            entries.filter(name =>
                /libsqlcipher|probe[^/]*\.js|startup-observer\.js|__hrt_upgrade_canary__|rendererDelivery\.worker-/i.test(
                    name,
                ),
            ),
        ).toEqual([]);
        expect(entries.filter(name => /^assets\/public\/assets\/engine\.worker-[^/]+\.js$/.test(name))).toHaveLength(1);
        const js = files('dist-mobile')
            .filter(path => path.endsWith('.js'))
            .map(path => readFileSync(path, 'utf8'))
            .join('\n');
        expect(
            /__importDialogCounts|__hrtProbe|__hrtStorageQualification|__hrtScreenQualification|__hrtContentQualification|__hrtEngineWorkerQualification|__hrtAppEngineWorkerQualification|__hrtForecastWorkerQualification|ForecastReference|__hrtDemoWorkerQualification|DemoReference|__hrtLongHistoryQualification|__hrtRendererProfile|hrt\.renderer\.|__hrtStartupNetwork|__hrtUpgradeAssetVersion|__hrtDocumentQualification|__hrtBackupQualification|synthetic-qualification-password|HrtNativeDocuments|HrtNativeStorage|hrt_feasibility|CapacitorSQLite|registerSW/.test(
                js,
            ),
            'qualification-free JavaScript',
        ).toBe(false);
        expect(js).toContain('BACKEND_DISABLED');
        // Vite keeps this tiny getter instead of constant-folding its call.
        // Built-browser tests separately exercise the actual rejection path.
        const target = js.match(/const ([\w$]+)=\(\)=>"mobile"/);
        expect(target, 'compiled standalone target').not.toBeNull();
        expect(js.includes(`remoteBackend:${target![1]}()==="web"`)).toBe(true);
        const plugins = JSON.parse(unpack('assets/capacitor.plugins.json').toString());
        expect(plugins.map((plugin: { pkg: string }) => plugin.pkg)).toEqual(['@capacitor/app']);
        for (const name of entries.filter(name => /^classes\d*\.dex$/.test(name))) {
            expect(unpack(name).toString('latin1')).not.toMatch(
                /capacitor[/]community[/]database[/]sqlite|HrtNativeDocuments|DocumentIo|DocumentUiTest|ScreenMigrationTest|LifecycleParityTest|EngineWorkerTest|LongHistoryPerformanceTest|PlanningSettingsTest|ContentBoundaryTest|StartupNetworkTest|OfflineUpgradeTest|NetworkTestRunner|RecordingActivity|HrtNativeStorage|EncryptedRecordStore|NativeSecretStore|ProbeBridgeTest|KeystoreProbeTest|BackupBridgeTest/,
            );
        }
    });

    it('uses only the bundled origin with bridge logging and HTTP patching disabled', () => {
        const config = JSON.parse(unpack('assets/capacitor.config.json').toString());
        expect(config.webDir).toBe('dist-mobile');
        expect(config.appId).toBe('org.askarys.hrttracker.spike');
        expect(config.server).toEqual({
            hostname: 'localhost',
            androidScheme: 'https',
            cleartext: false,
            allowNavigation: [],
        });
        expect(config.loggingBehavior).toBe('none');
        expect(config.plugins.CapacitorHttp.enabled).toBe(false);
        expect(config.includePlugins).toEqual(['@capacitor/app']);
    });
});
