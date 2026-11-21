package org.askarys.hrttracker.files;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.*;

/** Stream boundary only; never interprets backups or exposes provider paths. */
public final class DocumentIo {
    public static final int MAX_BYTES = 16 * 1024 * 1024;
    public static final class TooLarge extends IOException {}
    public static final class Picked {
        public final String name, mimeType;
        public final byte[] bytes;
        Picked(String name, String mimeType, byte[] bytes) { this.name = name; this.mimeType = mimeType; this.bytes = bytes; }
    }
    public static void requireContent(Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) throw new IOException("Invalid document URI");
    }
    public static Picked read(ContentResolver resolver, Uri uri) throws IOException {
        requireContent(uri);
        String name = "backup.json";
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int size = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (size >= 0 && !cursor.isNull(size) && cursor.getLong(size) > MAX_BYTES) throw new TooLarge();
                int display = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (display >= 0 && !cursor.isNull(display)) {
                    String value = cursor.getString(display);
                    if (value != null && !value.isEmpty()) name = value.substring(0, Math.min(value.length(), 255));
                }
            }
        }
        String type = resolver.getType(uri);
        if (type == null || type.length() > 255) type = "application/octet-stream";
        return new Picked(name, type, readBounded(resolver.openInputStream(uri)));
    }
    public static byte[] readBounded(InputStream stream) throws IOException {
        if (stream == null) throw new IOException("Document unavailable");
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            int count;
            while ((count = input.read(chunk)) != -1) {
                if (count > MAX_BYTES - output.size()) throw new TooLarge();
                output.write(chunk, 0, count);
            }
            return output.toByteArray();
        }
    }
    public static void writeAndClose(OutputStream stream, byte[] bytes) throws IOException {
        if (stream == null) throw new IOException("Document unavailable");
        try (OutputStream output = stream) { output.write(bytes); output.flush(); }
    }
    private DocumentIo() {}
}
