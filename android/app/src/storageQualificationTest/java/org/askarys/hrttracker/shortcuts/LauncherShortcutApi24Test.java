package org.askarys.hrttracker.shortcuts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * API 24 has no ShortcutManager. The early OS guard must settle the call
 * without a bridge, so the plugin stays inert on unsupported launchers.
 */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(maxSdkVersion = 24)
public final class LauncherShortcutApi24Test {

    @Test public void publishAddDoseResolvesEarlyWithoutReachingShortcutApis() {
        assertEquals("add-dose", HrtLauncherShortcutPlugin.ADD_DOSE_ID);
        assertEquals("hrttracker://add-dose", HrtLauncherShortcutPlugin.ADD_DOSE_URI);
        // Instantiated without a bridge: any bridge or ShortcutManager touch
        // would throw and fail this test instead of resolving.
        RecordingCall call = new RecordingCall();
        new HrtLauncherShortcutPlugin().publishAddDose(call);
        assertTrue(call.resolved);
        assertFalse(call.rejected);
    }

    /** Records the settlement; production delivery needs the real bridge. */
    private static final class RecordingCall extends PluginCall {
        private boolean resolved;
        private boolean rejected;
        private RecordingCall() {
            super(null, "HrtLauncherShortcut", "api24-guard", "publishAddDose",
                new JSObject().put("label", "Add dose"));
        }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject data) { resolved = true; }
        @Override public void reject(String reason, String rejectionCode) { rejected = true; }
        @Override public void reject(String reason, String rejectionCode, Exception error, JSObject extra) { rejected = true; }
    }
}
