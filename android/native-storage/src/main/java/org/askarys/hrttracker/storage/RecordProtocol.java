package org.askarys.hrttracker.storage;

import java.util.*;
import org.json.JSONArray;
import org.json.JSONTokener;

/** Wire-independent equivalent of src/platform/contracts.ts and src/records/scope.ts. */
public final class RecordProtocol {
    public static final long MAX_REVISION = 9007199254740991L;
    /** Device-local namespace mirroring DEVICE_PREFERENCES_NAMESPACE; only the HRT mode selection. */
    static final String DEVICE_PREFERENCES = "device-preferences:v1";
    private static final Set<String> DEVICE_MODES = new HashSet<>(Arrays.asList("transfem", "transmasc"));
    public static final class Snapshot {
        public final long revision;
        public final Map<String, String> entries;
        public Snapshot(long revision, Map<String, String> entries) {
            this.revision = revision;
            this.entries = Collections.unmodifiableMap(new LinkedHashMap<>(entries));
        }
    }
    public static final class Change {
        public final String namespace;
        public final long expectedRevision;
        public final Map<String, String> puts;
        public final List<String> removes;
        public Change(String namespace, long expectedRevision, Map<String, String> puts, List<String> removes) {
            this.namespace = namespace;
            this.expectedRevision = expectedRevision;
            this.puts = Collections.unmodifiableMap(new LinkedHashMap<>(puts));
            this.removes = Collections.unmodifiableList(new ArrayList<>(removes));
        }
    }
    public static final class StaleRevisionException extends Exception {
        public StaleRevisionException() { super("Records changed; refresh and review the operation again."); }
    }
    static Set<String> allowedKeys(String namespace, String backend) throws Exception {
        if ("preferences:v1".equals(namespace)) return new HashSet<>(Arrays.asList(
            "app-theme", "app-palette", "hrt-lang", "app-show-prediction", "app-hide-site-label",
            "hrt-supply-lead-days"));
        if (DEVICE_PREFERENCES.equals(namespace)) return new HashSet<>(Arrays.asList("hrt-mode"));
        if (namespace == null || !namespace.startsWith("records:v1:")) throw new IllegalArgumentException("Invalid record namespace");
        JSONArray parts = new JSONArray(namespace.substring("records:v1:".length()));
        if (parts.length() != 2 || !(parts.get(0) instanceof String) || !(parts.get(1) instanceof String)) {
            throw new IllegalArgumentException("Invalid record namespace");
        }
        String origin = parts.getString(0), owner = parts.getString(1);
        if (!backend.equals(origin) || owner.isEmpty() || !namespace.equals("records:v1:[" + quote(origin) + "," + quote(owner) + "]")) {
            throw new IllegalArgumentException("Foreign or noncanonical record namespace");
        }
        String prefix = owner.equals("local") ? "hrt-" : "hrt-u" + owner + "-";
        Set<String> keys = new HashSet<>();
        for (String suffix : Arrays.asList("weight", "weight-at", "birth-year", "birth-year-at", "pk-params", "pk-params-at",
                "cal-method", "cal-history-mode", "age-beta", "model-settings-at", "cpa-plan")) keys.add(prefix + suffix);
        for (String mode : Arrays.asList("", "masc-")) {
            for (String suffix : Arrays.asList("events", "lab-results", "dose-templates", "deletions", "quick-doses", "supplies", "plan", "plan-at")) {
                keys.add(prefix + mode + suffix);
            }
        }
        return keys;
    }

    static void revision(long revision) {
        if (revision < 0 || revision > MAX_REVISION) throw new IllegalArgumentException("Invalid store revision");
    }

    /** Package-visible read-path check for stored device mode values. */
    static boolean isDeviceMode(String value) {
        return DEVICE_MODES.contains(value);
    }

    static void validate(Change change, String backend) throws Exception {
        revision(change.expectedRevision);
        Set<String> keys = allowedKeys(change.namespace, backend);
        Set<String> seen = new HashSet<>();
        for (Map.Entry<String, String> entry : change.puts.entrySet()) {
            if (!keys.contains(entry.getKey()) || entry.getValue() == null) throw new IllegalArgumentException("Invalid record entry");
            if (DEVICE_PREFERENCES.equals(change.namespace) && !DEVICE_MODES.contains(entry.getValue()))
                throw new IllegalArgumentException("Invalid record entry");
            seen.add(entry.getKey());
        }
        for (String key : change.removes) {
            if (!keys.contains(key) || !seen.add(key)) throw new IllegalArgumentException("Invalid or duplicate record removal");
        }
    }

    /** JSON.stringify string escaping, including lone UTF-16 surrogates; Android's JSON writer escapes '/'. */
    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (Character.isHighSurrogate(c) && i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) {
                        out.append(c).append(value.charAt(++i));
                    } else if (c < 32 || Character.isSurrogate(c)) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    static String unquote(String encoded) throws Exception {
        if (encoded == null) throw new IllegalArgumentException("Invalid stored record");
        Object value = new JSONTokener(encoded).nextValue();
        if (!(value instanceof String) || !quote((String) value).equals(encoded)) throw new IllegalArgumentException("Invalid stored record");
        return (String) value;
    }
}
