# Android record storage

The Android app stores dose and lab records through the shared `RecordStore` interface backed by SQLCipher 4.17.0 and Android Keystore. The signed APK uses `org.askarys.hrttracker`. The separate `storageQualification` variant exercises the native bridge with synthetic records. [Android build instructions](../../docs/mobile/15-offline-beta-preview.md)

## Storage boundary

- `EncryptedRecordStore(context, id, backend)` exposes `initialize`, `read`, `commit` and `close`. The store ID is an application-owned identifier; account owners belong in validated namespaces, never directory paths. Initialize before reads or writes.
- Record and portable preference changes use the shared namespace/key allowlist. Android also accepts `hrt-mode` in `device-preferences:v1` for the active mode on this device. One SQL transaction checks all revisions, then updates all requested namespaces. Empty changes assert dependencies without advancing revisions. A stale revision requires a fresh read and user review of the operation; never replay it automatically.
- Values and keys use canonical JSON string encoding inside encrypted SQL columns to preserve JavaScript UTF-16 strings. The shared fixture checks compatibility with `src/records/scope.ts`.
- A random 256-bit SQLCipher raw key is sealed using Keystore AES-256-GCM and authenticated store/backend identity. Envelopes are synced, renamed and directory-synced before database initialization returns. An initialization marker prevents recreating a missing established database. Invalid keys, envelopes and schemas fail without deleting records. The custom SQLCipher corruption handler deliberately preserves files.
- Before first key publication, interrupted temporary files are recoverable only when no database, journal or initialization marker exists. An authenticated complete key is preserved; incomplete unpublished fragments are removed after a durable replacement. Missing aliases, corrupt complete envelopes and ambiguous keys remain errors. A journal without its database always blocks recreation.
- Transactions use checked `journal_mode=DELETE`, `synchronous=EXTRA` and foreign keys. Schema version 1 is created transactionally. Future numbered migrations belong in this module; never reset an unknown version.
- `NativeSecretStore` has separate files and a Keystore alias. Secrets are strict UTF-8, bounded below 1 MiB including envelope overhead, and never appear in record snapshots. Missing entries return null; unreadable entries throw. Removal syncs the directory even on retry.

Both stores live in `noBackupFilesDir`. A JVM monitor and OS file lock coordinate library instances. These APIs perform blocking I/O; the qualification bridge runs them on a single I/O executor. I/O failures around commit/sync can have an uncertain outcome: reopen and inspect state before deciding what to retry.

## Temporary files and recovery policy

Interrupted replacements can leave `.pending-*.sealed` files. Cleanup runs under the store lock, only after record initialization has authenticated the key, validated the database/schema and published its marker, or after a secret has been successfully read/decoded or durably written. It removes only direct regular files with that name pattern; other names, directories and symlinks are preserved. It does not recurse.

Cleanup is best effort. Listing, deletion or directory-sync failures cannot hide a successful read or durable write. Leftovers can be retried by a later successful operation. This housekeeping is separate from the required durability of published files and SQLite commits.

| State                                                            | Policy                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| First record key unpublished; alias still usable                 | Authenticate and recover complete candidates before cleanup; retain existing fragment-recovery rules.          |
| Record open or secret authentication/write fails                 | Preserve pending evidence; do not sweep. Missing secret reads and removals also do not trigger a sweep.        |
| Only pending secret files remain, but alias is lost              | Writes fail without generating a replacement alias. Pending files still count as evidence in `hasEnvelopes()`. |
| Published data is missing, corrupt or uses an unsupported schema | Retain the existing failure and preservation rules; cleanup is never a repair/reset mechanism.                 |

The module has no destructive reset API. Task 3B must surface storage/recovery failures without silently clearing files or creating another identity to bypass them. Deleting temporary files cannot recover a lost key or decrypt existing ciphertext; any future discard, reauthentication or portable-record restore flow needs an explicit user decision and its own tested design. These are future integration requirements, not an implemented recovery UI.

## Qualification

With Node 22, JDK 21 and the Android SDK configured:

```sh
npm run android:sync:storage
cd android
./gradlew -PstorageQualification :app:assembleStorageQualification :app:assembleStorageQualificationAndroidTest
cd ..
node scripts/mobile/run-native-storage-qualification.mjs --serial emulator-5580 --output /tmp/native-storage-run --bridge --reboot
```

The runner accepts only explicitly selected dedicated HRT AVDs and checks their measured page size before installation. It creates synthetic data in the separate qualification app, counts actual instrumentation results and writes JSON, JUnit XML and a log. Killed preparation phases are not counted as passed tests.

SQLCipher Community Edition attribution and its license are bundled in `src/main/assets/licenses/`. AndroidX uses Apache 2.0. Preserve these notices and add accessible application attribution before shipping a production adapter; consult [Zetetic's notices](https://www.zetetic.net/sqlcipher/license/) when changing the native dependency.
