package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual ordinary Forecast, with qualification-only observation and synthetic records. */
@RunWith(AndroidJUnit4.class)
public final class ForecastEngineWorkerTest {
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        // Forecast's full batch may use most of its ordinary 30-second task budget.
        long until = System.currentTimeMillis() + 40_000;
        while (System.currentTimeMillis() < until) {
            if ("true".equals(js(a, expression))) return;
            Thread.sleep(100);
        }
        fail("Forecast UI condition timed out");
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a, "window.__forecastResult=null;Promise.resolve("+expression+").then(value=>window.__forecastResult={value},()=>window.__forecastResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__forecastResult)");
        JSONObject result = new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__forecastResult)")).nextValue());
        assertFalse("Forecast setup failed",result.optBoolean("failed"));
        return result;
    }
    private static JSONObject read(ActivityScenario<MainActivity> a) throws Exception {
        return call(a,"__hrtForecastWorkerQualification.read()").getJSONObject("value");
    }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {
        return call(a,"__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }
    private static void button(ActivityScenario<MainActivity> a,String name) throws Exception {
        String nodes="[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.disabled&&!n.closest('[inert]')&&n.innerText.trim()==="+JSONObject.quote(name)+")";
        waitFor(a,nodes+".length===1");
        js(a,nodes+"[0].click();void 0");
    }
    private static String dose() {
        return "[...document.querySelectorAll('label')].find(n=>n.textContent.trim().startsWith('Dose'))?.querySelector('input')";
    }
    private static void setDose(ActivityScenario<MainActivity> a,String value) throws Exception {
        waitFor(a,"Boolean("+dose()+")");
        js(a,"(()=>{const n="+dose()+";Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,"+JSONObject.quote(value)+");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
    }
    private static void ready(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a,"Boolean(document.querySelector('section[aria-busy=\"false\"]'))&&!document.body.textContent.includes('Updating estimates')&&!document.body.textContent.includes('Estimates could not be calculated')&&__hrtForecastWorkerQualification.read().active===0");
    }
    private static boolean draft(ActivityScenario<MainActivity> a,String weeks) throws Exception {
        return "true".equals(js(a,"(()=>{const tabs=[...document.querySelectorAll('button[role=tab][aria-selected=true]')].map(n=>n.innerText.trim());return ("+dose()+")?.value==='7'&&tabs.includes('Plan B')&&tabs.includes('"+weeks+" wk')})()"));
    }
    @Test public void ordinaryForecast() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            waitFor(a,"Boolean(window.__hrtForecastWorkerQualification&&window.__hrtScreenQualification&&window.__hrtAppEngineWorkerQualification)");
            call(a,"__hrtScreenQualification.prepare()"); a.recreate();
            waitFor(a,"Boolean(window.__hrtForecastWorkerQualification&&window.__hrtScreenQualification&&window.__hrtAppEngineWorkerQualification)");
            assertEquals("\"https://localhost\"",js(a,"location.origin"));
            call(a,"__hrtAppEngineWorkerQualification.seed()");
            button(a,"Overview");
            waitFor(a,"__hrtAppEngineWorkerQualification.read().metrics.mcmcResults>0&&!document.body.textContent.includes('Updating estimates')");
            String before=snapshot(a);
            boolean negative="heartbeat".equals(InstrumentationRegistry.getArguments().getString("negativeControl"));
            if(negative) js(a,"window.__savedForecastInterval=window.setInterval;window.setInterval=()=>0;void 0");
            try {
                button(a,"What-if");
                waitFor(a,"__hrtForecastWorkerQualification.read().metrics.results>0"); ready(a);
                JSONObject initial=read(a),checks=new JSONObject();
                checks.put("ordinaryForecast",initial.getBoolean("ordinaryForecast"));
                checks.put("sharedWorker",initial.getBoolean("sharedWorker"));
                checks.put("rendererProgress",initial.getJSONObject("metrics").getInt("ticks")>0);
                assertTrue("rendererProgress",checks.getBoolean("rendererProgress"));
                checks.put("exactBatch",call(a,"__hrtForecastWorkerQualification.compareInitial()").getBoolean("value"));
                button(a,"Add plan");
                button(a,"Plan B");
                setDose(a,"7");
                button(a,"12 wk");
                waitFor(a,"__hrtForecastWorkerQualification.read().last.doseMG===7&&__hrtForecastWorkerQualification.read().last.horizonH===2016"); ready(a);
                assertTrue("edited draft",draft(a,"12"));
                call(a,"__hrtForecastWorkerQualification.setFailure(true)"); button(a,"4 wk");
                waitFor(a,"document.body.textContent.includes('Estimates could not be calculated. Your records are still available.')");
                checks.put("failureVisible","true".equals(js(a,"Boolean(document.querySelector('section[aria-busy=\"false\"]'))"))&&draft(a,"4"));
                int completed=read(a).getJSONObject("metrics").getInt("results");
                call(a,"__hrtForecastWorkerQualification.setFailure(false)"); button(a,"Retry estimates");
                waitFor(a,"__hrtForecastWorkerQualification.read().metrics.results>"+completed); ready(a);
                checks.put("retrySucceeded",read(a).getJSONObject("metrics").getInt("results")>completed);
                checks.put("draftsRetained",draft(a,"4"));
                String after=snapshot(a);checks.put("recordsUnchanged",before.equals(after));
                for(java.util.Iterator<String> keys=checks.keys();keys.hasNext();) {String key=keys.next();assertTrue(key,checks.getBoolean(key));}
                JSONObject result=new JSONObject().put("outcome","pass").put("checks",checks).put("metrics",read(a).getJSONObject("metrics"))
                    .put("snapshotUnchanged",before.equals(after)).put("localOrigin",true)
                    .put("beforeHash",DocumentUiTest.sha(before.getBytes(StandardCharsets.UTF_8)))
                    .put("afterHash",DocumentUiTest.sha(after.getBytes(StandardCharsets.UTF_8)));
                Bundle status=new Bundle();status.putString("forecast_worker_report",result.toString());InstrumentationRegistry.getInstrumentation().sendStatus(2,status);
            } finally {
                if(negative)js(a,"window.setInterval=window.__savedForecastInterval;delete window.__savedForecastInterval;void 0");
            }
        }
    }
}
