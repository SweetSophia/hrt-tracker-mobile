package org.askarys.hrttracker.updates;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Selects the newest stable release that carries its matching APK. */
final class ReleaseCatalog {
    static final String RELEASES_URL = "https://api.github.com/repos/SweetSophia/hrt-tracker-mobile/releases?per_page=20";
    private static final String TAG_PREFIX = "android-v";
    private static final String COMPONENT = "(0|[1-9][0-9]{0,9})";
    private static final Pattern VERSION = Pattern.compile(COMPONENT + "\\." + COMPONENT + "\\." + COMPONENT);

    private ReleaseCatalog() {}

    static String selectLatest(String body) {
        JSONArray releases;
        try {
            releases = new JSONArray(body);
        } catch (JSONException malformed) {
            return null;
        }
        String best = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || !Boolean.FALSE.equals(release.opt("draft"))
                || !Boolean.FALSE.equals(release.opt("prerelease"))) continue;
            String tag = release.optString("tag_name");
            if (!tag.startsWith(TAG_PREFIX)) continue;
            String candidate = tag.substring(TAG_PREFIX.length());
            if (!isVersion(candidate) || !hasUploadedApk(release, candidate)) continue;
            if (best == null || isNewer(candidate, best)) best = candidate;
        }
        return best;
    }

    static String releaseUrl(String version) {
        return isVersion(version) ? "https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/" + TAG_PREFIX + version : null;
    }

    private static boolean hasUploadedApk(JSONObject release, String version) {
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return false;
        String expected = "hrt-tracker-" + version + ".apk";
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset != null && expected.equals(asset.optString("name")) && "uploaded".equals(asset.optString("state")))
                return true;
        }
        return false;
    }

    static boolean isVersion(String version) { return triplet(version) != null; }

    static boolean isNewer(String candidate, String installed) {
        int[] left = triplet(candidate), right = triplet(installed);
        if (left == null || right == null) return false;
        for (int i = 0; i < left.length; i++) {
            if (left[i] != right[i]) return left[i] > right[i];
        }
        return false;
    }

    private static int[] triplet(String version) {
        if (version == null) return null;
        Matcher value = VERSION.matcher(version);
        if (!value.matches()) return null;
        try {
            return new int[] {Integer.parseInt(value.group(1)), Integer.parseInt(value.group(2)), Integer.parseInt(value.group(3))};
        } catch (NumberFormatException oversized) {
            return null;
        }
    }
}
