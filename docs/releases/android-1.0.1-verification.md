# Android 1.0.1 verification

The release APK updates `org.askarys.hrttracker` from version code 7 to 8. It requires API 24 or later and targets API 36.

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `hrt-tracker-1.0.1.apk` | `98db6e05d0f4fd25bde0dd6bdcdfe3036171f18c8bcb351788fb5b0d22e0d38a` |
| Signing certificate     | `6200ccd2efe6120d78b386298729d98d88dd5c4db4acb5c3adb3bf1d8bd2dac5` |

Android's signing tool verified the APK against the certificate used for 1.0.0. It passed the 16 KiB alignment check. All 198 bundled web files matched the production build. The manifest disables Android app backup and cleartext traffic.

## Force-stop and upgrade

An offline API 36 emulator held a different synthetic dose in each mode. After each tap in Settings, the check waited for the new checkmark, force-stopped the app, then identified the cold-start mode from its dose history.

| Signed APK | Selected feminizing    | Selected masculinizing |
| ---------- | ---------------------- | ---------------------- |
| 1.0.0      | Reopened masculinizing | Reopened feminizing    |
| 1.0.1      | Reopened feminizing    | Reopened masculinizing |

Force-stop completed 30–32 ms after the visible checkmark on 1.0.0 and 27–33 ms on the final 1.0.1 APK. Updating the emulator in place kept the app UID, the previously selected masculinizing mode, both synthetic dose histories, and a lab result entered through the 1.0.0 form.

On 1.0.1, Android's file picker exported a complete backup. After adding another synthetic dose and reopening it from a cold start, the tester switched modes and restored the exported file. The restore removed the extra dose, preserved the original records, and kept the mode selected on the device.

## Physical Pixel 8

A Pixel 8 on API 37 updated from signed 1.0.0 to the first signed 1.0.1 candidate in place. Its app UID and original mode were retained. In Settings, the tester switched modes, observed the new checkmark, force-stopped the app, and checked the selection after a cold launch. Both directions passed, with the original mode restored and verified. The physical-device check used Settings only. Record and backup checks used synthetic data on the emulator.

## Automated checks

The browser suite injected a failed mode save, used the alert to retry the same choice, and verified that onboarding could advance after it was saved. Both TypeScript projects passed, along with 51 mobile Playwright tests and 1,553 unit tests. Vitest also recorded four expected failures and 20 skips. The targeted Android instrumentation test passed against the encrypted store. Android lint reported zero errors and 11 warnings.
