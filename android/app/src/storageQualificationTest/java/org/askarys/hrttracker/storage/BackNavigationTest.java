package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.WindowInsets;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.InputDevice;
import android.view.MotionEvent;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Actual Android Back through the installed App plugin; synthetic records only. */
public final class BackNavigationTest {
    private static final Instrumentation I = InstrumentationRegistry.getInstrumentation();
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        StorageBridgeTest.waitFor(a, expression);
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a,"window.__backResult=null;Promise.resolve("+expression+").then(value=>window.__backResult={value},error=>window.__backResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__backResult)");
        JSONObject result=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__backResult)")).nextValue());
        assertFalse("Qualification setup/read failed",result.optBoolean("failed"));
        return result;
    }
    private static void prepare(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a,"Boolean(window.__hrtScreenQualification)");
        assertEquals("ready",call(a,"__hrtScreenQualification.prepare()").getString("value"));
        a.recreate();
        waitFor(a,"Boolean(window.__hrtScreenQualification)");
        js(a,"Date.now=()=>1793534400000;void 0");
        waitFor(a,"[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Medication plan')");
    }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {
        return call(a,"__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }
    private static String nodes(String label, boolean contains) {
        return "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.closest('[inert]')&&!n.disabled&&[n.getAttribute('aria-label')||'',(()=>{const c=n.cloneNode(true);c.querySelectorAll('[aria-hidden=true]').forEach(x=>x.remove());return c.textContent.trim()})()].some(t=>"+(contains?"t.includes(":"t===(")+JSONObject.quote(label)+")))";
    }
    private static void button(ActivityScenario<MainActivity> a, String label, boolean contains) throws Exception {
        String selector=nodes(label,contains);
        waitFor(a,selector+".length===1");
        js(a,selector+"[0].click();void 0");
    }
    private static void back() {
        assertTrue("Android Back action failed",I.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
    }
    private static void report(String name) throws Exception {
        Bundle status=new Bundle();
        status.putString("back_report",new JSONObject().put("test",name).put("outcome","pass").put("snapshotUnchanged",true).toString());
        I.sendStatus(2,status);
    }
    private static void foreground(ActivityScenario<MainActivity> a, boolean expected) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while ((a.getState()==Lifecycle.State.RESUMED)!=expected) {
            assertTrue("Foreground transition timed out",System.nanoTime()<end); Thread.sleep(50);
        }
        assertNotEquals("Back destroyed Activity instead of minimizing",Lifecycle.State.DESTROYED,a.getState());
    }
    private static boolean ime(ActivityScenario<MainActivity> a) {
        AtomicBoolean shown=new AtomicBoolean();
        a.onActivity(activity->{ WindowInsets insets=activity.getWindow().getDecorView().getRootWindowInsets(); shown.set(insets!=null&&insets.isVisible(WindowInsets.Type.ime())); });
        return shown.get();
    }
    private static void waitIme(ActivityScenario<MainActivity> a, boolean expected) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while (ime(a)!=expected) { assertTrue("IME visibility timed out; expected shown="+expected,System.nanoTime()<end); Thread.sleep(50); }
    }
    private static void tapInput(ActivityScenario<MainActivity> a, String selector) throws Exception {
        js(a,"document.querySelector("+JSONObject.quote(selector)+").scrollIntoView({block:'center'});void 0");
        JSONObject point=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify((()=>{const r=document.querySelector("+JSONObject.quote(selector)+").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})())")).nextValue());
        float[] xy=new float[2];
        a.onActivity(activity->{
            android.webkit.WebView web=activity.getBridge().getWebView(); int[] location=new int[2]; web.getLocationOnScreen(location);
            float scale=(float)(web.getWidth()/point.optDouble("width"));
            xy[0]=location[0]+(float)point.optDouble("x")*scale; xy[1]=location[1]+(float)point.optDouble("y")*scale;
        });
        long time=SystemClock.uptimeMillis();
        for (int action : new int[]{MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP}) {
            MotionEvent event=MotionEvent.obtain(time,SystemClock.uptimeMillis(),action,xy[0],xy[1],0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try { assertTrue("Input tap failed",I.getUiAutomation().injectInputEvent(event,true)); }
            finally { event.recycle(); }
        }
    }
    @Test public void rootBackgroundResumeAndRecreation() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String before=snapshot(a);
            for (String tab : new String[]{"Overview","History","Labs"}) {
                button(a,tab,false);
                String view=tab.equals("Overview")?"home":tab.equals("History")?"history":"lab";
                waitFor(a,"history.state.view==="+JSONObject.quote(view));
                back(); foreground(a,false);
                Intent intent=I.getTargetContext().getPackageManager().getLaunchIntentForPackage(I.getTargetContext().getPackageName());
                assertNotNull(intent); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                I.getTargetContext().startActivity(intent); foreground(a,true);
                waitFor(a,"history.state.view==="+JSONObject.quote(view));
                assertEquals(before,snapshot(a));
                a.recreate(); waitFor(a,"Boolean(window.__hrtScreenQualification)");
                waitFor(a,"[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Medication plan')");
            }
            assertEquals(before,snapshot(a)); report("rootBackgroundResumeAndRecreation");
        }
    }
    @Test public void settingsBackUsesOwnedHistory() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String before=snapshot(a);
            button(a,"Settings",false); button(a,"Data management",true); button(a,"Export data",false);
            waitFor(a,"history.state.depth===2");
            back(); waitFor(a,"history.state.depth===1"); foreground(a,true);
            back(); waitFor(a,"history.state.depth===0"); foreground(a,true);
            // A selector retained inside a collapsed Supplies form must not steal page Back.
            button(a,"General",true); button(a,"Supplies",false); button(a,"Add supply",false);
            String selector="document.querySelector('button[aria-haspopup=listbox]')";
            js(a,selector+".click();void 0"); waitFor(a,selector+".getAttribute('aria-expanded')==='true'");
            js(a,nodes("Cancel",false)+"[0].click();void 0"); waitFor(a,nodes("Add supply",false)+".length===1");
            back(); waitFor(a,"history.state.view==='settings'&&history.state.depth===1");
            back(); waitFor(a,"history.state.depth===0"); foreground(a,true);
            assertEquals(before,snapshot(a)); report("settingsBackUsesOwnedHistory");
        }
    }
    @Test public void promptInputAndKeyboardConsumeBeforeForm() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String before=snapshot(a);
            button(a,"History",false); button(a,"1.00 mg",true);
            String form="document.querySelector('form:has(button[aria-label=Delete])')";
            waitFor(a,"Boolean("+form+")");
            js(a,form+".querySelector('button[aria-haspopup=listbox]').click();void 0");
            waitFor(a,form+".querySelector('button[aria-haspopup=listbox]').getAttribute('aria-expanded')==='true'");
            back(); waitFor(a,form+".querySelector('button[aria-haspopup=listbox]').getAttribute('aria-expanded')==='false'");
            button(a,"Delete",false); waitFor(a,"Boolean(document.querySelector('[data-prompt=confirm]'))");
            back(); waitFor(a,"!document.querySelector('[data-prompt=confirm]')");
            waitFor(a,"Boolean("+form+")&&history.state.depth===0");
            android.content.ContentResolver settings=I.getTargetContext().getContentResolver();
            String original=Settings.Secure.getString(settings,"show_ime_with_hard_keyboard");
            I.getUiAutomation().adoptShellPermissionIdentity(android.Manifest.permission.WRITE_SECURE_SETTINGS);
            try {
                assertTrue(Settings.Secure.putString(settings,"show_ime_with_hard_keyboard","1"));
                tapInput(a,"form:has(button[aria-label=Delete]) input[inputmode=decimal]");
                waitIme(a,true);
                back(); waitIme(a,false);
                assertEquals("true",js(a,"Boolean("+form+")"));
                back(); waitFor(a,"!"+form); foreground(a,true);
            } finally {
                try { assertTrue("IME setting restore failed",Settings.Secure.putString(settings,"show_ime_with_hard_keyboard",original)); }
                finally { I.getUiAutomation().dropShellPermissionIdentity(); }
            }
            assertEquals(before,snapshot(a)); report("promptInputAndKeyboardConsumeBeforeForm");
        }
    }
    @Test public void wizardBackStepsThenCancels() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a); String before=snapshot(a);
            button(a,"Medication plan",false); button(a,"Oral",false); button(a,"Next",false);
            waitFor(a,"document.body.innerText.includes('Which drug?')");
            back(); waitFor(a,nodes("Oral",false)+".length===1"); foreground(a,true);
            back(); waitFor(a,nodes("Medication plan",false)+".length===1"); foreground(a,true);
            assertEquals(before,snapshot(a)); report("wizardBackStepsThenCancels");
        }
    }
}
