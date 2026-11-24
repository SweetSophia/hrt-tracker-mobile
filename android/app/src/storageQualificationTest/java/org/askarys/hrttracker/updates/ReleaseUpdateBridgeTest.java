package org.askarys.hrttracker.updates;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.net.Uri;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.askarys.hrttracker.spike.MainActivity;
import org.junit.Test;

/**
 * Real authorized Capacitor bridge drives HrtReleaseUpdatesPlugin.checkNow rejection mapping.
 * Synthetic data only; the plugin API surface stays production.
 */
public final class ReleaseUpdateBridgeTest {

    @Test public void oversizedCatalogRejectsWithTheCatalogTooLargeCode() throws Exception {
        assertCheckRejectsWith("UPDATE_CATALOG_TOO_LARGE", () -> GitHubReleaseFetcher.readCatalog(
            ReleaseUpdatesTest.catalogWithChangelog(GitHubReleaseFetcher.MAX_BYTES + 1)));
    }

    @Test public void ordinaryFetchFailureRejectsWithTheCheckUnavailableCode() throws Exception {
        assertCheckRejectsWith("UPDATE_CHECK_UNAVAILABLE", () -> {
            throw new IOException("Synthetic release fetch failure.");
        });
    }

    private static void assertCheckRejectsWith(String code, ReleaseUpdateEngine.ReleaseFetcher fetcher) throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        assertTrue(instrumentation.getTargetContext().getPackageName().endsWith(".storagequalification"));
        AtomicInteger fetches = new AtomicInteger();
        ReleaseUpdateEngine engine = new ReleaseUpdateEngine(new ReleaseUpdatesTest.FakePrefs(), System::currentTimeMillis, () -> {
            fetches.incrementAndGet();
            return fetcher.fetchLatest();
        }, "1.0.0");
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            HrtReleaseUpdatesPlugin plugin = new HrtReleaseUpdatesPlugin();
            try {
                waitForAuthorizedOrigin(activity);
                // The qualification app leaves update checks unregistered. Attach the
                // instance for this native call without exporting it to JavaScript.
                activity.onActivity(a -> {
                    plugin.setBridge(a.getBridge());
                    plugin.load();
                });
                injectEngine(plugin, engine);
                RecordingCall call = new RecordingCall();
                plugin.checkNow(call);
                assertTrue("checkNow did not settle", call.settled.await(30, TimeUnit.SECONDS));
                // Prove the failure came from the fetcher, past the bundled-origin check.
                assertEquals(1, fetches.get());
                assertEquals(code, call.code);
            } finally {
                instrumentation.runOnMainSync(plugin::handleOnDestroy);
            }
        }
    }

    /** The same bundled-origin rule allowed() enforces before any check dispatches. */
    private static void waitForAuthorizedOrigin(ActivityScenario<MainActivity> activity) throws Exception {
        AtomicReference<String> url = new AtomicReference<>();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            activity.onActivity(a -> url.set(a.getBridge().getWebView().getUrl()));
            Uri parsed = Uri.parse(url.get() == null ? "" : url.get());
            if ("https".equals(parsed.getScheme()) && "localhost".equals(parsed.getHost())
                && parsed.getPort() == -1 && parsed.getUserInfo() == null) return;
            Thread.sleep(100);
        }
        fail("The WebView never reached the bundled https://localhost origin: " + url.get());
    }

    // Reflection is confined to the instrumentation APK, like BackupBridgeTest and ReleaseUpdatesTest.
    private static void injectEngine(HrtReleaseUpdatesPlugin plugin, ReleaseUpdateEngine engine) throws Exception {
        Field field = HrtReleaseUpdatesPlugin.class.getDeclaredField("engine");
        field.setAccessible(true);
        assertNotNull("The production load() did not create an engine", field.get(plugin));
        field.set(plugin, engine);
    }

    /** Records the rejection the real bridge would forward, without touching the WebView. */
    private static final class RecordingCall extends PluginCall {
        private final CountDownLatch settled = new CountDownLatch(1);
        private String code;
        private RecordingCall() { super(null, "HrtReleaseUpdates", "bridge-error-mapping", "checkNow", new JSObject()); }
        @Override public void reject(String reason, String rejectionCode, Exception error, JSObject extra) {
            this.code = rejectionCode;
            settled.countDown();
        }
        @Override public void resolve(JSObject data) { settled.countDown(); }
    }
}
