package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import java.util.Collections;
import java.util.UUID;
import org.junit.Before;
import org.junit.Test;

/** Seeded interruption states; these tests do not claim a kill inside the file writer. */
public final class PendingCleanupTest {
    private Context context;
    private String id;

    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        id = "cleanup-" + UUID.randomUUID();
    }

    private File root(String kind) { return new File(context.getNoBackupFilesDir(), kind + "/" + id); }
    private File pending(File root, byte[] bytes) throws Exception {
        File file = File.createTempFile(".pending-", ".sealed", root);
        Files.write(file.toPath(), bytes);
        return file;
    }
    private File secretFile(File root) throws Exception {
        return new File(root, SecretStoreTest.hash("token") + ".sealed");
    }

    @Test public void completedInitializationCleansInterruptedMarkerAndPreservesRecords() throws Exception {
        File root = root("native-records");
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            store.initialize();
        }
        File marker = new File(root, "initialized");
        byte[] markerBytes = Files.readAllBytes(marker.toPath());
        byte[] keyBytes = Files.readAllBytes(new File(root, "key.sealed").toPath());
        File orphan = pending(root, markerBytes);
        Files.delete(marker.toPath());
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            store.initialize();
            assertFalse(orphan.exists());
            assertArrayEquals(markerBytes, Files.readAllBytes(marker.toPath()));
            assertArrayEquals(keyBytes, Files.readAllBytes(new File(root, "key.sealed").toPath()));
            store.commit(Collections.singletonList(RecordStoreTest.put(RecordStoreTest.LOCAL, 0, "hrt-events", "synthetic")));
        }
        File laterOrphan = pending(root, markerBytes);
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            store.initialize();
            assertFalse(laterOrphan.exists());
            assertEquals(1, store.read(RecordStoreTest.LOCAL).revision);
            assertEquals("synthetic", store.read(RecordStoreTest.LOCAL).entries.get("hrt-events"));
        }
    }

    @Test public void failedSchemaValidationPreservesPendingEvidence() throws Exception {
        File root = root("native-records");
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            store.initialize();
            RecordStoreTest.sql(store, "PRAGMA user_version=2");
        }
        byte[] bytes = new byte[] { 11, 22, 33 };
        File orphan = pending(root, bytes);
        byte[] database = Files.readAllBytes(new File(root, "records.db").toPath());
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            assertThrows(Exception.class, store::initialize);
        }
        assertArrayEquals(bytes, Files.readAllBytes(orphan.toPath()));
        assertArrayEquals(database, Files.readAllBytes(new File(root, "records.db").toPath()));
    }

    @Test public void durableSecretWriteCleansPendingWithoutChangingAcknowledgedValue() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "old-synthetic");
        File orphan = pending(root("native-secrets"), new byte[] { 1, 2, 3 });
        store.set("token", "new-synthetic");
        assertFalse(orphan.exists());
        assertEquals("new-synthetic", new NativeSecretStore(context, id).get("token"));
    }

    @Test public void authenticatedSecretReadCleansPendingWithoutReplacingCiphertext() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "synthetic");
        File root = root("native-secrets");
        byte[] sealed = Files.readAllBytes(secretFile(root).toPath());
        File orphan = pending(root, new byte[] { 1, 2, 3 });
        assertEquals("synthetic", new NativeSecretStore(context, id).get("token"));
        assertFalse(orphan.exists());
        assertArrayEquals(sealed, Files.readAllBytes(secretFile(root).toPath()));
    }

    @Test public void missingAndCorruptSecretReadsPreservePendingEvidence() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "synthetic");
        File root = root("native-secrets");
        byte[] bytes = new byte[] { 11, 22, 33 };
        File orphan = pending(root, bytes);
        Files.write(secretFile(root).toPath(), new byte[] { 1 });
        assertNull(store.get("missing"));
        assertArrayEquals(bytes, Files.readAllBytes(orphan.toPath()));
        assertThrows(Exception.class, () -> store.get("token"));
        assertArrayEquals(bytes, Files.readAllBytes(orphan.toPath()));
        assertArrayEquals(new byte[] { 1 }, Files.readAllBytes(secretFile(root).toPath()));
    }

    @Test public void secretRemovalDoesNotAuthenticateOrSweepTheVault() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "synthetic");
        byte[] bytes = new byte[] { 11, 22, 33 };
        File orphan = pending(root("native-secrets"), bytes);
        store.remove("missing");
        store.remove("token");
        assertArrayEquals(bytes, Files.readAllBytes(orphan.toPath()));
        assertNull(store.get("token"));
    }

    @Test public void failedSecretReplacementPreservesPendingEvidenceAndOldValue() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "old-synthetic");
        File root = root("native-secrets");
        byte[] bytes = new byte[] { 11, 22, 33 };
        File orphan = pending(root, bytes);
        File published = secretFile(root), held = new File(root, "held");
        Files.move(published.toPath(), held.toPath());
        assertTrue(published.mkdir());
        try {
            assertThrows(Exception.class, () -> store.set("token", "new-synthetic"));
            assertArrayEquals(bytes, Files.readAllBytes(orphan.toPath()));
        } finally {
            Files.delete(published.toPath());
            Files.move(held.toPath(), published.toPath());
        }
        assertEquals("old-synthetic", store.get("token"));
    }

    @Test public void cleanupPreservesOtherNamesDirectoriesSymlinksAndExternalFiles() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "synthetic");
        File root = root("native-secrets");
        byte[] bytes = new byte[] { 11, 22, 33 };
        File orphan = pending(root, bytes);
        File directory = new File(root, ".pending-directory.sealed");
        assertTrue(directory.mkdir());
        File nested = new File(directory, ".pending-nested.sealed");
        Files.write(nested.toPath(), bytes);
        File external = new File(root.getParentFile(), id + "-external");
        Files.write(external.toPath(), bytes);
        File link = new File(root, ".pending-link.sealed");
        Os.symlink(external.getAbsolutePath(), link.getAbsolutePath());
        String[] otherNames = { "other.sealed", ".pending-near.tmp", "prefix.pending-name.sealed" };
        for (String name : otherNames) Files.write(new File(root, name).toPath(), bytes);
        try {
            assertEquals("synthetic", store.get("token"));
            assertFalse(orphan.exists());
            assertTrue(directory.isDirectory());
            assertTrue(OsConstants.S_ISLNK(Os.lstat(link.getAbsolutePath()).st_mode));
            assertArrayEquals(bytes, Files.readAllBytes(nested.toPath()));
            assertArrayEquals(bytes, Files.readAllBytes(external.toPath()));
            for (String name : otherNames) assertArrayEquals(bytes, Files.readAllBytes(new File(root, name).toPath()));
        } finally { Files.deleteIfExists(external.toPath()); }
    }

    @Test public void failedCleanupDoesNotHideAReadableSecretAndRetriesLater() throws Exception {
        NativeSecretStore store = new NativeSecretStore(context, id);
        store.set("token", "synthetic");
        File root = root("native-secrets");
        File orphan = pending(root, new byte[] { 1, 2, 3 });
        int permissions = Os.stat(root.getAbsolutePath()).st_mode & 0777;
        try {
            for (int mode : new int[] { 0500, 0100 }) {
                Os.chmod(root.getAbsolutePath(), mode);
                assertEquals("synthetic", store.get("token"));
                assertTrue(orphan.exists());
            }
        } finally { Os.chmod(root.getAbsolutePath(), permissions); }
        assertEquals("synthetic", store.get("token"));
        assertFalse(orphan.exists());
    }
}
