package org.askarys.hrttracker.network;

import static org.junit.Assert.*;
import static org.askarys.hrttracker.network.StartupNetworkTest.*;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Controlled debug APK replacement, not native-record or release-signing admission. */
public final class OfflineUpgradeTest {
    private static final Instrumentation I=InstrumentationRegistry.getInstrumentation();
    private static final String CACHE="hrt-upgrade-qualification";
    private static final String URL="https://localhost/assets/__hrt_upgrade_canary__.js";
    private static final String STALE="window.__hrtUpgradeAssetVersion='stale-cache';";

    private static void network(boolean expected) throws Exception {
        I.getUiAutomation().adoptShellPermissionIdentity(android.Manifest.permission.ACCESS_NETWORK_STATE);
        try {
            ConnectivityManager manager=(ConnectivityManager)I.getTargetContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
            while (true) {
                android.net.Network active=manager.getActiveNetwork();
                NetworkCapabilities caps=manager.getNetworkCapabilities(active);
                if (!expected && active==null) return;
                if (expected && caps!=null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return;
                assertTrue("Android connectivity did not reach expected state",System.nanoTime()<until);
                Thread.sleep(100);
            }
        } finally { I.getUiAutomation().dropShellPermissionIdentity(); }
    }
    private static JSONObject identity(ActivityScenario<MainActivity> a,int stage) throws Exception {
        Context context=I.getTargetContext();
        assertEquals("org.askarys.hrttracker.spike.upgradequalification",context.getPackageName());
        PackageInfo info=context.getPackageManager().getPackageInfo(context.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES);
        assertEquals(stage,info.getLongVersionCode());
        int canary=Integer.parseInt(js(a,"window.__hrtUpgradeAssetVersion"));
        assertEquals("Stale or missing packaged canary",stage,canary);
        Signature[] certificates=info.signingInfo.getApkContentsSigners(); assertEquals(1,certificates.length);
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(certificates[0].toByteArray());
        StringBuilder signer=new StringBuilder(); for(byte b:digest) signer.append(String.format("%02x",b));
        return new JSONObject().put("versionCode",info.getLongVersionCode()).put("canaryVersion",canary)
            .put("firstInstallTime",info.firstInstallTime).put("lastUpdateTime",info.lastUpdateTime)
            .put("uid",android.os.Process.myUid()).put("signerSha256",signer.toString())
            .put("webViewOnline",new JSONTokener(js(a,"navigator.onLine")).nextValue());
    }
    private static boolean cachePresent(ActivityScenario<MainActivity> a) throws Exception {
        js(a,"window.__upgradeCacheRead=undefined;void caches.open('"+CACHE+"').then(c=>c.match('"+URL+"')).then(r=>r?r.text():null).then(v=>window.__upgradeCacheRead=v).catch(e=>window.__upgradeCacheRead='ERROR:'+String(e));void 0");
        waitFor(a,"window.__upgradeCacheRead!==undefined");
        Object value=new JSONTokener(js(a,"window.__upgradeCacheRead")).nextValue();
        if (JSONObject.NULL.equals(value)) return false;
        assertEquals("Cache fixture changed or could not be read",STALE,value);
        return true;
    }
    private static JSONObject existing(ActivityScenario<MainActivity> a,int stage,boolean online) throws Exception {
        ready(a); JSONObject state=quiet(a,online); equalFixtures(state.getJSONObject("initialStorage"));
        boolean retained=cachePresent(a);
        return identity(a,stage).put("fixtureSha256",fixtureDigest(state.getJSONObject("currentStorage")))
            .put("cacheSentinelPresent",retained);
    }
    private static void report(String phase,boolean online,int documents,JSONObject value) throws Exception {
        value.put("phase",phase).put("outcome","pass").put("pid",android.os.Process.myPid())
            .put("earlyObserver",true).put("online",online).put("localOrigin",true).put("noServiceWorker",true)
            .put("ordinaryPluginsOnly",true).put("automaticAttempts",0).put("observedDocuments",documents);
        Bundle status=new Bundle(); status.putString("upgrade_report",value.toString()); I.sendStatus(2,status);
    }
    @Test public void offlineFirstLaunch() throws Exception {
        network(false);
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); JSONObject initial=quiet(a,false).getJSONObject("initialStorage"); assertEquals(6,initial.length());
            for(java.util.Iterator<String> keys=initial.keys();keys.hasNext();) assertTrue(initial.isNull(keys.next()));
            assertEquals("true",js(a,"Boolean(document.querySelector('#root .onboarding-steps h1'))"));
            report("offlineFirstLaunch",false,1,identity(a,1));
        }
    }
    @Test public void seedUpgradeState() throws Exception {
        network(true);
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a); quiet(a,true); JSONObject info=identity(a,1);
            js(a,"Object.entries("+fixtures()+").forEach(([key,value])=>localStorage.setItem(key,value));localStorage.setItem('app-onboarded','true');localStorage.setItem('hrt-lang','en');localStorage.setItem('hrt-mode','transfem');localStorage.setItem('app-pixel-cats','false');void 0");
            js(a,"window.__upgradeCacheWritten=false;void caches.open('"+CACHE+"').then(c=>c.put('"+URL+"',new Response("+JSONObject.quote(STALE)+"))).then(()=>window.__upgradeCacheWritten=true);void 0");
            waitFor(a,"window.__upgradeCacheWritten===true"); assertTrue("Cache fixture was not seeded",cachePresent(a));
            // Fixture preparation only; not a web-storage durable-write acknowledgement claim.
            Thread.sleep(2000);
            info.put("fixtureSha256",fixtureDigest(quiet(a,true).getJSONObject("currentStorage"))).put("cacheSentinelPresent",true);
            report("seedUpgradeState",true,1,info);
        }
    }
    @Test public void upgradedOffline() throws Exception {
        network(false);
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            JSONObject info=existing(a,2,false);
            assertEquals("true",js(a,"Boolean(document.querySelector('#root .main-view'))"));
            report("upgradedOffline",false,1,info);
        }
    }
    @Test public void upgradedOnline() throws Exception {
        network(true);
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            JSONObject first=existing(a,2,true); a.recreate(); JSONObject second=existing(a,2,true);
            assertEquals(first.getString("fixtureSha256"),second.getString("fixtureSha256"));
            second.put("cacheSentinelPresent",first.getBoolean("cacheSentinelPresent")&&second.getBoolean("cacheSentinelPresent"));
            report("upgradedOnline",true,2,second);
        }
    }
}
