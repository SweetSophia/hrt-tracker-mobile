package org.askarys.hrttracker.network;

import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import org.askarys.hrttracker.spike.MainActivity;

public final class RecordingActivity extends MainActivity {
    @Override protected void load() {
        // BridgeActivity has inflated the WebView, but Bridge construction/loadUrl has not run.
        // AndroidX runs this script before page JavaScript, for subsequent matching navigations.
        WebView webView=findViewById(com.getcapacitor.android.R.id.webview);
        if (webView==null || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            throw new IllegalStateException("Document-start observation unavailable");
        try (InputStream input=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("startup-observer.js");
             ByteArrayOutputStream output=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[8192]; int count;
            while((count=input.read(buffer))!=-1) output.write(buffer,0,count);
            WebViewCompat.addDocumentStartJavaScript(webView,output.toString(StandardCharsets.UTF_8.name()),Collections.singleton("https://localhost"));
        } catch (java.io.IOException error) { throw new IllegalStateException("Missing startup observer",error); }
        super.load();
    }
}
