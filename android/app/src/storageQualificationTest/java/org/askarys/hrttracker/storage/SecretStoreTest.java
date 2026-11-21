package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import org.junit.Before;
import org.junit.Test;

public final class SecretStoreTest {
    private Context context;
    private String id;
    private NativeSecretStore store;
    private File root;

    @Before public void setup() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        id = "test-" + UUID.randomUUID();
        root = new File(context.getNoBackupFilesDir(), "native-secrets/" + id);
        store = new NativeSecretStore(context, id);
    }

    static String hash(String key) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))) {
            hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        }
        return hex.toString();
    }

    private File sealed(String key) throws Exception { return new File(root, hash(key) + ".sealed"); }

    @Test public void roundTripAndRemovalSurviveNewInstances() throws Exception {
        assertNull(store.get("token"));
        store.set("token", "synthetic-only-α-secret");
        assertEquals("synthetic-only-α-secret", new NativeSecretStore(context, id).get("token"));
        store.remove("token");
        assertNull(new NativeSecretStore(context, id).get("token"));
        store.remove("token");
        store.set("token", "");
        assertEquals("", store.get("token"));
    }

    @Test public void freshIvAndNoPlaintextOnDisk() throws Exception {
        store.set("token", "synthetic-only-secret-sentinel");
        byte[] first = Files.readAllBytes(sealed("token").toPath());
        store.set("token", "synthetic-only-secret-sentinel");
        byte[] second = Files.readAllBytes(sealed("token").toPath());
        assertFalse(Arrays.equals(first, second));
        assertFalse(new String(second, StandardCharsets.ISO_8859_1).contains("synthetic-only-secret-sentinel"));
    }

    @Test public void copiedEnvelopeRejectsDifferentLogicalKey() throws Exception {
        store.set("token", "synthetic");
        Files.copy(sealed("token").toPath(), sealed("other").toPath());
        assertThrows(Exception.class, () -> store.get("other"));
        assertEquals("synthetic", store.get("token"));
    }

    @Test public void differentVaultKeyRejectsCiphertext() throws Exception {
        store.set("token", "synthetic");
        String otherId = id + "-other";
        NativeSecretStore other = new NativeSecretStore(context, otherId);
        other.set("token", "other");
        File target = new File(context.getNoBackupFilesDir(), "native-secrets/" + otherId + "/" + hash("token") + ".sealed");
        Files.write(target.toPath(), Files.readAllBytes(sealed("token").toPath()));
        assertThrows(Exception.class, () -> other.get("token"));
    }

    @Test public void missingKeystoreKeyNeverRegeneratesOverSecrets() throws Exception {
        store.set("token", "synthetic");
        byte[] before = Files.readAllBytes(sealed("token").toPath());
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        String alias = context.getPackageName() + ".native-secrets." + id;
        keys.deleteEntry(alias);
        assertThrows(Exception.class, () -> store.get("token"));
        assertThrows(Exception.class, () -> store.set("other", "replacement"));
        assertFalse(keys.containsAlias(alias));
        assertArrayEquals(before, Files.readAllBytes(sealed("token").toPath()));
    }

    @Test public void corruptOrTrailingBytesFailWithoutReplacement() throws Exception {
        store.set("token", "synthetic");
        byte[] original = Files.readAllBytes(sealed("token").toPath());
        for (byte[] invalid : new byte[][] { new byte[] {1}, Arrays.copyOf(original, original.length + 1) }) {
            Files.write(sealed("token").toPath(), invalid);
            assertThrows(Exception.class, () -> store.get("token"));
            assertArrayEquals(invalid, Files.readAllBytes(sealed("token").toPath()));
        }
    }

    @Test public void failedReplacementNeverAcknowledges() throws Exception {
        store.set("token", "old");
        File file = sealed("token");
        File held = new File(root, "held");
        Files.move(file.toPath(), held.toPath());
        assertTrue(file.mkdir());
        assertThrows(Exception.class, () -> store.set("token", "new"));
        assertTrue(file.delete());
        Files.move(held.toPath(), file.toPath());
        assertEquals("old", store.get("token"));
    }

    @Test public void rejectsUnpairedSurrogatesInsteadOfChangingSecret() throws Exception {
        assertThrows(Exception.class, () -> store.set("token", "\ud800"));
        assertNull(store.get("token"));
        assertThrows(Exception.class, () -> store.set("\ud800", "synthetic"));
    }
}
