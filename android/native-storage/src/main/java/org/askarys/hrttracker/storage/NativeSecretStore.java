package org.askarys.hrttracker.storage;

import android.content.Context;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Separate from portable records; only the qualification APK uses this module yet. */
public final class NativeSecretStore {
    private final File root;
    private final String identity;
    private final KeystoreEnvelope envelope;

    public NativeSecretStore(Context context, String id) {
        identity = context.getPackageName() + ".native-secrets." + StoreGuard.id(id);
        root = new File(context.getNoBackupFilesDir(), "native-secrets/" + id);
        envelope = new KeystoreEnvelope(identity);
    }

    private static byte[] utf8(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("Missing secret value");
        ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder().encode(CharBuffer.wrap(value));
        byte[] bytes = new byte[encoded.remaining()];
        encoded.get(bytes);
        return bytes;
    }

    private File file(String key) throws Exception {
        if (key == null || key.isEmpty()) throw new IllegalArgumentException("Missing secret identity");
        StringBuilder hash = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(utf8(key))) {
            hash.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        }
        return new File(root, hash + ".sealed");
    }

    private boolean hasEnvelopes() throws IOException {
        // Pending files also prove a previous alias existed. Never regenerate over that evidence.
        String[] files = root.list((dir, name) -> name.endsWith(".sealed"));
        if (files == null) throw new IOException("Cannot inspect secret storage");
        return files.length > 0;
    }

    public String get(String key) throws Exception {
        File file = file(key);
        return StoreGuard.with(root, () -> {
            if (!file.exists()) return null;
            byte[] plain = envelope.open(DurableFiles.read(file, KeystoreEnvelope.MAX_BYTES), identity + ":" + key);
            try {
                String value = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(plain)).toString();
                DurableFiles.cleanupPending(root);
                return value;
            }
            finally { Arrays.fill(plain, (byte) 0); }
        });
    }

    public void set(String key, String value) throws Exception {
        File file = file(key);
        byte[] plain = utf8(value);
        try {
            StoreGuard.with(root, () -> {
                byte[] bytes = envelope.seal(plain, identity + ":" + key, !hasEnvelopes());
                DurableFiles.replace(file, bytes);
                DurableFiles.cleanupPending(root);
                return null;
            });
        } finally { Arrays.fill(plain, (byte) 0); }
    }

    public void remove(String key) throws Exception {
        File file = file(key);
        StoreGuard.with(root, () -> { DurableFiles.remove(file); return null; });
    }
}
