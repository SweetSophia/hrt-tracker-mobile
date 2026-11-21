package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Bundle;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.askarys.hrttracker.storage.RecordProtocol.*;

/** Staged by the serial-scoped host runner, not by the default unit suite. Synthetic fixtures only. */
public final class LifecycleTest {
    private static void signal(String name, String value) {
        Bundle status = new Bundle();
        status.putString(name, value);
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
    }

    @Test public void phase() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String phase = args.getString("phase"), id = args.getString("storeId");
        assertNotNull(id);
        assertTrue(id.matches("lifecycle-[a-f0-9-]{36}"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().endsWith(".storagequalification"));
        NativeSecretStore secrets = new NativeSecretStore(context, id);
        try (EncryptedRecordStore store = new EncryptedRecordStore(context, id, "offline")) {
            store.initialize();
            switch (Objects.requireNonNull(phase)) {
                case "ack": {
                    assertEquals(0, store.read(RecordStoreTest.LOCAL).revision);
                    Map<String, String> modes = new LinkedHashMap<>();
                    modes.put("hrt-events", "old-fem"); modes.put("hrt-masc-events", "old-masc");
                    store.commit(Arrays.asList(new Change(RecordStoreTest.LOCAL, 0, modes, Collections.emptyList()),
                        RecordStoreTest.put(RecordStoreTest.PREFS, 0, "app-theme", "old-theme")));
                    secrets.set("token", "synthetic-restart-secret");
                    secrets.set("removed", "synthetic-deleted-secret");
                    secrets.remove("removed");
                    // No close, activity teardown or grace period before the host kills this process.
                    signal("native_ack", "durable");
                    new CountDownLatch(1).await(60, TimeUnit.SECONDS);
                    fail("Host did not kill after acknowledgement");
                    break;
                }
                case "verify": {
                    Snapshot records = store.read(RecordStoreTest.LOCAL), prefs = store.read(RecordStoreTest.PREFS);
                    assertEquals(1, records.revision); assertEquals(1, prefs.revision);
                    assertEquals("old-fem", records.entries.get("hrt-events"));
                    assertEquals("old-masc", records.entries.get("hrt-masc-events"));
                    assertEquals("old-theme", prefs.entries.get("app-theme"));
                    assertEquals("synthetic-restart-secret", secrets.get("token"));
                    assertNull(secrets.get("removed"));
                    break;
                }
                case "interrupt": {
                    assertEquals(1, store.read(RecordStoreTest.LOCAL).revision);
                    char[] chars = new char[8 * 1024 * 1024]; Arrays.fill(chars, 'x');
                    Map<String, String> modes = new LinkedHashMap<>();
                    modes.put("hrt-events", "new-fem-" + new String(chars));
                    modes.put("hrt-masc-events", "new-masc");
                    // Test-only cache setting forces journaled pages to spill while commit is in progress.
                    RecordStoreTest.sql(store, "PRAGMA cache_size=8");
                    signal("native_commit", "starting");
                    store.commit(Arrays.asList(RecordStoreTest.put(RecordStoreTest.PREFS, 1, "app-theme", "new-theme"),
                        new Change(RecordStoreTest.LOCAL, 1, modes, Collections.emptyList())));
                    signal("native_commit", "completed");
                    new CountDownLatch(1).await(60, TimeUnit.SECONDS);
                    fail("Host did not interrupt commit");
                    break;
                }
                case "recover": {
                    Snapshot records = store.read(RecordStoreTest.LOCAL), prefs = store.read(RecordStoreTest.PREFS);
                    assertEquals(records.revision, prefs.revision);
                    assertTrue(records.revision == 1 || records.revision == 2);
                    if (records.revision == 1) {
                        assertEquals("old-fem", records.entries.get("hrt-events"));
                        assertEquals("old-masc", records.entries.get("hrt-masc-events"));
                        assertEquals("old-theme", prefs.entries.get("app-theme"));
                    } else {
                        assertEquals(8 * 1024 * 1024 + 8, records.entries.get("hrt-events").length());
                        assertTrue(records.entries.get("hrt-events").startsWith("new-fem-"));
                        assertEquals("new-masc", records.entries.get("hrt-masc-events"));
                        assertEquals("new-theme", prefs.entries.get("app-theme"));
                    }
                    assertEquals("synthetic-restart-secret", secrets.get("token"));
                    assertNull(secrets.get("removed"));
                    signal("recovered_revision", Long.toString(records.revision));
                    break;
                }
                default: fail("Unknown qualification phase");
            }
        }
    }
}
