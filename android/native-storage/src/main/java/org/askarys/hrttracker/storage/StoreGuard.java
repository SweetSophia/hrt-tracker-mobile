package org.askarys.hrttracker.storage;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;

/** One JVM monitor prevents overlapping Java locks; the OS lock coordinates other processes. */
final class StoreGuard {
    private static final Object PROCESS_LOCK = new Object();
    interface Operation<T> { T run() throws Exception; }

    static <T> T with(File root, Operation<T> operation) throws Exception {
        synchronized (PROCESS_LOCK) {
            DurableFiles.directory(root);
            try (RandomAccessFile file = new RandomAccessFile(new File(root, ".lock"), "rw");
                 FileLock lock = file.getChannel().lock()) {
                return operation.run();
            }
        }
    }

    static String id(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid store identity");
        return id;
    }
}
