package org.askarys.hrttracker.updates;

import java.io.IOException;
import java.util.Objects;

/** Serializes preference access across bridges. The release request runs outside the lock. */
final class ReleaseUpdateEngine {
    interface ReleasePreferences {
        String get(String key);
        /** A null value removes the preference. */
        boolean put(String key, String value);
    }
    interface Clock { long nowMillis(); }
    interface ReleaseFetcher { String fetchLatest() throws IOException; }

    enum Outcome {
        SKIPPED("skipped"), CHECKED("checked"), NO_RELEASE("noRelease");

        final String wireName;
        Outcome(String wireName) { this.wireName = wireName; }
    }

    static final class CheckResult {
        final Outcome outcome;
        final ReleaseUpdateState state;

        CheckResult(Outcome outcome, ReleaseUpdateState state) {
            this.outcome = outcome;
            this.state = state;
        }
    }

    static final String KEY_AUTOMATIC = "automatic";
    static final String KEY_LAST_ATTEMPT = "lastAttemptMillis";
    static final String KEY_AVAILABLE = "availableVersion";
    static final String KEY_DISMISSED = "dismissedVersion";
    private static final long AUTOMATIC_INTERVAL_MILLIS = 24L * 60 * 60 * 1000;
    private static final Object PREFERENCES_LOCK = new Object();

    private final ReleasePreferences prefs;
    private final Clock clock;
    private final ReleaseFetcher fetcher;
    private final String installedVersion;
    private long revision;
    private volatile boolean retired;

    ReleaseUpdateEngine(ReleasePreferences prefs, Clock clock, ReleaseFetcher fetcher, String installedVersion) {
        this.prefs = prefs;
        this.clock = clock;
        this.fetcher = fetcher;
        this.installedVersion = installedVersion;
    }

    ReleaseUpdateState state() {
        synchronized (PREFERENCES_LOCK) {
            return new ReleaseUpdateState(revision, installedVersion, automatic(), available(), prefs.get(KEY_DISMISSED));
        }
    }

    // Teardown is on the main thread. A write already in progress finishes under
    // PREFERENCES_LOCK before the replacement bridge can read or write the store.
    void retire() { retired = true; }

    boolean setAutomatic(boolean enabled) {
        synchronized (PREFERENCES_LOCK) {
            return !retired && writeLocked(KEY_AUTOMATIC, enabled ? "1" : "0");
        }
    }

    // The plugin serializes network checks. Either kind of check satisfies the interval.
    CheckResult checkNow() throws IOException { return check(false); }

    CheckResult checkOnOpen() throws IOException { return check(true); }

    boolean dismiss(String version) {
        synchronized (PREFERENCES_LOCK) {
            return !retired && canOpen(version) && writeLocked(KEY_DISMISSED, version);
        }
    }

    boolean canOpen(String version) {
        synchronized (PREFERENCES_LOCK) {
            return version != null && version.equals(available());
        }
    }

    private String available() {
        String cached = prefs.get(KEY_AVAILABLE);
        return ReleaseCatalog.isNewer(cached, installedVersion) ? cached : null;
    }

    private CheckResult check(boolean automatic) throws IOException {
        if (!admitCheck(automatic)) return new CheckResult(Outcome.SKIPPED, state());
        return publishCheck(fetcher.fetchLatest());
    }

    private boolean admitCheck(boolean fromForeground) throws IOException {
        synchronized (PREFERENCES_LOCK) {
            if (retired) return false;
            long now = clock.nowMillis();
            if (fromForeground) {
                if (!automatic()) return false;
                long lastAttempt = lastAttempt();
                if (lastAttempt > now) {
                    // Restart the interval when Android corrects a clock that was set ahead.
                    recordAttemptLocked(now);
                    return false;
                }
                if (lastAttempt >= 0 && now - lastAttempt < AUTOMATIC_INTERVAL_MILLIS) return false;
            }
            if (!ReleaseCatalog.isVersion(installedVersion)) throw new IOException("Installed Android version unavailable.");
            // Record unsuccessful requests too, so foreground checks stay throttled offline.
            recordAttemptLocked(now);
            return true;
        }
    }

    private CheckResult publishCheck(String latest) throws IOException {
        synchronized (PREFERENCES_LOCK) {
            if (retired) return new CheckResult(Outcome.SKIPPED, state());
            // A catalog without a usable Android release can leave earlier evidence intact.
            if (latest == null) return new CheckResult(Outcome.NO_RELEASE, state());
            String newer = ReleaseCatalog.isNewer(latest, installedVersion) ? latest : null;
            if (!writeLocked(KEY_AVAILABLE, newer)) throw new IOException("Could not save the release check result.");
            return new CheckResult(Outcome.CHECKED, state());
        }
    }

    private void recordAttemptLocked(long now) throws IOException {
        if (!writeLocked(KEY_LAST_ATTEMPT, Long.toString(now))) throw new IOException("Could not record the release check.");
    }

    private boolean writeLocked(String key, String value) {
        String previous = prefs.get(key);
        if (Objects.equals(previous, value)) return true;
        if (prefs.put(key, value)) {
            revision++;
            return true;
        }
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
