package org.askarys.hrttracker.storage;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Versioned AES-GCM envelope; the Keystore key is non-exportable and never regenerated on reads. */
final class KeystoreEnvelope {
    static final int MAX_BYTES = 1024 * 1024;
    private final String alias;

    KeystoreEnvelope(String alias) { this.alias = alias; }

    void requireExistingKey() throws Exception { key(false); }

    private SecretKey key(boolean allowCreation) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) {
            if (!allowCreation) throw new IOException("Storage key unavailable; existing data preserved");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build());
            return generator.generateKey();
        }
        SecretKey key = (SecretKey) store.getKey(alias, null);
        if (key == null) throw new IOException("Storage key unavailable");
        return key;
    }

    byte[] seal(byte[] plain, String identity, boolean allowCreation) throws Exception {
        if (plain.length > MAX_BYTES - 64) throw new IOException("Secret too large");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(allowCreation));
        cipher.updateAAD(identity.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(plain);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(1);
            out.writeInt(cipher.getIV().length);
            out.write(cipher.getIV());
            out.writeInt(encrypted.length);
            out.write(encrypted);
        }
        return bytes.toByteArray();
    }

    byte[] open(byte[] bytes, String identity) throws Exception {
        if (bytes.length > MAX_BYTES) throw new IOException("Invalid storage envelope");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (in.readInt() != 1 || in.readInt() != 12) throw new IOException("Invalid storage envelope");
            byte[] iv = new byte[12];
            in.readFully(iv);
            int count = in.readInt();
            if (count < 16 || count != in.available()) throw new IOException("Invalid storage envelope");
            byte[] encrypted = new byte[count];
            in.readFully(encrypted);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            cipher.updateAAD(identity.getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(encrypted);
        }
    }
}
