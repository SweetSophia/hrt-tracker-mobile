# Android 1.1.0 verification

The signed release updates `org.askarys.hrttracker` from version code 8 to 9. It supports Android 7.0 (API 24) and later and targets API 36.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.1.0.apk` | `1823df12ff2e37b937324c40d94f022d374547ad134919067710558556b76bd2` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the APK and the certificate matched the public 1.0.1 download. The APK passed 16 KiB ZIP alignment. All 197 files in its bundled web interface matched the offline production build byte for byte. The manifest disables Android app backup and cleartext traffic. Both the APK and the WebView disable debugging.

## Patch replacement

On an offline Android 16 emulator, three synthetic 100 µg/day patches logged three days apart with the development build produced a next-day estimate of 72.6 pg/mL after each application. History contained three applications and two removals linked to the correct patches. With replacement enabled in a saved medication plan, **Done** added the application and removal together. **Undo** restored the original history, and the saved plan survived a cold launch.

## Automated checks

Both TypeScript projects, the production builds, and bundle size checks passed. Vitest reported 1,619 passing tests, four expected failures, and 20 skips. Android lint reported zero errors and 10 warnings.
