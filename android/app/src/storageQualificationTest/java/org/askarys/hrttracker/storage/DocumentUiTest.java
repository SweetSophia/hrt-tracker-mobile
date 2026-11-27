package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Actual system UI and Downloads provider: no picker-result interception. */
public final class DocumentUiTest {
    private static final Instrumentation INSTRUMENTATION = InstrumentationRegistry.getInstrumentation();
    private static final String VIEWER = "com.google.android.apps.docs";

    private static AccessibilityNodeInfo find(AccessibilityNodeInfo node, Predicate<AccessibilityNodeInfo> match) {
        if (node == null) return null;
        if (node.isVisibleToUser() && match.test(node)) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = find(node.getChild(i), match);
            if (found != null) return found;
        }
        return null;
    }
    private static boolean documents(AccessibilityNodeInfo node) {
        return node != null && node.getPackageName() != null && node.getPackageName().toString().endsWith("documentsui");
    }
    private static AccessibilityNodeInfo awaitNode(String label, Predicate<AccessibilityNodeInfo> match) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            AccessibilityNodeInfo result = find(INSTRUMENTATION.getUiAutomation().getRootInActiveWindow(), match);
            if (result != null) return result;
            Thread.sleep(100);
        }
        throw new AssertionError("System UI control missing: " + label);
    }
    private static boolean text(AccessibilityNodeInfo node, String value) { return value.contentEquals(node.getText() == null ? "" : node.getText()); }
    private static boolean clickable(AccessibilityNodeInfo node) {
        while (node != null) { if (node.isClickable() && node.isEnabled()) return true; node = node.getParent(); }
        return false;
    }
    private static void click(AccessibilityNodeInfo node) {
        while (node != null && !node.isClickable()) node = node.getParent();
        assertNotNull("Clickable system UI ancestor", node);
        assertTrue("Enabled system UI control", node.isEnabled());
        assertTrue("System UI click", node.performAction(AccessibilityNodeInfo.ACTION_CLICK));
    }
    static void downloads() throws Exception {
        awaitNode("DocumentsUI", DocumentUiTest::documents);
        Predicate<AccessibilityNodeInfo> header = n -> documents(n) && text(n, "Files in Downloads");
        if (find(INSTRUMENTATION.getUiAutomation().getRootInActiveWindow(), header) == null) {
            click(awaitNode("Show roots", n -> documents(n) && "Show roots".contentEquals(n.getContentDescription() == null ? "" : n.getContentDescription())));
            INSTRUMENTATION.getUiAutomation().waitForIdle(300, 5_000);
            click(awaitNode("Downloads root", n -> documents(n) && text(n, "Downloads") && clickable(n)));
        }
        awaitNode("Downloads directory", header);
    }
    static String unique(String extension) { return "hrt-ui-" + UUID.randomUUID() + "." + extension; }
    static void begin(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        StorageBridgeTest.waitFor(activity, "Boolean(window.__hrtDocumentQualification)");
        StorageBridgeTest.evaluate(activity, "window.__documentUiResult=null;" + expression + ".then(r=>window.__documentUiResult=r);void 0");
        downloads();
        // A visible accessibility tree can precede completion of the Activity
        // transition. Send Back only once the newly opened picker is idle.
        INSTRUMENTATION.getUiAutomation().waitForIdle(500, 10_000);
        assertEquals("No acknowledgement while the picker is open", "null", StorageBridgeTest.evaluate(activity, "window.__documentUiResult"));
    }
    static JSONObject result(ActivityScenario<MainActivity> activity) throws Exception {
        StorageBridgeTest.waitFor(activity, "Boolean(window.__documentUiResult)");
        return new JSONObject((String)new JSONTokener(StorageBridgeTest.evaluate(activity, "JSON.stringify(window.__documentUiResult)")).nextValue());
    }
    static void setSaveName(String name) throws Exception {
        AccessibilityNodeInfo input = awaitNode("Save filename", n -> documents(n) && "android:id/title".equals(n.getViewIdResourceName()) && "android.widget.EditText".contentEquals(n.getClassName()));
        Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, name);
        assertTrue(input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args));
        awaitNode("Exact save filename", n -> documents(n) && text(n, name));
    }
    static void saveAs(String name) throws Exception {
        setSaveName(name);
        click(awaitNode("Save button", n -> documents(n) && "android:id/button1".equals(n.getViewIdResourceName())));
    }
    static void select(String name) throws Exception {
        click(awaitNode("Saved document " + name, n -> documents(n) && text(n, name)));
    }
    static byte[] picked(ActivityScenario<MainActivity> activity, String name) throws Exception {
        begin(activity, "__hrtDocumentQualification.pick()");
        select(name);
        JSONObject read = result(activity);
        assertEquals("picked", read.getString("outcome")); assertEquals(name, read.getString("name"));
        JSONArray values = read.getJSONArray("bytes"); byte[] bytes = new byte[values.length()];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)values.getInt(i);
        return bytes;
    }
    static String sha(byte[] bytes) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format("%02x", value & 255));
        return hex.toString();
    }
    static void removeSynthetic(String name) throws Exception {
        assertTrue(name.matches("hrt-ui-[a-f0-9-]{36}\\.(json|csv|ics|pdf)"));
        // Test-created file only, on the runner's dedicated AVD. No wildcard cleanup.
        String path = "/sdcard/Download/" + name;
        // UiAutomation uses Runtime.exec, not a shell. One command, no quoting or operators.
        try (ParcelFileDescriptor fd = INSTRUMENTATION.getUiAutomation().executeShellCommand("rm -v " + path);
             InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            assertEquals("rm '" + path + "'\n", new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
    private static void report(String test, JSONObject value) throws Exception {
        value.put("test", test).put("outcome", "pass");
        Bundle status = new Bundle(); status.putString("document_ui_report", value.toString());
        INSTRUMENTATION.sendStatus(2, status);
    }
    static String png(Bitmap image) throws Exception {
        assertNotNull(image);
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, bytes));
            assertTrue("Bounded synthetic image", bytes.size() < 400_000);
            return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } finally { image.recycle(); }
    }
    private static void roundTrip(ActivityScenario<MainActivity> activity, String name, String mime, byte[] bytes) throws Exception {
        JSONArray values = new JSONArray(); for (byte value : bytes) values.put(value & 255);
        begin(activity, "__hrtDocumentQualification.save(" + values + "," + JSONObject.quote(name) + "," + JSONObject.quote(mime) + ")");
        saveAs(name); assertEquals("saved", result(activity).getString("outcome"));
        assertArrayEquals(bytes, picked(activity, name));
        removeSynthetic(name);
    }

    @Test public void systemDownloadsRoundTrip() throws Exception {
        JSONArray formats = new JSONArray();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            String[][] fixtures = {
                {"json", "application/json", "{\"synthetic\":\"💜\",\"value\":1}\n"},
                {"csv", "text/csv;charset=utf-8;", "Type,Dose,Unit\r\nsynthetic,12.5,mg\r\n"},
                {"ics", "text/calendar;charset=utf-8", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//qualification//EN\r\nEND:VCALENDAR\r\n"},
            };
            for (String[] fixture : fixtures) {
                byte[] bytes = fixture[2].getBytes(StandardCharsets.UTF_8);
                roundTrip(activity, unique(fixture[0]), fixture[1], bytes);
                formats.put(new JSONObject().put("extension", fixture[0]).put("bytes", bytes.length).put("sha256", sha(bytes)));
            }
        }
        report("systemDownloadsRoundTrip", new JSONObject().put("formats", formats).put("exactBytes", true).put("cleaned", true));
    }
    @Test public void systemCancellationAllowsRetry() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            begin(activity, "__hrtDocumentQualification.save([1]," + JSONObject.quote(unique("json")) + ")");
            assertTrue(INSTRUMENTATION.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
            assertEquals("cancelled", result(activity).getString("outcome"));
            begin(activity, "__hrtDocumentQualification.pick()");
            assertTrue(INSTRUMENTATION.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
            assertEquals("cancelled", result(activity).getString("outcome"));
            roundTrip(activity, unique("json"), "application/json", new byte[]{0, (byte)255, (byte)128, 10});
        }
        report("systemCancellationAllowsRetry", new JSONObject().put("saveCancelled", true).put("pickCancelled", true).put("retryExact", true).put("cleaned", true));
    }
    @Test public void sharedPdfRendersAndOpensExternally() throws Exception {
        String name = unique("pdf");
        JSONObject evidence = new JSONObject();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            begin(activity, "__hrtDocumentQualification.pdf()"); saveAs(name);
            assertEquals("saved", result(activity).getString("outcome"));
            byte[] bytes = picked(activity, name);
            assertTrue(new String(bytes, 0, 5, StandardCharsets.US_ASCII).equals("%PDF-"));
            evidence.put("pdfSha256", sha(bytes)).put("pdfBytes", bytes.length);
            // PdfRenderer needs a seekable FD. Only this synthetic test creates a
            // temporary copy; the production document adapter never does so.
            File file = File.createTempFile("synthetic-document-ui-", ".pdf", INSTRUMENTATION.getTargetContext().getNoBackupFilesDir());
            try {
                try (OutputStream output = new FileOutputStream(file)) { output.write(bytes); }
                try (PdfRenderer renderer = new PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY))) {
                    assertEquals(1, renderer.getPageCount()); evidence.put("pages", renderer.getPageCount());
                    try (PdfRenderer.Page page = renderer.openPage(0)) {
                        StringBuilder text = new StringBuilder();
                        page.getTextContents().forEach(item -> text.append(item.getText()).append(' '));
                        String normalized = text.toString().replaceAll("\\s+", " ");
                        for (String expected : new String[]{"Dose history", "12.5 mg", "injection", "valerate", "Lab results", "Estradiol", "Testosterone", "95 pg/mL", "425 ng/dL"})
                            assertTrue("Rendered PDF text: " + expected, normalized.contains(expected));
                        evidence.put("textVerified", true);
                        Bitmap bitmap = Bitmap.createBitmap(page.getWidth() * 2, page.getHeight() * 2, Bitmap.Config.ARGB_8888);
                        bitmap.eraseColor(Color.WHITE); page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        evidence.put("renderPng", png(bitmap));
                    }
                }
            } finally { assertTrue("Synthetic temporary PDF removed", file.delete()); }
            Intent files = new Intent(Intent.ACTION_VIEW).setDataAndType(
                DocumentsContract.buildRootUri("com.android.providers.downloads.documents", "downloads"),
                DocumentsContract.Root.MIME_TYPE_ITEM).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            INSTRUMENTATION.getTargetContext().startActivity(files);
            downloads(); click(awaitNode("Saved PDF in Files", n -> documents(n) && text(n, name)));
            awaitNode("External PDF viewer and exact filename", n -> VIEWER.contentEquals(n.getPackageName() == null ? "" : n.getPackageName()) && text(n, name));
            INSTRUMENTATION.getUiAutomation().waitForIdle(500, 10_000);
            evidence.put("viewerPackage", VIEWER).put("viewerOpened", true).put("viewerPng", png(INSTRUMENTATION.getUiAutomation().takeScreenshot()));
            assertTrue(INSTRUMENTATION.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
            assertTrue(INSTRUMENTATION.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
            removeSynthetic(name); evidence.put("cleaned", true).put("temporaryPdfRemoved", true);
        }
        report("sharedPdfRendersAndOpensExternally", evidence);
    }
}
