package org.askarys.hrttracker.updates;

import android.util.JsonReader;
import android.util.JsonToken;
import java.io.IOException;
import java.io.Reader;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Selects the newest stable release that carries its matching APK. */
final class ReleaseCatalog {
    // Read one page at GitHub's maximum page size. Compare versions within that window.
    static final String RELEASES_URL = "https://api.github.com/repos/SweetSophia/hrt-tracker-mobile/releases?per_page=100";
    private static final String TAG_PREFIX = "android-v";
    private static final String APK_PREFIX = "hrt-tracker-";
    private static final String APK_SUFFIX = ".apk";
    private static final String COMPONENT = "(0|[1-9][0-9]{0,9})";
    private static final Pattern VERSION = Pattern.compile(COMPONENT + "\\." + COMPONENT + "\\." + COMPONENT);

    private ReleaseCatalog() {}

    /** Reads and closes a JSON catalog. Returns null when no usable Android release is listed. */
    static String selectLatest(Reader body) throws IOException {
        try (JsonReader json = new JsonReader(body)) {
            if (json.peek() != JsonToken.BEGIN_ARRAY) throw new IOException("Release catalog malformed.");
            String best = null;
            json.beginArray();
            while (json.hasNext()) {
                String candidate = readRelease(json);
                if (candidate != null && (best == null || isNewer(candidate, best))) best = candidate;
            }
            json.endArray();
            if (json.peek() != JsonToken.END_DOCUMENT) throw new IOException("Release catalog malformed.");
            return best;
        }
    }

    static String releaseUrl(String version) {
        return isVersion(version) ? "https://github.com/SweetSophia/hrt-tracker-mobile/releases/tag/" + TAG_PREFIX + version : null;
    }

    private static String readRelease(JsonReader json) throws IOException {
        if (json.peek() != JsonToken.BEGIN_OBJECT) {
            json.skipValue();
            return null;
        }
        String tag = null;
        boolean published = false;
        boolean stable = false;
        Set<String> uploadedVersions = Collections.emptySet();
        json.beginObject();
        while (json.hasNext()) {
            switch (json.nextName()) {
                case "tag_name": tag = readString(json); break;
                case "draft": published = readFalseFlag(json); break;
                case "prerelease": stable = readFalseFlag(json); break;
                case "assets": uploadedVersions = readUploadedVersions(json); break;
                default: json.skipValue();
            }
        }
        json.endObject();
        if (!published || !stable || tag == null || !tag.startsWith(TAG_PREFIX)) return null;
        String version = tag.substring(TAG_PREFIX.length());
        return uploadedVersions.contains(version) ? version : null;
    }

    private static Set<String> readUploadedVersions(JsonReader json) throws IOException {
        if (json.peek() != JsonToken.BEGIN_ARRAY) {
            json.skipValue();
            return Collections.emptySet();
        }
        Set<String> versions = new HashSet<>();
        json.beginArray();
        while (json.hasNext()) {
            if (json.peek() != JsonToken.BEGIN_OBJECT) {
                json.skipValue();
                continue;
            }
            String name = null;
            String state = null;
            json.beginObject();
            while (json.hasNext()) {
                switch (json.nextName()) {
                    case "name": name = readString(json); break;
                    case "state": state = readString(json); break;
                    default: json.skipValue();
                }
            }
            json.endObject();
            if (!"uploaded".equals(state) || name == null || !name.startsWith(APK_PREFIX) || !name.endsWith(APK_SUFFIX))
                continue;
            String version = name.substring(APK_PREFIX.length(), name.length() - APK_SUFFIX.length());
            if (isVersion(version)) versions.add(version);
        }
        json.endArray();
        return versions;
    }

    private static String readString(JsonReader json) throws IOException {
        if (json.peek() == JsonToken.STRING) return json.nextString();
        json.skipValue();
        return null;
    }

    private static boolean readFalseFlag(JsonReader json) throws IOException {
        if (json.peek() == JsonToken.BOOLEAN) return !json.nextBoolean();
        json.skipValue();
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
