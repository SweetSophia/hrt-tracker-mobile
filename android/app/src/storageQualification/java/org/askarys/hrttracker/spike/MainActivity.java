package org.askarys.hrttracker.spike;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.askarys.hrttracker.storage.HrtNativeStoragePlugin;
import org.askarys.hrttracker.files.HrtNativeDocumentsPlugin;
import org.askarys.hrttracker.updates.HrtReleaseUpdatesPlugin;

/** Shared registration for the explicit native storage builds. */
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(HrtNativeStoragePlugin.class);
        registerPlugin(HrtNativeDocumentsPlugin.class);
        // Update checks exist only in the released application id, never in qualification builds.
        if ("org.askarys.hrttracker".equals(getPackageName())) registerPlugin(HrtReleaseUpdatesPlugin.class);
        super.onCreate(state);
    }
}
