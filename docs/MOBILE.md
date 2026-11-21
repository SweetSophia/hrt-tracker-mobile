# HRT Tracker Mobile

## Goal

Create a native mobile app from Oyama's HRT Tracker, starting with Android
and adding an iPhone release later. Users should be able to use the app
directly on their phone without hosting the web application on another
machine or accessing it over LAN or Tailscale.

Keep the app modular so improvements from the web project remain practical
to review and port. The app is a bundled Capacitor build with shared React UI
and native adapters at the platform boundary.

## Repository baseline

The public history starts directly from upstream commit
`de7fd0701dcb2e2feaf1a57b4529572e9d1374b6`, fully incorporated, with the
Android port added on top. The baseline is recorded in `upstream.lock.json`.

- Primary web source: https://github.com/xunxunProjects/Oyama-s-HRT-Tracker
- Earlier upstream: https://github.com/LaoZhong-Mihari/HRT-Recorder-online

The bundled web code and README also describe the web and desktop app. Keep
the existing license, credits, and source attribution with the imported code.

## Tracking web changes

The initial local checkout uses these remotes:

- `origin`: `SweetSophia/hrt-tracker-mobile`, the mobile project.
- `web-upstream`: `xunxunProjects/Oyama-s-HRT-Tracker`, the primary web source.
- `upstream`: `LaoZhong-Mihari/HRT-Recorder-online`, its earlier upstream.

Fetch web updates with `git fetch web-upstream +refs/heads/main:refs/remotes/web-upstream/main`.
After the fetch succeeds, run `node scripts/mobile/check-upstream.mjs`
to see the incoming files and where they overlap with the mobile port.
Follow the [upstream sync log](upstream/SYNC-LOG.md)
for the recorded baseline and integration procedure. Configure the reference
remotes again in future clones.

## Android architecture

The app is a bundled Capacitor host around the shared React interface. Records
live in an on-device SQLCipher store whose key is protected by Android
Keystore, backups use the system document picker, and platform adapters sit at
the boundary so shared files stay close to the web source for review. Follow
the [upstream sync log](upstream/SYNC-LOG.md) when porting web changes.

## Developing the Android prototype

Use the Node patch in `.node-version`, JDK 21, and Android SDK/platform 36.
Set `JAVA_HOME` and `ANDROID_HOME` for your shell, then run:

```bash
npm ci
npm run mobile:doctor
npm run android:sync
./android/gradlew -p android :app:assembleDebug
```

`build:mobile` creates `dist-mobile/`; `android:sync` rebuilds it before
copying assets/plugins to the Android host. The web build still uses `npm
run build`. Mobile builds reject a nonempty `VITE_API_ORIGIN` and disable
PWA asset updates. Keep generated assets/build outputs and signing keys out
of Git. Mobile version fields live in `mobile/version.json`, separately
from the upstream web/Tauri version.

Devices need Android 7.0 or newer (minSdk 24). The build targets are:

- **Debug prototype**: `npm run android:sync` then
  `./android/gradlew -p android :app:assembleDebug`, installing as
  `org.askarys.hrttracker.spike`.
- **Offline beta preview**: `npm run build:mobile:offline-beta` then
  `./android/gradlew -p android -PofflineBeta :app:assembleOfflineBeta`,
  debug-signed and installing as `org.askarys.hrttracker.spike.offlinebeta`.
- **Release APK**: the offline-beta build with `-PprivateBeta`, aligned and
  signed with the project keystore, installing as `org.askarys.hrttracker`
  and published as `hrt-tracker-<version>.apk`. Signing steps in
  [mobile/15-offline-beta-preview.md](mobile/15-offline-beta-preview.md).

The `org.askarys.hrttracker.spike` APK is a synthetic-data prototype.
Its record store has not been migrated or qualified for real records.

The native record store ships in the offline beta preview and the release
build, and the dedicated `storageQualification` APK exists for storage
qualification. Ordinary prototype builds have `nativeRecords: false`.

## Running feasibility probes

`npm run test:e2e:mobile` tests ordinary built assets without a backend.
For synthetic native probes, use `npm run android:sync:probe`, then build
`:app:assembleDebug :app:assembleDebugAndroidTest`. Install both APKs on an
explicitly chosen device and run:

```bash
node scripts/mobile/run-device-probe.mjs --serial DEVICE --scenario engine --phase verify
node scripts/mobile/run-webview-checks.mjs --serial emulator-NUMBER --output /tmp/new-webview-report.json
node scripts/mobile/check-webview-durability.mjs --serial DEVICE --output /tmp/new-durability-report.json
```

The durability diagnostic currently fails immediate acknowledged-write
retention on the tested API 36 and API 37 emulators. Its delayed control is diagnostic only.
The WebView smoke runner seeds synthetic records and is restricted to a dedicated
emulator, with or without `--offline`. Before seeding, it refuses existing
credentials or nonempty record arrays without its fixture marker. Exact empty
arrays created by fresh app startup are allowed. Use non-seeding/manual checks
for physical-phone qualification; this command cannot overwrite a phone's records.
`connectedDebugAndroidTest` installs and subsequently uninstalls the prototype;
set `ANDROID_SERIAL` to the dedicated test device and inspect the generated XML.
Always finish with `npm run android:sync` and rebuild to remove probe assets.
Use synthetic records with the probe APK.

The community SQLite plugin is a rejected production candidate. It is available only in
probe syncs; ordinary sync removes its native registration and library. The
original Keystore probe envelope exists solely in the test APK. For the committed and
interrupted transaction probes, run `sqlite-batch prepare --abrupt`, then
`sqlite-batch verify`; follow with `sqlite-key prepare --abrupt` and
`sqlite-key verify`, always specifying the dedicated serial. These use only
the synthetic `hrt_feasibility` database.

## Ordinary artifact gate

After ordinary sync and APK assembly, run `npm run test:mobile:artifacts`.
This explicit gate fails on missing/stale outputs, probes or service workers,
unexpected native plugins, or a hosted shell configuration. It is separate
from `npm test` because it requires built Android artifacts. Run the installed
smoke with `run-webview-checks.mjs --serial emulator-NUMBER --ordinary --output NEW_FILE`.
The runtime remains conditional and the storage candidate stays rejected.
