package org.askarys.hrttracker.storage;

import static org.askarys.hrttracker.storage.StorageBridgeTest.evaluate;
import static org.askarys.hrttracker.storage.StorageBridgeTest.waitFor;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Installed Android launcher shortcut and bundled WebView, using synthetic records. */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 25)
public final class LauncherShortcutColdLaunchTest {
    private static final String SHORTCUT_ID = "add-dose";
    private static final String ENGLISH_LABEL = "Add dose";
    private static final String GERMAN_LABEL = "Dosis hinzuf\u00fcgen";
    private static final String OPEN_DOSE_FORM =
        "Boolean(document.querySelector('.disclosure[data-open=\"true\"]:not([inert])"
            + " form .dose-fields input[inputmode=\"decimal\"]'))";
    private static final Context APP = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Before
    @After
    public void removeShortcut() {
        shortcutManager().removeDynamicShortcuts(Collections.singletonList(SHORTCUT_ID));
    }

    @Test
    public void coldLaunchFromTheInstalledShortcutOpensAddDoseAndKeepsTheRecords() throws Exception {
        AtomicReference<MainActivity> firstActivity = new AtomicReference<>();
        Intent launch;
        String before;
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            prepare(activity);
            before = snapshot(activity);
            Intent[] intents = awaitShortcut(ENGLISH_LABEL).getIntents();
            assertNotNull("The shortcut should carry an intent", intents);
            assertEquals("The shortcut should carry one intent", 1, intents.length);
            launch = new Intent(intents[0]);
            assertEquals(Intent.ACTION_VIEW, launch.getAction());
            assertEquals("hrttracker://add-dose", launch.getDataString());
            assertEquals(new ComponentName(APP, MainActivity.class), launch.getComponent());
            activity.onActivity(firstActivity::set);
        }

        assertNotNull("The shortcut should survive closing the activity", installedShortcut());
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(launch)) {
            activity.onActivity(current -> assertNotSame(firstActivity.get(), current));
            waitFor(activity, "history.state?.view==='history'");
            waitFor(activity, OPEN_DOSE_FORM);
            assertEquals("Opening the form changed records", before, snapshot(activity));
        }
    }

    @Test
    public void anIdenticalPublishKeepsTheShortcutAndAnAlternateLabelUpdatesIt() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            prepare(activity);
            awaitShortcut(ENGLISH_LABEL);
            publish(activity, ENGLISH_LABEL);
            long changed = awaitShortcut(ENGLISH_LABEL).getLastChangedTimestamp();
            // Leave a clock tick so a redundant write would change the timestamp.
            Thread.sleep(1200);
            publish(activity, ENGLISH_LABEL);
            assertEquals(
                "An identical publication rewrote the shortcut",
                changed,
                awaitShortcut(ENGLISH_LABEL).getLastChangedTimestamp()
            );

            publish(activity, GERMAN_LABEL);
            ShortcutInfo updated = awaitShortcut(GERMAN_LABEL);
            assertEquals(GERMAN_LABEL, String.valueOf(updated.getLongLabel()));
            // Check that the timestamp responds to a real update on this device.
            assertTrue(
                "A changed label did not advance the shortcut timestamp",
                updated.getLastChangedTimestamp() > changed
            );
        }
    }

    private static void prepare(ActivityScenario<MainActivity> activity) throws Exception {
        waitFor(activity, "Boolean(window.__hrtScreenQualification&&window.__hrtContentQualification)");
        assertEquals("ready", call(activity, "__hrtScreenQualification.prepare()").getString("value"));
        assertEquals("ready", call(activity, "__hrtContentQualification.language('en')").getString("value"));
        activity.recreate();
        waitFor(activity, "history.state?.view==='home'");
    }

    private static String snapshot(ActivityScenario<MainActivity> activity) throws Exception {
        return call(activity, "__hrtScreenQualification.read()").getJSONObject("value").getString("snapshot");
    }

    private static ShortcutManager shortcutManager() {
        ShortcutManager manager = APP.getSystemService(ShortcutManager.class);
        assertNotNull("This device has no ShortcutManager", manager);
        return manager;
    }

    private static ShortcutInfo installedShortcut() {
        for (ShortcutInfo entry : shortcutManager().getDynamicShortcuts()) {
            if (SHORTCUT_ID.equals(entry.getId())) return entry;
        }
        return null;
    }

    private static ShortcutInfo awaitShortcut(String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            ShortcutInfo entry = installedShortcut();
            if (entry != null && label.equals(String.valueOf(entry.getShortLabel()))) return entry;
            Thread.sleep(100);
        }
        fail("The installed shortcut did not get the label " + label);
        return null;
    }

    private static void publish(ActivityScenario<MainActivity> activity, String label) throws Exception {
        call(activity, "Capacitor.Plugins.HrtLauncherShortcut.publishAddDose({label:" + JSONObject.quote(label) + "})");
    }

    private static JSONObject call(ActivityScenario<MainActivity> activity, String expression) throws Exception {
        evaluate(
            activity,
            "window.__shortcutResult=null;Promise.resolve().then(()=>" + expression
                + ").then(value=>window.__shortcutResult={value},"
                + "error=>window.__shortcutResult={error:String(error)});void 0"
        );
        waitFor(activity, "Boolean(window.__shortcutResult)");
        JSONObject result = new JSONObject(
            (String) new JSONTokener(evaluate(activity, "JSON.stringify(window.__shortcutResult)")).nextValue()
        );
        assertFalse("Qualification call failed: " + result.optString("error"), result.has("error"));
        return result;
    }
}
