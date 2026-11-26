# HRT Tracker Mobile

English · [简体中文](./README.zh-CN.md)

**HRT Tracker Mobile** is the independent Android port of [Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker), maintained by [SweetSophia](https://github.com/SweetSophia) at Askarys. It brings the upstream tracker and its hormone level model directly to your phone. The app is bundled in the APK and works offline from first launch, so you can use it without a server, an account, or a LAN or Tailscale connection.

## Android features

- **On-device records.** Log doses and lab results in feminizing and masculinizing modes. Records are encrypted at rest in a local SQLCipher database with a key protected by Android Keystore.
- **Charts and planning.** View estimated hormone levels over time, compare estimates with labs, and use medication plans, supplies, and what-if forecasts. When logging a patch change, you can record removing the previous patch in the same step.
- **Color themes.** Choose Terracotta, Plum, or Teal with Light, Dark, or System. Complete backups include your saved palette.
- **Portable backups.** Use Android's file picker to save or restore a complete backup of both modes. A compatible backup file can carry records from the web tracker or the earlier Android preview. Complete backup exports contain readable health data.
- **Optional update checks.** Check for new Android releases in **Settings → About**. Automatic checks are off by default and use public release information from GitHub.
- **Phone controls and ten languages.** The app supports Android Back navigation and adapts its screens to phones. The interface offers Simplified Chinese, Traditional Chinese, Cantonese, English, German, Japanese, Korean, Turkish, Russian, and Ukrainian.

## Download for Android

[Download the signed Android APK (1.3.0)](https://github.com/SweetSophia/hrt-tracker-mobile/releases/download/android-v1.3.0/hrt-tracker-1.3.0.apk) · [Release notes in English and Simplified Chinese](https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/android-v1.3.0)

HRT Tracker runs on Android 7.0 or newer. To update an earlier signed release or the private **HRT Tracker** beta, open the APK and choose **Update**. The Android package ID is `org.askarys.hrttracker`. An iPhone version is planned.

## Build and contribute

Use the Node version in [`.node-version`](./.node-version), JDK 21, and Android SDK Platform 36. Build the debug preview from the repository root:

```sh
npm ci
npm run android:sync
npm run build:mobile:offline-beta
./android/gradlew -p android -PofflineBeta :app:assembleOfflineBeta
```

The preview APK is at `android/app/build/outputs/apk/offlineBeta/app-offlineBeta.apk` and installs as the debug package `org.askarys.hrttracker.spike.offlinebeta`. These commands build the debug preview target only; the release target (`org.askarys.hrttracker`) is aligned and signed with the project keystore as described in the build and signing guide above. Run `npm test` for unit tests and `npm run test:e2e:mobile` for browser checks of the mobile bundle.

Android testing, issue reports, translations, accessibility feedback, design, documentation, and code are welcome. Start with the [contributor guide](./CONTRIBUTING.md) or [open an issue](https://github.com/SweetSophia/hrt-tracker-mobile/issues/new/choose). Use sample records when reporting a problem.

## Upstream and attribution

The Android app bundles the shared React interface and TypeScript model in Capacitor. Android storage, file picking, and lifecycle adapters live at the platform boundary so changes from the web project can be reviewed and brought over. The [upstream sync log](./docs/upstream/SYNC-LOG.md) records that process.

[Oyama's HRT Tracker](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker) is the upstream web project. Its README covers the hosted web app, desktop versions, cloud backup, and share links. The original tracker and pharmacokinetic work come from [LaoZhong-Mihari's HRT-Recorder](https://github.com/LaoZhong-Mihari/HRT-Recorder-online) and [PK model repository](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test). See the [algorithm explanation](./Algorithm%20Explanation.md) and [MIT license](./LICENSE).

### Docker

For self-hosting the web tracker, follow the [upstream Docker guide](https://github.com/xunxunProjects/Oyama-s-HRT-Tracker#docker).

> **For information only.** The app shows model estimates that can differ from measured hormone levels. Discuss treatment decisions with a clinician.
