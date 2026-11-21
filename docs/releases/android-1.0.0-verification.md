# Android 1.0.0 verification

The signed APK for tag `android-v1.0.0` installs as `org.askarys.hrttracker`, version code 7. It declares Android API 24 as its minimum and targets API 36.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.0.0.apk` | `3a6c9516b6f407e14c044210d63693892cdc040b51ee6497f3a464fd69030b5c` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the APK and the certificate matched the signed 0.0.6 beta. The APK passed 16 KiB alignment checks. Its bundled web files matched the release build. The manifest disables app backup and cleartext traffic.

On an offline API 36 emulator with 4 KiB pages, a fresh install opened in Traditional Chinese and showed the new public project in Credits. In a separate install on the same emulator, 0.0.6 imported a synthetic backup from Android's file picker. Updating it to the signed 1.0.0 APK preserved the app UID, dose and lab result after a force-stop and relaunch. The final APK also reopened those record types offline on an API 37 emulator with 16 KiB pages.

Both TypeScript checks, 49 mobile Playwright tests and 1,545 unit tests passed. Vitest also recorded four expected failures and 20 skips. Android lint reported zero errors and ten warnings. The release APK was tested on emulators. The maintainer separately reported that the preceding beta worked on their device.
