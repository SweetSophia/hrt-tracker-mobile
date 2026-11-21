# Synthetic backup compatibility vectors

All records, identifiers, timestamps, and the password here are invented. No
fixture came from a person's account. `complete-v1.json` pins both modes and all
six supply pack kinds, arrays, tombstones, scalar settings and portable preferences.
`legacy-v1.json` is the older flat event-array form. `records-v2.json` follows the
current records export envelope, including fields whose manual-import coverage
is narrower than cloud sync. These files are deliberately frozen, not regenerated
by the implementation under test.

`encrypted-v1.json` wraps the exact UTF-8 bytes of `complete-v1.json` using the
existing AES-256-GCM / PBKDF2-SHA256 envelope, 600,000 rounds, and password
`synthetic-qualification-password`. It was generated independently with Node's
crypto implementation. Fixed salt/IV are ONLY for this synthetic vector; actual
export uses the application's random salt/IV generator.

The harness builds web exports with the real shared builder, imports them through
the supplied RecordStore/controller, exports again, and reimports through a fresh
WebRecordStore. Canonical comparison sorts object keys only; it preserves array
order and every semantic field. The complete-export clock is fixed at
2030-01-02T00:00:00.000Z. Source account tags are retained and compared within the
same synthetic owner. Storage recovery hashes also include namespace revisions.

Aliases, malformed categories, limit boundaries, conflicts and replacement
variants are deterministic derivatives of these vectors. No synthetic test
bridge or fixture is allowed in the ordinary APK.

`checks-v1.json` is the explicit expected result-name inventory, shared by the
unit assertion and host runner. It lists 55 behavioral checks and the separate
`configuredLimitsPinned` constant pin. Missing, renamed, extra or failed checks
are rejected; a minimum-count threshold is not sufficient.
