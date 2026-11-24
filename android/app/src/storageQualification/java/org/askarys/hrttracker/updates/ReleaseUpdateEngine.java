package org.askarys.hrttracker.updates;

import java.io.IOException;
import java.util.Objects;

/** Holds the lock for local state changes. The release request runs outside the lock. */
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

    private final ReleasePreferences prefs;
    private final Clock clock;
    private final ReleaseFetcher fetcher;
    private final String installedVersion;
    private long revision;

    ReleaseUpdateEngine(ReleasePreferences prefs, Clock clock, ReleaseFetcher fetcher, String installedVersion) {
        this.prefs = prefs;
        this.clock = clock;
        this.fetcher = fetcher;
        this.installedVersion = installedVersion;
    }

    synchronized ReleaseUpdateState state() {
        return new ReleaseUpdateState(revision, installedVersion, automatic(), available(), prefs.get(KEY_DISMISSED));
    }

    synchronized boolean setAutomatic(boolean enabled) { return write(KEY_AUTOMATIC, enabled ? "1" : "0"); }

    // The plugin serializes network checks. Either kind of check satisfies the interval.
    CheckResult checkNow() throws IOException { return check(false); }

    CheckResult checkOnOpen() throws IOException { return check(true); }

    synchronized boolean dismiss(String version) { return canOpen(version) && write(KEY_DISMISSED, version); }

    synchronized boolean canOpen(String version) { return version != null && version.equals(available()); }

    private String available() {
        String cached = prefs.get(KEY_AVAILABLE);
        return ReleaseCatalog.isNewer(cached, installedVersion) ? cached : null;
    }

    private CheckResult check(boolean automatic) throws IOException {
        if (!admitCheck(automatic)) return new CheckResult(Outcome.SKIPPED, state());
        return publishCheck(fetcher.fetchLatest());
    }

    private synchronized boolean admitCheck(boolean fromForeground) throws IOException {
        long now = clock.nowMillis();
        if (fromForeground) {
            if (!automatic()) return false;
            long lastAttempt = lastAttempt();
            if (lastAttempt > now) {
                // Restart the interval when Android corrects a clock that was set ahead.
                recordAttempt(now);
                return false;
            }
            if (lastAttempt >= 0 && now - lastAttempt < AUTOMATIC_INTERVAL_MILLIS) return false;
        }
        if (!ReleaseCatalog.isVersion(installedVersion)) throw new IOException("Installed Android version unavailable.");
        // Record unsuccessful requests too, so foreground checks stay throttled offline.
        recordAttempt(now);
        return true;
    }

    private synchronized CheckResult publishCheck(String latest) throws IOException {
        // A catalog without a usable Android release can leave earlier evidence intact.
        if (latest == null) return new CheckResult(Outcome.NO_RELEASE, state());
        String newer = ReleaseCatalog.isNewer(latest, installedVersion) ? latest : null;
        if (!write(KEY_AVAILABLE, newer)) throw new IOException("Could not save the release check result.");
        return new CheckResult(Outcome.CHECKED, state());
    }

    private void recordAttempt(long now) throws IOException {
        if (!write(KEY_LAST_ATTEMPT, Long.toString(now))) throw new IOException("Could not record the release check.");
    }

    private boolean write(String key, String value) {
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
