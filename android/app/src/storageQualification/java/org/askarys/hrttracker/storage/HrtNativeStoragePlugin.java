package org.askarys.hrttracker.storage;

import android.net.Uri;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.concurrent.*;
import org.json.JSONException;
import org.json.JSONObject;

/** Qualified bundled Android UI only. No file, alias, backend, or reset API. */
@CapacitorPlugin(name = "HrtNativeStorage")
public final class HrtNativeStoragePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private EncryptedRecordStore records;
    private NativeSecretStore secrets;
    private boolean supported;
    private volatile boolean destroyed;

    @Override public void load() {
        // Capacitor 8.6 creates MessageHandler before registering plugins, and loads
        // its first page afterwards. Remove its addJavascriptInterface fallback
        // now, before navigation. This does not remove WebMessageListener.
        bridge.getWebView().removeJavascriptInterface("androidBridge");
        supported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && !bridge.getConfig().isUsingLegacyBridge()
            && bridge.getServerUrl() == null
            && bridge.getAllowedOriginRules().equals(Collections.singleton("https://localhost"));
        records = new EncryptedRecordStore(getContext(), StorageBridgeProtocol.STORE_ID, StorageBridgeProtocol.BACKEND);
        secrets = new NativeSecretStore(getContext(), StorageBridgeProtocol.STORE_ID);
    }

    static boolean bundledUrl(String url) {
        if (url == null) return false;
        Uri value = Uri.parse(url);
        return "https".equals(value.getScheme()) && "localhost".equals(value.getHost())
            && value.getPort() == -1 && value.getUserInfo() == null;
    }

    @PluginMethod public void execute(PluginCall call) {
        // WebMessageListener enforces origin and main-frame before this method.
        // Check the current page too, on the WebView thread, before scheduling IO.
        bridge.executeOnMainThread(() -> {
            if (destroyed || !supported || !bundledUrl(bridge.getWebView().getUrl())) {
                call.reject("Native storage host unavailable.", "UNSUPPORTED_STORAGE_HOST");
                return;
            }
            // Capacitor supplies a separately parsed options object for each call.
            // Decode its (potentially large) payload on IO, not the WebView thread.
            final JSONObject request = call.getData();
            try {
                io.execute(() -> {
                    if (destroyed) {
                        call.reject("Native storage unavailable.", "STORAGE_UNAVAILABLE");
                        return;
                    }
                    try {
                        String payload = StorageBridgeProtocol.execute(request, records, secrets);
                        call.resolve(new JSObject().put("version", 1).put("payload", payload));
                    } catch (RecordProtocol.StaleRevisionException stale) {
                        call.reject("Records changed; refresh before trying again.", "STALE_REVISION");
                    } catch (IllegalArgumentException | JSONException invalid) {
                        call.reject("Invalid storage request.", "INVALID_STORAGE_REQUEST");
                    } catch (Exception | LinkageError unavailable) {
                        // No Throwable argument: Capacitor must not log plaintext or paths.
                        call.reject("Native storage unavailable; existing data preserved.", "STORAGE_UNAVAILABLE");
                    }
                });
            } catch (RejectedExecutionException closed) {
                call.reject("Native storage unavailable.", "STORAGE_UNAVAILABLE");
            }
        });
    }

    @Override protected void handleOnDestroy() {
        if (destroyed) return;
        destroyed = true;
        // Already running operations finish before close; queued work is rejected.
        io.execute(() -> {
            try { records.close(); } catch (Exception ignored) { /* Never log stored data. */ }
        });
        io.shutdown();
    }
}
