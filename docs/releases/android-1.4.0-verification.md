# Android 1.4.0 verification

The signed APK for `org.askarys.hrttracker` advances the Android version code from 11 to 12. It requires Android 7.0 (API 24) or later and targets API 36. The launcher shortcut requires Android 7.1 (API 25) or later and a launcher that supports app shortcuts.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.4.0.apk` | `8d5eeccad1f41359415378085233dfa001b1a792e9852bbeefc63a034dd6b69b` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the v2 and v3 signatures. The certificate matched the published 1.3.0 APK. The APK passed the 16 KiB ZIP alignment check, and all 197 packaged web files matched the offline build byte for byte. The release manifest disables Android app backup, cleartext traffic and app debugging. The packaged Capacitor configuration disables WebView debugging.

The signed APK launched on a production Android 17 emulator (API 37, 16 KiB memory pages). The language picker and Overview both rendered. With the WebView renderer running, the Android socket table showed no WebView DevTools socket for the app process.

## Signed upgrade and offline backup

On an Android 16 emulator with no active network, the published 1.3.0 APK held a synthetic dose and lab result. Installing the signed 1.4.0 APK in place preserved the app's Android user ID and first installation time. The encrypted database matched byte for byte across the installation, and both records were visible after a cold launch.

In German, entering `1,5` saved a dose of 1.5 mg. Malformed input showed an inline error and left the record count unchanged. Long-pressing the app icon and choosing **Dosis hinzufügen** opened the dose form both from a stopped app and from a running app. Canceling left the record count unchanged.

The complete backup exported through Android's file picker contained two doses, one lab result, and the German language preference. After switching to English, merging that file restored German and retained the existing medication plan, as the import dialog reported. Both doses, the lab result, and German were present after another cold launch.

The German dose form showed three existing untranslated route labels (`route.nasal`, `route.sc`, and `route.pellet`) and a `0.0` placeholder. The signed release checks used emulators. The earlier Pixel 8 shortcut check is recorded in [PR #23](https://github.com/SweetSophia/hrt-tracker-mobile/pull/23).

## Automated checks

Vitest reported 1,683 passing tests, four expected failures, and 20 skips. All 102 mobile browser tests and all 91 web browser tests passed. Both TypeScript projects, version consistency, the web build, the bundle size check, and the Android offline release build passed.
