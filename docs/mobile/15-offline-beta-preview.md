# Android build and signing guide

The preview runs the shared tracker screens from assets bundled in the Android app. Dose and lab records use the SQLCipher store through the native record bridge. Backup export and import use Android's system document picker.

The debug-signed preview installs as **HRT Tracker Offline Beta** (`org.askarys.hrttracker.spike.offlinebeta`). Its separate app data starts empty. Use synthetic records for this preview.

## Build

Use the [Android development prerequisites](../MOBILE.md#developing-the-android-prototype) for the pinned Node version, JDK 21, and Android SDK Platform 36. Leave `VITE_API_ORIGIN` unset or empty. Run these commands from the repository root.

```sh
npm ci
npm run android:sync
npm run build:mobile:offline-beta
./android/gradlew -p android -PofflineBeta :app:assembleOfflineBeta
```

The APK is at `android/app/build/outputs/apk/offlineBeta/app-offlineBeta.apk`. The two npm build steps supply Capacitor's configuration and the beta's web assets. Run both after changing web assets or switching from a qualification build.

## Run the release-update checks

Run the focused Android instrumented tests on a dedicated emulator with the [Android development tools](../MOBILE.md#developing-the-android-prototype) installed. Gradle uses the separate storage-qualification app. The tests use fake release responses.

From the repository root, run the following commands with one emulator connected. Set `ANDROID_SERIAL` to select it when multiple devices are connected.

```sh
npm run android:sync:storage
./android/gradlew -p android -PstorageQualification \
  -Pandroid.testInstrumentationRunnerArguments.class=org.askarys.hrttracker.updates.ReleaseUpdatesTest \
  :app:connectedStorageQualificationAndroidTest
```

Gradle writes the connected test report under `android/app/build/reports/androidTests/connected/`.

## Build and sign the release APK

**HRT Tracker** installs as `org.askarys.hrttracker`. Keep this ID and the same Android signing key for future updates; APKs signed with the same certificate as the earlier private beta builds install in place. Use `mobile/version.json` to set the version name and increase the version code, and name the signed file `hrt-tracker-<version>.apk`. To move records from the debug preview, export a complete backup there and import it from Settings in HRT Tracker.

After the same npm setup above, assemble the unsigned release variant and align it before signing. Set `HRT_ANDROID_RELEASE_KEYSTORE` to the project keystore outside the checkout. Android's signing tool prompts for its password.

```sh
./android/gradlew -p android -PofflineBeta -PprivateBeta :app:assembleOfflineBeta
sdk_tools="$ANDROID_HOME/build-tools/36.0.0"
unsigned="android/app/build/outputs/apk/offlineBeta/app-offlineBeta-unsigned.apk"
output=$(mktemp -d)
version=$(node -p "require('./mobile/version.json').versionName")
apk="$output/hrt-tracker-$version.apk"
"$sdk_tools/zipalign" -P 16 4 "$unsigned" "$output/aligned.apk"
"$sdk_tools/apksigner" sign --ks "$HRT_ANDROID_RELEASE_KEYSTORE" --ks-key-alias release \
  --v4-signing-enabled false --out "$apk" "$output/aligned.apk"
"$sdk_tools/apksigner" verify --verbose --print-certs "$apk"
"$sdk_tools/zipalign" -c -P 16 4 "$apk"
printf '%s\n' "$apk"
```

Keep the keystore and its password in project-controlled storage outside Git and preserve both for upgrades. [Android signing and key custody](https://developer.android.com/studio/publish/app-signing)

## Release checklist

For in-app update checks, publish the stable Android release under the tag `android-v<version>` and upload `hrt-tracker-<version>.apk` to that release on [GitHub](https://github.com/SweetSophia/hrt-tracker-mobile/releases). Match `<version>` to `versionName` in the APK and increase `versionCode` from the previous release.

The checker compares Android versions within the first 100 releases returned by GitHub. Keep the latest stable Android release in that window as other platforms are added. The app uses a fixed release repository URL. Plan for existing installs before renaming or transferring the repository.

Before publishing, install the signed APK on a device or emulator with no active default network and walk the core offline journey: save a synthetic dose and lab result, force-stop and reopen the app, then export and restore a complete backup through the file picker. Use synthetic records only, and report device-specific problems through [issues](https://github.com/SweetSophia/hrt-tracker-mobile/issues/new/choose).
