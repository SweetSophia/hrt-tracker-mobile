package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Existing web content scenarios on the installed WebView and real bridge. Synthetic data only. */
public final class ContentBoundaryTest {
    private static final Instrumentation I = InstrumentationRegistry.getInstrumentation();
    private static String js(ActivityScenario<MainActivity> a, String expression) throws Exception {
        return StorageBridgeTest.evaluate(a, expression);
    }
    private static void waitFor(ActivityScenario<MainActivity> a, String expression) throws Exception {
        StorageBridgeTest.waitFor(a, expression);
    }
    private static JSONObject call(ActivityScenario<MainActivity> a, String expression) throws Exception {
        js(a,"window.__contentResult=null;Promise.resolve("+expression+").then(value=>window.__contentResult={value},()=>window.__contentResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__contentResult)");
        JSONObject result=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__contentResult)")).nextValue());
        assertFalse("Qualification setup/read failed",result.optBoolean("failed"));
        return result;
    }
    private static String nodes(String label, boolean contains) {
        return "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&!n.disabled&&[n.getAttribute('aria-label')||'',(()=>{const c=n.cloneNode(true);c.querySelectorAll('[aria-hidden=true]').forEach(x=>x.remove());return c.textContent.trim()})()].some(t=>"+(contains?"t.includes(":"t===(")+JSONObject.quote(label)+")))";
    }
    private static void button(ActivityScenario<MainActivity> a, String label, boolean contains) throws Exception {
        String selector=nodes(label,contains);
        waitFor(a,selector+".length===1"); js(a,selector+"[0].click();void 0");
    }
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {
        return call(a,"__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }
    private static void bridge(ActivityScenario<MainActivity> a) throws Exception {
        assertEquals("true",js(a,"Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('HrtNativeStorage')&&Capacitor.isPluginAvailable('HrtNativeDocuments')"));
        assertEquals("\"https://localhost\"",js(a,"location.origin"));
    }
    private static void prepare(ActivityScenario<MainActivity> a, String language) throws Exception {
        waitFor(a,"Boolean(window.__hrtContentQualification&&window.__hrtScreenQualification)");
        assertEquals("ready",call(a,"__hrtScreenQualification.prepare()").getString("value"));
        assertEquals("ready",call(a,"__hrtContentQualification.language("+JSONObject.quote(language)+")").getString("value"));
        a.recreate();
        waitFor(a,"Boolean(window.__hrtContentQualification&&window.__hrtScreenQualification)");
        waitFor(a,nodes(language.equals("en")?"Settings":"设置",false)+".length===1");
        bridge(a);
        js(a,"window.__contentObserved={logs:[],errors:[],alerts:[]};"+
            "const describe=v=>{try{return v instanceof Error?String(v.stack||v):typeof v==='string'?v:JSON.stringify(v)}catch{return String(v)}};"+
            "for(const level of ['log','info','warn','error','debug']){const original=console[level];console[level]=function(...args){__contentObserved.logs.push(args.map(describe).join(' '));return original.apply(this,args)}};"+
            "window.addEventListener('error',e=>__contentObserved.errors.push(String(e.error||e.message)));"+
            "window.addEventListener('unhandledrejection',e=>__contentObserved.errors.push(String(e.reason)));"+
            "window.alert=value=>__contentObserved.alerts.push(String(value));void 0");
    }
    private static void input(ActivityScenario<MainActivity> a, String selector, String value, boolean textarea) throws Exception {
        waitFor(a,"Boolean(document.querySelector("+JSONObject.quote(selector)+"))");
        js(a,"(()=>{const n=document.querySelector("+JSONObject.quote(selector)+");Object.getOwnPropertyDescriptor("+(textarea?"HTMLTextAreaElement":"HTMLInputElement")+".prototype,'value').set.call(n,"+JSONObject.quote(value)+");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
        assertEquals("true",js(a,"document.querySelector("+JSONObject.quote(selector)+").value==="+JSONObject.quote(value)));
    }
    private static void settle(ActivityScenario<MainActivity> a) throws Exception {
        call(a,"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
    }
    private static void report(ActivityScenario<MainActivity> a, String name, String before) throws Exception {
        settle(a); bridge(a);
        assertTrue("Native records or revisions changed",before.equals(snapshot(a)));
        assertEquals("0",js(a,"__contentObserved.errors.length"));
        assertEquals("0",js(a,"__contentObserved.alerts.length"));
        Bundle status=new Bundle();
        status.putString("content_report",new JSONObject().put("test",name).put("outcome","pass")
            .put("snapshotUnchanged",true).put("bridgeAvailable",true).put("privilegedOriginUnchanged",true).toString());
        I.sendStatus(2,status);
    }
    @Test public void passwordEntropyIsText() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a,"en"); String before=snapshot(a);
            // Do not authenticate or enable connected features to reach this component.
            js(a,"__hrtContentQualification.mountShare();void 0");
            try {
                waitFor(a,"Boolean(document.querySelector('#share-password-toggle'))");
                js(a,"document.querySelector('#share-password-toggle').click();void 0");
                for(String payload:new String[]{"<img src=x onerror=alert(1)>","</span><script>alert(1)</script>","\"><svg/onload=alert(1)>"}) {
                    input(a,"#share-password",payload,false);
                    waitFor(a,"Boolean(document.querySelector('#content-qualification-host [role=progressbar][aria-label=\"Entropy estimate\"]'))");
                    settle(a);
                    assertEquals("0",js(a,"document.querySelectorAll('#content-qualification-host img[src=x],#content-qualification-host svg[onload]').length"));
                    assertEquals("false",js(a,"[...document.querySelectorAll('#content-qualification-host script')].some(n=>n.textContent.includes('alert(1)'))"));
                    assertEquals("0",js(a,"__contentObserved.alerts.length"));
                }
            } finally { js(a,"__hrtContentQualification.unmountShare();void 0"); }
            report(a,"passwordEntropyIsText",before);
        }
    }
    private static void diagrams(String language, String name) throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a,language); String before=snapshot(a); boolean english=language.equals("en");
            button(a,english?"Settings":"设置",false);
            button(a,english?"About":"关于",true);
            button(a,english?"Everyday security":"日常操作与安全",false);
            String[] ids={"extended-protocols","extended-irc","extended-network-map","extended-messaging","extended-tor"};
            int[] counts={3,2,1,1,1};
            for(int index=0;index<ids.length;index++) {
                String section="document.getElementById("+JSONObject.quote(ids[index])+")";
                waitFor(a,"Boolean("+section+")");
                js(a,section+".scrollIntoView({block:'center'});void 0");
                waitFor(a,section+".querySelectorAll('.opsec-mermaid svg').length==="+counts[index]);
                assertEquals("0",js(a,section+".querySelectorAll('.opsec-mermaid-fallback,.opsec-mermaid-loading').length"));
                assertEquals("0",js(a,section+".querySelectorAll('.opsec-mermaid script,.opsec-mermaid [onload],.opsec-mermaid [onerror]').length"));
            }
            report(a,name,before);
        }
    }
    @Test public void opsecDiagramsEnglish() throws Exception { diagrams("en","opsecDiagramsEnglish"); }
    @Test public void opsecDiagramsChinese() throws Exception { diagrams("zh","opsecDiagramsChinese"); }

    private static String processLog() throws Exception {
        try (InputStream input=new ParcelFileDescriptor.AutoCloseInputStream(I.getUiAutomation().executeShellCommand("logcat -d --pid="+android.os.Process.myPid()+" -v brief"));
             ByteArrayOutputStream output=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[8192]; int count;
            while((count=input.read(buffer))!=-1) output.write(buffer,0,count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
    @Test public void malformedImportStaysPrivate() throws Exception {
        try (ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a,"en"); String before=snapshot(a);
            String marker="HRT_SYNTHETIC_IMPORT_PRIVATE_"+android.os.Process.myPid();
            button(a,"Settings",false); button(a,"Data management",true); button(a,"Import data",false);
            button(a,"Paste JSON text",true);
            input(a,"textarea", "{\"notes\":\""+marker+"\",bad json",true);
            button(a,"Import",false);
            waitFor(a,"Boolean(document.querySelector('[data-prompt=alert]')?.textContent.includes('Import failed. Please check that the file is valid.'))");
            settle(a);
            assertEquals("false",js(a,"__contentObserved.logs.some(value=>value.includes("+JSONObject.quote(marker)+")||value.includes('SyntaxError'))"));
            assertEquals("0",js(a,"__contentObserved.errors.length"));
            assertFalse("Synthetic import marker leaked to process logcat",processLog().contains(marker));
            button(a,"OK",false);
            report(a,"malformedImportStaysPrivate",before);
        }
    }
}
