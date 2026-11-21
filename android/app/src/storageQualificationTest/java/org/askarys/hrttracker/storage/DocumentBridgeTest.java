package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

public final class DocumentBridgeTest {
    private static Uri uri(String id) { return DocumentsContract.buildDocumentUri(SyntheticDocumentsProvider.AUTHORITY, id); }
    private static byte[] read(Uri uri) throws Exception {
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException("Missing document");
            byte[] chunk = new byte[16];
            int count;
            while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count);
            return output.toByteArray();
        }
    }
    private static JSONObject operation(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
        StorageBridgeTest.evaluate(activity, "window.__documentResult=null;" + expression + ".then(r=>window.__documentResult=r);void 0");
        StorageBridgeTest.waitFor(activity, "Boolean(window.__documentResult)");
        return new JSONObject((String)new JSONTokener(StorageBridgeTest.evaluate(activity, "JSON.stringify(window.__documentResult)")).nextValue());
    }
    private static final class Picker extends Instrumentation.ActivityMonitor implements AutoCloseable {
        final AtomicReference<Intent> launched = new AtomicReference<>();
        final Uri selected;
        final int result;
        Picker(Uri selected, int result) { this.selected = selected; this.result = result; InstrumentationRegistry.getInstrumentation().addMonitor(this); }
        @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
            if (!Intent.ACTION_CREATE_DOCUMENT.equals(intent.getAction()) && !Intent.ACTION_OPEN_DOCUMENT.equals(intent.getAction())) return null;
            launched.set(intent);
            return new Instrumentation.ActivityResult(result, selected == null ? null : new Intent().setData(selected));
        }
        @Override public void close() { InstrumentationRegistry.getInstrumentation().removeMonitor(this); }
    }
    @Test public void actualAdaptersSaveAndPickBinaryThroughContentProvider() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            for (String type : new String[]{"application/json", "application/pdf", "text/csv;charset=utf-8;", "text/calendar;charset=utf-8"}) {
                try (Picker picker = new Picker(uri("write"), Activity.RESULT_OK)) {
                    assertEquals("saved", operation(activity, "__hrtDocumentQualification.save([0,255,128],'synthetic.json'," + JSONObject.quote(type) + ")").getString("outcome"));
                    Intent intent = picker.launched.get();
                    assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.getAction());
                    assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
                    assertEquals(type.split(";")[0], intent.getType());
                    assertEquals(0, intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                }
                try (Picker picker = new Picker(uri("write"), Activity.RESULT_OK)) {
                    JSONObject result = operation(activity, "__hrtDocumentQualification.pick()");
                    assertEquals("picked", result.getString("outcome"));
                    assertEquals("[0,255,128]", result.getJSONArray("bytes").toString());
                    assertEquals("synthetic.json", result.getString("name"));
                    assertEquals(Intent.ACTION_OPEN_DOCUMENT, picker.launched.get().getAction());
                }
            }
        }
    }
    @Test public void cancellationSettlesWithoutWritingAndAllowsRetry() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class);
             Picker picker = new Picker(null, Activity.RESULT_CANCELED)) {
            assertEquals("cancelled", operation(activity, "__hrtDocumentQualification.pick()").getString("outcome"));
            assertEquals("cancelled", operation(activity, "__hrtDocumentQualification.save([1])").getString("outcome"));
            assertEquals("cancelled", operation(activity, "__hrtDocumentQualification.pick()").getString("outcome"));
        }
    }
    @Test public void metadataAndStreamBoundsRejectBeforeImport() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            for (String id : new String[]{"large", "unknown", "lying"}) {
                try (Picker picker = new Picker(uri(id), Activity.RESULT_OK)) {
                    assertEquals(id, "DOCUMENT_TOO_LARGE", operation(activity, "__hrtDocumentQualification.pick()").getString("code"));
                }
            }
            for (Uri uri : new Uri[]{uri("denied"), Uri.parse("file:///synthetic.json")}) {
                try (Picker picker = new Picker(uri, Activity.RESULT_OK)) {
                    assertEquals("failed", operation(activity, "__hrtDocumentQualification.pick()").getString("outcome"));
                }
            }
        }
    }
    @Test public void failedSaveLeavesPickerDocumentAndRetries() throws Exception {
        byte[] existing = new byte[] {9, 8, 7, 6};
        InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver()
            .call(uri("failopen"), "android:seed", null, null);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            try (Picker failOpen = new Picker(uri("failopen"), Activity.RESULT_OK)) {
                assertEquals("failed", operation(activity, "__hrtDocumentQualification.save([1,2,3])").getString("outcome"));
                assertArrayEquals(existing, read(uri("failopen")));
            }
            try (Picker partial = new Picker(uri("partial"), Activity.RESULT_OK)) {
                assertEquals("failed", operation(activity, "__hrtDocumentQualification.save([1,2,3])").getString("outcome"));
                assertArrayEquals(new byte[] {0x51}, read(uri("partial")));
            }
            try (Picker failBody = new Picker(uri("failbody"), Activity.RESULT_OK)) {
                assertEquals("failed", operation(activity, "__hrtDocumentQualification.save([1,2,3])").getString("outcome"));
                assertArrayEquals(existing, read(uri("failbody")));
            }
            try (Picker retry = new Picker(uri("write"), Activity.RESULT_OK)) {
                assertEquals("saved", operation(activity, "__hrtDocumentQualification.save([4,5,6])").getString("outcome"));
                assertArrayEquals(new byte[] {4, 5, 6}, read(uri("write")));
            }
        }
    }
    @Test public void pendingPickerRejectsOverlapAndDoesNotPersistExportOptions() throws Exception {
        // A blocking monitor with no immediate result holds the actual request pending.
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        IntentFilter filter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("*/*");
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(filter, null, true);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
            StorageBridgeTest.evaluate(activity, "__hrtDocumentQualification.save([83,69,67,82,69,84],'synthetic-sensitive-name.json');void 0");
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
            while (monitor.getHits() == 0 && System.nanoTime() < deadline) Thread.sleep(50);
            assertEquals(1, monitor.getHits());
            assertEquals("failed", operation(activity, "__hrtDocumentQualification.pick()").getString("outcome"));
            activity.onActivity(a -> {
                Bundle state = new Bundle();
                a.getBridge().saveInstanceState(state);
                assertTrue("Pending document call must not enter saved state", state.isEmpty());
            });
            activity.recreate();
            StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
            try (Picker cancel = new Picker(null, Activity.RESULT_CANCELED)) {
                assertEquals("cancelled", operation(activity, "__hrtDocumentQualification.pick()").getString("outcome"));
            }
        } finally { instrumentation.removeMonitor(monitor); }
    }
    @Test public void invalidFilenameNeverLaunchesPicker() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class);
             Picker picker = new Picker(uri("write"), Activity.RESULT_OK)) {
            for (String name : new String[]{"", "../synthetic.json", "first\nsecond\n.json"}) {
                assertEquals("failed", operation(activity, "__hrtDocumentQualification.save([1]," + JSONObject.quote(name) + ")").getString("outcome"));
                assertNull(picker.launched.get());
            }
        }
    }
    @Test public void realSystemPickerCanBeCancelled() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
            StorageBridgeTest.evaluate(activity, "window.__documentResult=null;__hrtDocumentQualification.pick().then(r=>window.__documentResult=r);void 0");
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(15);
            boolean pickerVisible = false;
            while (System.nanoTime() < deadline) {
                android.view.accessibility.AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
                if (root != null && root.getPackageName() != null && root.getPackageName().toString().endsWith("documentsui")) { pickerVisible = true; break; }
                Thread.sleep(100);
            }
            assertTrue("Actual Android document picker must be visible", pickerVisible);
            assertTrue(instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));
            StorageBridgeTest.waitFor(activity, "Boolean(window.__documentResult)");
            assertEquals("\"cancelled\"", StorageBridgeTest.evaluate(activity, "window.__documentResult.outcome"));
        }
    }
    @Test public void childFrameCannotOpenDocumentPicker() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class);
             Picker picker = new Picker(null, Activity.RESULT_CANCELED)) {
            StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
            StorageBridgeTest.evaluate(activity, "window.__docChild=document.createElement('iframe');__docChild.src='/index.html';document.body.appendChild(__docChild);void 0");
            StorageBridgeTest.waitFor(activity, "Boolean(window.__docChild.contentWindow.androidBridge)");
            String request = new JSONObject().put("callbackId", "forbidden-document-child").put("pluginId", "HrtNativeDocuments").put("methodName", "pick")
                .put("options", new JSONObject().put("version", 1)).toString();
            StorageBridgeTest.evaluate(activity, "__docChild.contentWindow.androidBridge.postMessage(" + JSONObject.quote(request) + ");void 0");
            StorageBridgeTest.run(activity, "ping", "document-frame-fence");
            assertNull(picker.launched.get());
        }
    }

}
