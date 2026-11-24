package org.askarys.hrttracker.updates;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import okhttp3.Authenticator;
import okhttp3.CookieJar;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** One bounded GET using a client isolated from Capacitor's process-wide cookie handler. */
final class GitHubReleaseFetcher implements ReleaseUpdateEngine.ReleaseFetcher {
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    // Initialize TLS and the HTTP client only when a check actually runs.
    private static final class Connection {
        private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .authenticator(Authenticator.NONE)
            .proxyAuthenticator(Authenticator.NONE)
            .followRedirects(false)
            .retryOnConnectionFailure(false)
            .callTimeout(15, TimeUnit.SECONDS)
            .build();
        private static final Request RELEASES = new Request.Builder()
            .url(ReleaseCatalog.RELEASES_URL)
            .header("User-Agent", "hrt-tracker-mobile-android")
            .header("Accept", "application/vnd.github+json")
            .build();
    }

    @Override public String fetch() throws IOException {
        try (Response response = Connection.CLIENT.newCall(Connection.RELEASES).execute()) {
            ResponseBody body = response.body();
            if (response.code() != 200 || body == null) throw new IOException("Release catalog unavailable.");
            return readBounded(body.byteStream());
        }
    }

    private static String readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int count;
        while ((count = input.read(chunk)) != -1) {
            if (output.size() + count > MAX_BYTES) throw new IOException("Release catalog exceeds the size limit.");
            output.write(chunk, 0, count);
        }
        return output.toString("UTF-8");
    }
}
