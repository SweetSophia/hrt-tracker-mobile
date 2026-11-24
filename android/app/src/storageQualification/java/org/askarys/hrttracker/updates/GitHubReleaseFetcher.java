package org.askarys.hrttracker.updates;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Authenticator;
import okhttp3.CookieJar;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** One bounded GET using a client isolated from Capacitor's process-wide cookie handler. */
final class GitHubReleaseFetcher implements ReleaseUpdateEngine.ReleaseFetcher {
    static final int MAX_BYTES = 10 * 1024 * 1024;
    // Initialize TLS and the HTTP client only when a check actually runs.
    private static final class Connection {
        private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .authenticator(Authenticator.NONE)
            .proxyAuthenticator(Authenticator.NONE)
            // Restrict metadata requests to the configured GitHub endpoint.
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

    @Override public String fetchLatest() throws IOException {
        try (Response response = Connection.CLIENT.newCall(Connection.RELEASES).execute()) {
            ResponseBody body = response.body();
            if (response.code() != 200 || body == null) throw new IOException("Release catalog unavailable.");
            return readCatalog(body.byteStream());
        }
    }

    static String readCatalog(InputStream input) throws IOException {
        InputStream bounded = new CatalogInputStream(input);
        return ReleaseCatalog.selectLatest(new InputStreamReader(bounded, StandardCharsets.UTF_8.newDecoder()));
    }

    static final class CatalogTooLargeException extends IOException {
        CatalogTooLargeException() { super("Release catalog exceeds the size limit."); }
    }

    private static final class CatalogInputStream extends FilterInputStream {
        private int remaining = MAX_BYTES;

        CatalogInputStream(InputStream input) { super(input); }

        @Override public int read() throws IOException {
            int value = super.read();
            if (value >= 0) count(1);
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            // Probe for EOF at the limit so an exact-sized response stays valid.
            int read = super.read(buffer, offset, Math.min(length, remaining + 1));
            if (read > 0) count(read);
            return read;
        }

        private void count(int read) throws CatalogTooLargeException {
            if (read > remaining) throw new CatalogTooLargeException();
            remaining -= read;
        }
    }
}
