package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Real shared backup planners -> RecordController -> installed native bridge. Synthetic data only. */
public final class BackupBridgeTest {
    private static ActivityScenario<MainActivity> launch() {
        assertTrue(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName().endsWith(".storagequalification"));
        return ActivityScenario.launch(MainActivity.class);
    }
    static void start(ActivityScenario<MainActivity> activity, String phase, String owner) throws Exception {
        StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtBackupQualification)");
        StorageBridgeTest.evaluate(activity, "window.__backupResult=null;window.__hrtBackupQualification.run(" + JSONObject.quote(phase) + "," + JSONObject.quote(owner) + ").then(r=>window.__backupResult=r);void 0");
    }
    static JSONObject result(ActivityScenario<MainActivity> activity) throws Exception {
        StorageBridgeTest.waitFor(activity, "Boolean(window.__backupResult)");
        return new JSONObject((String) new JSONTokener(StorageBridgeTest.evaluate(activity, "JSON.stringify(window.__backupResult)")).nextValue());
    }
    static JSONObject run(ActivityScenario<MainActivity> activity, String phase, String owner) throws Exception {
        start(activity, phase, owner);
        JSONObject report = result(activity);
        assertEquals(report.toString(), "pass", report.getString("outcome"));
        return report;
    }
    static void report(JSONObject value) {
        Bundle status = new Bundle(); status.putString("backup_report", value.toString());
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
    }
    // Reflection is confined to the instrumentation APK. No test/fault command enters the plugin API.
    static EncryptedRecordStore records(ActivityScenario<MainActivity> activity) throws Exception {
        AtomicReference<Object> plugin = new AtomicReference<>();
        activity.onActivity(a -> plugin.set(a.getBridge().getPlugin("HrtNativeStorage").getInstance()));
        java.lang.reflect.Field field = HrtNativeStoragePlugin.class.getDeclaredField("records");
        field.setAccessible(true);
        return (EncryptedRecordStore) field.get(plugin.get());
    }
    private void compatibility(String owner) throws Exception {
        try (ActivityScenario<MainActivity> activity = launch()) { report(run(activity, "compatibility", owner)); }
    }
    @Test public void anonymousBackupInteroperability() throws Exception { compatibility("local"); }
    @Test public void accountBackupInteroperability() throws Exception { compatibility("synthetic-account"); }

    private void rollback(String owner) throws Exception {
        String expected;
        try (ActivityScenario<MainActivity> activity = launch()) {
            expected = run(activity, "seed", owner).getString("before");
            EncryptedRecordStore store = records(activity);
            // The second namespace must fail after the record namespace was actually updated.
            String weightKey = RecordProtocol.quote(owner.equals("local") ? "hrt-weight" : "hrt-u" + owner + "-weight");
            // entries stores RecordProtocol.quote(value), not bare SQL text. Use that codec
            // in the predicate so an encoding change cannot leave a stale magic literal.
            String restoredWeight = RecordProtocol.quote("78");
            RecordStoreTest.sql(store, "CREATE TEMP TRIGGER qualification_fail_restore BEFORE INSERT ON entries "
                + "WHEN NEW.namespace='preferences:v1' AND EXISTS (SELECT 1 FROM entries WHERE key='" + weightKey + "' AND value='" + restoredWeight + "') "
                + "BEGIN SELECT RAISE(ABORT, 'synthetic restore failure'); END");
            try {
                start(activity, "replace", owner);
                JSONObject failure = result(activity);
                assertEquals(failure.toString(), "fail", failure.getString("outcome"));
                // The public bridge intentionally hides SQL error text and stored values.
                assertEquals("Native storage is unavailable", failure.getString("reason"));
            } finally { RecordStoreTest.sql(store, "DROP TRIGGER qualification_fail_restore"); }
            assertEquals(expected, run(activity, "verify", owner).getString("digest"));
        }
        try (ActivityScenario<MainActivity> activity = launch()) {
            assertEquals(expected, run(activity, "verify", owner).getString("digest"));
        }
    }
    @Test public void anonymousFailedRestoreRollsBackEveryEntry() throws Exception { rollback("local"); }
    @Test public void accountFailedRestoreRollsBackEveryEntry() throws Exception { rollback("synthetic-account"); }

    @Test public void phase() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String phase = args.getString("phase"), owner = args.getString("owner");
        // Host runner invokes named methods; this entry cannot silently pass without its arguments.
        assertTrue("local".equals(owner) || "synthetic-account".equals(owner));
        try (ActivityScenario<MainActivity> activity = launch()) {
            if ("seed".equals(phase) || "verify".equals(phase) || "cleanup".equals(phase)) {
                report(run(activity, phase, owner));
            } else if ("interrupt".equals(phase) || "ack".equals(phase)) {
                StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtBackupQualification)");
                if ("interrupt".equals(phase)) {
                    EncryptedRecordStore store = records(activity);
                    RecordStoreTest.sql(store, "PRAGMA cache_size=8");
                    // Hold the transaction in the second namespace long enough for the host to
                    // observe its nonempty journal and stop the process. TEMP disappears on death.
                    // Keep a generous 100M-row window for 20ms host polling plus adb latency,
                    // even on fast emulators. A shorter loop risks commit winning before observation.
                    RecordStoreTest.sql(store, "CREATE TEMP TRIGGER qualification_delay_restore BEFORE INSERT ON entries WHEN NEW.namespace='preferences:v1' BEGIN "
                        + "SELECT sum(x) FROM (WITH RECURSIVE delay(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM delay WHERE x<100000000) SELECT x FROM delay); END");
                    Bundle status = new Bundle(); status.putString("backup_commit", "starting");
                    InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
                }
                JSONObject completed = run(activity, "replace", owner);
                report(completed);
                Bundle status = new Bundle(); status.putString("backup_commit", "acknowledged");
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
                new CountDownLatch(1).await(60, TimeUnit.SECONDS);
                fail("Host did not stop the process at the requested boundary");
            } else fail("Unknown backup phase");
        }
    }
}
