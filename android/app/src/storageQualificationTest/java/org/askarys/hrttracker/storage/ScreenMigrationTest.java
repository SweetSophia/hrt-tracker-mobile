package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import static org.askarys.hrttracker.storage.DocumentUiTest.*;
import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Shared React handlers in the installed WebView, with actual system pickers. */
public final class ScreenMigrationTest {
    private static final Instrumentation I = InstrumentationRegistry.getInstrumentation();
    private static final long NOW = 1793534400000L;
    private static JSONObject expectedFixture;

    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void ready(ActivityScenario<MainActivity> a) throws Exception {
        StorageBridgeTest.waitFor(a, "Boolean(window.__hrtScreenQualification)");
        // Pin the existing import's mutation clock; no product clock override ships.
        js(a, "Date.now=()=>" + NOW + ";void 0");
        expectedFixture=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(__hrtScreenQualification.fixture())")).nextValue());
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a, "window.__screenResult=null;Promise.resolve(" + expression + ").then(value=>window.__screenResult={value},error=>window.__screenResult={failed:true,reason:String(error.message).slice(0,160)});void 0");
        StorageBridgeTest.waitFor(a, "Boolean(window.__screenResult)");
        JSONObject result = new JSONObject((String)new JSONTokener(js(a, "JSON.stringify(window.__screenResult)")).nextValue());
        assertFalse("Qualification inspection/setup failed: " + result.optString("reason"), result.optBoolean("failed"));
        return result;
    }
    private static JSONObject state(ActivityScenario<MainActivity> a) throws Exception {
        return call(a, "__hrtScreenQualification.read()").getJSONObject("value");
    }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception { return state(a).getString("snapshot"); }
    private static void prepare(ActivityScenario<MainActivity> a) throws Exception {
        ready(a); assertEquals("ready", call(a, "__hrtScreenQualification.prepare()").getString("value"));
        a.recreate(); ready(a);
    }
    /** A null label matches the only visible control of its kind, without asking what it says. */
    private static String nodes(String selector, String label, boolean contains) {
        if (label == null)
            return "[...document.querySelectorAll(" + JSONObject.quote(selector) + ")].filter(n=>n.getClientRects().length && !n.disabled)";
        String value = JSONObject.quote(label);
        return "[...document.querySelectorAll(" + JSONObject.quote(selector) + ")].filter(n=>n.getClientRects().length && !n.disabled && " +
            "[n.getAttribute('aria-label')||'',n.textContent.trim()].some(t=>" + (contains ? "t.includes(" + value + ")" : "t===" + value) + "))";
    }
    private static void tap(ActivityScenario<MainActivity> a, String selector, String label, boolean contains) throws Exception {
        Bundle status = new Bundle(); status.putString("screen_step", label == null ? selector : label); I.sendStatus(2,status);
        String expression = nodes(selector, label, contains);
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(20);
        while (!"true".equals(js(a,expression + ".length===1"))) {
            if (System.nanoTime()>deadline) throw new AssertionError("Missing unique visible control: " + (label == null ? selector : label) + "; available=" +
                js(a,"JSON.stringify([...document.querySelectorAll("+JSONObject.quote(selector)+")].filter(n=>n.getClientRects().length).map(n=>n.getAttribute('aria-label')||n.textContent.trim()).slice(0,20))"));
            Thread.sleep(100);
        }
        assertEquals("true", js(a, "(()=>{const n=" + expression + "[0];n.scrollIntoView({block:'center'});n.click();return true})()"));
    }
    private static void button(ActivityScenario<MainActivity> a, String label) throws Exception { tap(a, "button", label, false); }
    private static void prompt(ActivityScenario<MainActivity> a, String type, String text) throws Exception {
        StorageBridgeTest.waitFor(a, "Boolean(document.querySelector('[data-prompt=" + type + "]')?.textContent.includes(" + JSONObject.quote(text) + "))");
    }
    private static void confirm(ActivityScenario<MainActivity> a, String label) throws Exception { tap(a, "[data-prompt=confirm] button", label, false); }
    private static void alert(ActivityScenario<MainActivity> a, String message) throws Exception {
        prompt(a, "alert", message); tap(a, "[data-prompt=alert] button", "OK", false);
    }
    private static void input(ActivityScenario<MainActivity> a, String selector, String value) throws Exception {
        StorageBridgeTest.waitFor(a, "document.querySelectorAll(" + JSONObject.quote(selector) + ").length===1");
        js(a, "(()=>{const n=document.querySelector(" + JSONObject.quote(selector) + ");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n," + JSONObject.quote(value) + ");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
    }
    private static void open(ActivityScenario<MainActivity> a, String page) throws Exception {
        button(a, "Settings");
        String category=nodes("button", "Data management", true);
        String target=nodes("button",page + " data",false);
        StorageBridgeTest.waitFor(a,category + ".length===1 || " + target + ".length===1");
        if ("true".equals(js(a,category + ".length===1"))) tap(a,"button","Data management",true);
        button(a, page + " data");
    }
    private static void picker() throws Exception { downloads(); I.getUiAutomation().waitForIdle(500, 10_000); }
    private static void documentIdle(ActivityScenario<MainActivity> a) throws Exception {
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(20);
        while (true) {
            java.util.concurrent.atomic.AtomicBoolean idle=new java.util.concurrent.atomic.AtomicBoolean();
            a.onActivity(activity -> {
                Object plugin=activity.getBridge().getPlugin("HrtNativeDocuments").getInstance();
                try {
                    java.lang.reflect.Field pending=plugin.getClass().getDeclaredField("pending");
                    pending.setAccessible(true); idle.set(pending.get(plugin)==null);
                } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
            });
            if (idle.get()) return;
            assertTrue("Native document completion timed out",System.nanoTime()<deadline); Thread.sleep(50);
        }
    }
    private static void saved(ActivityScenario<MainActivity> a,String name) throws Exception {
        saveAs(name); documentIdle(a);
    }
    private static void back(ActivityScenario<MainActivity> a) throws Exception {
        assertTrue(I.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)); documentIdle(a);
    }
    private static String canonical(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value; List<String> keys = new ArrayList<>();
            object.keys().forEachRemaining(keys::add); Collections.sort(keys);
            List<String> pairs = new ArrayList<>(); for (String key : keys) pairs.add(JSONObject.quote(key) + ":" + canonical(object.get(key)));
            return "{" + String.join(",", pairs) + "}";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray)value; List<String> items = new ArrayList<>();
            for (int n = 0; n < array.length(); n++) items.add(canonical(array.get(n)));
            return "[" + String.join(",", items) + "]";
        }
        return value instanceof String ? JSONObject.quote((String)value) : String.valueOf(value);
    }
    private static void sameBundle(JSONObject exported, JSONObject expected) throws Exception {
        exported.put("createdAt", expected.get("createdAt")); // Only the export clock is volatile.
        assertEquals(canonical(expected), canonical(exported));
    }
    private static void semantics(JSONObject state, String kind) throws Exception {
        JSONObject bundle = state.getJSONObject("bundle");
        assertEquals(kind.equals("baseline") ? 77 : 72, bundle.getInt("weight"));
        for (String mode : new String[]{"transfem", "transmasc"}) {
            JSONObject block = bundle.getJSONObject("modes").getJSONObject(mode);
            Set<String> ids = new TreeSet<>(); JSONArray events = block.getJSONArray("events");
            for (int n=0;n<events.length();n++) ids.add(events.getJSONObject(n).getString("id"));
            Set<String> expected = new TreeSet<>();
            if (!kind.equals("baseline")) expected.add("synthetic-" + mode + "-event");
            if (kind.equals("baseline") || kind.equals("merged") || kind.equals("legacy"))
                expected.add("synthetic-screen-local-" + mode);
            assertEquals("Exact events for " + mode, expected, ids);
            JSONObject expectedBlock=expectedFixture.getJSONObject("modes").getJSONObject(mode);
            for (int n=0;n<events.length();n++) {
                JSONObject expectedEvent=new JSONObject(expectedBlock.getJSONArray("events").getJSONObject(0).toString());
                if (events.getJSONObject(n).getString("id").startsWith("synthetic-screen-local-"))
                    expectedEvent.put("id","synthetic-screen-local-"+mode).put("doseMG",1);
                assertEquals(canonical(expectedEvent),canonical(events.getJSONObject(n)));
            }
            if (!kind.equals("baseline")) for (String category:new String[]{"labResults","doseTemplates","quickDoses","supplies","plan"})
                assertEquals("Exact imported "+mode+"."+category,canonical(expectedBlock.get(category)),canonical(block.get(category)));
            int count=kind.equals("baseline") ? 0 : 1;
            assertEquals(count, block.getJSONArray("labResults").length());
            assertEquals(count, block.getJSONArray("doseTemplates").length());
            assertEquals(count, block.getJSONArray("quickDoses").length());
            assertEquals(count*6, block.getJSONArray("supplies").length());
            assertEquals(count, block.getJSONArray("plan").length());
            if (count>0) for (String category:new String[]{"events","labResults","doseTemplates"}) {
                String suffix=category.equals("events") ? "event" : category.equals("labResults") ? "lab" : "template";
                assertEquals(NOW-1000,block.getJSONObject("deletions").getJSONObject(category).getLong("synthetic-"+mode+"-deleted-"+suffix));
            }
            if (kind.equals("replaced")) assertEquals(NOW, block.getJSONObject("deletions").getJSONObject("events").getLong("synthetic-screen-local-" + mode));
        }
        assertEquals("en", bundle.getJSONObject("preferences").getString("hrt-lang"));
        assertEquals("off", bundle.getJSONObject("calibration").getString("method"));
    }
    private static String incoming(ActivityScenario<MainActivity> a) throws Exception {
        String name = unique("json");
        begin(a, "__hrtDocumentQualification.save(Array.from(new TextEncoder().encode(JSON.stringify(__hrtScreenQualification.fixture())))," + JSONObject.quote(name) + ")");
        saveAs(name); assertEquals("saved", result(a).getString("outcome")); return name;
    }
    private static void importFile(ActivityScenario<MainActivity> a, String name, boolean replace) throws Exception {
        open(a, "Import");
        tap(a, "button", replace ? "Replace this device from a complete backup" : "Select JSON file", true);
        picker(); select(name);
    }
    private static byte[] exportFile(ActivityScenario<MainActivity> a, String label, String extension) throws Exception {
        String name = unique(extension); tap(a, "button", label, true); picker(); saved(a,name);
        byte[] bytes = picked(a, name); removeSynthetic(name); return bytes;
    }
    private static JSONObject completeExport(ActivityScenario<MainActivity> a) throws Exception {
        open(a, "Export"); tap(a, "button", "Complete backup", true);
        prompt(a, "confirm", "Download an unencrypted backup?"); confirm(a, "Download");
        String name = unique("json"); picker(); saved(a,name);
        byte[] bytes = picked(a, name); removeSynthetic(name);
        JSONObject exported = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        sameBundle(exported, state(a).getJSONObject("bundle")); return exported;
    }
    private static void absentWithControl(String absent, String present) throws Exception {
        assertTrue(absent.matches("hrt-ui-[a-f0-9-]{36}\\.json"));
        try (ParcelFileDescriptor fd=I.getUiAutomation().executeShellCommand("ls -1 /sdcard/Download");
             InputStream input=new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            Set<String> names=new HashSet<>(Arrays.asList(new String(input.readAllBytes(),StandardCharsets.UTF_8).split("\\r?\\n")));
            assertTrue("Downloads listing includes known saved control", names.contains(present));
            assertFalse("Cancelled save did not create its unique file", names.contains(absent));
        }
    }
    /**
     * The report row opens the options screen, and the options screen owns the
     * save. The row's call to action is the design's to change, so the row is
     * matched on the "PDF" the reader sees and not on the words beside it.
     */
    private static byte[] reportPdf(ActivityScenario<MainActivity> a) throws Exception {
        String name = unique("pdf");
        tap(a, "button", "PDF", true);
        // The range picker is the only listbox on the options screen.
        tap(a, "button[aria-haspopup=listbox]", null, false);
        // The synthetic rows sit on 1 Nov 2026. The default window is the last
        // ninety days of the device clock, and the clock is not the test's to
        // set, so all time is what keeps those rows in the report wherever the
        // device stands.
        tap(a, "button[role=option]", "All time", false);
        tap(a, "button", "Save PDF", false);
        picker(); saved(a, name);
        byte[] bytes = picked(a, name); removeSynthetic(name); return bytes;
    }
    /**
     * The finished page, read back: the two dose rows and the lab result in
     * the words the report prints. The stored unit is "pg/ml" and the printed
     * one is "pg/mL", so the raw form must not appear.
     */
    private static void verifyReportPdf(byte[] bytes) throws Exception {
        File file=File.createTempFile("synthetic-screen-", ".pdf", I.getTargetContext().getNoBackupFilesDir());
        try {
            try (OutputStream output=new FileOutputStream(file)) { output.write(bytes); }
            try (android.graphics.pdf.PdfRenderer renderer=new android.graphics.pdf.PdfRenderer(ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY))) {
                assertEquals(1,renderer.getPageCount());
                try (android.graphics.pdf.PdfRenderer.Page page=renderer.openPage(0)) {
                    StringBuilder text=new StringBuilder(); page.getTextContents().forEach(item->text.append(item.getText()).append(' '));
                    String normalized=text.toString().replaceAll("\\s+"," ");
                    for (String expected:new String[]{"HRT Tracker report","All time","Dose history","Lab results","Oral estradiol","1 mg","2 mg","120","pg/mL","Dose entries: 2","Lab results: 1"})
                        assertTrue("Actual screen PDF data: "+expected,normalized.contains(expected));
                    // The cells of each row, in the order the page draws them.
                    for (String row:new String[]{"Estradiol 120 pg/mL","Oral estradiol Oral 1 mg","Oral estradiol Oral 2 mg"})
                        assertTrue("Actual screen PDF row: "+row,normalized.contains(row));
                    assertFalse("Actual screen PDF keeps the raw stored unit",normalized.contains("pg/ml"));
                }
            }
        } finally { assertTrue("Synthetic PDF temp removed",file.delete()); }
    }
    private static void emit(String phase, JSONObject value) throws Exception {
        value.put("phase", phase).put("outcome", "pass").put("pid", android.os.Process.myPid()); Bundle status=new Bundle();
        status.putString("screen_report", value.toString()); I.sendStatus(2,status);
    }
    @Test public void screenJourneys() throws Exception {
        JSONObject report=new JSONObject();
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); semantics(state(a),"baseline"); String name=incoming(a);
            completeExport(a);
            String before=snapshot(a);
            importFile(a,name,false); prompt(a,"confirm","Merge this backup?"); assertEquals(before,snapshot(a));
            report.put("previewPng",png(I.getUiAutomation().takeScreenshot()));
            confirm(a,"Cancel"); assertEquals(before,snapshot(a));
            importFile(a,name,false); prompt(a,"confirm","Merge this backup?"); confirm(a,"Merge");
            alert(a,"Backup merged."); semantics(state(a),"merged"); completeExport(a);
            report.put("previewNoWrite",true).put("mergeCancelledUnchanged",true).put("bothModesMerged",true).put("completeExportExact",true);

            // The ordinary shared exporters are reached through their actual rows.
            open(a,"Export"); byte[] legacy=exportFile(a,"Export JSON file","json");
            JSONObject plain=new JSONObject(new String(legacy,StandardCharsets.UTF_8));
            assertEquals(2,plain.getJSONArray("events").length());
            JSONObject active=state(a).getJSONObject("bundle").getJSONObject("modes").getJSONObject("transfem");
            for (String category:new String[]{"events","labResults","doseTemplates"}) assertEquals(canonical(active.get(category)),canonical(plain.get(category)));
            byte[] csv=exportFile(a,"Export CSV file","csv");
            String csvText=new String(csv,StandardCharsets.UTF_8);
            assertEquals(4,csvText.split("\\n").length);
            for (String expected:new String[]{",1,mg,oral - E2",",2,mg,oral - E2",",120,pg/ml,-"}) assertTrue(csvText.contains(expected));
            report.put("csvRowsVerified",true);
            byte[] pdf=reportPdf(a);
            assertEquals("%PDF-",new String(pdf,0,5,StandardCharsets.US_ASCII));
            assertTrue(pdf.length>3000); verifyReportPdf(pdf); report.put("pdfTextVerified",true);
            report.put("jsonRows",2).put("csvSha256",sha(csv)).put("pdfSha256",sha(pdf));

            tap(a,"button","JSON (Encrypted)",true);
            button(a,"Export encrypted file"); picker(); String cancelled=unique("json"); setSaveName(cancelled);
            assertEquals("0",js(a,"document.querySelectorAll('span.select-all').length")); back(a);
            StorageBridgeTest.waitFor(a,nodes("button","Export encrypted file",false)+".length===1");
            absentWithControl(cancelled,name);
            button(a,"Export encrypted file"); picker(); String encrypted=unique("json"); saved(a,encrypted);
            StorageBridgeTest.waitFor(a,"document.querySelectorAll('span.select-all').length===1");
            String password=(String)new JSONTokener(js(a,"document.querySelector('span.select-all').textContent")).nextValue();
            assertTrue("Generated backup password is shown",password.length()>=12);
            byte[] cipher=picked(a,encrypted); assertFalse(new String(cipher,StandardCharsets.UTF_8).contains("synthetic-screen-local"));
            button(a,"OK"); report.put("cancelledSaveAbsent",true).put("encryptedSaved",true);

            before=snapshot(a); importFile(a,name,true); prompt(a,"confirm","Replace this device");
            assertEquals(before,snapshot(a)); confirm(a,"Keep it"); assertEquals(before,snapshot(a));
            importFile(a,name,true); prompt(a,"confirm","Replace this device"); confirm(a,"Replace everything");
            alert(a,"Complete backup restored."); semantics(state(a),"replaced"); completeExport(a);
            report.put("replaceCancelledUnchanged",true).put("bothModesReplaced",true);

            before=snapshot(a); importFile(a,encrypted,false);
            StorageBridgeTest.waitFor(a,"Boolean(document.querySelector('input[autocomplete=current-password]'))");
            tap(a,"form.inline-prompt button","Cancel",false); assertEquals(before,snapshot(a));
            importFile(a,encrypted,false); input(a,"input[autocomplete=current-password]","synthetic-wrong-password");
            tap(a,"form.inline-prompt button","OK",false);
            prompt(a,"alert","Decryption failed."); assertEquals(before,snapshot(a));
            alert(a,"Decryption failed."); report.put("wrongPasswordUnchanged",true);
            input(a,"input[autocomplete=current-password]",password);
            tap(a,"form.inline-prompt button","OK",false); prompt(a,"confirm","Replace your records");
            assertEquals(before,snapshot(a)); confirm(a,"Replace"); alert(a,"Imported doses successfully.");
            semantics(state(a),"legacy"); completeExport(a);
            report.put("passwordCancelledUnchanged",true).put("encryptedImportExact",true);

            // Picker cancellation returns to the screen and permits a subsequent complete export.
            before=snapshot(a); open(a,"Import"); tap(a,"button","Select JSON file",true); picker(); back(a);
            StorageBridgeTest.waitFor(a,nodes("button","Select JSON file",true)+".length===1"); assertEquals(before,snapshot(a));
            completeExport(a); report.put("pickerCancelledUnchanged",true).put("retrySucceeded",true);
            button(a,"Overview"); button(a,"Medication plan");
            byte[] ics=exportFile(a,"Remind me in my calendar","ics");
            String calendar=new String(ics,StandardCharsets.UTF_8);
            assertTrue(calendar.contains("BEGIN:VCALENDAR")); assertTrue(calendar.contains("BEGIN:VEVENT"));
            alert(a,"Open the file you just saved"); report.put("icsSha256",sha(ics));
            removeSynthetic(name); removeSynthetic(encrypted);
            report.put("cleaned",true).put("snapshotSha256",sha(snapshot(a).getBytes(StandardCharsets.UTF_8)));
        }
        emit("screenJourneys",report);
    }
    @Test public void confirmedRestartSeed() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String name=incoming(a); importFile(a,name,true); prompt(a,"confirm","Replace this device");
            confirm(a,"Replace everything"); alert(a,"Complete backup restored."); semantics(state(a),"replaced"); removeSynthetic(name);
            emit("confirmedRestartSeed",new JSONObject().put("acknowledged",true).put("cleaned",true).put("snapshotSha256",sha(snapshot(a).getBytes(StandardCharsets.UTF_8))));
        }
    }
    @Test public void pendingRestartSeed() throws Exception {
        ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class);
        prepare(a); String name=incoming(a); String before=snapshot(a); importFile(a,name,true); prompt(a,"confirm","Replace this device");
        assertEquals(before,snapshot(a)); removeSynthetic(name);
        // Never return to AndroidJUnitRunner cleanup: the host must stop this live preview.
        a.onActivity(activity -> { assertFalse(activity.isFinishing()); assertFalse(activity.isDestroyed()); });
        JSONObject boundary=new JSONObject().put("phase","pendingRestartSeed").put("outcome","waiting")
            .put("pid",android.os.Process.myPid()).put("previewOpen",true).put("unchanged",true).put("cleaned",true)
            .put("holdMillis",60000).put("snapshotSha256",sha(before.getBytes(StandardCharsets.UTF_8)));
        Bundle status=new Bundle(); status.putString("screen_boundary",boundary.toString()); I.sendStatus(2,status);
        new java.util.concurrent.CountDownLatch(1).await(60,java.util.concurrent.TimeUnit.SECONDS);
        fail("Host did not interrupt the live replacement preview before timeout");
    }
    private static void verifyRestart(String phase,String kind) throws Exception {
        String expected=InstrumentationRegistry.getArguments().getString("expectedDigest");
        assertNotNull("Run through the phase-aware host runner",expected); assertTrue(expected.matches("[a-f0-9]{64}"));
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); semantics(state(a),kind); String actual=sha(snapshot(a).getBytes(StandardCharsets.UTF_8)); assertEquals(expected,actual);
            assertEquals("0",js(a,"document.querySelectorAll('[data-prompt],form.inline-prompt').length"));
            completeExport(a); assertEquals(actual,sha(snapshot(a).getBytes(StandardCharsets.UTF_8)));
            emit(phase,new JSONObject().put("snapshotSha256",actual).put("reopenedExact",true).put("noReplay",true).put("exportExact",true).put("cleaned",true));
        }
    }
    @Test public void confirmedRestartVerify() throws Exception { verifyRestart("confirmedRestartVerify","replaced"); }
    @Test public void pendingRestartVerify() throws Exception { verifyRestart("pendingRestartVerify","baseline"); }
}
