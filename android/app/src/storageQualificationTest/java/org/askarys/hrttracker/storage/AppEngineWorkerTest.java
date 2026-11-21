package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Actual ordinary React model hook, with synthetic records in the qualification APK. */
public final class AppEngineWorkerTest {
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        StorageBridgeTest.waitFor(a, expression);
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a, "window.__appWorkerResult=null;Promise.resolve(" + expression + ").then(value=>window.__appWorkerResult={value},()=>window.__appWorkerResult={failed:true});void 0");
        waitFor(a, "Boolean(window.__appWorkerResult)");
        JSONObject result = new JSONObject((String)new JSONTokener(js(a, "JSON.stringify(window.__appWorkerResult)")).nextValue());
        assertFalse("App worker setup failed", result.optBoolean("failed"));
        return result;
    }
    private static JSONObject observed(ActivityScenario<MainActivity> a) throws Exception {
        return call(a, "__hrtAppEngineWorkerQualification.read()").getJSONObject("value");
    }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {
        return call(a, "__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }
    private static void button(ActivityScenario<MainActivity> a, String name) throws Exception {
        String nodes = "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.disabled&&n.textContent.trim()===" + JSONObject.quote(name) + ")";
        waitFor(a, nodes + ".length===1");
        js(a, nodes + "[0].click();void 0");
    }
    private static void modelReady(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a, "(()=>{const r=__hrtAppEngineWorkerQualification.read();return r.metrics.mcmcResults>0&&r.last.hasE2&&r.last.baselineHash.length===64&&!document.body.textContent.includes('Updating estimates')&&!document.body.textContent.includes('Estimates could not be calculated')})()");
    }
    @Test public void ordinaryScreenModel() throws Exception {
        try (ActivityScenario<MainActivity> a = ActivityScenario.launch(MainActivity.class)) {
            waitFor(a, "Boolean(window.__hrtAppEngineWorkerQualification&&window.__hrtScreenQualification)");
            call(a, "__hrtScreenQualification.prepare()");
            a.recreate();
            waitFor(a, "Boolean(window.__hrtAppEngineWorkerQualification&&window.__hrtScreenQualification)");
            assertEquals("\"https://localhost\"", js(a, "location.origin"));
            boolean negative = "heartbeat".equals(InstrumentationRegistry.getArguments().getString("negativeControl"));
            if (negative) js(a, "window.__savedAppWorkerInterval=window.setInterval;window.setInterval=()=>0;void 0");
            try {
                call(a, "__hrtAppEngineWorkerQualification.seed()");
                button(a, "Overview");
                modelReady(a);
                JSONObject first = observed(a);
                JSONObject checks = new JSONObject();
                checks.put("ordinaryHook", first.getJSONObject("metrics").getInt("requests") > 0);
                checks.put("exactSamples", first.getJSONObject("last").getBoolean("samplesCovered"));
                checks.put("rendererProgress", first.getJSONObject("metrics").getInt("ticks") > 0);
                assertTrue("rendererProgress", checks.getBoolean("rendererProgress"));
                String before = snapshot(a);
                long clock = first.getJSONObject("last").getLong("nowMs");
                String baseline = first.getJSONObject("last").getString("baselineHash");
                // Natural readout tick, rather than a qualification-only callback.
                Thread.sleep(61_000);
                waitFor(a, "__hrtAppEngineWorkerQualification.read().last.nowMs>" + clock);
                modelReady(a);
                JSONObject tick = observed(a);
                checks.put("readoutTick", tick.getJSONObject("last").getLong("nowMs") > clock);
                checks.put("baselineStable", baseline.equals(tick.getJSONObject("last").getString("baselineHash")));
                call(a, "__hrtAppEngineWorkerQualification.fail()");
                waitFor(a, "document.body.textContent.includes('Estimates could not be calculated. Your records are still available.')");
                checks.put("failureVisible", "true".equals(js(a, "[...document.querySelectorAll('button')].some(n=>n.getClientRects().length&&n.textContent.trim()==='History')")));
                int completed = observed(a).getJSONObject("metrics").getInt("results");
                call(a, "__hrtAppEngineWorkerQualification.recover()");
                button(a, "Retry estimates");
                modelReady(a);
                checks.put("retrySucceeded", observed(a).getJSONObject("metrics").getInt("results") > completed);
                String after = snapshot(a);
                checks.put("recordsUnchanged", before.equals(after));
                for (java.util.Iterator<String> keys = checks.keys(); keys.hasNext();) {
                    String key = keys.next(); assertTrue(key, checks.getBoolean(key));
                }
                JSONObject result = new JSONObject().put("checks", checks).put("metrics", observed(a).getJSONObject("metrics"))
                    .put("outcome", "pass").put("snapshotUnchanged", before.equals(after)).put("localOrigin", true)
                    .put("beforeHash", DocumentUiTest.sha(before.getBytes(StandardCharsets.UTF_8)))
                    .put("afterHash", DocumentUiTest.sha(after.getBytes(StandardCharsets.UTF_8)));
                Bundle status = new Bundle(); status.putString("app_engine_worker_report", result.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
            } finally {
                if (negative) js(a, "window.setInterval=window.__savedAppWorkerInterval;delete window.__savedAppWorkerInterval;void 0");
            }
        }
    }
}
