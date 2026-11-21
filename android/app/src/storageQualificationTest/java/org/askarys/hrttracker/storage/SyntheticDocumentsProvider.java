package org.askarys.hrttracker.storage;

import android.database.*;
import android.os.*;
import android.provider.DocumentsContract.Document;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.net.Uri;
import java.io.*;

/** Isolated synthetic provider in the TEST APK. IDs select failure modes, never arbitrary paths. */
public final class SyntheticDocumentsProvider extends ContentProvider {
    static final String AUTHORITY = "org.askarys.hrttracker.synthetic.documents";
    private static final byte[] EXISTING = new byte[] {9, 8, 7, 6};
    private File output() { return new File(getContext().getCacheDir(), "synthetic-output"); }
    private File kept() { return new File(getContext().getCacheDir(), "synthetic-existing"); }
    private File partial() { return new File(getContext().getCacheDir(), "synthetic-partial"); }
    private File body() { return new File(getContext().getCacheDir(), "synthetic-body"); }
    private File fileFor(String id) {
        if ("failopen".equals(id)) return kept();
        if ("partial".equals(id)) return partial();
        if ("failbody".equals(id)) return body();
        return output();
    }
    private static void writeBytes(File file, byte[] bytes) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); }
    }
    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        String id = uri.getLastPathSegment();
        MatrixCursor result = new MatrixCursor(new String[]{Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_SIZE, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS});
        Long size = 3L;
        if (id.equals("large")) size = 16777217L;
        else if (id.equals("unknown")) size = null;
        else if (id.equals("deleted")) size = output().exists() ? 1L : 0L;
        result.addRow(new Object[]{id, "synthetic.json", size, "application/json", Document.FLAG_SUPPORTS_WRITE | Document.FLAG_SUPPORTS_DELETE});
        return result;
    }
    @Override public String getType(Uri uri) { return "application/json"; }
    @Override public Bundle call(String method, String arg, Bundle extras) {
        if ("android:deleteDocument".equals(method)) {
            Object value = extras == null ? null : extras.get("uri");
            Uri target = value instanceof Uri ? (Uri) value : null;
            fileFor(target == null ? null : target.getLastPathSegment()).delete();
            return Bundle.EMPTY;
        }
        if ("android:seed".equals(method)) {
            try {
                writeBytes(kept(), EXISTING);
                writeBytes(body(), EXISTING);
                writeBytes(output(), EXISTING);
            } catch (IOException failure) { throw new IllegalStateException(failure); }
            partial().delete();
            return Bundle.EMPTY;
        }
        throw new UnsupportedOperationException();
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String id = uri.getLastPathSegment();
        if (id.equals("denied")) throw new FileNotFoundException("Synthetic denied");
        if (mode.contains("w")) {
            try {
                if ("failopen".equals(id)) throw new FileNotFoundException("Synthetic open failure");
                if ("partial".equals(id)) {
                    writeBytes(partial(), new byte[] {0x51});
                    throw new FileNotFoundException("Synthetic partial open");
                }
                if ("failbody".equals(id)) return ParcelFileDescriptor.open(body(), ParcelFileDescriptor.MODE_READ_ONLY);
                new FileOutputStream(output()).close();
                if (id.equals("failwrite")) throw new FileNotFoundException("Synthetic write failure");
                return ParcelFileDescriptor.open(output(), ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE);
            } catch (IOException failure) { throw new FileNotFoundException("Synthetic write failure"); }
        }
        if (id.equals("write")) return ParcelFileDescriptor.open(output(), ParcelFileDescriptor.MODE_READ_ONLY);
        if (id.equals("failopen")) return ParcelFileDescriptor.open(kept(), ParcelFileDescriptor.MODE_READ_ONLY);
        if (id.equals("partial")) return ParcelFileDescriptor.open(partial(), ParcelFileDescriptor.MODE_READ_ONLY);
        if (id.equals("failbody")) return ParcelFileDescriptor.open(body(), ParcelFileDescriptor.MODE_READ_ONLY);
        if (id.equals("large")) throw new AssertionError("Declared oversize must not be opened");
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            new Thread(() -> {
                try (OutputStream stream = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    if (id.equals("unknown") || id.equals("lying")) {
                        byte[] chunk = new byte[8192];
                        for (int i = 0; i < 2049; i++) stream.write(chunk);
                    } else stream.write(new byte[]{0, (byte)255, (byte)128});
                } catch (IOException expectedWhenReaderRejectsOversize) { /* Synthetic pipe closes. */ }
            }).start();
            return pipe[0];
        } catch (IOException failure) { throw new FileNotFoundException("Synthetic unavailable"); }
    }
}
