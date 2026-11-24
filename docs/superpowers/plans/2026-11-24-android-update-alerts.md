# Android Update Alerts Implementation Plan

> Implement the Android and interface tasks in parallel, then review and verify the integrated build.

People who installed the signed Android APK can find updates in **Settings → About**. About shows the installed version and offers **Check for updates**. An optional setting checks on app launch or return to the foreground, with at most one automatic attempt per 24 hours. It starts off. A notice offers **View release** and **Later** when a newer release is found. Later survives relaunch and applies to that version. A manual check still shows an available update after dismissal.

## Android release checks

- [x] Add a release-only Capacitor plugin in `android/app/src/storageQualification/java/`. Register it for `org.askarys.hrttracker` in `MainActivity`. Use the bundled HTTPS origin checks already used by the native document bridge.
- [x] Read the installed `versionName` from Android and persist consent, the last attempt, the available version, and the dismissed version in private Android preferences. Record an attempt before the request. An explicit check works independently of consent and also satisfies the daily check interval.
- [x] Query one bounded page at `https://api.github.com/repos/SweetSophia/hrt-tracker-mobile/releases?per_page=20`. Select the highest numeric `android-vMAJOR.MINOR.PATCH` from published, stable releases with the matching uploaded `hrt-tracker-MAJOR.MINOR.PATCH.apk`. Use a dedicated OkHttp client without cookies or credentials. Set a whole-request timeout and treat failures or an unrecognized release list as unavailable.
- [x] Open the public GitHub release page from an explicit button tap. Build the URL from the cached, validated version. The user chooses the APK on GitHub and Android handles the installation.
- [x] Add Android tests for default consent, throttling, failed writes and requests, version ordering, release filtering, and dismissal across a reload of local settings.

## App interface

- [x] Add an optional `HrtReleaseUpdates` adapter to the native runtime. Use `getState`, `setAutomatic`, `checkNow`, `checkOnOpen`, `dismiss`, and `openRelease`. State includes `installedVersion`, `automatic`, `availableVersion`, and `dismissedVersion`. The last two fields are nullable. The toggle passes `enabled`, and the notice actions pass `version`.
- [x] Check on startup and Android foreground events. Show checking, up-to-date, release available, and retry feedback for manual checks. Keep automatic network errors quiet. Stop showing the notice when automatic checks are off.
- [x] Add the About controls and dismissible notice using existing Settings and banner styles. Localize the text in every supported language. Keep checks separate from health records, backup data, and the web app's service worker.
- [x] Exercise the Settings and notice flow through the native bridge with release fixtures, and confirm the ordinary Android artifact excludes the update bridge.

## Review and verification

- [x] Run TypeScript, lint, format, unit, web build, and mobile checks. Build the Android release profile and verify it on a disposable emulator, including a manual check against the public release endpoint if network access is available.
- [x] Review consent, Android lifecycle, release selection, relaunch behavior, and what users can do with the notice. Fix verified findings and rerun the affected checks.

## Verification record

The Android 16 emulator ran a release-profile APK with a temporary 1.0.0 manifest version. The live GitHub check found 1.1.0 after the app returned to the foreground. View release sent the matching release URL to Chrome, and Later survived a force-stop. The in-place upgrade to the 1.1.0 build cleared the saved availability from Settings. A manual check showed retry feedback in airplane mode and reported the installed version as current after reconnecting. Both emulator APKs used the same debug certificate.

The 15 focused Android instrumented tests, 56 mobile browser tests, and 3 ordinary APK artifact checks passed. TypeScript, unit tests, formatting, web build, and bundle checks also passed. Lint reported its existing warnings and zero errors.

[About screenshot](../../mobile/screenshots/android-update-settings.png) · [Update notice screenshot](../../mobile/screenshots/android-update-notice.png)
