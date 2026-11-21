package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Real installed WebView -> TypeScript adapter/controller -> Capacitor -> native stores. */
public final class StorageBridgeTest {
    static String evaluate(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        activity.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView callback timed out", done.await(15, TimeUnit.SECONDS));
        return result.get();
    }
    static void waitFor(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (!"true".equals(evaluate(activity, expression))) {
            assertTrue("WebView condition timed out", System.nanoTime() < deadline);
            Thread.sleep(100);
        }
    }
    static JSONObject run(ActivityScenario<MainActivity> activity, String scenario, String runId) throws Exception {
        waitFor(activity, "Boolean(window.__hrtStorageQualification)");
        evaluate(activity, "window.__storageResult=null;window.__hrtStorageQualification.run(" + JSONObject.quote(scenario) + "," + JSONObject.quote(runId) + ").then(r=>window.__storageResult=r);void 0");
        waitFor(activity, "Boolean(window.__storageResult)");
        JSONObject report = new JSONObject((String) new JSONTokener(evaluate(activity, "JSON.stringify(window.__storageResult)")).nextValue());
        Bundle status = new Bundle(); status.putString("bridge_report", report.toString());
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
        assertEquals("pass", report.getString("outcome"));
        assertTrue(report.getJSONObject("checks").length() > 0);
        for (java.util.Iterator<String> keys = report.getJSONObject("checks").keys(); keys.hasNext();) {
            String key = keys.next(); assertTrue(key, report.getJSONObject("checks").getBoolean(key));
        }
        return report;
    }
    @Test public void contractThroughInstalledBridge() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            run(activity, "contract", UUID.randomUUID().toString());
        }
    }
    @Test public void sharedControllerPublishesNativeAcknowledgements() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            run(activity, "controller", UUID.randomUUID().toString());
            waitFor(activity, "document.querySelector('#root').childElementCount>0");
            assertEquals("false", evaluate(activity, "document.querySelector('#root').innerText.includes('Could not open local records')"));
        }
    }
    @Test public void missingKeyBlocksStartupAndPreservesEvidence() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = new File(context.getNoBackupFilesDir(), "native-records/primary-v1");
        try (EncryptedRecordStore records = new EncryptedRecordStore(context, "primary-v1", "offline")) { records.initialize(); }
        File key = new File(root, "key.sealed"), saved = new File(root, "qualification-saved-key");
        assertTrue(key.renameTo(saved));
        try {
            try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
                waitFor(activity, "document.querySelector('#root').innerText.includes('Could not open local records')");
                assertEquals("false", evaluate(activity, "Boolean(window.__hrtStorageQualification)"));
                assertEquals("0", evaluate(activity, "document.querySelectorAll('#root input,#root textarea,#root form').length"));
                assertFalse(key.exists());
                assertTrue(new File(root, "records.db").isFile());
                assertTrue(saved.isFile());
            }
        } finally { assertTrue(saved.renameTo(key)); }
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            waitFor(activity, "Boolean(window.__hrtStorageQualification)");
        }
    }
    @Test public void childFrameCannotInvokeStorage() throws Exception {
        String key = "child-" + UUID.randomUUID();
        String request = new JSONObject().put("callbackId", "forbidden-child").put("pluginId", "HrtNativeStorage").put("methodName", "execute")
            .put("options", new JSONObject().put("version", 1).put("operation", "setSecret").put("payload", new JSONObject().put("key", key).put("value", "synthetic-child").toString())).toString();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            waitFor(activity, "Boolean(window.__hrtStorageQualification)");
            evaluate(activity, "window.__child=document.createElement('iframe');__child.src='/index.html';document.body.appendChild(__child);void 0");
            waitFor(activity, "Boolean(window.__child.contentWindow.androidBridge)");
            evaluate(activity, "__child.contentWindow.androidBridge.postMessage(" + JSONObject.quote(request) + ");void 0");
            // Main-frame round trip provides an ordering fence after the child's message.
            run(activity, "ping", "frame-fence");
        }
        NativeSecretStore secrets = new NativeSecretStore(InstrumentationRegistry.getInstrumentation().getTargetContext(), "primary-v1");
        assertNull(secrets.get(key));
    }
    @Test public void externalNavigationLeavesPrivilegedWebView() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        IntentFilter filter = new IntentFilter(Intent.ACTION_VIEW);
        filter.addDataScheme("https"); filter.addCategory(Intent.CATEGORY_BROWSABLE);
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(filter, null, true);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            waitFor(activity, "Boolean(window.__hrtStorageQualification)");
            evaluate(activity, "location.href='https://example.invalid/storage-qualification';void 0");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (monitor.getHits() == 0 && System.nanoTime() < deadline) Thread.sleep(100);
            assertEquals(1, monitor.getHits());
            assertEquals("\"https://localhost\"", evaluate(activity, "location.origin"));
        } finally { instrumentation.removeMonitor(monitor); }
    }
    @Test public void rejectsNonBundledHostUrls() {
        assertTrue(HrtNativeStoragePlugin.bundledUrl("https://localhost/index.html"));
        for (String value : new String[] {null, "http://localhost", "https://localhost:444", "https://user@localhost", "https://localhost.evil.invalid", "file:///index.html"}) {
            assertFalse(HrtNativeStoragePlugin.bundledUrl(value));
        }
    }
}
