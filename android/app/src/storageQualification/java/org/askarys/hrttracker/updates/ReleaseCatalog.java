package org.askarys.hrttracker.updates;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Selects the newest stable release that carries its matching APK. */
final class ReleaseCatalog {
    // Read one page at GitHub’s maximum page size. Compare versions within that window.
    static final String RELEASES_URL = "https://api.github.com/repos/SweetSophia/hrt-tracker-mobile/releases?per_page=100";
    private static final String TAG_PREFIX = "android-v";
    private static final String COMPONENT = "(0|[1-9][0-9]{0,9})";
    private static final Pattern VERSION = Pattern.compile(COMPONENT + "\\." + COMPONENT + "\\." + COMPONENT);

    private ReleaseCatalog() {}

    /**
     * Returns the newest matching version, or null for a valid catalog with no match.
     * @throws IOException if the response is missing the GitHub release fields used here
     *     or does not contain one JSON array
     */
    static String selectLatest(String body) throws IOException {
        if (body == null) throw new IOException("Release catalog malformed.");
        JSONArray releases;
        try {
            JSONTokener parser = new JSONTokener(body);
            Object value = parser.nextValue();
            if (!(value instanceof JSONArray) || parser.nextClean() != 0)
                throw new IOException("Release catalog malformed.");
            releases = (JSONArray) value;
        } catch (JSONException malformed) {
            throw new IOException("Release catalog malformed.", malformed);
        }
        String best = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null) throw new IOException("Release catalog row malformed.");
            Object tagField = release.opt("tag_name");
            Object draftField = release.opt("draft");
            Object prereleaseField = release.opt("prerelease");
            JSONArray assets = release.optJSONArray("assets");
            if (!(tagField instanceof String) || !(draftField instanceof Boolean)
                || !(prereleaseField instanceof Boolean) || assets == null)
                throw new IOException("Release catalog row malformed.");
            if ((Boolean) draftField || (Boolean) prereleaseField) continue;
            String tag = (String) tagField;
            if (!tag.startsWith(TAG_PREFIX)) continue;
            String candidate = tag.substring(TAG_PREFIX.length());
            if (!isVersion(candidate) || !hasUploadedApk(assets, candidate)) continue;
            if (best == null || isNewer(candidate, best)) best = candidate;
        }
        return best;
    }

    static String releaseUrl(String version) {
        return isVersion(version) ? "https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/" + TAG_PREFIX + version : null;
    }

    private static boolean hasUploadedApk(JSONArray assets, String version) {
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
