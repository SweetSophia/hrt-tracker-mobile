package org.askarys.hrttracker.files;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.Collections;
import java.util.concurrent.*;

/** User-selected documents in the bundled native storage app. */
@CapacitorPlugin(name = "HrtNativeDocuments")
public final class HrtNativeDocumentsPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private boolean supported;
    private Pending pending; // Main-thread ownership, retained only until completion/destruction.
    private static final class Pending {
        final PluginCall call;
        byte[] bytes;
        Pending(PluginCall call) { this.call = call; }
    }
    @Override public void load() {
        bridge.getWebView().removeJavascriptInterface("androidBridge");
        supported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && !bridge.getConfig().isUsingLegacyBridge() && bridge.getServerUrl() == null
            && bridge.getAllowedOriginRules().equals(Collections.singleton("https://localhost"));
    }
    private boolean allowed() {
        Uri uri = Uri.parse(bridge.getWebView().getUrl() == null ? "" : bridge.getWebView().getUrl());
        return !destroyed && supported && "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }
    @PluginMethod public void pick(PluginCall call) { begin(call, false); }
    @PluginMethod public void save(PluginCall call) { begin(call, true); }
    private void begin(PluginCall call, boolean save) {
        bridge.executeOnMainThread(() -> {
            if (!allowed() || pending != null) { reject(call, "DOCUMENT_UNAVAILABLE"); return; }
            Pending operation = new Pending(call);
            pending = operation;
            io.execute(() -> {
                try {
                    if (!(call.getData().opt("version") instanceof Integer) || call.getInt("version", 0) != 1) throw new IllegalArgumentException();
                    Intent intent = new Intent(save ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    if (save) {
                        String name = call.getString("name"), type = call.getString("mimeType"), base64 = call.getString("base64");
                        if (name == null || name.isEmpty() || name.length() > 200 || java.util.regex.Pattern.compile("[\\x00-\\x1f/\\\\]").matcher(name).find() || type == null || base64 == null) throw new IllegalArgumentException();
                        // MIME parameters belong to the bytes, not the Android picker filter.
                        type = type.split(";", 2)[0];
                        if (!type.matches("application/(json|pdf)|text/(csv|calendar)")) throw new IllegalArgumentException();
                        if (base64.length() > 4 * ((DocumentIo.MAX_BYTES + 2) / 3)) throw new DocumentIo.TooLarge();
                        byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
                        if (bytes.length > DocumentIo.MAX_BYTES) throw new DocumentIo.TooLarge();
                        if (!Base64.encodeToString(bytes, Base64.NO_WRAP).equals(base64)) throw new IllegalArgumentException();
                        operation.bytes = bytes;
                        // Neither saved calls nor activity state may retain the export payload.
                        call.getData().remove("base64");
                        intent.setType(type);
                        intent.putExtra(Intent.EXTRA_TITLE, name);
                    } else {
                        // Providers sometimes report JSON as text/plain or octet-stream. The shared parser validates it.
                        intent.setType("*/*");
                    }
                    call.getData().remove("name");
                    call.getData().remove("mimeType");
                    bridge.executeOnMainThread(() -> {
                        if (!allowed() || pending != operation) { finish(operation, null, "DOCUMENT_UNAVAILABLE"); return; }
                        try { startActivityForResult(call, intent, "selected"); }
                        catch (Exception unavailable) { finish(operation, null, "DOCUMENT_UNAVAILABLE"); }
                    });
                } catch (DocumentIo.TooLarge large) { finishAsync(operation, null, "DOCUMENT_TOO_LARGE"); }
                catch (Exception unavailable) { finishAsync(operation, null, "DOCUMENT_UNAVAILABLE"); }
            });
        });
    }
    @ActivityCallback private void selected(PluginCall call, ActivityResult result) {
        Pending operation = pending;
        // A recreated process has no payload or live JS promise. Never replay a document operation.
        if (operation == null || operation.call != call) return;
        if (!allowed()) { finish(operation, null, "DOCUMENT_UNAVAILABLE"); return; }
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            finish(operation, new JSObject().put("version", 1).put("outcome", "cancelled"), null); return;
        }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK) { finish(operation, null, "DOCUMENT_UNAVAILABLE"); return; }
        io.execute(() -> {
            byte[] bytes = operation.bytes;
            boolean saving = bytes != null;
            try {
                if (destroyed) throw new IllegalStateException();
                DocumentIo.requireContent(uri);
                JSObject response = new JSObject().put("version", 1);
                if (saving) {
                    // ACTION_CREATE_DOCUMENT may return an existing document. This operation did not create it.
                    DocumentIo.writeAndClose(getContext().getContentResolver().openOutputStream(uri, "wt"), bytes);
                    response.put("outcome", "saved");
                } else {
                    DocumentIo.Picked picked = DocumentIo.read(getContext().getContentResolver(), uri);
                    response.put("outcome", "picked").put("name", picked.name).put("mimeType", picked.mimeType)
                        .put("base64", Base64.encodeToString(picked.bytes, Base64.NO_WRAP));
                }
                finishAsync(operation, response, null);
            } catch (Exception unavailable) {
                // "wt" is not an atomic replace: a provider may truncate or leave partial bytes. Drop the in-memory draft only.
                finishAsync(operation, null, unavailable instanceof DocumentIo.TooLarge ? "DOCUMENT_TOO_LARGE" : "DOCUMENT_UNAVAILABLE");
            }
        });
    }
    private void finishAsync(Pending operation, JSObject response, String error) {
        bridge.executeOnMainThread(() -> finish(operation, response, error));
    }
    private void finish(Pending operation, JSObject response, String error) {
        if (pending != operation) return;
        pending = null;
        operation.bytes = null;
        if (error == null) operation.call.resolve(response); else reject(operation.call, error);
        bridge.releaseCall(operation.call);
    }
    private static void reject(PluginCall call, String code) { call.reject("Document operation failed.", code); }
    @Override protected Bundle saveInstanceState() { return null; }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        if (pending != null) finish(pending, null, "DOCUMENT_UNAVAILABLE");
        io.shutdown();
    }
}
