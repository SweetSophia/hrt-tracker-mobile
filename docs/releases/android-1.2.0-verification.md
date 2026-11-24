# Android 1.2.0 verification

The signed APK updates `org.askarys.hrttracker` from version code 9 to 10. It supports Android 7.0 (API 24) and later and targets API 36.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.2.0.apk` | `4619cc0599cae8a7bc2bb065cf0cdcac1d98ef81b370bd01a6116b6ee256d91a` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the APK and its certificate matched the public 1.1.0 release. The APK passed 16 KiB ZIP alignment. All 197 bundled web files matched the offline build. The manifest disables Android app backup and cleartext traffic. APK and WebView debugging are disabled.

## Signed upgrade and offline backup

On an Android 16 emulator with no active default network, the public 1.1.0 APK preserved a synthetic dose and lab result after a force-stop and cold launch. Installing the signed 1.2.0 APK in place preserved both records, the app's Android user ID, and its first installation time.

On signed 1.2.0, a complete backup exported and restored through Android's file picker preserved the dose and original lab after a cold launch and removed the test lab added after export. A new synthetic dose saved while offline also survived a cold launch.

## Update checks

The signed candidate showed version 1.2.0 in **Settings → About**. A manual check showed retry feedback while the emulator was offline. After reconnecting, a manual check of the public GitHub release list reported 1.2.0 up to date.

## Automated checks

All eight GitHub checks passed on [PR #16](https://github.com/SweetSophia/hrt-tracker-mobile/pull/16). Vitest reported 1,619 passing tests, four expected failures, and 20 skips. Both TypeScript projects passed on the release branch, and the production Android build completed.
