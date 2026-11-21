package org.askarys.hrttracker.storage;

import java.util.*;
import org.json.*;
import org.askarys.hrttracker.storage.RecordProtocol.Change;
import org.askarys.hrttracker.storage.RecordProtocol.Snapshot;

/** Versioned transport codec; never coerce JavaScript values to strings or integers. */
final class StorageBridgeProtocol {
    static final String BACKEND = "offline";
    static final String STORE_ID = "primary-v1";

    private static void fields(JSONObject value, String... names) {
        Set<String> expected = new HashSet<>(Arrays.asList(names));
        if (value.length() != expected.size()) throw new IllegalArgumentException();
        for (Iterator<String> it = value.keys(); it.hasNext();) {
            if (!expected.remove(it.next())) throw new IllegalArgumentException();
        }
        if (!expected.isEmpty()) throw new IllegalArgumentException();
    }

    private static String string(JSONObject value, String key) throws JSONException {
        Object raw = value.get(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException();
        return (String) raw;
    }

    private static long revision(Object raw) {
        if (!(raw instanceof Number)) throw new IllegalArgumentException();
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value < 0 || value > RecordProtocol.MAX_REVISION || value != Math.rint(value)) {
            throw new IllegalArgumentException();
        }
        return ((Number) raw).longValue();
    }

    static String execute(JSONObject request, EncryptedRecordStore records, NativeSecretStore secrets) throws Exception {
        fields(request, "version", "operation", "payload");
        if (revision(request.get("version")) != 1) throw new IllegalArgumentException();
        String operation = string(request, "operation");
        JSONTokener tokens = new JSONTokener(string(request, "payload"));
        Object decoded = tokens.nextValue();
        if (!(decoded instanceof JSONObject) || tokens.nextClean() != 0) throw new IllegalArgumentException();
        JSONObject payload = (JSONObject) decoded;
        switch (operation) {
            case "initialize":
                fields(payload);
                records.initialize();
                return "{\"backend\":\"offline\"}";
            case "read":
                fields(payload, "namespace");
                return snapshot(records.read(string(payload, "namespace")));
            case "commit":
                fields(payload, "changes");
                Object raw = payload.get("changes");
                if (!(raw instanceof JSONArray)) throw new IllegalArgumentException();
                JSONArray array = (JSONArray) raw;
                List<Change> changes = new ArrayList<>();
                for (int i = 0; i < array.length(); i++) {
                    Object item = array.get(i);
                    if (!(item instanceof JSONObject)) throw new IllegalArgumentException();
                    JSONObject change = (JSONObject) item;
                    fields(change, "namespace", "expectedRevision", "puts", "removes");
                    if (!(change.get("puts") instanceof JSONObject) || !(change.get("removes") instanceof JSONArray)) {
                        throw new IllegalArgumentException();
                    }
                    JSONObject puts = (JSONObject) change.get("puts");
                    Map<String, String> entries = new LinkedHashMap<>();
                    for (Iterator<String> it = puts.keys(); it.hasNext();) {
                        String key = it.next();
                        entries.put(key, string(puts, key));
                    }
                    JSONArray removes = (JSONArray) change.get("removes");
                    List<String> removed = new ArrayList<>();
                    for (int j = 0; j < removes.length(); j++) {
                        if (!(removes.get(j) instanceof String)) throw new IllegalArgumentException();
                        removed.add((String) removes.get(j));
                    }
                    changes.add(new Change(string(change, "namespace"), revision(change.get("expectedRevision")), entries, removed));
                }
                return snapshots(records.commit(changes));
            case "getSecret":
                fields(payload, "key");
                String value = secrets.get(string(payload, "key"));
                return "{\"value\":" + (value == null ? "null" : RecordProtocol.quote(value)) + "}";
            case "setSecret":
                fields(payload, "key", "value");
                secrets.set(string(payload, "key"), string(payload, "value"));
                return "{}";
            case "removeSecret":
                fields(payload, "key");
                secrets.remove(string(payload, "key"));
                return "{}";
            default: throw new IllegalArgumentException();
        }
    }

    private static String snapshot(Snapshot value) {
        StringBuilder out = new StringBuilder("{\"revision\":").append(value.revision).append(",\"entries\":{");
        boolean separator = false;
        for (Map.Entry<String, String> entry : value.entries.entrySet()) {
            if (separator) out.append(',');
            separator = true;
            out.append(RecordProtocol.quote(entry.getKey())).append(':').append(RecordProtocol.quote(entry.getValue()));
        }
        return out.append("}}").toString();
    }

    private static String snapshots(Map<String, Snapshot> values) {
        StringBuilder out = new StringBuilder("{");
        boolean separator = false;
        for (Map.Entry<String, Snapshot> entry : values.entrySet()) {
            if (separator) out.append(',');
            separator = true;
            out.append(RecordProtocol.quote(entry.getKey())).append(':').append(snapshot(entry.getValue()));
        }
        return out.append('}').toString();
    }
}
