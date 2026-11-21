package org.askarys.hrttracker.network;

import static org.junit.Assert.*;
import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** First-document observation using ordinary assets/plugins in a disposable test package. */
public final class StartupNetworkTest {
    private static final Instrumentation I=InstrumentationRegistry.getInstrumentation();
    private static final String APP_READY="Boolean(window.__hrtStartupNetwork)&&document.readyState==='complete'&&Boolean(document.querySelector('#root .onboarding-steps h1,#root .main-view'))";
    static String js(ActivityScenario<MainActivity> a,String expression) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        a.onActivity(activity->activity.getBridge().getWebView().evaluateJavascript(expression,result->{value.set(result);done.countDown();}));
        assertTrue("WebView callback timed out",done.await(15,TimeUnit.SECONDS)); return value.get();
    }
    static void waitFor(ActivityScenario<MainActivity> a,String expression) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(!"true".equals(js(a,expression))) {
            assertTrue("WebView condition timed out: "+expression,System.nanoTime()<deadline); Thread.sleep(100);
        }
    }
    static JSONObject object(ActivityScenario<MainActivity> a,String expression) throws Exception {
        return new JSONObject((String)new JSONTokener(js(a,"JSON.stringify("+expression+")")).nextValue());
    }
    static void ready(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a,APP_READY);
        // Explicit bounded observation window; delayed background timers are a separate browser gate.
        Thread.sleep(1000);
    }
    static JSONObject fixtures() throws Exception {
        return new JSONObject().put("auth_token","SYNTHETIC-NOT-A-REAL-TOKEN")
            .put("auth_user","{\"id\":\"synthetic\",\"username\":\"synthetic\",\"isAdmin\":true}")
            .put("enc_key","SYNTHETIC-NOT-A-REAL-KEY")
            .put("hrt-usynthetic-events","[{\"id\":\"synthetic-feminizing-sentinel\"}]")
            .put("hrt-usynthetic-masc-events","[{\"id\":\"synthetic-masculinizing-sentinel\"}]")
            .put("app-auto-backup","true");
    }
    static void equalFixtures(JSONObject actual) throws Exception {
        JSONObject expected=fixtures(); assertEquals(6,actual.length());
        for(java.util.Iterator<String> keys=expected.keys();keys.hasNext();) {
            String key=keys.next(); assertEquals("Dormant fixture changed: "+key,expected.getString(key),actual.getString(key));
        }
    }
    static String fixtureDigest(JSONObject value) throws Exception {
        equalFixtures(value);
        java.util.List<String> keys=new java.util.ArrayList<>(); value.keys().forEachRemaining(keys::add); java.util.Collections.sort(keys);
        JSONArray canonical=new JSONArray(); for(String key:keys) canonical.put(new JSONArray().put(key).put(value.getString(key)));
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(canonical.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder text=new StringBuilder(); for(byte b:bytes) text.append(String.format("%02x",b)); return text.toString();
    }
    private static void online(boolean expected) {
        I.getUiAutomation().adoptShellPermissionIdentity(android.Manifest.permission.ACCESS_NETWORK_STATE);
        try {
            ConnectivityManager manager=(ConnectivityManager)I.getTargetContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (!expected) { assertNull("Android still has an active network",manager.getActiveNetwork()); return; }
            NetworkCapabilities caps=manager.getNetworkCapabilities(manager.getActiveNetwork());
            assertNotNull("No active Android network",caps);
            assertTrue("Android network is not Internet capable",caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
            assertTrue("Android network is not validated",caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        } finally { I.getUiAutomation().dropShellPermissionIdentity(); }
    }
    private static JSONObject inspect(ActivityScenario<MainActivity> a) throws Exception { return inspect(a,true); }
    private static JSONObject inspect(ActivityScenario<MainActivity> a,boolean expectedOnline) throws Exception {
        JSONObject state=object(a,"__hrtStartupNetwork.read()");
        assertEquals("loading",state.getJSONObject("early").getString("readyState"));
        assertFalse("Recorder attached after body parsing",state.getJSONObject("early").getBoolean("bodyPresent"));
        assertEquals("https://localhost",state.getJSONObject("early").getString("origin"));
        assertEquals("https://localhost",state.getString("origin"));
        assertFalse("Recorder overflowed",state.getBoolean("overflow"));
        // The ordinary APK lacks ACCESS_NETWORK_STATE, so WebView's advisory flag
        // can remain true offline. Native connectivity, never this flag, proves offline.
        if (expectedOnline) assertTrue("WebView reports offline",state.getBoolean("online"));
        online(expectedOnline);
        assertEquals("true",js(a,"Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('App')&&!Capacitor.isPluginAvailable('HrtNativeStorage')&&!Capacitor.isPluginAvailable('HrtNativeDocuments')"));
        js(a,"window.__serviceWorkerCount=null;navigator.serviceWorker.getRegistrations().then(value=>window.__serviceWorkerCount=value.length);void 0");
        waitFor(a,"window.__serviceWorkerCount!==null"); assertEquals("0",js(a,"window.__serviceWorkerCount"));
        assertEquals("false",js(a,"Boolean(navigator.serviceWorker.controller)"));
        return state;
    }
    static JSONObject quiet(ActivityScenario<MainActivity> a) throws Exception { return quiet(a,true); }
    static JSONObject quiet(ActivityScenario<MainActivity> a,boolean expectedOnline) throws Exception {
        JSONObject state=inspect(a,expectedOnline);
        assertEquals("Automatic JS API attempt or CSP violation",0,state.getJSONArray("attempts").length());
        JSONArray resources=state.getJSONArray("resources"); assertTrue("No bundled resources observed",resources.length()>0);
        boolean script=false;
        for(int i=0;i<resources.length();i++) {
            JSONObject resource=resources.getJSONObject(i); android.net.Uri uri=android.net.Uri.parse(resource.getString("url"));
            assertEquals("Unexpected resource scheme","https",uri.getScheme());
            assertEquals("Unexpected resource host","localhost",uri.getHost());
            assertTrue("Unexpected resource port",uri.getPort()==-1||uri.getPort()==443);
            String path=uri.getPath(); assertNotNull(path);
            assertTrue("Unexpected resource path: "+path,path.equals("/")||path.startsWith("/assets/")||path.startsWith("/fonts/")||path.startsWith("/pwa-")||path.startsWith("/favicon"));
            script|=path.startsWith("/assets/")&&path.endsWith(".js");
        }
        assertTrue("No bundled application script observed",script); return state;
    }
    private static void report(String phase,int documents,JSONObject extra) throws Exception {
        JSONObject value=extra.put("phase",phase).put("outcome","pass").put("pid",android.os.Process.myPid())
            .put("earlyObserver",true).put("online",true).put("localOrigin",true).put("noServiceWorker",true)
            .put("ordinaryPluginsOnly",true).put("automaticAttempts",0).put("observedDocuments",documents);
        Bundle status=new Bundle(); status.putString("startup_report",value.toString()); I.sendStatus(2,status);
    }
    @Test public void freshStartup() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); JSONObject state=quiet(a),initial=state.getJSONObject("initialStorage");
            assertEquals(6,initial.length());
            for(java.util.Iterator<String> keys=initial.keys();keys.hasNext();) assertTrue("Fresh fixture was not empty",initial.isNull(keys.next()));
            report("freshStartup",1,new JSONObject());
        }
    }
    @Test public void seedDormantCredentials() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); quiet(a);
            js(a,"Object.entries("+fixtures()+").forEach(([key,value])=>localStorage.setItem(key,value));localStorage.setItem('app-onboarded','true');localStorage.setItem('hrt-lang','en');localStorage.setItem('hrt-mode','transfem');localStorage.setItem('app-pixel-cats','false');void 0");
            // Fixture setup only, not a claim that web storage acknowledges durable writes.
            Thread.sleep(2000);
            JSONObject state=quiet(a);
            report("seedDormantCredentials",1,new JSONObject().put("fixtureSha256",fixtureDigest(state.getJSONObject("currentStorage"))));
        }
    }
    private static void resume(ActivityScenario<MainActivity> a) throws Exception {
        assertTrue(I.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME));
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while(a.getState()==Lifecycle.State.RESUMED) { assertTrue(System.nanoTime()<until); Thread.sleep(50); }
        Intent intent=I.getTargetContext().getPackageManager().getLaunchIntentForPackage(I.getTargetContext().getPackageName());
        assertNotNull(intent); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        I.getTargetContext().startActivity(intent);
        until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while(a.getState()!=Lifecycle.State.RESUMED) { assertTrue(System.nanoTime()<until); Thread.sleep(50); }
        js(a,"window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));void 0"); ready(a);
    }
    @Test public void restartDormantCredentials() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); JSONObject initial=quiet(a); equalFixtures(initial.getJSONObject("initialStorage"));
            assertEquals("false",js(a,"[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Account')"));
            String before=fixtureDigest(initial.getJSONObject("currentStorage"));
            resume(a); assertEquals(before,fixtureDigest(quiet(a).getJSONObject("currentStorage")));
            a.recreate(); ready(a); JSONObject after=quiet(a); equalFixtures(after.getJSONObject("initialStorage"));
            assertEquals(before,fixtureDigest(after.getJSONObject("currentStorage")));
            report("restartDormantCredentials",2,new JSONObject().put("fixtureSha256",before));
        }
    }
    @Test public void observerControls() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); quiet(a);
            // An initialization failure also renders an h1. It must not count as loaded app UI.
            assertEquals("Startup failure UI passed readiness","false",js(a,
                "(()=>{const app=document.getElementById('root');app.id='network-guard-app';const failed=document.createElement('div');failed.id='root';const heading=document.createElement('h1');heading.textContent='Could not open local records';failed.appendChild(heading);document.body.appendChild(failed);try{return ("+APP_READY+")}finally{failed.remove();app.id='root'}})()"));
            js(a,"void fetch('/api/__network_control_fetch__').catch(()=>{});const x=new XMLHttpRequest();x.open('GET','/api/__network_control_xhr__');x.send();navigator.sendBeacon('/api/__network_control_beacon__','synthetic');try{const ws=new WebSocket('wss://startup-qualification.invalid/control');ws.onerror=()=>{}}catch{};void fetch('https://startup-qualification.invalid/control').catch(()=>{});const image=new Image();image.src='/network-control.png';document.body.appendChild(image);void 0");
            waitFor(a,"['fetch','xhr','beacon','websocket','csp'].every(channel=>__hrtStartupNetwork.read().attempts.some(item=>item.channel===channel))&&__hrtStartupNetwork.read().resources.some(item=>item.url.endsWith('/network-control.png'))");
            JSONObject state=inspect(a); java.util.Set<String> channels=new java.util.TreeSet<>();
            JSONArray attempts=state.getJSONArray("attempts"); for(int i=0;i<attempts.length();i++) channels.add(attempts.getJSONObject(i).getString("channel"));
            channels.add("resource");
            // Zero automatic attempts was asserted before these explicit controls, not afterwards.
            report("observerControls",1,new JSONObject().put("controlChannels",new JSONArray(channels)));
        }
    }
}
