package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import org.junit.Before;
import org.junit.Test;

/** Lost-alias pending record keys stay in RecordStoreTest.unpublishedKeyRecoveryNeverRegeneratesLostAlias. */
public final class RecoveryPolicyTest {
    private Context context;
    private String id;

    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        id = "test-" + UUID.randomUUID();
    }

    @Test public void orphanPendingSecretWithLostAliasRejectsRepeatedSets() throws Exception {
        File root = new File(context.getNoBackupFilesDir(), "native-secrets/" + id);
        DurableFiles.directory(root);
        String alias = context.getPackageName() + ".native-secrets." + id;
        byte[] pendingBytes = new KeystoreEnvelope(alias).seal(
                "synthetic-orphan".getBytes(StandardCharsets.UTF_8), alias + ":orphan", true);
        File pending = File.createTempFile(".pending-", ".sealed", root);
        Files.write(pending.toPath(), pendingBytes);
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        keys.deleteEntry(alias);

        assertThrows(Exception.class, () -> new NativeSecretStore(context, id).set("token", "synthetic-replacement"));
        assertThrows(Exception.class, () -> new NativeSecretStore(context, id).set("other", "synthetic-second"));

        assertFalse(keys.containsAlias(alias));
        assertArrayEquals(pendingBytes, Files.readAllBytes(pending.toPath()));
        assertNull(new NativeSecretStore(context, id).get("token"));
        assertNull(new NativeSecretStore(context, id).get("other"));
        String[] names = root.list();
        assertNotNull(names);
        for (String name : names) {
            if (name.endsWith(".sealed")) assertTrue(name.startsWith(".pending-"));
        }
    }

    @Test public void corruptCompleteUnpublishedRecordKeyPreservesCandidateBytes() throws Exception {
        File root = new File(context.getNoBackupFilesDir(), "native-records/" + id);
        DurableFiles.directory(root);
        String alias = context.getPackageName() + ".native-records." + id;
        String aad = alias + ":\"offline\"";
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 3);
        byte[] candidate = new KeystoreEnvelope(alias).seal(key, aad, true);
        candidate[candidate.length - 1] ^= 1;
        assertTrue(candidate.length >= 72);
        File pending = File.createTempFile(".pending-", ".sealed", root);
        Files.write(pending.toPath(), candidate);
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            assertThrows(Exception.class, () -> store.initialize());
        }
        assertArrayEquals(candidate, Files.readAllBytes(pending.toPath()));
        assertFalse(new File(root, "key.sealed").exists());
        assertFalse(new File(root, "records.db").exists());
    }

    @Test public void conflictingCompleteUnpublishedRecordKeysPreserveBothCandidates() throws Exception {
        File root = new File(context.getNoBackupFilesDir(), "native-records/" + id);
        DurableFiles.directory(root);
        String alias = context.getPackageName() + ".native-records." + id;
        String aad = alias + ":\"offline\"";
        KeystoreEnvelope envelope = new KeystoreEnvelope(alias);
        byte[] firstKey = new byte[32], secondKey = new byte[32];
        Arrays.fill(firstKey, (byte) 7);
        Arrays.fill(secondKey, (byte) 9);
        byte[] first = envelope.seal(firstKey, aad, true);
        byte[] second = envelope.seal(secondKey, aad, false);
        assertTrue(first.length >= 72);
        assertTrue(second.length >= 72);
        File firstPending = File.createTempFile(".pending-", ".sealed", root);
        File secondPending = File.createTempFile(".pending-", ".sealed", root);
        Files.write(firstPending.toPath(), first);
        Files.write(secondPending.toPath(), second);
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            assertThrows(Exception.class, () -> store.initialize());
        }
        assertArrayEquals(first, Files.readAllBytes(firstPending.toPath()));
        assertArrayEquals(second, Files.readAllBytes(secondPending.toPath()));
        assertFalse(new File(root, "key.sealed").exists());
        assertFalse(new File(root, "records.db").exists());
    }
}
