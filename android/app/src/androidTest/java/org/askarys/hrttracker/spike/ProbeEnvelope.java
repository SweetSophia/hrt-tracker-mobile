package org.askarys.hrttracker.spike;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Test APK only: evaluates an app-owned secret primitive, not a production adapter. */
final class ProbeEnvelope {
    final String alias;
    private final File file;
    ProbeEnvelope(Context context, String name) {
        if (!name.matches("checks|restart|wrong")) throw new IllegalArgumentException("Unknown fixture");
        alias = "org.askarys.hrttracker.feasibility." + name;
        file = new File(context.getFilesDir(), "hrt-feasibility-" + name + ".sealed");
    }
    private KeyStore store() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); return store;
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = store();
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create || file.exists()) throw new GeneralSecurityException("MISSING_KEY_NO_REGENERATION");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build());
        return generator.generateKey();
    }
    void write(byte[] plaintext, String identity, boolean injectWriteFailure) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(identity.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(plaintext);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(1); out.writeInt(cipher.getIV().length); out.write(cipher.getIV());
            out.writeInt(ciphertext.length); out.write(ciphertext);
        }
        if (injectWriteFailure) throw new IOException("INJECTED_CIPHERTEXT_WRITE_FAILURE");
        File temp = new File(file.getPath() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temp)) { output.write(bytes.toByteArray()); output.getFD().sync(); }
            Os.rename(temp.getPath(), file.getPath());
            FileDescriptor directory = Os.open(file.getParent(), OsConstants.O_RDONLY, 0);
            try { Os.fsync(directory); } finally { Os.close(directory); }
        } finally { if (temp.exists() && !temp.delete()) throw new IOException("Failed fixture temp cleanup"); }
    }
    byte[] readCiphertext() throws IOException {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] block = new byte[1024]; int n;
            while ((n = input.read(block)) >= 0) { output.write(block, 0, n); if (output.size() > 8192) throw new IOException("Oversized fixture"); }
            return output.toByteArray();
        }
    }
    byte[] read(String identity) throws Exception { return read(identity, alias); }
    byte[] read(String identity, String keyAlias) throws Exception {
        SecretKey key = (SecretKey) store().getKey(keyAlias, null);
        if (key == null) throw new GeneralSecurityException("MISSING_KEY_NO_REGENERATION");
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(readCiphertext()))) {
            if (input.readInt() != 1) throw new IOException("Unknown envelope version");
            int ivLength = input.readInt(); if (ivLength != 12) throw new IOException("Invalid IV length");
            byte[] iv = new byte[ivLength]; input.readFully(iv);
            int length = input.readInt(); if (length < 16 || length > 4096) throw new IOException("Invalid ciphertext size");
            byte[] ciphertext = new byte[length]; input.readFully(ciphertext);
            if (input.available() != 0) throw new IOException("Trailing envelope data");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            cipher.updateAAD(identity.getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(ciphertext);
        }
    }
    void cleanup() throws Exception {
        if (file.exists() && !file.delete()) throw new IOException("Failed fixture cleanup");
        store().deleteEntry(alias);
    }
}
