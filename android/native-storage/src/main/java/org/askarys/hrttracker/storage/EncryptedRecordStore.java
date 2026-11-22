package org.askarys.hrttracker.storage;

import android.content.Context;
import android.database.Cursor;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.util.*;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.askarys.hrttracker.storage.RecordProtocol.Change;
import org.askarys.hrttracker.storage.RecordProtocol.Snapshot;

/** App-owned transactional record store; used by the qualification bridge only. */
public final class EncryptedRecordStore implements AutoCloseable {
    private static final byte[] INITIALIZED = "native-records-v1\n".getBytes(StandardCharsets.US_ASCII);
    private final File root;
    private final String identity;
    private final String backend;
    private SQLiteDatabase database;

    public EncryptedRecordStore(Context context, String id, String backend) {
        if (backend == null || backend.isEmpty()) throw new IllegalArgumentException("Missing backend identity");
        this.backend = backend;
        identity = context.getPackageName() + ".native-records." + StoreGuard.id(id);
        root = new File(context.getNoBackupFilesDir(), "native-records/" + id);
    }

    /** Only called before any published key, database, journal or initialization marker exists. */
    private void recoverUnpublishedKey(File keyFile, List<File> pending, KeystoreEnvelope envelope, String aad) throws Exception {
        if (pending.isEmpty()) return;
        // The alias is created before the temporary file. Losing it is not an ordinary interrupted write.
        envelope.requireExistingKey();
        byte[] recovered = null, encodedKey = null;
        try {
            for (File file : pending) {
                byte[] encoded = DurableFiles.read(file, 1024);
                // A version-1 envelope of a 32-byte key is 72 bytes. A shorter unpublished file
                // cannot contain committed data: SQLite is never opened before key publication.
                if (encoded.length < 72) continue;
                byte[] candidate = envelope.open(encoded, aad);
                try {
                    if (candidate.length != 32 || (recovered != null && !MessageDigest.isEqual(recovered, candidate))) {
                        throw new IOException("Ambiguous unpublished database key; evidence preserved");
                    }
                    if (recovered == null) { recovered = candidate.clone(); encodedKey = encoded; }
                } finally { Arrays.fill(candidate, (byte) 0); }
            }
            if (recovered == null) {
                recovered = new byte[32];
                new SecureRandom().nextBytes(recovered);
                encodedKey = envelope.seal(recovered, aad, false);
            }
            // Preserve an authenticated complete key, including repeated crashes during this promotion.
            DurableFiles.replace(keyFile, encodedKey);
            for (File file : pending) DurableFiles.remove(file);
        } finally {
            if (recovered != null) Arrays.fill(recovered, (byte) 0);
        }
    }

    public void initialize() throws Exception {
        StoreGuard.with(root, () -> {
            if (database != null) return null;
            File keyFile = new File(root, "key.sealed"), dbFile = new File(root, "records.db"), marker = new File(root, "initialized");
            String[] artifacts = root.list((dir, name) -> name.startsWith("records.db") || name.endsWith(".sealed") || name.equals("initialized"));
            if (artifacts == null) throw new IOException("Cannot inspect record storage");
            List<File> pending = new ArrayList<>();
            for (String name : artifacts) {
                boolean unpublished = name.startsWith(".pending-") && name.endsWith(".sealed");
                if (!keyFile.exists() && !unpublished) throw new IOException("Record key missing; data preserved");
                if (!dbFile.exists() && name.startsWith("records.db")) throw new IOException("Database missing with recovery artifacts; evidence preserved");
                if (unpublished) pending.add(new File(root, name));
            }
            if (marker.exists() && (!dbFile.isFile() || !Arrays.equals(INITIALIZED, DurableFiles.read(marker, 64)))) {
                throw new IOException("Established database missing or initialization marker invalid");
            }
            KeystoreEnvelope envelope = new KeystoreEnvelope(identity);
            String keyIdentity = identity + ":" + RecordProtocol.quote(backend);
            byte[] key = null, rawKey = null;
            try {
                if (!keyFile.exists()) recoverUnpublishedKey(keyFile, pending, envelope, keyIdentity);
                if (keyFile.exists()) key = envelope.open(DurableFiles.read(keyFile, 1024), keyIdentity);
                else {
                    key = new byte[32];
                    new SecureRandom().nextBytes(key);
                    DurableFiles.replace(keyFile, envelope.seal(key, keyIdentity, true));
                }
                if (key.length != 32) throw new IOException("Invalid database key");
                // Complete an earlier rename whose directory sync may have failed before returning.
                DurableFiles.syncDirectory(root);
                rawKey = new byte[67]; rawKey[0] = 'x'; rawKey[1] = '\''; rawKey[66] = '\'';
                byte[] hex = "0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
                for (int i = 0; i < 32; i++) { rawKey[2 + 2 * i] = hex[(key[i] & 255) >>> 4]; rawKey[3 + 2 * i] = hex[key[i] & 15]; }
                System.loadLibrary("sqlcipher");
                int flags = SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS;
                if (!dbFile.exists()) flags |= SQLiteDatabase.CREATE_IF_NECESSARY;
                // SQLCipher's default corruption handler can delete files. Always preserve them here.
                database = SQLiteDatabase.openDatabase(dbFile.getAbsolutePath(), rawKey, null, flags,
                    (db, cause) -> { throw new android.database.sqlite.SQLiteException("Encrypted database unavailable; data preserved", cause); }, null);
                scalar("SELECT count(*) FROM sqlite_master"); // Authenticate an existing database before changing it.
                long version = scalar("PRAGMA user_version");
                if (version > 1 || version < 0 || (version == 0 && marker.exists())) throw new IOException("Unsupported record schema");
                if (!"4.17.0 community".equals(text("PRAGMA cipher_version"))) throw new IOException("Unqualified SQLCipher version");
                if (!"delete".equals(text("PRAGMA journal_mode=DELETE"))) throw new IOException("Unexpected journal mode");
                database.execSQL("PRAGMA synchronous=EXTRA");
                database.setForeignKeyConstraintsEnabled(true);
                if (scalar("PRAGMA synchronous") != 3 || scalar("PRAGMA foreign_keys") != 1) throw new IOException("Unsafe database settings");
                if (version == 0) {
                    if (scalar("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") != 0) throw new IOException("Unknown initial schema");
                    database.beginTransaction();
                    try {
                        database.execSQL("CREATE TABLE namespaces (name TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991))");
                        database.execSQL("CREATE TABLE entries (namespace TEXT NOT NULL REFERENCES namespaces(name), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))");
                        database.execSQL("PRAGMA user_version=1");
                        database.setTransactionSuccessful();
                    } finally { database.endTransaction(); }
                }
                // Reject missing columns/tables; never recreate an established schema.
                try (Cursor ignored = database.rawQuery("SELECT n.name,n.revision,e.key,e.value FROM namespaces n LEFT JOIN entries e ON e.namespace=n.name LIMIT 0", (String[]) null)) {
                    ignored.getCount();
                }
                if (!marker.exists()) DurableFiles.replace(marker, INITIALIZED);
                DurableFiles.cleanupPending(root);
                return null;
            } catch (Exception | LinkageError failure) {
                if (database != null) {
                    try { database.close(); } catch (Exception closeFailure) { failure.addSuppressed(closeFailure); }
                    database = null;
                }
                throw failure;
            } finally {
                if (key != null) Arrays.fill(key, (byte) 0);
                if (rawKey != null) Arrays.fill(rawKey, (byte) 0);
            }
        });
    }

    private void ready() {
        if (database == null) throw new IllegalStateException("Initialize record storage before use");
    }

    private String text(String query) throws IOException {
        try (Cursor cursor = database.rawQuery(query, (String[]) null)) {
            if (!cursor.moveToFirst()) throw new IOException("Missing database result");
            return cursor.getString(0);
        }
    }

    private long scalar(String query) throws IOException { return Long.parseLong(text(query)); }

    private Snapshot snapshot(String namespace) throws Exception {
        Set<String> keys = RecordProtocol.allowedKeys(namespace, backend);
        long revision = 0;
        try (Cursor cursor = database.rawQuery("SELECT revision FROM namespaces WHERE name=?", new String[] { namespace })) {
            if (cursor.moveToFirst()) {
                if (cursor.getType(0) != Cursor.FIELD_TYPE_INTEGER) throw new IOException("Invalid stored revision");
                revision = cursor.getLong(0);
            }
        }
        RecordProtocol.revision(revision);
        Map<String, String> entries = new LinkedHashMap<>();
        try (Cursor cursor = database.rawQuery("SELECT key,value FROM entries WHERE namespace=?", new String[] { namespace })) {
            while (cursor.moveToNext()) {
                String key = RecordProtocol.unquote(cursor.getString(0)), value = RecordProtocol.unquote(cursor.getString(1));
                if (!keys.contains(key) || revision == 0 || entries.put(key, value) != null) throw new IOException("Invalid stored record");
                if (RecordProtocol.DEVICE_PREFERENCES.equals(namespace) && !RecordProtocol.isDeviceMode(value))
                    throw new IOException("Invalid stored record");
            }
        }
        return new Snapshot(revision, entries);
    }

    /** Reads do not adopt legacy storage or write defaults. */
    public Snapshot read(String namespace) throws Exception {
        return StoreGuard.with(root, () -> { ready(); return snapshot(namespace); });
    }

    public Map<String, Snapshot> commit(List<Change> changes) throws Exception {
        List<Change> batch = new ArrayList<>(changes);
        Set<String> unique = new HashSet<>();
        for (Change change : batch) {
            RecordProtocol.validate(change, backend);
            if (!unique.add(change.namespace)) throw new IllegalArgumentException("Duplicate record namespace");
        }
        return StoreGuard.with(root, () -> {
            ready();
            Map<String, Snapshot> result = new LinkedHashMap<>();
            database.beginTransaction();
            try {
                for (Change change : batch) {
                    Snapshot before = snapshot(change.namespace);
                    if (before.revision != change.expectedRevision) throw new RecordProtocol.StaleRevisionException();
                    boolean changed = !change.puts.isEmpty() || !change.removes.isEmpty();
                    if (changed && before.revision == RecordProtocol.MAX_REVISION) throw new IllegalStateException("Revision exhausted");
                    Map<String, String> entries = new LinkedHashMap<>(before.entries);
                    entries.putAll(change.puts);
                    for (String key : change.removes) entries.remove(key);
                    result.put(change.namespace, new Snapshot(before.revision + (changed ? 1 : 0), entries));
                }
                // Every revision and key has been checked before the first mutation.
                for (Change change : batch) {
                    if (change.puts.isEmpty() && change.removes.isEmpty()) continue;
                    database.execSQL("INSERT INTO namespaces(name,revision) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision",
                        new Object[] { change.namespace, result.get(change.namespace).revision });
                    for (Map.Entry<String, String> entry : change.puts.entrySet()) {
                        database.execSQL("INSERT INTO entries(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
                            new Object[] { change.namespace, RecordProtocol.quote(entry.getKey()), RecordProtocol.quote(entry.getValue()) });
                    }
                    for (String key : change.removes) database.execSQL("DELETE FROM entries WHERE namespace=? AND key=?", new Object[] { change.namespace, RecordProtocol.quote(key) });
                }
                database.setTransactionSuccessful();
            } finally { database.endTransaction(); }
            // No post-commit reads: acknowledgement is built inside the transaction and returned after commit durability.
            return Collections.unmodifiableMap(result);
        });
    }

    @Override public void close() throws Exception {
        StoreGuard.with(root, () -> {
            if (database != null) { database.close(); database = null; }
            return null;
        });
    }
}
