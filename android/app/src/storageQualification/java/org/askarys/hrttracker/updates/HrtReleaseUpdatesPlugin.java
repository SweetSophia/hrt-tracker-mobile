package org.askarys.hrttracker.updates;

import android.os.Bundle;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/**
 * Release-update checks for the bundled Android release. Methods only
 * run from explicit calls; nothing fetches on lifecycle events by itself.
 */
@CapacitorPlugin(name = "HrtReleaseUpdates")
public final class HrtReleaseUpdatesPlugin extends Plugin {
    private static final String PREFS = "hrt_release_updates";
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private boolean supported;
    private ReleaseUpdateEngine engine;

    @Override public void load() {
        bridge.getWebView().removeJavascriptInterface("androidBridge");
        supported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && !bridge.getConfig().isUsingLegacyBridge() && bridge.getServerUrl() == null
            && bridge.getAllowedOriginRules().equals(Collections.singleton("https://localhost"));
        engine = new ReleaseUpdateEngine(new AndroidReleasePreferences(getContext(), PREFS),
            System::currentTimeMillis, new GitHubReleaseFetcher(), installedVersion(getContext()));
    }

    private boolean allowed() {
        Uri uri = Uri.parse(bridge.getWebView().getUrl() == null ? "" : bridge.getWebView().getUrl());
        return !destroyed && supported && "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    @PluginMethod public void getState(PluginCall call) {
        onIo(call, () -> call.resolve(stateJson(engine.state())));
    }

    @PluginMethod public void setAutomatic(PluginCall call) {
        Object raw = call.getData().opt("enabled");
        if (!(raw instanceof Boolean)) { reject(call, "UPDATE_PREFERENCES_UNAVAILABLE"); return; }
        boolean enabled = (Boolean) raw;
        onIo(call, () -> {
            if (engine.setAutomatic(enabled)) call.resolve(stateJson(engine.state()));
            else reject(call, "UPDATE_PREFERENCES_UNAVAILABLE");
        });
    }

    @PluginMethod public void checkNow(PluginCall call) { check(call, false); }

    @PluginMethod public void checkOnOpen(PluginCall call) { check(call, true); }

    @PluginMethod public void dismiss(PluginCall call) {
        String version = call.getString("version");
        onIo(call, () -> {
            if (engine.dismiss(version)) call.resolve(stateJson(engine.state()));
            else reject(call, "UPDATE_NOTICE_UNAVAILABLE");
        });
    }

    @PluginMethod public void openRelease(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            String version = call.getString("version");
            String url = !allowed() || !bridge.getApp().isActive() || !engine.canOpen(version) ? null : ReleaseCatalog.releaseUrl(version);
            if (url == null) { reject(call, "RELEASE_PAGE_UNAVAILABLE"); return; }
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception unavailable) { reject(call, "RELEASE_PAGE_UNAVAILABLE"); }
        });
    }

    private void check(PluginCall call, boolean automatic) {
        onIo(call, automatic, () -> {
            try {
                call.resolve(stateJson(automatic ? engine.checkOnOpen() : engine.checkNow()));
            } catch (IOException unavailable) {
                reject(call, "UPDATE_CHECK_UNAVAILABLE");
            }
        });
    }

    private void onIo(PluginCall call, Runnable work) { onIo(call, false, work); }

    private void onIo(PluginCall call, boolean foregroundOnly, Runnable work) {
        bridge.executeOnMainThread(() -> {
            if (!allowed() || (foregroundOnly && !bridge.getApp().isActive())) {
                reject(call, "UPDATE_CHECK_UNAVAILABLE");
                return;
            }
            try {
                io.execute(() -> {
                    try {
                        if (!destroyed) work.run();
                        else reject(call, "UPDATE_CHECK_UNAVAILABLE");
                    } catch (RuntimeException unavailable) {
                        reject(call, "UPDATE_CHECK_UNAVAILABLE");
                    }
                });
            } catch (RejectedExecutionException closed) {
                reject(call, "UPDATE_CHECK_UNAVAILABLE");
            }
        });
    }

    static JSObject stateJson(ReleaseUpdateState state) {
        JSObject json = new JSObject();
        json.put("installedVersion", state.installedVersion);
        json.put("automatic", state.automatic);
        json.put("availableVersion", state.availableVersion == null ? JSONObject.NULL : state.availableVersion);
        json.put("dismissedVersion", state.dismissedVersion == null ? JSONObject.NULL : state.dismissedVersion);
        return json;
    }

    private static void reject(PluginCall call, String code) { call.reject("Release update request failed.", code); }

    private static String installedVersion(Context context) {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return name == null ? "—" : name;
        } catch (Exception unavailable) { return "—"; }
    }

    @Override protected Bundle saveInstanceState() { return null; }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        io.shutdown();
    }
}
