package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Shared rendered controls, actual Android lifecycle, fresh native record reads. Synthetic data only. */
public final class LifecycleParityTest {
    private static final Instrumentation I = InstrumentationRegistry.getInstrumentation();
    // Dose and lab amounts are localized decimal entry fields (inputmode=decimal), no longer type=number.
    private static final String INPUTS = "[...document.querySelectorAll('input[inputmode=decimal]')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]'))";
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception { return StorageBridgeTest.evaluate(a, expression); }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception { StorageBridgeTest.waitFor(a, expression); }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a,"window.__lifecycleResult=null;Promise.resolve("+expression+").then(value=>window.__lifecycleResult={value},()=>window.__lifecycleResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__lifecycleResult)");
        JSONObject result=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__lifecycleResult)")).nextValue());
        assertFalse("Qualification setup/read failed",result.optBoolean("failed"));
        return result;
    }
    private static void ready(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a,"Boolean(window.__hrtScreenQualification)");
        // The shared fixture reader validates timestamps against SCREEN_NOW.
        // Pin constructors and Date.now together so entered dates are not future doses.
        js(a,"window.Date=class extends Date{constructor(...args){super(...(args.length?args:[1793534400000]));}static now(){return 1793534400000;}};void 0");
        waitFor(a,nodes("Settings",false)+".length===1");
    }
    private static void prepare(ActivityScenario<MainActivity> a) throws Exception {
        ready(a); assertEquals("ready",call(a,"__hrtScreenQualification.prepare()").getString("value"));
        a.recreate(); ready(a); waitFor(a,nodes("Medication plan",false)+".length===1");
    }
    private static JSONObject state(ActivityScenario<MainActivity> a) throws Exception { return call(a,"__hrtScreenQualification.read()").getJSONObject("value"); }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception { return state(a).getString("snapshot"); }
    private static JSONObject mode(JSONObject state, String mode) throws Exception { return state.getJSONObject("bundle").getJSONObject("modes").getJSONObject(mode); }
    private static String nodes(String label, boolean contains) {
        return "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&!n.disabled&&[n.getAttribute('aria-label')||'',(()=>{const c=n.cloneNode(true);c.querySelectorAll('[aria-hidden=true]').forEach(x=>x.remove());return c.textContent.trim()})()].some(t=>"+(contains?"t.includes(":"t===(")+JSONObject.quote(label)+")))";
    }
    private static void button(ActivityScenario<MainActivity> a, String label, boolean contains) throws Exception {
        Bundle status=new Bundle(); status.putString("lifecycle_step",label); I.sendStatus(2,status);
        String selector=nodes(label,contains); waitFor(a,selector+".length===1");
        js(a,selector+"[0].click();void 0");
    }
    private static void button(ActivityScenario<MainActivity> a, String label) throws Exception { button(a,label,false); }
    private static void input(ActivityScenario<MainActivity> a, int index, String value) throws Exception {
        waitFor(a,INPUTS+".length>"+index);
        js(a,"(()=>{const n="+INPUTS+"["+index+"];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,"+JSONObject.quote(value)+");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
        waitFor(a,INPUTS+"["+index+"]?.value==="+JSONObject.quote(value));
    }
    private static void foreground(ActivityScenario<MainActivity> a, boolean expected) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while ((a.getState()==Lifecycle.State.RESUMED)!=expected) {
            assertTrue("Foreground transition timed out",System.nanoTime()<end); Thread.sleep(50);
        }
        assertNotEquals(Lifecycle.State.DESTROYED,a.getState());
    }
    private static void backgroundAndResume(ActivityScenario<MainActivity> a) throws Exception {
        assertTrue(I.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)); foreground(a,false);
        Intent intent=I.getTargetContext().getPackageManager().getLaunchIntentForPackage(I.getTargetContext().getPackageName());
        assertNotNull(intent); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        I.getTargetContext().startActivity(intent); foreground(a,true);
    }
    private static void rotate(ActivityScenario<MainActivity> a, int request, int expected) throws Exception {
        a.onActivity(activity->activity.setRequestedOrientation(request));
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while (true) {
            AtomicInteger orientation=new AtomicInteger();
            a.onActivity(activity->orientation.set(activity.getResources().getConfiguration().orientation));
            if (orientation.get()==expected) break;
            assertTrue("Requested rotation did not occur",System.nanoTime()<end); Thread.sleep(50);
        }
    }
    private static String digest(String value) throws Exception {
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder text=new StringBuilder(); for(byte b:bytes) text.append(String.format("%02x",b)); return text.toString();
    }
    private static void report(String phase, String snapshot, JSONObject flags) throws Exception {
        flags.put("phase",phase).put("outcome","pass").put("pid",android.os.Process.myPid()).put("snapshotSha256",digest(snapshot));
        Bundle status=new Bundle(); status.putString("lifecycle_report",flags.toString()); I.sendStatus(2,status);
    }
    @Test public void draftLifecycle() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String before=snapshot(a);
            button(a,"History"); button(a,"Add dose"); input(a,0,"3,25");
            backgroundAndResume(a);
            waitFor(a,"history.state.view==='history'&&"+INPUTS+"[0]?.value==='3,25'");
            assertEquals(before,snapshot(a));
            AtomicInteger original=new AtomicInteger(); a.onActivity(activity->original.set(activity.getRequestedOrientation()));
            try {
                rotate(a,ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,Configuration.ORIENTATION_LANDSCAPE);
                waitFor(a,"innerWidth>innerHeight&&history.state.view==='history'&&"+INPUTS+"[0]?.value==='3,25'");
                rotate(a,ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,Configuration.ORIENTATION_PORTRAIT);
                waitFor(a,"innerHeight>innerWidth&&history.state.view==='history'&&"+INPUTS+"[0]?.value==='3,25'");
                assertEquals(before,snapshot(a));
            } finally { a.onActivity(activity->activity.setRequestedOrientation(original.get())); }
            a.recreate(); ready(a); waitFor(a,nodes("Medication plan",false)+".length===1");
            assertEquals(before,snapshot(a));
            button(a,"History"); waitFor(a,nodes("Add dose",false)+".length===1");
            assertEquals("0",js(a,INPUTS+".length"));
            report("draftLifecycle",before,new JSONObject().put("backgroundDraftRetained",true).put("rotationDraftRetained",true).put("recreationNoReplay",true).put("unchanged",true));
        }
    }
    private static void switchMode(ActivityScenario<MainActivity> a, String label) throws Exception {
        button(a,"Settings");
        waitFor(a,nodes("General",true)+".length===1||"+nodes("HRT mode",true)+".length===1");
        if ("true".equals(js(a,nodes("General",true)+".length===1"))) button(a,"General",true);
        button(a,"HRT mode",true); button(a,label,true);
        waitFor(a,nodes(label,true)+"[0]?.getAttribute('aria-pressed')==='true'");
    }
    private static void savedRecords(JSONObject state) throws Exception {
        for (String name:new String[]{"transfem","transmasc"}) {
            JSONObject records=mode(state,name); JSONArray events=records.getJSONArray("events"), labs=records.getJSONArray("labResults");
            assertEquals("Exactly one new dose per mode",2,events.length()); assertEquals("Exactly one lab per mode",1,labs.length());
            double expected=name.equals("transfem")?3.25:12.5; int matching=0;
            for(int n=0;n<events.length();n++) if(events.getJSONObject(n).getDouble("doseMG")==expected) matching++;
            assertEquals("Saved dose value",1,matching);
            assertEquals(name.equals("transfem")?123.5:456.5,labs.getJSONObject(0).getDouble("concValue"),0);
            assertEquals(name.equals("transfem")?"pmol/l":"ng/dl",labs.getJSONObject(0).getString("unit"));
        }
    }
    @Test public void acknowledgedEditsSeed() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a);
            for (String name:new String[]{"transfem","transmasc"}) {
                if (name.equals("transmasc")) switchMode(a,"Masculinizing HRT");
                String other=name.equals("transfem")?"transmasc":"transfem";
                String otherBefore=mode(state(a),other).toString();
                button(a,"History"); button(a,"Add dose"); input(a,0,name.equals("transfem")?"3,25":"12,5");
                button(a,"Save"); waitFor(a,nodes("Add dose",false)+".length===1");
                assertEquals(2,mode(state(a),name).getJSONArray("events").length());
                // Empty Labs exposes the same action in both header and empty state.
                button(a,"Labs"); waitFor(a,nodes("Add lab result",false)+".length===2");
                js(a,nodes("Add lab result",false)+"[0].click();void 0");
                input(a,name.equals("transfem")?0:1,name.equals("transfem")?"123,5":"456,5");
                button(a,"Save"); waitFor(a,nodes("Add lab result",false)+".length===1");
                assertEquals(1,mode(state(a),name).getJSONArray("labResults").length());
                assertEquals("Other mode must not change",otherBefore,mode(state(a),other).toString());
            }
            savedRecords(state(a)); String after=snapshot(a);
            backgroundAndResume(a); waitFor(a,"history.state.view==='lab'"); assertEquals(after,snapshot(a));
            a.recreate(); ready(a); waitFor(a,nodes("Medication plan",false)+".length===1");
            savedRecords(state(a)); assertEquals(after,snapshot(a));
            report("acknowledgedEditsSeed",after,new JSONObject().put("bothModesSaved",true).put("scopeIsolated",true).put("acknowledged",true).put("backgroundUnchanged",true).put("recreationUnchanged",true));
        }
    }
    @Test public void acknowledgedEditsVerify() throws Exception {
        String expected=InstrumentationRegistry.getArguments().getString("expectedDigest");
        assertNotNull("Run through the lifecycle host runner",expected); assertTrue(expected.matches("[a-f0-9]{64}"));
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); waitFor(a,nodes("Medication plan",false)+".length===1");
            String after=snapshot(a); assertEquals(expected,digest(after)); savedRecords(state(a));
            assertEquals("0",js(a,"document.querySelectorAll('[data-prompt]').length"));
            for (String label:new String[]{"Feminizing HRT","Masculinizing HRT"}) {
                switchMode(a,label); button(a,"History");
                waitFor(a,nodes(label.equals("Feminizing HRT")?"3.25 mg":"12.50 mg",true)+".length===1");
                button(a,"Labs"); waitFor(a,nodes(label.equals("Feminizing HRT")?"123.5":"456.5",true)+".length===1");
            }
            assertEquals(after,snapshot(a));
            report("acknowledgedEditsVerify",after,new JSONObject().put("reopenedExact",true).put("noReplay",true).put("bothModesExact",true));
        }
    }
}
