package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.*;
import org.junit.Test;

/** Rendered shared controls, synthetic data, fresh native reads. No ordinary-build admission. */
public final class PlanningSettingsTest {
    private static final Instrumentation I=InstrumentationRegistry.getInstrumentation();
    private static String js(ActivityScenario<MainActivity> a,String expression) throws Exception { return StorageBridgeTest.evaluate(a,expression); }
    private static void waitFor(ActivityScenario<MainActivity> a,String expression) throws Exception {
        try { StorageBridgeTest.waitFor(a,expression); }
        catch(AssertionError failure) {
            Bundle info=new Bundle();info.putString("parity_wait",expression);I.sendStatus(2,info);throw failure;
        }
    }
    private static JSONObject call(ActivityScenario<MainActivity> a,String expression) throws Exception {
        js(a,"window.__parityResult=null;Promise.resolve("+expression+").then(value=>window.__parityResult={value},()=>window.__parityResult={failed:true});void 0");
        waitFor(a,"Boolean(window.__parityResult)");
        JSONObject result=new JSONObject((String)new JSONTokener(js(a,"JSON.stringify(window.__parityResult)")).nextValue());
        assertFalse("Qualification setup/read failed",result.optBoolean("failed"));return result;
    }
    private static void ready(ActivityScenario<MainActivity> a) throws Exception {
        waitFor(a,"Boolean(window.__hrtScreenQualification)");
        js(a,"window.Date=class extends Date{constructor(...args){super(...(args.length?args:[1793534400000]));}static now(){return 1793534400000;}};void 0");
        assertEquals("true",js(a,"Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('HrtNativeStorage')"));
        assertEquals("\"https://localhost\"",js(a,"location.origin"));
    }
    private static void prepare(ActivityScenario<MainActivity> a) throws Exception {
        ready(a);assertEquals("ready",call(a,"__hrtScreenQualification.prepare()").getString("value"));
        a.recreate();ready(a);waitFor(a,nodes("Medication plan",false)+".length===1");
    }
    private static JSONObject state(ActivityScenario<MainActivity> a) throws Exception {return call(a,"__hrtScreenQualification.read()").getJSONObject("value");}
    private static String snapshot(ActivityScenario<MainActivity> a) throws Exception {return state(a).getString("snapshot");}
    private static JSONObject mode(JSONObject state,String name) throws Exception {return state.getJSONObject("bundle").getJSONObject("modes").getJSONObject(name);}
    private static String nodes(String label,boolean contains) {
        return "[...document.querySelectorAll('button')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&!n.disabled&&[n.getAttribute('aria-label')||'',(()=>{const c=n.cloneNode(true);c.querySelectorAll('[aria-hidden=true]').forEach(x=>x.remove());return c.textContent.trim()})()].some(t=>"+(contains?"t.includes(":"t===(")+JSONObject.quote(label)+")))";
    }
    private static void button(ActivityScenario<MainActivity> a,String label,boolean contains) throws Exception {
        Bundle step=new Bundle();step.putString("parity_step",label);I.sendStatus(2,step);
        String selector=nodes(label,contains);waitFor(a,selector+".length===1");js(a,selector+"[0].click();void 0");
    }
    private static void button(ActivityScenario<MainActivity> a,String label) throws Exception {button(a,label,false);}
    private static String digest(String value) throws Exception {
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format("%02x",b));return out.toString();
    }
    private static void report(String phase,String value,String... flags) throws Exception {
        JSONObject r=new JSONObject().put("phase",phase).put("outcome","pass").put("pid",android.os.Process.myPid()).put("snapshotSha256",digest(value));
        for(String flag:flags)r.put(flag,true);Bundle result=new Bundle();result.putString("parity_report",r.toString());I.sendStatus(2,result);
    }
    private static void expected(ActivityScenario<MainActivity> a) throws Exception {
        String expected=InstrumentationRegistry.getArguments().getString("expectedDigest");
        assertNotNull("Run through the host runner",expected);assertTrue(expected.matches("[a-f0-9]{64}"));
        assertEquals("Fresh native snapshot changed",expected,digest(snapshot(a)));
    }

    private static void heading(ActivityScenario<MainActivity> a,String title) throws Exception {
        waitFor(a,"[...document.querySelectorAll('#root h1')].some(n=>n.getClientRects().length&&n.textContent.trim()==="+JSONObject.quote(title)+")");
    }
    private static void onlyLanguageChanged(JSONObject before,JSONObject after) throws Exception {
        JSONObject snapshots=before.getJSONObject("snapshots");
        for(java.util.Iterator<String> names=snapshots.keys();names.hasNext();) {
            String name=names.next();if(!name.equals("preferences:v1"))assertEquals("Settings wrote records",snapshots.getJSONObject(name).toString(),after.getJSONObject("snapshots").getJSONObject(name).toString());
        }
        JSONObject previous=snapshots.getJSONObject("preferences:v1").getJSONObject("entries"),current=after.getJSONObject("snapshots").getJSONObject("preferences:v1").getJSONObject("entries");
        java.util.Set<String> keys=new java.util.HashSet<>();previous.keys().forEachRemaining(keys::add);current.keys().forEachRemaining(keys::add);
        for(String key:keys)if(!key.equals("hrt-lang"))assertEquals("Language change wrote unrelated preference: "+key,previous.optString(key,null),current.optString(key,null));
    }
    private static void language(ActivityScenario<MainActivity> a,String language) throws Exception {
        assertEquals(language,state(a).getJSONObject("snapshots").getJSONObject("preferences:v1").getJSONObject("entries").getString("hrt-lang"));
    }
    @Test public void onboardingSettingsSeed() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a);waitFor(a,"Boolean(document.querySelector('#root .onboarding-steps'))");
            assertNotEquals("\"true\"",js(a,"localStorage.getItem('app-onboarded')"));
            JSONObject before=state(a);
            button(a,"English");heading(a,"Hello there");
            button(a,"Next");heading(a,"What are you tracking?");button(a,"Feminizing HRT",true);
            button(a,"Next");heading(a,"How it works");
            button(a,"Next");heading(a,"What do you weigh?");
            button(a,"Next");heading(a,"What are you taking?");
            button(a,"Next");heading(a,"Your data, and one warning");
            button(a,"Get started");waitFor(a,"Boolean(document.querySelector('#root .main-view'))");
            assertEquals("\"true\"",js(a,"localStorage.getItem('app-onboarded')"));
            button(a,"Settings");button(a,"General",true);button(a,"Language",true);
            button(a,"简体中文");waitFor(a,nodes("语言设置",true)+".length===1");language(a,"zh");
            button(a,"English");waitFor(a,nodes("Language",true)+".length===1");language(a,"en");
            button(a,"简体中文");waitFor(a,nodes("语言设置",true)+".length===1");language(a,"zh");
            JSONObject after=state(a);onlyLanguageChanged(before,after);
            // Device-local flag fixture grace; not a native durable-acknowledgement contract.
            Thread.sleep(2000);
            report("onboardingSettingsSeed",after.getString("snapshot"),"onboardingComplete","enZhSwitched","languageSaved","recordsUnchanged");
        }
    }
    @Test public void onboardingSettingsVerify() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a);waitFor(a,"Boolean(document.querySelector('#root .main-view'))");expected(a);language(a,"zh");
            assertEquals("\"true\"",js(a,"localStorage.getItem('app-onboarded')"));
            assertEquals("0",js(a,"document.querySelectorAll('#root .onboarding-steps').length"));
            button(a,"设置");button(a,"常规设置",true);button(a,"语言设置",true);waitFor(a,nodes("语言设置",true)+".length===1");
            waitFor(a,nodes("简体中文",false)+".length===1&&"+nodes("简体中文",false)+"[0].getAttribute('aria-pressed')==='true'");
            expected(a);report("onboardingSettingsVerify",snapshot(a),"reopenedExact","onboardingSkipped","chineseRetained");
        }
    }
    private static void switchMode(ActivityScenario<MainActivity> a,String label) throws Exception {
        button(a,"Settings");if("true".equals(js(a,nodes("General",true)+".length===1")))button(a,"General",true);
        button(a,"HRT mode",true);button(a,label,true);
        waitFor(a,nodes(label,true)+"[0]?.getAttribute('aria-pressed')==='true'");
    }
    private static void numeric(ActivityScenario<MainActivity> a,int index,String value) throws Exception {
        String ns="[...document.querySelectorAll('input[type=number]')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]'))";
        waitFor(a,ns+".length>"+index);
        js(a,"(()=>{const n="+ns+"["+index+"];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,"+JSONObject.quote(value)+");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
        waitFor(a,ns+"["+index+"].value==="+JSONObject.quote(value));
    }
    private static void supplyDrug(ActivityScenario<MainActivity> a,String name) throws Exception {
        String trigger="[...document.querySelectorAll('button[aria-haspopup=listbox]')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&document.getElementById(n.getAttribute('aria-labelledby').split(' ')[0])?.textContent==='Drug')";
        waitFor(a,trigger+".length===1");js(a,trigger+"[0].click();void 0");
        String option="[...document.querySelectorAll('[role=option]')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&n.textContent.includes("+JSONObject.quote(name+" injection")+"))";
        waitFor(a,option+".length===1");js(a,option+"[0].click();void 0");js(a,trigger+"[0].click();void 0");
    }
    private static void onlyTargetChanged(JSONObject before,JSONObject after,String selected,String category) throws Exception {
        String other=selected.equals("transfem")?"transmasc":"transfem";
        assertEquals("Other mode changed",mode(before,other).toString(),mode(after,other).toString());
        String prefix=selected.equals("transmasc")?"hrt-masc-":"hrt-";
        java.util.Set<String> allowed=new java.util.HashSet<>();allowed.add(prefix+category);
        if(category.equals("plan")){allowed.add(prefix+"plan-at");if(selected.equals("transfem"))allowed.add("hrt-cpa-plan");}
        JSONObject all=before.getJSONObject("snapshots"),next=after.getJSONObject("snapshots");
        assertEquals(all.length(),next.length());
        for(java.util.Iterator<String> names=all.keys();names.hasNext();) {
            String name=names.next();JSONObject previous=all.getJSONObject(name),current=next.getJSONObject(name);
            if(name.equals("preferences:v1")){assertEquals("Save changed preferences",previous.toString(),current.toString());continue;}
            assertEquals("One acknowledged transaction per save",previous.getLong("revision")+1,current.getLong("revision"));
            JSONObject oldEntries=previous.getJSONObject("entries"),newEntries=current.getJSONObject("entries");
            if(category.equals("plan")) {
                assertEquals("Plan timestamp", "1793534400000",newEntries.getString(prefix+"plan-at"));
                if(selected.equals("transfem"))assertFalse("Legacy CPA key must be removed",newEntries.has("hrt-cpa-plan"));
            }
            java.util.Set<String> keys=new java.util.HashSet<>();oldEntries.keys().forEachRemaining(keys::add);newEntries.keys().forEachRemaining(keys::add);
            for(String key:keys)if(!allowed.contains(key))assertEquals("Unrelated native entry changed: "+key,oldEntries.optString(key,null),newEntries.optString(key,null));
        }
    }

    private static void saved(JSONObject state) throws Exception {
        for(String name:new String[]{"transfem","transmasc"}) {
            boolean fem=name.equals("transfem");JSONObject records=mode(state,name);
            JSONArray plan=records.getJSONArray("plan"),supplies=records.getJSONArray("supplies");
            assertEquals("Exactly one plan",1,plan.length());assertEquals("Exactly one supply",1,supplies.length());
            JSONObject item=plan.getJSONObject(0),supply=supplies.getJSONObject(0);String ester=fem?"EV":"TC";
            assertTrue(item.getString("id").matches("[a-f0-9-]{36}"));
            assertEquals("injection",item.getString("route"));assertEquals(ester,item.getString("ester"));
            assertEquals(fem?4.25:60,item.getDouble("doseMG"),0);assertEquals(7,item.getDouble("everyDays"),0);assertEquals(1,item.getDouble("timesPerDay"),0);
            assertEquals(0,item.getJSONObject("extras").length());
            assertTrue(supply.getString("id").matches("[a-f0-9-]{36}"));assertEquals("injection",supply.getString("route"));assertEquals(ester,supply.getString("ester"));
            assertEquals(fem?2:3,supply.getDouble("count"),0);assertEquals(1793534400000L,supply.getLong("startedAt"));
            JSONObject pack=supply.getJSONObject("pack");assertEquals("vial",pack.getString("kind"));assertEquals(5,pack.getDouble("ml"),0);assertEquals(fem?20:100,pack.getDouble("mgPerMl"),0);
            assertEquals(1,records.getJSONArray("events").length());assertEquals(0,records.getJSONArray("labResults").length());
        }
    }
    @Test public void plansSuppliesSeed() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            prepare(a);
            for(String name:new String[]{"transfem","transmasc"}) {
                boolean fem=name.equals("transfem");if(!fem)switchMode(a,"Masculinizing HRT");
                JSONObject before=state(a);button(a,"Overview");button(a,"Medication plan");heading(a,"How do you take it?");
                button(a,"Injection",true);button(a,"Next");
                button(a,fem?"Estradiol valerate (EV)":"Testosterone cypionate",true);button(a,"Next");
                numeric(a,0,fem?"4.25":"60");button(a,"Next");button(a,"Weekly");button(a,"Add");
                waitFor(a,nodes("Add a drug",false)+".length===1");JSONObject afterPlan=state(a);
                assertEquals(1,mode(afterPlan,name).getJSONArray("plan").length());onlyTargetChanged(before,afterPlan,name,"plan");
                button(a,"Settings");if("true".equals(js(a,nodes("General",true)+".length===1")))button(a,"General",true);
                button(a,"Supplies",true);button(a,"Add supply");supplyDrug(a,fem?"Estradiol valerate":"Testosterone cypionate");
                waitFor(a,"[...document.querySelectorAll('input[type=number]')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')).length===3");
                numeric(a,0,"5");numeric(a,1,fem?"20":"100");numeric(a,2,fem?"2":"3");button(a,"Add");
                waitFor(a,nodes("Add supply",false)+".length===1");JSONObject afterSupply=state(a);
                assertEquals(1,mode(afterSupply,name).getJSONArray("supplies").length());onlyTargetChanged(afterPlan,afterSupply,name,"supplies");
            }
            JSONObject after=state(a);saved(after);report("plansSuppliesSeed",after.getString("snapshot"),"bothModesCreated","scopeIsolated","exactValues","acknowledged");
        }
    }
    private static String supplyRows(String drug) {
        return "[...document.querySelectorAll('button[aria-expanded]:not([aria-haspopup])')].filter(n=>n.getClientRects().length&&!n.closest('[inert],[hidden]')&&!n.disabled&&n.querySelector('p')?.textContent.trim().toLowerCase()==="+JSONObject.quote(drug+" injection")+")";
    }
    private static String supplyRendered(String drug) {
        return supplyRows(drug)+".length===1";
    }
    private static void supplyRowControls(ActivityScenario<MainActivity> a,String drug) throws Exception {
        waitFor(a,supplyRendered(drug));waitFor(a,supplyRows(drug)+".length===1");
        String before=snapshot(a);
        String expression="(()=>{const row="+supplyRows(drug)+"[0],marker=document.createComment('saved-supply-row-control');"+
            "const originalHidden=row.hasAttribute('hidden'),originalInert=row.hasAttribute('inert');let duplicate;const observed={};"+
            "try{row.replaceWith(marker);"+
            "observed.hiddenFormPresent=[...document.querySelectorAll('button[aria-haspopup=listbox]')].some(n=>n.closest('[inert]')&&n.textContent.toLowerCase().includes("+JSONObject.quote(drug)+"));"+
            "observed.missingRejected=!("+supplyRendered(drug)+");marker.replaceWith(row);"+
            "row.hidden=true;observed.hiddenRejected=!("+supplyRendered(drug)+");row.toggleAttribute('hidden',originalHidden);"+
            "row.setAttribute('inert','');observed.inertRejected=!("+supplyRendered(drug)+");row.toggleAttribute('inert',originalInert);"+
            "duplicate=row.cloneNode(true);row.after(duplicate);observed.duplicateRejected=!("+supplyRendered(drug)+");return JSON.stringify(observed);"+
            "}finally{duplicate?.remove();row.toggleAttribute('hidden',originalHidden);row.toggleAttribute('inert',originalInert);if(marker.parentNode)marker.replaceWith(row)}})()";
        JSONObject controls=new JSONObject((String)new JSONTokener(js(a,expression)).nextValue());
        assertTrue("Hidden add form must remain mounted during missing-row control",controls.getBoolean("hiddenFormPresent"));
        assertTrue("Missing saved row passed rendering qualification",controls.getBoolean("missingRejected"));
        assertTrue("Hidden saved row passed rendering qualification",controls.getBoolean("hiddenRejected"));
        assertTrue("Inert saved row passed rendering qualification",controls.getBoolean("inertRejected"));
        assertTrue("Duplicate saved rows passed rendering qualification",controls.getBoolean("duplicateRejected"));
        waitFor(a,supplyRendered(drug));assertEquals("DOM controls changed native records",before,snapshot(a));
    }
    @Test public void plansSuppliesVerify() throws Exception {
        try(ActivityScenario<MainActivity> a=ActivityScenario.launch(MainActivity.class)) {
            ready(a);waitFor(a,nodes("Medication plan",false)+".length===1");expected(a);saved(state(a));
            for(String name:new String[]{"transfem","transmasc"}) {
                boolean fem=name.equals("transfem");String drug=fem?"estradiol valerate":"testosterone cypionate";
                switchMode(a,fem?"Feminizing HRT":"Masculinizing HRT");button(a,"Overview");button(a,"Medication plan");
                waitFor(a,nodes(fem?"4.25 mg":"60 mg",true)+".length===1");
                button(a,"Settings");if("true".equals(js(a,nodes("General",true)+".length===1")))button(a,"General",true);
                button(a,"Supplies",true);supplyRowControls(a,drug);
                saved(state(a));expected(a);
            }
            report("plansSuppliesVerify",snapshot(a),"reopenedExact","bothModesRendered","noDuplicates","savedSupplyRowsControlled");
        }
    }
}
