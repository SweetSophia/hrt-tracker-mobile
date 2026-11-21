package org.askarys.hrttracker.spike;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class KeystoreProbeTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private static final String IDENTITY = "synthetic-namespace:synthetic-key";
    private static final byte[] SECRET = "SYNTHETIC-KEYSTORE-PROBE".getBytes(StandardCharsets.UTF_8);

    @Test public void authenticatedEnvelopeRejectsWrongIdentityMissingKeyAndWriteFailure() throws Exception {
        ProbeEnvelope envelope = new ProbeEnvelope(context, "checks");
        envelope.cleanup();
        try {
            envelope.write(SECRET, IDENTITY, false);
            byte[] first = envelope.readCiphertext();
            assertArrayEquals(SECRET, envelope.read(IDENTITY));
            envelope.write(SECRET, IDENTITY, false);
            byte[] second = envelope.readCiphertext();
            assertFalse("Each sealing must use a fresh IV", Arrays.equals(first, second));
            assertFalse(new String(second, StandardCharsets.ISO_8859_1).contains("SYNTHETIC-KEYSTORE-PROBE"));
            try { envelope.read("wrong:identity"); fail("Wrong AAD accepted"); } catch (java.security.GeneralSecurityException expected) {}
            ProbeEnvelope other = new ProbeEnvelope(context, "wrong");
            try {
                other.write(SECRET, IDENTITY, false);
                try { envelope.read(IDENTITY, other.alias); fail("Wrong key accepted"); } catch (java.security.GeneralSecurityException expected) {}
            } finally { other.cleanup(); }
            try { envelope.write(SECRET, IDENTITY, true); fail("Injected I/O failure accepted"); } catch (IOException expected) {}
            assertArrayEquals(second, envelope.readCiphertext());
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(envelope.alias);
            try { envelope.read(IDENTITY); fail("Deleted key accepted"); } catch (java.security.GeneralSecurityException expected) {}
            try { envelope.write(SECRET, IDENTITY, false); fail("Regenerated key over existing ciphertext"); } catch (java.security.GeneralSecurityException expected) {}
            assertArrayEquals(second, envelope.readCiphertext());
        } finally { envelope.cleanup(); }
    }

    @Test public void stagedEnvelopeLifecycle() throws Exception {
        ProbeEnvelope envelope = new ProbeEnvelope(context, "restart");
        String phase = InstrumentationRegistry.getArguments().getString("phase", "self-check");
        if (phase.equals("prepare") || phase.equals("self-check")) envelope.write(SECRET, IDENTITY, false);
        assertArrayEquals(SECRET, envelope.read(IDENTITY));
        // Explicit prepare/verify invocations preserve the fixture across a
        // process restart or emulator reboot; the default is only a self-check.
        if (phase.equals("cleanup") || phase.equals("self-check")) envelope.cleanup();
    }
}
