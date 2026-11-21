package org.askarys.hrttracker.storage;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** Acknowledges replacement/removal only after the containing directory is synced. */
final class DurableFiles {
    private DurableFiles() {}

    static void directory(File dir) throws Exception {
        if (!dir.isDirectory()) {
            File parent = dir.getParentFile();
            if (parent == null) throw new IOException("Missing storage parent");
            directory(parent);
            if (!dir.mkdir() && !dir.isDirectory()) throw new IOException("Cannot create storage directory");
            syncDirectory(parent);
        }
        // Also sync an earlier mkdir whose parent sync may have failed.
        if (dir.getParentFile() != null) syncDirectory(dir.getParentFile());
    }

    static void syncDirectory(File dir) throws Exception {
        FileDescriptor fd = Os.open(dir.getAbsolutePath(), OsConstants.O_RDONLY, 0);
        try { Os.fsync(fd); } finally { Os.close(fd); }
    }

    static byte[] read(File file, int maximum) throws IOException {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() > maximum - count) throw new IOException("Storage envelope too large");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    static void replace(File file, byte[] value) throws Exception {
        File temp = File.createTempFile(".pending-", ".sealed", file.getParentFile());
        try {
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(value);
                out.getFD().sync();
            }
            Os.rename(temp.getAbsolutePath(), file.getAbsolutePath());
            syncDirectory(file.getParentFile());
        } finally {
            // Orphan encrypted temporary files are safe; never mask a failed durable write.
            if (temp.exists()) temp.delete();
        }
    }

    static void remove(File file) throws Exception {
        if (file.exists() && (!file.isFile() || !file.delete())) throw new IOException("Cannot remove secret");
        // A retry after a failed sync must still sync even when the entry is already absent.
        syncDirectory(file.getParentFile());
    }

    /** Caller holds the store lock and has already authenticated/committed the published state. */
    static void cleanupPending(File root) {
        try {
            File[] files = root.listFiles((dir, name) -> name.startsWith(".pending-") && name.endsWith(".sealed"));
            if (files == null) return;
            boolean removed = false;
            for (File file : files) {
                try {
                    // Do not follow symlinks or recurse into directories with matching names.
                    if (OsConstants.S_ISREG(Os.lstat(file.getAbsolutePath()).st_mode)) removed |= file.delete();
                } catch (ErrnoException ignored) {
                    // Housekeeping can retry on a later successful operation.
                }
            }
            if (removed) syncDirectory(root);
        } catch (Exception ignored) {
            // Cleanup durability is separate from the already successful storage operation.
            // A leftover/reappearing temporary is safe and can be retried; never hide its result.
        }
    }
}
