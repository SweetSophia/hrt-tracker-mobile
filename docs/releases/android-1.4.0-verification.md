# Android 1.4.0 verification

The signed APK for `org.askarys.hrttracker` advances the Android version code from 11 to 12. It requires Android 7.0 (API 24) or later and targets API 36. The launcher shortcut requires Android 7.1 (API 25) or later and a launcher that supports app shortcuts.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.4.0.apk` | `f45867f342d74aaac492d2ff8d46c217ed46cc15e070f3d21e6dbc3948605cfa` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the v2 and v3 signatures. The certificate matched the published 1.3.0 APK. The APK passed the 16 KiB ZIP alignment check, and all 197 packaged web files matched the offline build byte for byte. The release manifest disables Android app backup, cleartext traffic and app debugging. The packaged Capacitor configuration disables WebView debugging.

The signed APK launched on a production Android 17 emulator (API 37, 16 KiB memory pages). The language picker and Overview both rendered. With the WebView renderer running, the Android socket table showed no WebView DevTools socket for the app process.

## Signed upgrade and offline backup

On an Android 16 emulator with no active network, the published 1.3.0 APK held a synthetic dose and lab result. Installing the signed 1.4.0 APK in place preserved the app's Android user ID and first installation time. Both records were visible after a cold launch on 1.4.0.

In German, entering `1,5` saved a dose of 1.5 mg. In English, tapping **Save** on `1,234` displayed the decimal-format hint and left the dose count at two. Long-pressing the app icon and choosing **Dosis hinzufügen** opened the dose form both from a stopped app and from a running app. Canceling left the record count unchanged.

The complete backup exported through Android's file picker contained two doses, one lab result, a medication plan repeating every three days, and the German language preference. We switched to English and changed the local plan to weekly. Choosing **Merge** restored German, kept the weekly plan, and left the record counts unchanged. Choosing **Replace this device** restored the original three-day plan. Both doses and the lab result remained visible after an offline cold launch.

After clearing the synthetic tracker, we also selected the same file and tapped **Merge**. After another offline cold launch, the empty tracker had recovered both doses, the lab result, the three-day plan, and German.

The German dose picker and Calibration both displayed **Nasenspray**, **Subkutane Injektion**, and **Pellet**. Both screens showed the same three routes as **噴鼻劑**, **皮下注射**, and **皮下植入劑** in Cantonese. The language tests cover every dose-form route and every route that can have a calibration factor in all ten languages. The empty dose field uses the same `0.0` placeholder across languages. The signed release checks used emulators. The earlier Pixel 8 shortcut check is recorded in [PR #23](https://github.com/SweetSophia/hrt-tracker-mobile/pull/23).

## Automated checks

Vitest reported 1,692 passing tests, four expected failures, and 20 skips. All 102 mobile browser tests and all 91 web browser tests passed. Both TypeScript projects, version consistency, the web build, the bundle size check, and the Android offline release build passed.
