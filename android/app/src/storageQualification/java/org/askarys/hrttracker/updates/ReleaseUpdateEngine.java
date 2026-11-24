package org.askarys.hrttracker.updates;

import java.io.IOException;
import java.util.Objects;

/** Owns consent, throttling, and dismissal. The plugin serializes all writes. */
final class ReleaseUpdateEngine {
    interface ReleasePreferences {
        String get(String key);
        /** A null value removes the preference. */
        boolean put(String key, String value);
    }
    interface Clock { long nowMillis(); }
    interface ReleaseFetcher { String fetch() throws IOException; }

    static final String KEY_AUTOMATIC = "automatic";
    static final String KEY_LAST_ATTEMPT = "lastAttemptMillis";
    static final String KEY_AVAILABLE = "availableVersion";
    static final String KEY_DISMISSED = "dismissedVersion";
    private static final long AUTOMATIC_INTERVAL_MILLIS = 24L * 60 * 60 * 1000;

    private final ReleasePreferences prefs;
    private final Clock clock;
    private final ReleaseFetcher fetcher;
    private final String installedVersion;

    ReleaseUpdateEngine(ReleasePreferences prefs, Clock clock, ReleaseFetcher fetcher, String installedVersion) {
        this.prefs = prefs;
        this.clock = clock;
        this.fetcher = fetcher;
        this.installedVersion = installedVersion;
    }

    ReleaseUpdateState state() {
        return new ReleaseUpdateState(installedVersion, automatic(), available(), prefs.get(KEY_DISMISSED));
    }

    boolean setAutomatic(boolean enabled) { return write(KEY_AUTOMATIC, enabled ? "1" : "0"); }

    // A manual check also satisfies the interval for an automatic check.
    ReleaseUpdateState checkNow() throws IOException { return refresh(clock.nowMillis()); }

    ReleaseUpdateState checkOnOpen() throws IOException {
        if (!automatic()) return state();
        long now = clock.nowMillis();
        long lastAttempt = lastAttempt();
        if (lastAttempt > now) {
            // Restart the interval when Android corrects a clock that was set ahead.
            recordAttempt(now);
            return state();
        }
        if (lastAttempt >= 0 && now - lastAttempt < AUTOMATIC_INTERVAL_MILLIS) return state();
        return refresh(now);
    }

    boolean dismiss(String version) { return canOpen(version) && write(KEY_DISMISSED, version); }

    boolean canOpen(String version) { return version != null && version.equals(available()); }

    private String available() {
        String cached = prefs.get(KEY_AVAILABLE);
        return ReleaseCatalog.isNewer(cached, installedVersion) ? cached : null;
    }

    private ReleaseUpdateState refresh(long now) throws IOException {
        if (!ReleaseCatalog.isVersion(installedVersion)) throw new IOException("Installed Android version unavailable.");
        // Record unsuccessful requests too, so foreground checks stay throttled offline.
        recordAttempt(now);
        String latest = ReleaseCatalog.selectLatest(fetcher.fetch());
        if (latest == null) throw new IOException("No Android releases recognized.");
        String newer = ReleaseCatalog.isNewer(latest, installedVersion) ? latest : null;
        if (!write(KEY_AVAILABLE, newer)) throw new IOException("Could not save the release check result.");
        return state();
    }

    private void recordAttempt(long now) throws IOException {
        if (!write(KEY_LAST_ATTEMPT, Long.toString(now))) throw new IOException("Could not record the release check.");
    }

    private boolean write(String key, String value) {
        String previous = prefs.get(key);
        if (Objects.equals(previous, value) || prefs.put(key, value)) return true;
        // SharedPreferences can update its in-memory value even if the disk commit fails.
        prefs.put(key, previous);
        return false;
    }

    private long lastAttempt() {
        String raw = prefs.get(KEY_LAST_ATTEMPT);
        if (raw == null) return -1L;
        try { return Long.parseLong(raw); } catch (NumberFormatException unreadable) { return -1L; }
    }

    private boolean automatic() { return "1".equals(prefs.get(KEY_AUTOMATIC)); }
}
