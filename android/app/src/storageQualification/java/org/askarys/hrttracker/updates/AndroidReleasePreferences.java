package org.askarys.hrttracker.updates;

import android.content.Context;
import android.content.SharedPreferences;

/** Private per-app storage for update consent and check results. */
final class AndroidReleasePreferences implements ReleaseUpdateEngine.ReleasePreferences {
    private final SharedPreferences prefs;

    AndroidReleasePreferences(Context context, String name) {
        prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    @Override public String get(String key) { return prefs.getString(key, null); }

    /** Synchronous write so callers can verify the stored value immediately. */
    @Override public boolean put(String key, String value) { return prefs.edit().putString(key, value).commit(); }

}
