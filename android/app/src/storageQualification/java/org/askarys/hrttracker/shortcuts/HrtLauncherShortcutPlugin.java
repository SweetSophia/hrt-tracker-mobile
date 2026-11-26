package org.askarys.hrttracker.shortcuts;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.regex.Pattern;
import org.askarys.hrttracker.spike.MainActivity;
import org.askarys.hrttracker.spike.R;

/**
 * Publication-only launcher shortcut for the Add dose action. The web app owns
 * the timing; this plugin verifies the bundled WebView origin and upserts the
 * one stable shortcut. Publication failures stay independent from app startup.
 */
@CapacitorPlugin(name = "HrtLauncherShortcut")
public final class HrtLauncherShortcutPlugin extends Plugin {
    /** Stable shortcut identity the web side relies on; never rename these. */
    static final String ADD_DOSE_ID = "add-dose";
    static final String ADD_DOSE_URI = "hrttracker://add-dose";
    private static final int MAX_LABEL_LENGTH = 100;
    private static final Pattern LABEL_CONTROL_CHARACTERS = Pattern.compile("[\\x00-\\x1f]");
    private volatile boolean destroyed;
    private boolean supported;

    @Override public void load() {
        // Same bundled-build rule as the storage and update plugins. A failure
        // here only disables publication; it must not fail app startup.
        try {
            supported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                && !bridge.getConfig().isUsingLegacyBridge() && bridge.getServerUrl() == null
                && bridge.getAllowedOriginRules().equals(Collections.singleton("https://localhost"));
        } catch (RuntimeException unavailable) { supported = false; }
    }

    @PluginMethod public void publishAddDose(PluginCall call) {
        // ShortcutManager needs API 25. Older systems have no launcher shortcut
        // API; resolve before touching the bridge or any platform class.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) { call.resolve(); return; }
        String label = call.getString("label");
        if (!validLabel(label)) { reject(call); return; }
        bridge.executeOnMainThread(() -> {
            // WebView state may only be read on the main thread.
            if (destroyed || !allowed()) { reject(call); return; }
            // addDynamicShortcuts is a binder round trip; run it on the bridge
            // worker thread so the UI stays responsive.
            bridge.execute(() -> publish(call, label));
        });
    }

    private static boolean validLabel(String label) {
        return label != null && !label.trim().isEmpty()
            && label.length() <= MAX_LABEL_LENGTH
            && !LABEL_CONTROL_CHARACTERS.matcher(label).find();
    }

    /** Same trusted bundled https://localhost origin rule as the other native plugins. */
    private boolean allowed() {
        if (destroyed || !supported) return false;
        String url = bridge.getWebView().getUrl();
        Uri uri = Uri.parse(url == null ? "" : url);
        return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private void publish(PluginCall call, String label) {
        try {
            // Lint analyzes this method in isolation, so repeat the OS guard.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) { call.resolve(); return; }
            if (destroyed) { reject(call); return; }
            Context context = getContext();
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) { reject(call); return; }
            // Explicit to the installed variant's MainActivity so every
            // application ID resolves the same action. No task-clearing flags:
            // a warm launch must reuse the current task and its draft.
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(ADD_DOSE_URI));
            intent.setClassName(context, MainActivity.class.getName());
            ShortcutInfo shortcut = new ShortcutInfo.Builder(context, ADD_DOSE_ID)
                .setShortLabel(label).setLongLabel(label)
                .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                .setIntents(new Intent[]{intent})
                .build();
            // addDynamicShortcuts updates a shortcut with the same ID in place.
            if (manager.addDynamicShortcuts(Collections.singletonList(shortcut))) call.resolve();
            else reject(call); // Usually the launcher's publication rate limit.
        } catch (RuntimeException unavailable) { reject(call); }
    }

    private static void reject(PluginCall call) {
        call.reject("Launcher shortcut publication failed.", "SHORTCUT_UNAVAILABLE");
    }

    @Override protected Bundle saveInstanceState() { return null; }

    @Override protected void handleOnDestroy() { destroyed = true; }
}
