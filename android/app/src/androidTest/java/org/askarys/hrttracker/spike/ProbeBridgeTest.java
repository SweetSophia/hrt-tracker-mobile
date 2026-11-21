package org.askarys.hrttracker.spike;

import static org.junit.Assert.*;

import android.os.Bundle;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Debug test APK only. Invokes the bundled, probe-only entry through the real bridge WebView. */
@RunWith(AndroidJUnit4.class)
public class ProbeBridgeTest {
    private String evaluate(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        activity.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(expression, value -> {
            result.set(value);
            done.countDown();
        }));
        assertTrue("WebView callback timed out", done.await(15, TimeUnit.SECONDS));
        return result.get();
    }

    @Test
    public void externalNavigationLeavesPrivilegedWebView() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        IntentFilter filter = new IntentFilter(Intent.ACTION_VIEW);
        filter.addDataScheme("https");
        filter.addCategory(Intent.CATEGORY_BROWSABLE);
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(filter, null, true);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!"true".equals(evaluate(activity, "Boolean(window.__hrtProbe)"))) {
                assertTrue("Probe not ready", System.nanoTime() < deadline);
                Thread.sleep(100);
            }
            evaluate(activity, "location.href='https://example.invalid/feasibility';void 0");
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (monitor.getHits() == 0 && System.nanoTime() < deadline) Thread.sleep(100);
            assertEquals("External URL must dispatch an OS intent", 1, monitor.getHits());
            assertEquals("\"https://localhost\"", evaluate(activity, "location.origin"));
        } finally { instrumentation.removeMonitor(monitor); }
    }

    @Test
    public void bundledProbeReturnsCheckedReport() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String runId = args.getString("runId", "instrumentation");
        String scenario = args.getString("scenario", "capabilities");
        String phase = args.getString("phase", "verify");
        runCheckedProbe(runId, scenario, phase);
    }

    public void runCheckedProbe(String runId, String scenario, String phase) throws Exception {
        JSONObject request = new JSONObject().put("runId", runId).put("scenario", scenario).put("phase", phase);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
            while (!"true".equals(evaluate(activity, "Boolean(window.__hrtProbe)"))) {
                assertTrue("Probe entry absent; install the probe build", System.nanoTime() < deadline);
                Thread.sleep(100);
            }
            evaluate(activity, "window.__hrtProbeResult=null;window.__hrtProbe.run(" + request + ").then(r=>window.__hrtProbeResult=r);void 0");
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(180);
            String raw;
            do {
                raw = evaluate(activity, "JSON.stringify(window.__hrtProbeResult)");
                if (!"\"null\"".equals(raw)) break;
                assertTrue("Probe timed out", System.nanoTime() < deadline);
                Thread.sleep(100);
            } while (true);
            JSONObject report = new JSONObject((String) new JSONTokener(raw).nextValue());
            Bundle status = new Bundle();
            status.putString("probe", report.toString());
            InstrumentationRegistry.getInstrumentation().sendStatus(0, status);
            assertEquals(runId, report.getString("runId"));
            assertEquals(scenario, report.getString("scenario"));
            assertEquals(phase, report.getString("phase"));
            assertTrue("Unexpected outcome", report.getString("outcome").equals("pass") ||
                (phase.equals("prepare") && report.getString("outcome").equals("ready")));
            JSONObject checks = report.getJSONObject("checks");
            assertTrue("No checks ran", checks.length() > 0);
            for (java.util.Iterator<String> it = checks.keys(); it.hasNext();) {
                String key = it.next();
                assertTrue("Failed check: " + key, checks.getBoolean(key));
            }
        }
    }
}
