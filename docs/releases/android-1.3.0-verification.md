# Android 1.3.0 verification

The signed APK updates `org.askarys.hrttracker` from version code 10 to 11. It supports Android 7.0 (API 24) and later and targets API 36.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.3.0.apk` | `02ba481bf345f21df58c1327d90619899c1c7b7427caddef63d0f69c2a2c3174` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the APK and its certificate matched the published 1.2.0 APK. The APK passed 16 KiB ZIP alignment, and all 197 bundled web files matched the offline build. The manifest disables Android app backup and cleartext traffic. App and WebView debugging are disabled in the package configuration.

The signed APK exposed no WebView DevTools connection on an API 37 emulator with a production Android image. Chromium enables WebView debugging on the API 36 development image used for the offline checks. [Chromium WebView documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/net-debugging.md)

## Signed upgrade and offline backup

On an Android 16 emulator with no active default network, the published 1.2.0 APK preserved a synthetic dose and lab result after a cold launch. Updating in place to the signed 1.3.0 APK preserved both records, the app's Android user ID, and its first installation time.

Choosing Plum while offline survived a force-stop and cold launch. The complete backup exported through Android's file picker contained the selected palette and both records. After switching to Teal, merging that file restored Plum. Both records and Plum were present after another cold launch.

## Automated checks

Vitest reported 1,624 passing tests, four expected failures, and 20 skips. Both TypeScript projects and version consistency checks passed. The production Android build completed.
