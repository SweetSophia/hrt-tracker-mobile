package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Completed instrumented measurement, never a phone/latency-budget acceptance claim. */
@RunWith(AndroidJUnit4.class)
public final class LongHistoryPerformanceTest {
    private static final String API = "__hrtLongHistoryQualification";
    private static long byteCount(JSONObject comparison, String key) throws JSONException {
        Object value = comparison.get(key);
        assertTrue(key + " must be a number", value instanceof Number);
        double bytes = ((Number) value).doubleValue();
        assertTrue(key + " must be a positive safe integer",
                bytes > 0 && bytes <= 9_007_199_254_740_991L && bytes == Math.floor(bytes));
        return (long) bytes;
    }
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        long until = System.currentTimeMillis() + 90_000;
        while (System.currentTimeMillis() < until) {
            if ("true".equals(js(a, expression))) return;
            Thread.sleep(100);
        }
        fail("Long-history condition timed out");
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a, "window.__longResult=null;Promise.resolve(" + expression + ").then(value=>window.__longResult={value},()=>window.__longResult={failed:true});void 0");
        waitFor(a, "Boolean(window.__longResult)");
        JSONObject result = new JSONObject((String) new JSONTokener(js(a, "JSON.stringify(window.__longResult)")).nextValue());
        assertFalse("Long-history setup failed", result.optBoolean("failed"));
        return result;
    }
    private static void overview(ActivityScenario<MainActivity> a) throws Exception {
        String buttons = "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.disabled&&!n.closest('[inert]')&&n.innerText.trim()==='Overview')";
        waitFor(a, buttons + ".length===1");
        js(a, buttons + "[0].click();void 0");
    }
    @Test public void ordinaryCappedHistory() throws Exception {
        try (ActivityScenario<MainActivity> a = ActivityScenario.launch(MainActivity.class)) {
            waitFor(a, "Boolean(window." + API + "&&window.__hrtScreenQualification)");
            call(a, "__hrtScreenQualification.prepare()");
            a.recreate();
            waitFor(a, "Boolean(window." + API + "&&window.__hrtScreenQualification)");
            assertEquals("\"https://localhost\"", js(a, "location.origin"));
            overview(a);
            Bundle arguments = InstrumentationRegistry.getArguments();
            boolean profile = "true".equals(arguments.getString("rendererProfile"));
            String mode = arguments.getString("deliveryMode");
            if (mode != null) {
                assertTrue("Delivery comparison requires profiling", profile);
                assertTrue("Unknown delivery comparison mode", "worker".equals(mode) || "preloaded".equals(mode)
                        || "direct".equals(mode) || "transferable".equals(mode));
            }
            if (profile) {
                js(a, "window.__hrtRendererProfileReady=true;void 0");
                waitFor(a, "window.__hrtRendererProfileArmed===true");
            }
            String control = arguments.getString("negativeControl");
            boolean heartbeat = "heartbeat".equals(control), pending = "pending-ui".equals(control);
            if (heartbeat) js(a, "window.__savedLongInterval=window.setInterval;window.setInterval=(fn,ms,...args)=>ms===5?window.__savedLongInterval(()=>{if(__hrtLongHistoryQualification.read().phase!=='worker')fn(...args);},ms):window.__savedLongInterval(fn,ms,...args);void 0");
            if (pending) js(a, "(()=>{const n=document.createElement('style');n.id='long-presentation-mask';n.textContent='.main-view svg{visibility:hidden!important}';document.head.appendChild(n);})()");
            try {
                call(a, API + ".start(" + (mode == null ? "" : JSONObject.quote(mode)) + ")");
                if (pending) {
                    waitFor(a, "['rendering','complete','failed'].includes(" + API + ".read().phase)");
                    assertTrue("control reached large worker delivery", call(a, API + ".read()").getJSONObject("value").getInt("samples") >= 100000);
                    // Deliberately retain a positive assertion: negative controls must fail
                    // instrumentation and produce no passing XML, like heartbeat suppression.
                    assertEquals("presentationBoundary", "true", js(a, API + ".screenReady()"));
                }
                waitFor(a, "['complete','failed'].includes(" + API + ".read().phase)");
                JSONObject observed = call(a, API + ".read()").getJSONObject("value");
                assertEquals("measurementComplete " + observed, "complete", observed.getString("phase"));
                JSONObject measured = call(a, API + ".finalize()").getJSONObject("value");
                JSONObject trace = measured.getJSONObject("trace"), m = trace.getJSONObject("metrics");
                JSONObject checks = new JSONObject()
                    .put("ordinaryHook", trace.getInt("workerId") > 0 && trace.getInt("requestId") > 0 && trace.getInt("events") == 43 && "mcmc".equals(trace.getString("method")))
                    .put("cappedGrid", trace.getInt("samples") >= 100000 && trace.getInt("samples") <= 100518)
                    .put("settledPresentation", "complete".equals(trace.getString("phase")) && trace.getInt("frames") == 2)
                    .put("workerProgress", m.getInt("workerTicks") > 0 && m.getInt("ticks") >= m.getInt("workerTicks"))
                    .put("snapshotStable", measured.getBoolean("snapshotUnchanged"))
                    .put("phaseOrder", Math.abs(m.getDouble("actionToPostMs") + m.getDouble("postToStartedMs") + m.getDouble("startedToResultMs") + m.getDouble("resultToFrameMs") - m.getDouble("totalMs")) < 0.001);
                for (java.util.Iterator<String> keys = checks.keys(); keys.hasNext();) {
                    String key = keys.next();
                    String detail = "workerProgress".equals(key) ? key + " aggregate=" + m.getInt("ticks") + "; worker=" + m.getInt("workerTicks") : key;
                    assertTrue(detail, checks.getBoolean(key));
                }
                // Keep the WebView alive until the host drains tracingComplete.
                if (profile) waitFor(a, "window.__hrtRendererProfileFinished===true");
                JSONObject result = new JSONObject()
                    .put("outcome", "pass").put("measurementOnly", true).put("performanceAccepted", false)
                    .put("rendererProfile", profile)
                    .put("localOrigin", true).put("snapshotUnchanged", measured.getBoolean("snapshotUnchanged"))
                    .put("beforeHash", measured.getString("beforeHash")).put("afterHash", measured.getString("afterHash"))
                    .put("checks", checks).put("trace", trace);
                if (mode != null) {
                    JSONObject comparison = measured.getJSONObject("deliveryComparison");
                    assertEquals("Delivery comparison mode", mode, comparison.getString("mode"));
                    assertTrue("Delivery output matched", comparison.getBoolean("sameOutput"));
                    byteCount(comparison, "outputBytes");
                    long replyBytes = byteCount(comparison, "replyBytes");
                    if ("transferable".equals(mode)) {
                        long bytes = byteCount(comparison, "transferredBytes");
                        assertTrue("Invalid transferred buffer size", bytes % Double.BYTES == 0 && bytes < replyBytes);
                    } else assertFalse("Unexpected transferred buffers", comparison.has("transferredBytes"));
                    result.put("deliveryComparison", comparison);
                }
                Bundle status = new Bundle(); status.putString("long_history_report", result.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
            } finally {
                js(a, "window." + API + "?.stop();document.getElementById('long-presentation-mask')?.remove();void 0");
                if (profile) js(a, "delete window.__hrtRendererProfileReady;delete window.__hrtRendererProfileArmed;delete window.__hrtRendererProfileFinished;void 0");
                if (heartbeat) js(a, "window.setInterval=window.__savedLongInterval;delete window.__savedLongInterval;void 0");
            }
        }
    }
}
