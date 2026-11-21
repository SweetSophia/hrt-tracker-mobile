package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Bundled module worker, synthetic numerical fixtures and renderer timer observation. */
public final class EngineWorkerTest {
    private static String js(ActivityScenario<MainActivity> a,String expression) throws Exception {return StorageBridgeTest.evaluate(a,expression);}
    private static void waitFor(ActivityScenario<MainActivity> a,String expression) throws Exception {StorageBridgeTest.waitFor(a,expression);}
    private static JSONObject read(ActivityScenario<MainActivity> a,String expression) throws Exception {
        js(a,"window.__workerResult=null;Promise.resolve("+expression+").then(value=>window.__workerResult={value},()=>window.__workerResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__workerResult)");
        JSONObject r=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__workerResult)")).nextValue());
        assertFalse("Worker qualification failed",r.optBoolean("failed"));return r;
    }
    @Test public void bundledWorkerBoundary() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            waitFor(a,"Boolean(window.__hrtEngineWorkerQualification&&window.__hrtScreenQualification)");
            assertEquals("\"https://localhost\"",js(a,"location.origin"));
            String before=read(a,"__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
            boolean suppressHeartbeat="heartbeat".equals(InstrumentationRegistry.getArguments().getString("negativeControl"));
            if(suppressHeartbeat)js(a,"window.__savedWorkerInterval=window.setInterval;window.setInterval=()=>0;void 0");
            JSONObject result;
            try {result=read(a,"__hrtEngineWorkerQualification.run()").getJSONObject("value");}
            finally {if(suppressHeartbeat)js(a,"window.setInterval=window.__savedWorkerInterval;delete window.__savedWorkerInterval;void 0");}
            JSONObject checks=result.getJSONObject("checks");assertEquals(9,checks.length());
            for(java.util.Iterator<String> keys=checks.keys();keys.hasNext();){String key=keys.next();assertTrue(key,checks.getBoolean(key));}
            assertTrue(result.getJSONObject("metrics").getInt("ticks")>0);
            assertTrue(result.getJSONObject("metrics").getDouble("roundTripMs")>0);
            assertEquals("Worker changed native records",before,read(a,"__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot"));
            result.put("outcome","pass").put("snapshotUnchanged",true).put("localOrigin",true);
            Bundle status=new Bundle();status.putString("engine_worker_report",result.toString());InstrumentationRegistry.getInstrumentation().sendStatus(2,status);
        }
    }
}
