package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.*;
import org.askarys.hrttracker.spike.MainActivity;
import org.junit.Test;

/** Host force-stops only the dedicated emulator APK after the JavaScript acknowledgement. */
public final class BridgeLifecycleTest {
    @Test public void phase() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String phase = args.getString("phase"), id = args.getString("storeId");
        assertNotNull(id);
        assertTrue(id.matches("lifecycle-[a-f0-9-]{36}"));
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            if ("ack".equals(phase)) {
                StorageBridgeTest.run(activity, "write", id);
                Bundle status = new Bundle(); status.putString("bridge_ack", "durable");
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
                new CountDownLatch(1).await(60, TimeUnit.SECONDS);
                fail("Host did not kill after JavaScript acknowledgement");
            } else {
                assertEquals("verify", phase);
                StorageBridgeTest.run(activity, "read", id);
            }
        }
    }
}
