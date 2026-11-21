package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual ordinary educational demos, with qualification-only observation and synthetic records. */
@RunWith(AndroidJUnit4.class)
public final class DemoEngineWorkerTest {
    private static final String ERROR = "Estimates could not be calculated. Your records are still available.";

    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }

    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        // Calibration's MCMC picture can use most of the ordinary 30-second task budget.
        long until = System.currentTimeMillis() + 90_000;
        while (System.currentTimeMillis() < until) {
            if ("true".equals(js(a, expression))) return;
            Thread.sleep(100);
        }
        fail("Demo UI condition timed out");
    }

    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a, "window.__demoResult=null;Promise.resolve(" + expression + ").then(value=>window.__demoResult={value},()=>window.__demoResult={failed:true});void 0");
        waitFor(a, "Boolean(window.__demoResult)");
        JSONObject result = new JSONObject((String) new JSONTokener(js(a, "JSON.stringify(window.__demoResult)")).nextValue());
        assertFalse("Demo setup failed", result.optBoolean("failed"));
        return result;
    }

    private static JSONObject read(ActivityScenario<MainActivity> a) throws Exception {
        return call(a, "__hrtDemoWorkerQualification.read()").getJSONObject("value");
    }

    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {
        return call(a, "__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }

    /** Visible label only. Tab measurement copies are hidden; a back control appends ", Back". */
    private static String buttons(String name) {
        return "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.disabled&&!n.closest('[inert]')&&(()=>{const t=n.innerText.replace(/\\s*,\\s*Back\\s*$/,'').trim().split('\\n')[0].trim();return t===" + JSONObject.quote(name) + ";})())";
    }

    private static void button(ActivityScenario<MainActivity> a, String name) throws Exception {
        String nodes = buttons(name);
        waitFor(a, nodes + ".length===1");
        js(a, nodes + "[0].click();void 0");
    }

    /** About is a desktop tab or a phone category whose hint continues on the next line. */
    private static void openAbout(ActivityScenario<MainActivity> a) throws Exception {
        String open = buttons("Model explanation") + ".length===1&&" + buttons("Model demos") + ".length===1";
        // Navigation commits after click(). Wait for the destination instead of treating
        // an in-flight transition as the category list. The About header goes back.
        String entry = buttons("About") + ".filter(n=>!n.closest('.glass-bar'))";
        waitFor(a, "(" + open + ")||" + entry + ".length===1");
        if (!"true".equals(js(a, open))) js(a, entry + "[0].click();void 0");
        waitFor(a, open);
    }

    private static void setRange(ActivityScenario<MainActivity> a, String id, String value) throws Exception {
        waitFor(a, "Boolean(document.getElementById(" + JSONObject.quote(id) + "))");
        js(a, "(()=>{const n=document.getElementById(" + JSONObject.quote(id) + ");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n," + JSONObject.quote(value) + ");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
    }

    private static String kindReady(String kind, String element) {
        String present = element == null ? "true" : "Boolean(document.getElementById(" + JSONObject.quote(element) + "))";
        return present + "&&__hrtDemoWorkerQualification.read().kinds.includes(" + JSONObject.quote(kind) + ")&&__hrtDemoWorkerQualification.read().active===0";
    }

    private static String presentationReady(String kind) {
        switch (kind) {
            case "model-guide": return "((()=>{const hit=(role,phrase)=>[...document.querySelectorAll('[role=\"'+role+'\"]')].some(n=>n.getClientRects().length&&n.innerText.includes(phrase));return !hit('status','Updating estimates')&&!hit('alert','Estimates could not be calculated. Your records are still available.');})())&&((()=>{const chart=[...document.querySelectorAll('svg[role=\"img\"]')].find(n=>n.getClientRects().length&&n.getAttribute('aria-label')===\"One dose\" );return !!chart&&[...chart.querySelectorAll('path')].some(p=>p.getClientRects().length&&p.getAttribute('stroke')==='var(--chart-line)');})())";
            case "sandbox": return "((()=>{const hit=(role,phrase)=>[...document.querySelectorAll('[role=\"'+role+'\"]')].some(n=>n.getClientRects().length&&n.innerText.includes(phrase));return !hit('status','Updating estimates')&&!hit('alert','Estimates could not be calculated. Your records are still available.');})())&&((()=>{const peak=[...document.querySelectorAll('dt')].find(n=>n.getClientRects().length&&n.innerText.trim()==='Peak');const value=peak?.parentElement?.querySelector('dd'),tex=document.querySelector('.pk-tex');return !!value&&!!value.getClientRects().length&&/^\\d+\\.\\d pg\\/mL$/.test(value.innerText.trim())&&!!tex&&!!tex.getClientRects().length&&tex.textContent.trim().length>0;})())";
            case "onboarding": return "((()=>{const hit=(role,phrase)=>[...document.querySelectorAll('[role=\"'+role+'\"]')].some(n=>n.getClientRects().length&&n.innerText.includes(phrase));return !hit('status','Updating estimates')&&!hit('alert','Estimates could not be calculated. Your records are still available.');})())&&((()=>{const step=document.querySelector('#root .onboarding-steps'),title=step?.querySelector('h1');if(!title||!title.getClientRects().length||title.innerText.trim()!=='How it works')return false;const svg=step.querySelector('svg[viewBox=\"0 0 320 146\"]');return !!svg&&!!svg.getClientRects().length&&[...svg.querySelectorAll('circle')].filter(n=>n.getClientRects().length&&n.getAttribute('r')==='3').length===8;})())";
            case "calibration-guide": return "((()=>{const hit=(role,phrase)=>[...document.querySelectorAll('[role=\"'+role+'\"]')].some(n=>n.getClientRects().length&&n.innerText.includes(phrase));return !hit('status','Updating estimates')&&!hit('alert','Estimates could not be calculated. Your records are still available.');})())&&((()=>{const chart=[...document.querySelectorAll('svg[role=\"img\"]')].find(n=>n.getClientRects().length&&n.getAttribute('aria-label')==='Try it');const series=!!chart&&[...chart.querySelectorAll('path')].some(p=>p.getClientRects().length&&p.getAttribute('stroke')==='var(--chart-line)');const lab=[...document.querySelectorAll('dt')].find(n=>n.getClientRects().length&&n.innerText.trim()==='at latest lab'),value=lab?.parentElement?.querySelector('dd');return series&&!!value&&!!value.getClientRects().length&&/^×\\d+\\.\\d{2}$/.test(value.innerText.trim());})())";
            default: throw new IllegalArgumentException("Unknown demo kind");
        }
    }

    private static void presentationMask(ActivityScenario<MainActivity> a, boolean enabled) throws Exception {
        js(a, "document.getElementById('hrt-presentation-mask')?.remove();document.querySelector('[data-qualification-pending]')?.remove();document.querySelectorAll('[data-hrt-masked]').forEach(n=>{n.hidden=false;delete n.dataset.hrtMasked;});void 0");
        if (!enabled) return;
        js(a, "(()=>{const style=document.createElement('style');style.id='hrt-presentation-mask';style.textContent='svg[role=\"img\"][aria-label=\"One dose\"],svg[role=\"img\"][aria-label=\"Try it\"],.pk-tex,.onboarding-steps svg[viewBox=\"0 0 320 146\"] circle{display:none!important}';document.head.appendChild(style);for(const label of ['Peak','at latest lab']){const row=[...document.querySelectorAll('dt')].find(n=>n.textContent.trim()===label)?.parentElement;if(row){row.dataset.hrtMasked='true';row.hidden=true;}}const bar=document.createElement('div');bar.setAttribute('role','status');bar.dataset.qualificationPending='pending';bar.style.cssText='position:fixed;z-index:99999;inset:0 auto auto 0;padding:12px;background:#fff';bar.appendChild(document.createElement('p')).textContent='Updating estimates…';document.body.appendChild(bar);})()");
    }

    private static boolean mcmcProgress(JSONObject report) throws Exception {
        JSONArray jobs = report.getJSONArray("mcmcJobs");
        if (jobs.length() != report.getJSONObject("metrics").getInt("mcmcResults") || jobs.length() == 0) return false;
        for (int i = 0; i < jobs.length(); i++) if (jobs.getJSONObject(i).getInt("ticks") <= 0) return false;
        return true;
    }

    private static boolean retained(ActivityScenario<MainActivity> a) throws Exception {
        return "true".equals(js(a, "document.getElementById('cal-guide-level')?.value==='1.5'&&document.getElementById('cal-guide-count')?.value==='3'"));
    }

    private static boolean terminalError(ActivityScenario<MainActivity> a) throws Exception {
        return "true".equals(js(a,
            "[...document.querySelectorAll('[role=alert]')].some(n=>n.getClientRects().length&&n.innerText.includes(" + JSONObject.quote(ERROR) + "))"
                + "&&![...document.querySelectorAll('[role=status]')].some(n=>n.getClientRects().length&&n.innerText.includes('Updating estimates'))"));
    }

    private static void expectKinds(JSONArray kinds) throws Exception {
        assertEquals(4, kinds.length());
        Set<String> found = new HashSet<>();
        for (int i = 0; i < kinds.length(); i++) found.add(kinds.getString(i));
        for (String kind : new String[] {"onboarding", "model-guide", "calibration-guide", "sandbox"})
            assertTrue(kind, found.contains(kind));
    }

    @Test public void ordinaryEducationalDemos() throws Exception {
        try (ActivityScenario<MainActivity> a = ActivityScenario.launch(MainActivity.class)) {
            waitFor(a, "Boolean(window.__hrtDemoWorkerQualification&&window.__hrtScreenQualification&&window.__hrtAppEngineWorkerQualification)");
            call(a, "__hrtScreenQualification.prepare()");
            a.recreate();
            waitFor(a, "Boolean(window.__hrtDemoWorkerQualification&&window.__hrtScreenQualification&&window.__hrtAppEngineWorkerQualification)");
            assertEquals("\"https://localhost\"", js(a, "location.origin"));
            call(a, "__hrtAppEngineWorkerQualification.seed()");
            button(a, "Overview");
            waitFor(a, "__hrtAppEngineWorkerQualification.read().metrics.mcmcResults>0&&!document.body.innerText.includes('Updating estimates')");
            String before = snapshot(a);
            String control = InstrumentationRegistry.getArguments().getString("negativeControl");
            boolean negative = "heartbeat".equals(control);
            boolean mcmcNegative = "mcmc-heartbeat".equals(control);
            if (negative) js(a, "window.__savedDemoInterval=window.setInterval;window.setInterval=()=>0;void 0");
            try {
                button(a, "Settings");
                openAbout(a);
                button(a, "Model explanation");
                waitFor(a, kindReady("model-guide", "model-doc-dose") + "&&" + presentationReady("model-guide"));
                if ("pending-initial".equals(control)) {
                    presentationMask(a, true);
                    assertEquals("initial control keeps transport complete", "true", js(a, kindReady("model-guide", "model-doc-dose")));
                    assertEquals("initialPresentation", "true", js(a, presentationReady("model-guide")));
                    presentationMask(a, false);
                }
                button(a, "Model explanation");
                openAbout(a);
                button(a, "Model demos");
                button(a, "Single dose");
                waitFor(a, kindReady("sandbox", "pk-calc-dose") + "&&" + presentationReady("sandbox"));
                button(a, "Model demos");
                openAbout(a);
                button(a, "Show the intro again");
                waitFor(a, "document.querySelector('#root .onboarding-steps h1')?.innerText.trim()==='Hello there'");
                button(a, "Next");
                waitFor(a, "document.querySelector('#root .onboarding-steps h1')?.innerText.trim()==='What are you tracking?'");
                button(a, "Next");
                waitFor(a, kindReady("onboarding", null) + "&&" + presentationReady("onboarding"));
                button(a, "Skip");
                button(a, "Labs");
                button(a, "Calibration settings");
                if (mcmcNegative) {
                    assertTrue("earlier demo heartbeat", read(a).getJSONObject("metrics").getInt("ticks") > 0);
                    call(a, "__hrtDemoWorkerQualification.setMcmcHeartbeatSuppressed(true)");
                }
                button(a, "How these methods work");
                waitFor(a, kindReady("calibration-guide", "cal-guide-level") + "&&Boolean(document.getElementById('cal-guide-count'))&&__hrtDemoWorkerQualification.read().metrics.mcmcResults>=1&&" + presentationReady("calibration-guide"));
                JSONObject initial = read(a);
                JSONObject checks = new JSONObject();
                checks.put("ordinaryDemos", initial.getBoolean("ordinaryDemos"));
                checks.put("sharedWorker", initial.getBoolean("sharedWorker"));
                checks.put("rendererProgress", initial.getJSONObject("metrics").getInt("ticks") > 0 && mcmcProgress(initial));
                assertTrue("rendererProgress: aggregate=" + initial.getJSONObject("metrics").getInt("ticks")
                    + "; mcmcJobs=" + initial.getJSONArray("mcmcJobs"), checks.getBoolean("rendererProgress"));
                checks.put("exactBatch", call(a, "__hrtDemoWorkerQualification.compareInitial()").getBoolean("value"));
                call(a, "__hrtDemoWorkerQualification.setFailure(true)");
                setRange(a, "cal-guide-level", "1.5");
                setRange(a, "cal-guide-count", "3");
                waitFor(a, "[...document.querySelectorAll('[role=alert]')].some(n=>n.getClientRects().length&&n.innerText.includes(" + JSONObject.quote(ERROR) + "))");
                checks.put("failureVisible", terminalError(a) && retained(a) && "true".equals(js(a, buttons("Retry estimates") + ".length===1")));
                int completed = read(a).getJSONObject("metrics").getInt("results");
                call(a, "__hrtDemoWorkerQualification.setFailure(false)");
                button(a, "Retry estimates");
                waitFor(a, "__hrtDemoWorkerQualification.read().metrics.results>" + completed
                    + "&&__hrtDemoWorkerQualification.read().active===0&&__hrtDemoWorkerQualification.read().last.level===1.5&&__hrtDemoWorkerQualification.read().last.count===3"
                    + "&&![...document.querySelectorAll('[role=alert]')].some(n=>n.innerText.includes(" + JSONObject.quote(ERROR) + "))");
                waitFor(a, presentationReady("calibration-guide"));
                if ("pending-retry".equals(control)) {
                    presentationMask(a, true);
                    assertEquals("retry control keeps transport complete", "true", js(a, "__hrtDemoWorkerQualification.read().metrics.results>" + completed + "&&__hrtDemoWorkerQualification.read().active===0&&__hrtDemoWorkerQualification.read().last.level===1.5&&__hrtDemoWorkerQualification.read().last.count===3"));
                    assertEquals("retryPresentation", "true", js(a, presentationReady("calibration-guide")));
                    presentationMask(a, false);
                }
                checks.put("retrySucceeded", read(a).getJSONObject("metrics").getInt("results") > completed
                    && !terminalError(a) && "true".equals(js(a, presentationReady("calibration-guide"))));
                checks.put("draftsRetained", retained(a));
                String after = snapshot(a);
                checks.put("recordsUnchanged", before.equals(after));
                JSONObject done = read(a);
                checks.put("rendererProgress", checks.getBoolean("rendererProgress") && mcmcProgress(done));
                for (java.util.Iterator<String> keys = checks.keys(); keys.hasNext();) {
                    String key = keys.next();
                    assertTrue(key, checks.getBoolean(key));
                }
                expectKinds(done.getJSONArray("kinds"));
                JSONObject result = new JSONObject()
                    .put("outcome", "pass")
                    .put("checks", checks)
                    .put("metrics", done.getJSONObject("metrics"))
                    .put("mcmcJobs", done.getJSONArray("mcmcJobs"))
                    .put("kinds", done.getJSONArray("kinds"))
                    .put("snapshotUnchanged", before.equals(after))
                    .put("localOrigin", true)
                    .put("beforeHash", DocumentUiTest.sha(before.getBytes(StandardCharsets.UTF_8)))
                    .put("afterHash", DocumentUiTest.sha(after.getBytes(StandardCharsets.UTF_8)));
                Bundle status = new Bundle();
                status.putString("demo_worker_report", result.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
            } finally {
                presentationMask(a, false);
                if (mcmcNegative) call(a, "__hrtDemoWorkerQualification.setMcmcHeartbeatSuppressed(false)");
                if (negative) js(a, "window.setInterval=window.__savedDemoInterval;delete window.__savedDemoInterval;void 0");
            }
        }
    }
}
