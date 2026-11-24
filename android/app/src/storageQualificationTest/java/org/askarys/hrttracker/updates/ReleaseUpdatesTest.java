package org.askarys.hrttracker.updates;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Build;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Consent, throttling, release selection, and dismissal rules for the update bridge. */
public final class ReleaseUpdatesTest {

    private static final class FakePrefs implements ReleaseUpdateEngine.ReleasePreferences {
        final Map<String, String> values = new HashMap<>();
        final Map<String, Integer> failingWrites = new HashMap<>();
        public String get(String key) { return values.get(key); }
        public boolean put(String key, String value) {
            // Models commit failures that lose the value, then succeed on retry.
            Integer remaining = failingWrites.get(key);
            if (remaining != null && remaining > 0) {
                failingWrites.put(key, remaining - 1);
                values.remove(key);
                return false;
            }
            if (value == null) values.remove(key); else values.put(key, value);
            return true;
        }
    }

    private static final class FakeClock implements ReleaseUpdateEngine.Clock {
        long now = 1_000_000_000L;
        public long nowMillis() { return now; }
    }

    /** Records the attempt marker the engine persisted before the request ran. */
    private static final class FakeFetcher implements ReleaseUpdateEngine.ReleaseFetcher {
        final FakePrefs prefs;
        final List<Object> script = new ArrayList<>();
        final List<String> attemptAtFetch = new ArrayList<>();
        int fetches;
        FakeFetcher(FakePrefs prefs) { this.prefs = prefs; }
        public String fetchLatest() throws IOException {
            fetches++;
            attemptAtFetch.add(prefs.get(ReleaseUpdateEngine.KEY_LAST_ATTEMPT));
            if (script.isEmpty()) throw new IOException("Synthetic fetch failure.");
            Object next = script.remove(0);
            if (next instanceof IOException) throw (IOException) next;
            return selectLatest((String) next);
        }
    }

    private static final class Harness {
        final FakePrefs prefs = new FakePrefs();
        final FakeClock clock = new FakeClock();
        final FakeFetcher fetcher;
        final ReleaseUpdateEngine engine;
        Harness(String installedVersion) {
            fetcher = new FakeFetcher(prefs);
            engine = new ReleaseUpdateEngine(prefs, clock, fetcher, installedVersion);
        }
    }

    private static String installedVersion() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
    }

    private static JSONObject release(String tag, boolean draft, boolean prerelease, String assetName, String assetState) throws Exception {
        JSONArray assets = new JSONArray();
        if (assetName != null) assets.put(new JSONObject().put("name", assetName).put("state", assetState));
        return new JSONObject().put("tag_name", tag).put("draft", draft).put("prerelease", prerelease).put("assets", assets);
    }

    private static String body(JSONObject... releases) throws Exception {
        JSONArray array = new JSONArray();
        for (JSONObject release : releases) array.put(release);
        return array.toString();
    }

    private static String available(String version) {
        try {
            return body(release("android-v" + version, false, false, "hrt-tracker-" + version + ".apk", "uploaded"));
        } catch (Exception malformed) { throw new AssertionError(malformed); }
    }

    private static String selectLatest(String catalog) throws IOException {
        return ReleaseCatalog.selectLatest(new StringReader(catalog));
    }

    private static ByteArrayInputStream catalogWithChangelog(int bytes) {
        byte[] prefix = "[{\"body\":\"".getBytes(StandardCharsets.UTF_8);
        byte[] suffix = ("\",\"assets\":[{\"state\":\"uploaded\",\"name\":\"hrt-tracker-1.2.0.apk\"}],"
            + "\"prerelease\":false,\"tag_name\":\"android-v1.2.0\",\"draft\":false}]").getBytes(StandardCharsets.UTF_8);
        byte[] catalog = new byte[bytes];
        Arrays.fill(catalog, (byte) 'x');
        System.arraycopy(prefix, 0, catalog, 0, prefix.length);
        System.arraycopy(suffix, 0, catalog, catalog.length - suffix.length, suffix.length);
        return new ByteArrayInputStream(catalog);
    }

    @Test public void freshStateKeepsConsentOffAndAutomaticChecksIdle() throws Exception {
        Harness h = new Harness(installedVersion());
        ReleaseUpdateEngine.CheckResult result = h.engine.checkOnOpen();
        assertEquals(ReleaseUpdateEngine.Outcome.SKIPPED, result.outcome);
        ReleaseUpdateState state = result.state;
        assertEquals(0, h.fetcher.fetches);
        assertFalse(state.automatic);
        assertNull(state.availableVersion);
        assertNull(state.dismissedVersion);
        JSONObject json = HrtReleaseUpdatesPlugin.stateJson(state);
        assertSame(JSONObject.NULL, json.get("availableVersion"));
        assertSame(JSONObject.NULL, json.get("dismissedVersion"));
        assertEquals(installedVersion(), json.getString("installedVersion"));
        assertFalse(json.getBoolean("automatic"));
        assertEquals(state.revision, json.getLong("revision"));
    }

    @Test public void automaticChecksNeedConsentAndRunAtMostOncePerDay() throws Exception {
        Harness h = new Harness("1.1.0");
        h.fetcher.script.add(available("1.2.0"));
        assertTrue(h.engine.setAutomatic(true));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(1, h.fetcher.fetches);
        h.clock.now += 60L * 60 * 1000;
        ReleaseUpdateEngine.CheckResult throttled = h.engine.checkOnOpen();
        assertEquals(ReleaseUpdateEngine.Outcome.SKIPPED, throttled.outcome);
        assertEquals("1.2.0", throttled.state.availableVersion);
        assertEquals(1, h.fetcher.fetches);
        h.clock.now += 25L * 60 * 60 * 1000;
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(2, h.fetcher.fetches);
        assertTrue(h.engine.setAutomatic(false));
        h.clock.now += 25L * 60 * 60 * 1000;
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(2, h.fetcher.fetches);
    }

    @Test public void manualChecksRunWithoutConsentAndSatisfyTheInterval() throws Exception {
        Harness h = new Harness("1.1.0");
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkNow().state.availableVersion);
        assertEquals(1, h.fetcher.fetches);
        assertTrue(h.engine.setAutomatic(true));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(1, h.fetcher.fetches);
        h.clock.now += 24L * 60 * 60 * 1000 + 1L;
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(2, h.fetcher.fetches);
    }

    @Test public void failedChecksRecordTheAttemptFirstAndKeepTheCachedState() throws Exception {
        Harness h = new Harness("1.1.0");
        assertTrue(h.engine.setAutomatic(true));
        h.fetcher.script.add(new IOException("Synthetic fetch failure."));
        boolean failed = false;
        try { h.engine.checkOnOpen(); } catch (IOException unavailable) { failed = true; }
        assertTrue(failed);
        assertEquals(1, h.fetcher.fetches);
        assertEquals(h.fetcher.attemptAtFetch.get(0), h.prefs.values.get(ReleaseUpdateEngine.KEY_LAST_ATTEMPT));
        assertNull(h.engine.state().availableVersion);
        h.clock.now += 25L * 60 * 60 * 1000;
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
    }

    @Test public void selectionPicksTheHighestStableReleaseWithAnExactUploadedApk() throws Exception {
        String list = body(
            release("android-v1.2.0", false, true, "hrt-tracker-1.2.0.apk", "uploaded"),
            release("android-v2.0.0", true, false, "hrt-tracker-2.0.0.apk", "uploaded"),
            release("android-v99999999999999999999.1.0", false, false, "hrt-tracker-99999999999999999999.1.0.apk", "uploaded"),
            release("android-v1.10.2", false, false, "hrt-tracker-1.10.2.apk", ""),
            release("android-v1.11.0", false, false, "hrt-tracker-1.11.1.apk", "uploaded"),
            release("android-v1.10.1", false, false, "hrt-tracker-1.10.1.apk", "starter"),
            release("android-v1.10.0", false, false, "hrt-tracker-1.10.0.apk", "uploaded"),
            release("android-v1.9.0", false, false, "hrt-tracker-1.9.0.apk", "uploaded"));
        assertEquals("1.10.0", selectLatest(list));
        assertEquals("https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/android-v1.10.0", ReleaseCatalog.releaseUrl("1.10.0"));
        assertNull(ReleaseCatalog.releaseUrl("../../wiki"));
        assertNull(ReleaseCatalog.releaseUrl("1.2"));
    }

    @Test public void emptyValidCatalogKeepsPreviouslyConfirmedAvailability() throws Exception {
        assertNull(selectLatest("[]"));
        assertNull(selectLatest(body(release("ios-v2.0.0", false, false, "hrt-tracker-2.0.0.ipa", "uploaded"))));
        Harness h = new Harness("1.0.9");
        h.fetcher.script.add(available("1.1.0"));
        assertEquals("1.1.0", h.engine.checkNow().state.availableVersion);
        h.fetcher.script.add("[]");
        ReleaseUpdateEngine.CheckResult result = h.engine.checkNow();
        assertEquals(ReleaseUpdateEngine.Outcome.NO_RELEASE, result.outcome);
        assertEquals("1.1.0", result.state.availableVersion);
        assertEquals("1.1.0", h.prefs.values.get(ReleaseUpdateEngine.KEY_AVAILABLE));
        assertTrue(h.engine.canOpen("1.1.0"));
        h.fetcher.script.add(body(release("android-v1.1.0", false, false, "hrt-tracker-1.1.0.apk", "starter")));
        result = h.engine.checkNow();
        assertEquals(ReleaseUpdateEngine.Outcome.NO_RELEASE, result.outcome);
        assertEquals("1.1.0", result.state.availableVersion);
    }

    @Test public void aConfirmedCurrentReleaseClearsPriorAvailability() throws Exception {
        Harness h = new Harness("1.1.0");
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkNow().state.availableVersion);
        h.fetcher.script.add(available("1.1.0"));
        ReleaseUpdateEngine.CheckResult result = h.engine.checkNow();
        assertEquals(ReleaseUpdateEngine.Outcome.CHECKED, result.outcome);
        assertNull(result.state.availableVersion);
        assertFalse(h.engine.canOpen("1.2.0"));
    }

    @Test public void unusableRowsDoNotHideAValidStableAndroidRelease() throws Exception {
        String valid = available("1.2.0").substring(1);
        assertEquals("1.2.0", selectLatest("[null,{},42,{\"tag_name\":\"ios-v3.0.0\"},"
            + "{\"tag_name\":\"android-v3.0.0\",\"draft\":false,\"prerelease\":false,\"assets\":null}," + valid));
        assertNull(selectLatest("[null,{}]"));
    }

    @Test public void streamsLargeChangelogsAndRejectsAtTheResponseLimit() throws Exception {
        assertEquals("1.2.0", GitHubReleaseFetcher.readCatalog(catalogWithChangelog(GitHubReleaseFetcher.MAX_BYTES)));
        assertThrows(GitHubReleaseFetcher.CatalogTooLargeException.class,
            () -> GitHubReleaseFetcher.readCatalog(catalogWithChangelog(GitHubReleaseFetcher.MAX_BYTES + 1)));
    }

    @Test public void malformedCatalogRejectsAndKeepsTheCachedState() throws Exception {
        assertThrows(IOException.class, () -> selectLatest("not json"));
        assertThrows(IOException.class, () -> selectLatest("{}"));
        assertThrows(IOException.class, () -> selectLatest("[{},]"));
        assertThrows(IOException.class, () -> selectLatest("[] {}"));
        Harness h = new Harness("1.0.9");
        h.fetcher.script.add(available("1.1.0"));
        assertEquals("1.1.0", h.engine.checkNow().state.availableVersion);
        h.fetcher.script.add("not json");
        assertThrows(IOException.class, h.engine::checkNow);
        assertEquals("1.1.0", h.engine.state().availableVersion);
    }

    @Test public void dismissalSurvivesReloadingTheStoredSettings() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "hrt_release_updates_test_" + UUID.randomUUID();
        try {
        ReleaseUpdateEngine engine = new ReleaseUpdateEngine(new AndroidReleasePreferences(context, name),
            () -> 5_000L, () -> "1.1.0", "1.0.0");
            assertEquals("1.1.0", engine.checkNow().state.availableVersion);
            assertFalse(engine.dismiss("9.9.9"));
            assertTrue(engine.dismiss("1.1.0"));
            assertTrue(engine.canOpen("1.1.0"));
            assertFalse(engine.canOpen("2.0.0"));
            ReleaseUpdateEngine reloaded = new ReleaseUpdateEngine(new AndroidReleasePreferences(context, name),
                () -> 5_000L, () -> { throw new IOException("Synthetic fetch failure."); }, "1.0.0");
            ReleaseUpdateState state = reloaded.state();
            assertEquals("1.1.0", state.availableVersion);
            assertEquals("1.1.0", state.dismissedVersion);
            ReleaseUpdateEngine updated = new ReleaseUpdateEngine(new AndroidReleasePreferences(context, name),
                () -> 25_000_000L, () -> "2.0.0", "1.0.0");
            ReleaseUpdateState afterUpdate = updated.checkNow().state;
            assertEquals("2.0.0", afterUpdate.availableVersion);
            assertEquals("1.1.0", afterUpdate.dismissedVersion);
        } finally {
            if (Build.VERSION.SDK_INT >= 24) context.deleteSharedPreferences(name);
        }
    }

    @Test public void aFailedConsentWriteCannotOptInSilently() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.failingWrites.put(ReleaseUpdateEngine.KEY_AUTOMATIC, 1);
        assertFalse(h.engine.setAutomatic(true));
        assertFalse(h.engine.state().automatic);
        h.clock.now += 48L * 60 * 60 * 1000;
        assertEquals(0, h.fetcher.fetches);
    }

    @Test public void aVersionMatchingTheInstallNeverShowsAsAvailable() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.values.put(ReleaseUpdateEngine.KEY_AVAILABLE, "1.1.0");
        assertNull(h.engine.state().availableVersion);
        assertFalse(h.engine.canOpen("1.1.0"));
        assertFalse(h.engine.dismiss("1.1.0"));
        h.fetcher.script.add(available("1.1.0"));
        assertNull(h.engine.checkNow().state.availableVersion);
        assertNull(h.prefs.values.get(ReleaseUpdateEngine.KEY_AVAILABLE));
    }

    @Test public void numericallyOlderReleasesNeverShowAsAvailable() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.values.put(ReleaseUpdateEngine.KEY_AVAILABLE, "1.0.9");
        assertNull(h.engine.state().availableVersion);
        assertFalse(h.engine.canOpen("1.0.9"));
        h.fetcher.script.add(available("1.0.9"));
        assertNull(h.engine.checkNow().state.availableVersion);
        assertNull(h.prefs.values.get(ReleaseUpdateEngine.KEY_AVAILABLE));
        h.fetcher.script.add(available("1.1.1"));
        assertEquals("1.1.1", h.engine.checkNow().state.availableVersion);
    }

    @Test public void aFailedAttemptWriteBlocksTheRequest() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.failingWrites.put(ReleaseUpdateEngine.KEY_LAST_ATTEMPT, 1);
        boolean failed = false;
        try { h.engine.checkNow(); } catch (IOException unavailable) { failed = true; }
        assertTrue(failed);
        assertEquals(0, h.fetcher.fetches);
    }

    @Test public void aFailedWriteRestoresTheAcknowledgedConsent() throws Exception {
        Harness h = new Harness("1.1.0");
        assertTrue(h.engine.setAutomatic(true));
        h.prefs.failingWrites.put(ReleaseUpdateEngine.KEY_AUTOMATIC, 1);
        assertFalse(h.engine.setAutomatic(false));
        assertEquals("1", h.prefs.values.get(ReleaseUpdateEngine.KEY_AUTOMATIC));
        h.clock.now += 25L * 60 * 60 * 1000;
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
    }
    @Test public void unrecognizedInstalledVersionsAndCacheEntriesNeverShowAnUpdate() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.values.put(ReleaseUpdateEngine.KEY_AVAILABLE, "1.2");
        assertNull(h.engine.state().availableVersion);
        assertNull(ReleaseCatalog.releaseUrl("2147483648.0.0"));
        Harness unknown = new Harness("—");
        try {
            unknown.engine.checkNow();
            throw new AssertionError("Expected installed version failure");
        } catch (IOException expected) {
            assertEquals(0, unknown.fetcher.fetches);
        }
    }

    @Test public void failureToSaveTheCheckResultKeepsThePriorVersionAndRejects() throws Exception {
        Harness h = new Harness("1.1.0");
        h.prefs.values.put(ReleaseUpdateEngine.KEY_AVAILABLE, "1.2.0");
        h.prefs.failingWrites.put(ReleaseUpdateEngine.KEY_AVAILABLE, 1);
        h.fetcher.script.add(available("1.3.0"));
        try {
            h.engine.checkNow();
            throw new AssertionError("Expected cache write failure");
        } catch (IOException expected) {
            assertEquals("1.2.0", h.engine.state().availableVersion);
        }
    }

    @Test public void aBackwardClockCorrectionRestartsTheIntervalWithoutARequest() throws Exception {
        Harness h = new Harness("1.1.0");
        long interval = 24L * 60 * 60 * 1000;
        assertTrue(h.engine.setAutomatic(true));
        h.fetcher.script.add(available("1.1.0"));
        h.engine.checkOnOpen();
        h.clock.now -= 3 * interval;
        h.engine.checkOnOpen();
        assertEquals(1, h.fetcher.fetches);
        h.clock.now += interval;
        h.fetcher.script.add(available("1.2.0"));
        assertEquals("1.2.0", h.engine.checkOnOpen().state.availableVersion);
        assertEquals(2, h.fetcher.fetches);
    }

    @Test public void dismissalAndConsentCanChangeWhileAForegroundRequestIsPending() throws Exception {
        FakePrefs prefs = new FakePrefs();
        prefs.values.put(ReleaseUpdateEngine.KEY_AVAILABLE, "1.2.0");
        CountDownLatch requested = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        ReleaseUpdateEngine engine = new ReleaseUpdateEngine(prefs, new FakeClock(), () -> {
            requested.countDown();
            try {
                if (!finish.await(10, TimeUnit.SECONDS)) throw new IOException("Test request did not finish.");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException(interrupted);
            }
            return "1.2.0";
        }, "1.1.0");
        assertTrue(engine.setAutomatic(true));
        ExecutorService network = Executors.newSingleThreadExecutor();
        try {
            Future<ReleaseUpdateEngine.CheckResult> pending = network.submit(engine::checkOnOpen);
            assertTrue(requested.await(5, TimeUnit.SECONDS));
            ReleaseUpdateState before = engine.state();
            assertTrue(engine.dismiss("1.2.0"));
            assertTrue(engine.setAutomatic(false));
            ReleaseUpdateState after = engine.state();
            assertFalse(pending.isDone());
            assertTrue(after.revision > before.revision);
            finish.countDown();
            ReleaseUpdateEngine.CheckResult result = pending.get(5, TimeUnit.SECONDS);
            assertEquals(ReleaseUpdateEngine.Outcome.CHECKED, result.outcome);
            assertEquals(after.revision, result.state.revision);
            assertFalse(result.state.automatic);
            assertEquals("1.2.0", result.state.dismissedVersion);
        } finally {
            finish.countDown();
            network.shutdownNow();
        }
    }

    @Test public void aCheckFromADestroyedBridgeCannotOverwriteTheCurrentRelease() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "hrt_release_updates_test_" + UUID.randomUUID();
        CountDownLatch requested = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        ReleaseUpdateEngine oldEngine = new ReleaseUpdateEngine(new AndroidReleasePreferences(context, name),
            () -> 5_000L, () -> {
                requested.countDown();
                try {
                    if (!finish.await(10, TimeUnit.SECONDS)) throw new IOException("Test request did not finish.");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException(interrupted);
                }
                return "1.2.0";
            }, "1.1.0");
        HrtReleaseUpdatesPlugin oldBridge = new HrtReleaseUpdatesPlugin();
        Field engine = HrtReleaseUpdatesPlugin.class.getDeclaredField("engine");
        engine.setAccessible(true);
        engine.set(oldBridge, oldEngine);
        ExecutorService network = Executors.newSingleThreadExecutor();
        try {
            Future<ReleaseUpdateEngine.CheckResult> pending = network.submit(oldEngine::checkNow);
            assertTrue(requested.await(5, TimeUnit.SECONDS));
            oldBridge.handleOnDestroy();

            ReleaseUpdateEngine currentEngine = new ReleaseUpdateEngine(new AndroidReleasePreferences(context, name),
                () -> 6_000L, () -> "1.3.0", "1.1.0");
            assertEquals("1.3.0", currentEngine.checkNow().state.availableVersion);

            finish.countDown();
            pending.get(5, TimeUnit.SECONDS);
            assertEquals("1.3.0", currentEngine.state().availableVersion);
            assertTrue(currentEngine.canOpen("1.3.0"));
            assertTrue(currentEngine.dismiss("1.3.0"));
        } finally {
            oldBridge.handleOnDestroy();
            finish.countDown();
            network.shutdownNow();
            if (Build.VERSION.SDK_INT >= 24) context.deleteSharedPreferences(name);
        }
    }

}
