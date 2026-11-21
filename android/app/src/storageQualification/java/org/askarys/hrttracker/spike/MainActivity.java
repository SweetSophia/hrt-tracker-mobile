package org.askarys.hrttracker.spike;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.askarys.hrttracker.storage.HrtNativeStoragePlugin;
import org.askarys.hrttracker.files.HrtNativeDocumentsPlugin;

/** Shared registration for the explicit native storage builds. */
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(HrtNativeStoragePlugin.class);
        registerPlugin(HrtNativeDocumentsPlugin.class);
        super.onCreate(state);
    }
}
