package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import org.askarys.hrttracker.storage.RecordProtocol.*;

public final class RecordStoreTest {
    static final String LOCAL = "records:v1:[\"offline\",\"local\"]";
    static final String ACCOUNT = "records:v1:[\"offline\",\"alice\"]";
    static final String PREFS = "preferences:v1";
    private Context context;
    private String id;
    private File root;
    private EncryptedRecordStore store;

    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        id = "test-" + UUID.randomUUID();
        root = new File(context.getNoBackupFilesDir(), "native-records/" + id);
        store = new EncryptedRecordStore(context, id, "offline");
    }
    @After public void close() throws Exception { store.close(); }

    static Change put(String namespace, long revision, String key, String value) {
        return new Change(namespace, revision, Collections.singletonMap(key, value), Collections.emptyList());
    }
    static Change dependency(String namespace, long revision) {
        return new Change(namespace, revision, Collections.emptyMap(), Collections.emptyList());
    }
    static Object database(EncryptedRecordStore store) throws Exception {
        java.lang.reflect.Field field = EncryptedRecordStore.class.getDeclaredField("database");
        field.setAccessible(true);
        return field.get(store);
    }
    static void sql(EncryptedRecordStore store, String statement) throws Exception {
        database(store).getClass().getMethod("execSQL", String.class).invoke(database(store), statement);
    }
    static long scalar(EncryptedRecordStore store, String statement) throws Exception {
        Object db = database(store);
        try (android.database.Cursor cursor = (android.database.Cursor) db.getClass()
                .getMethod("rawQuery", String.class, String[].class).invoke(db, statement, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }
    private void reopen() throws Exception {
        store.close();
        store = new EncryptedRecordStore(context, id, "offline");
        store.initialize();
    }

    @Test public void emptyReadsAndDependenciesDoNotCreateDefaults() throws Exception {
        assertThrows(Exception.class, () -> store.read(LOCAL));
        store.initialize();
        store.initialize();
        assertEquals(0, store.read(LOCAL).revision);
        assertTrue(store.read(LOCAL).entries.isEmpty());
        Map<String, Snapshot> ack = store.commit(Arrays.asList(dependency(LOCAL, 0), dependency(PREFS, 0)));
        assertEquals(2, ack.size());
        assertEquals(0, ack.get(PREFS).revision);
        assertEquals(0, scalar(store, "SELECT count(*) FROM namespaces"));
        assertTrue(store.commit(Collections.emptyList()).isEmpty());
    }

    @Test public void bothModesPreferencesAndAccountCommitAtomically() throws Exception {
        store.initialize();
        Map<String, String> modes = new LinkedHashMap<>();
        modes.put("hrt-events", "synthetic-fem");
        modes.put("hrt-masc-events", "synthetic-masc");
        Map<String, Snapshot> ack = store.commit(Arrays.asList(new Change(LOCAL, 0, modes, Collections.emptyList()),
                put(PREFS, 0, "app-theme", "dark"), put(ACCOUNT, 0, "hrt-ualice-weight", "synthetic")));
        assertEquals(1, ack.get(LOCAL).revision);
        assertThrows(UnsupportedOperationException.class, () -> ack.clear());
        assertThrows(UnsupportedOperationException.class, () -> ack.get(LOCAL).entries.clear());
        modes.clear();
        reopen();
        assertEquals("synthetic-fem", store.read(LOCAL).entries.get("hrt-events"));
        assertEquals("synthetic-masc", store.read(LOCAL).entries.get("hrt-masc-events"));
        assertEquals("dark", store.read(PREFS).entries.get("app-theme"));
        assertEquals(1, store.read(ACCOUNT).revision);
        Map<String, Snapshot> removed = store.commit(Arrays.asList(new Change(LOCAL, 1, Collections.emptyMap(), Arrays.asList("hrt-events")), dependency(PREFS, 1)));
        assertEquals(2, removed.get(LOCAL).revision);
        assertEquals(1, removed.get(PREFS).revision);
        assertFalse(removed.get(LOCAL).entries.containsKey("hrt-events"));
    }

    @Test public void staleReadDependencyRejectsWholeBatchBeforeMutation() throws Exception {
        store.initialize();
        store.commit(Arrays.asList(put(PREFS, 0, "app-theme", "dark")));
        assertThrows(StaleRevisionException.class, () -> store.commit(Arrays.asList(
                put(LOCAL, 0, "hrt-events", "new"), dependency(PREFS, 0))));
        assertEquals(0, store.read(LOCAL).revision);
        assertEquals("dark", store.read(PREFS).entries.get("app-theme"));
    }

    @Test public void invalidBatchAndUnsafeRevisionsNeverWrite() throws Exception {
        store.initialize();
        List<List<Change>> invalid = Arrays.asList(
            Arrays.asList(put(LOCAL, 0, "hrt-events", "x"), put(LOCAL, 0, "hrt-weight", "x")),
            Arrays.asList(put(LOCAL, 0, "hrt-events", "x"), put(PREFS, 0, "auth-token", "secret")),
            Arrays.asList(new Change(LOCAL, 0, Collections.singletonMap("hrt-events", "x"), Arrays.asList("hrt-events"))),
            Arrays.asList(new Change(LOCAL, 0, Collections.emptyMap(), Arrays.asList("hrt-events", "hrt-events"))),
            Arrays.asList(put(LOCAL, -1, "hrt-events", "x")),
            Arrays.asList(put(LOCAL, RecordProtocol.MAX_REVISION + 1, "hrt-events", "x"))
        );
        for (List<Change> batch : invalid) assertThrows(Exception.class, () -> store.commit(batch));
        assertEquals(0, store.read(LOCAL).revision);
        assertEquals(0, scalar(store, "SELECT count(*) FROM namespaces"));
        assertThrows(Exception.class, () -> store.read("records:v1:[\"foreign\",\"local\"]"));
    }

    @Test public void concurrentInstancesAllowOnlyOneRevisionWinner() throws Exception {
        store.initialize();
        try (EncryptedRecordStore other = new EncryptedRecordStore(context, id, "offline")) {
            other.initialize();
            ExecutorService pool = Executors.newFixedThreadPool(2);
            CountDownLatch start = new CountDownLatch(1);
            try {
                List<Future<Boolean>> results = new ArrayList<>();
                for (EncryptedRecordStore candidate : Arrays.asList(store, other)) {
                    results.add(pool.submit(() -> {
                        start.await();
                        try { candidate.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "winner"))); return true; }
                        catch (StaleRevisionException expected) { return false; }
                    }));
                }
                start.countDown();
                assertNotEquals(results.get(0).get(10, TimeUnit.SECONDS), results.get(1).get(10, TimeUnit.SECONDS));
            } finally { pool.shutdownNow(); }
        }
        assertEquals(1, store.read(LOCAL).revision);
    }

    @Test public void capacityFailureRollsBackEarlierNamespaceAndRemainsUsable() throws Exception {
        store.initialize();
        store.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "old"), put(PREFS, 0, "app-theme", "old")));
        long pages = scalar(store, "PRAGMA page_count");
        assertEquals(pages, scalar(store, "PRAGMA max_page_count=" + pages));
        char[] large = new char[1024 * 1024];
        Arrays.fill(large, 'x');
        assertThrows(Exception.class, () -> store.commit(Arrays.asList(
            put(PREFS, 1, "app-theme", "changed-first"), put(LOCAL, 1, "hrt-events", new String(large)))));
        assertEquals("old", store.read(PREFS).entries.get("app-theme"));
        assertEquals(1, store.read(PREFS).revision);
        assertEquals("old", store.read(LOCAL).entries.get("hrt-events"));
        reopen();
        assertEquals(1, store.read(LOCAL).revision);
        store.commit(Arrays.asList(put(LOCAL, 1, "hrt-events", "next")));
        assertEquals(2, store.read(LOCAL).revision);
    }

    @Test public void missingEnvelopeOrDatabaseNeverReinitializes() throws Exception {
        store.initialize();
        store.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "sentinel")));
        store.close();
        File key = new File(root, "key.sealed");
        byte[] savedKey = Files.readAllBytes(key.toPath());
        byte[] savedDb = Files.readAllBytes(new File(root, "records.db").toPath());
        assertTrue(key.delete());
        assertThrows(Exception.class, () -> store.initialize());
        assertFalse(key.exists());
        assertArrayEquals(savedDb, Files.readAllBytes(new File(root, "records.db").toPath()));
        Files.write(key.toPath(), savedKey);
        assertTrue(new File(root, "records.db").delete());
        assertThrows(Exception.class, () -> store.initialize());
        assertFalse(new File(root, "records.db").exists());
    }

    @Test public void missingAliasAndWrongDatabaseKeyPreserveExistingDatabase() throws Exception {
        store.initialize();
        store.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "sentinel")));
        store.close();
        String alias = context.getPackageName() + ".native-records." + id;
        File key = new File(root, "key.sealed");
        byte[] before = Files.readAllBytes(new File(root, "records.db").toPath());
        DurableFiles.replace(key, new KeystoreEnvelope(alias).seal(new byte[32], alias + ":\"offline\"", false));
        assertThrows(Exception.class, () -> store.initialize());
        assertArrayEquals(before, Files.readAllBytes(new File(root, "records.db").toPath()));
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        keys.deleteEntry(alias);
        assertThrows(Exception.class, () -> store.initialize());
        assertFalse(keys.containsAlias(alias));
    }

    @Test public void futureSchemaAndCorruptDatabaseAreNotReset() throws Exception {
        store.initialize();
        sql(store, "PRAGMA user_version=2");
        store.close();
        byte[] before = Files.readAllBytes(new File(root, "records.db").toPath());
        assertThrows(Exception.class, () -> store.initialize());
        assertArrayEquals(before, Files.readAllBytes(new File(root, "records.db").toPath()));
        byte[] invalid = "synthetic-corrupt-database".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(root, "records.db").toPath(), invalid);
        assertThrows(Exception.class, () -> store.initialize());
        assertArrayEquals(invalid, Files.readAllBytes(new File(root, "records.db").toPath()));
    }

    @Test public void interruptedFirstCreationReusesSealedKey() throws Exception {
        store.initialize();
        store.close();
        byte[] key = Files.readAllBytes(new File(root, "key.sealed").toPath());
        assertTrue(new File(root, "initialized").delete());
        assertTrue(new File(root, "records.db").delete());
        store.initialize();
        assertArrayEquals(key, Files.readAllBytes(new File(root, "key.sealed").toPath()));
        assertTrue(new File(root, "initialized").isFile());
    }

    @Test public void firstCreationRecoversCompleteUnpublishedKeyWithoutRekeying() throws Exception {
        DurableFiles.directory(root);
        String alias = context.getPackageName() + ".native-records." + id;
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 42);
        KeystoreEnvelope envelope = new KeystoreEnvelope(alias);
        byte[] sealed = envelope.seal(key, alias + ":\"offline\"", true);
        File pending = File.createTempFile(".pending-", ".sealed", root);
        Files.write(pending.toPath(), sealed);
        store.initialize();
        assertEquals(0, store.read(LOCAL).revision);
        assertArrayEquals(key, envelope.open(Files.readAllBytes(new File(root, "key.sealed").toPath()), alias + ":\"offline\""));
        assertFalse(pending.exists());
    }

    @Test public void firstCreationRecoversEmptyAndPartiallyWrittenTemps() throws Exception {
        for (int count : new int[] { 0, 16, 71 }) {
            String freshId = id + "-" + count;
            File freshRoot = new File(context.getNoBackupFilesDir(), "native-records/" + freshId);
            DurableFiles.directory(freshRoot);
            String alias = context.getPackageName() + ".native-records." + freshId;
            byte[] sealed = new KeystoreEnvelope(alias).seal(new byte[32], alias + ":\"offline\"", true);
            File pending = File.createTempFile(".pending-", ".sealed", freshRoot);
            Files.write(pending.toPath(), Arrays.copyOf(sealed, count));
            try (EncryptedRecordStore fresh = new EncryptedRecordStore(context, freshId, "offline")) {
                fresh.initialize();
                assertEquals(0, fresh.read(LOCAL).revision);
                assertFalse(pending.exists());
                fresh.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "after-recovery")));
            }
        }
    }

    @Test public void unpublishedKeyRecoveryNeverRegeneratesLostAlias() throws Exception {
        DurableFiles.directory(root);
        String alias = context.getPackageName() + ".native-records." + id;
        byte[] sealed = new KeystoreEnvelope(alias).seal(new byte[32], alias + ":\"offline\"", true);
        File pending = File.createTempFile(".pending-", ".sealed", root);
        Files.write(pending.toPath(), sealed);
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); keys.deleteEntry(alias);
        assertThrows(Exception.class, () -> store.initialize());
        assertArrayEquals(sealed, Files.readAllBytes(pending.toPath()));
        assertFalse(keys.containsAlias(alias));
        assertFalse(new File(root, "key.sealed").exists());
        assertFalse(new File(root, "records.db").exists());
    }

    @Test public void journalWithoutDatabaseBlocksRecreationEvenWithoutMarker() throws Exception {
        store.initialize(); store.close();
        assertTrue(new File(root, "initialized").delete());
        assertTrue(new File(root, "records.db").delete());
        byte[] evidence = "synthetic-journal-evidence".getBytes(StandardCharsets.UTF_8);
        File journal = new File(root, "records.db-journal"); Files.write(journal.toPath(), evidence);
        assertThrows(Exception.class, () -> store.initialize());
        assertFalse(new File(root, "records.db").exists());
        assertArrayEquals(evidence, Files.readAllBytes(journal.toPath()));
    }

    @Test public void encryptedFilesDoNotContainRecordSentinelsOrSecrets() throws Exception {
        store.initialize();
        store.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", "synthetic-only-record-sentinel")));
        new NativeSecretStore(context, id).set("token", "synthetic-only-secret-sentinel");
        store.close();
        for (File file : Objects.requireNonNull(root.listFiles())) {
            if (!file.isFile()) continue;
            String bytes = new String(Files.readAllBytes(file.toPath()), StandardCharsets.ISO_8859_1);
            assertFalse(bytes.contains("synthetic-only-record-sentinel"));
            assertFalse(bytes.contains("synthetic-only-secret-sentinel"));
        }
        reopen();
        assertEquals(Collections.singleton("hrt-events"), store.read(LOCAL).entries.keySet());
    }

    @Test public void recordsLargerThanCursorWindowSurviveReopening() throws Exception {
        store.initialize();
        char[] chars = new char[3 * 1024 * 1024];
        Arrays.fill(chars, 'x');
        String large = new String(chars) + "😀";
        store.commit(Arrays.asList(put(LOCAL, 0, "hrt-events", large)));
        reopen();
        assertEquals(large, store.read(LOCAL).entries.get("hrt-events"));
    }

    @Test public void sharedWebContractAndUtf16ValuesRoundTrip() throws Exception {
        store.initialize();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets()
                .open("record-store-contract-v1.json")) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
        }
        JSONObject fixture = new JSONObject(bytes.toString("UTF-8"));
        assertEquals(1, fixture.getInt("version"));
        for (int i = 0; i < fixture.getJSONArray("valid").length(); i++) {
            JSONObject item = fixture.getJSONArray("valid").getJSONObject(i);
            String ns = item.getString("namespace");
            Map<String, String> values = new LinkedHashMap<>();
            for (int k = 0; k < item.getJSONArray("keys").length(); k++) values.put(item.getJSONArray("keys").getString(k), "unicode-😀-\ud800-\u0000");
            store.commit(Arrays.asList(new Change(ns, store.read(ns).revision, values, Collections.emptyList())));
            assertEquals(values, store.read(ns).entries);
        }
        for (int i = 0; i < fixture.getJSONArray("invalid").length(); i++) {
            JSONObject item = fixture.getJSONArray("invalid").getJSONObject(i);
            String ns = item.getString("namespace");
            if (item.getJSONArray("keys").length() == 0) assertThrows(Exception.class, () -> store.read(ns));
            for (int k = 0; k < item.getJSONArray("keys").length(); k++) {
                String key = item.getJSONArray("keys").getString(k);
                long revision = store.read(ns).revision;
                assertThrows(Exception.class, () -> store.commit(Arrays.asList(put(ns, revision, key, "x"))));
            }
        }
    }
}
