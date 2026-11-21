package org.askarys.hrttracker.spike;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class StorageProbeTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test public void candidateAcknowledgesAnUndurableSecret() throws Exception {
        Class<?> candidate = Class.forName("com.getcapacitor.community.database.sqlite.SQLite.UtilsSecret");
        Map<String,String> memory = new HashMap<>();
        AtomicInteger applyCalls = new AtomicInteger();
        AtomicInteger commitCalls = new AtomicInteger();
        Object editor = Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{SharedPreferences.Editor.class}, (proxy, method, args) -> {
            if (method.getName().equals("putString")) { memory.put((String) args[0], (String) args[1]); return proxy; }
            if (method.getName().equals("apply")) { applyCalls.incrementAndGet(); return null; } // Inject dropped disk write.
            if (method.getName().equals("commit")) { commitCalls.incrementAndGet(); return false; }
            return proxy;
        });
        SharedPreferences preferences = (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{SharedPreferences.class}, (proxy, method, args) -> {
            if (method.getName().equals("edit")) return editor;
            if (method.getName().equals("getString")) return memory.getOrDefault((String)args[0], (String)args[1]);
            throw new UnsupportedOperationException(method.getName());
        });
        Field field = candidate.getDeclaredField("sharedPreferences"); field.setAccessible(true);
        Object original = field.get(null);
        try {
            Context isolated = new ContextWrapper(context) { @Override public String[] databaseList() { return new String[0]; } };
            Object secret = candidate.getConstructor(Context.class, SharedPreferences.class).newInstance(isolated, preferences);
            candidate.getMethod("setEncryptionSecret", String.class).invoke(secret, "SYNTHETIC-CANDIDATE-SECRET");
            assertEquals(1, applyCalls.get());
            assertEquals("No observable durable commit was requested", 0, commitCalls.get());
            assertEquals(Boolean.TRUE, candidate.getMethod("isPassphrase").invoke(null));
            // Passing this test confirms the admission defect; it does NOT
            // qualify the candidate as a production secret store.
        } finally { field.set(null, original); }
    }

    @Test public void encryptedFixtureRejectsWrongKeyAndContainsNoPlaintextSentinel() throws Exception {
        new ProbeBridgeTest().runCheckedProbe("storage-instrumentation", "sqlite-batch", "prepare");
        new ProbeBridgeTest().runCheckedProbe("storage-repeat", "sqlite-batch", "prepare");
        File file = context.getDatabasePath("hrt_feasibilitySQLite.db");
        assertTrue("Run sqlite-batch prepare before this test", file.isFile() && file.length() > 0);
        long lengthBefore = file.length();
        Class<?> database = Class.forName("net.zetetic.database.sqlcipher.SQLiteDatabase");
        System.loadLibrary("sqlcipher");
        boolean rejected = false;
        try {
            Object opened = database.getMethod("openDatabase", String.class, String.class,
                Class.forName("net.zetetic.database.sqlcipher.SQLiteDatabase$CursorFactory"), int.class,
                Class.forName("net.zetetic.database.sqlcipher.SQLiteDatabaseHook"))
                .invoke(null, file.getAbsolutePath(), "WRONG-SYNTHETIC-KEY", null, 1, null);
            try { database.getMethod("rawQuery", String.class, String[].class).invoke(opened, "SELECT * FROM entries", null); }
            finally { database.getMethod("close").invoke(opened); }
        } catch (InvocationTargetException error) {
            assertTrue(error.getCause() instanceof RuntimeException);
            rejected = true;
        }
        assertTrue("Wrong SQLCipher key unexpectedly read the file", rejected);
        assertTrue("Wrong-key read removed the existing database", file.isFile());
        assertEquals(lengthBefore, file.length());
        for (String suffix : new String[]{"", "-wal", "-journal", "-shm"}) {
            File artifact = new File(file.getAbsolutePath() + suffix);
            if (!artifact.isFile()) continue;
            try (FileInputStream input = new FileInputStream(artifact); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] block = new byte[8192]; int n;
                while ((n = input.read(block)) >= 0) output.write(block, 0, n);
                assertFalse("Plaintext sentinel in encrypted artifact", output.toString("ISO-8859-1").contains("SYNTHETIC_ENCRYPTED_SENTINEL_ASKARYS"));
            }
        }
    }

    @Test public void backupPolicyExcludesPrivateStores() throws Exception {
        assertEquals(0, context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        for (String resource : new String[]{"backup_rules", "data_extraction_rules"}) {
            int id = context.getResources().getIdentifier(resource, "xml", context.getPackageName());
            assertTrue(id != 0);
            Map<String, Set<String>> domains = new HashMap<>();
            String section = "legacy";
            try (XmlResourceParser xml = context.getResources().getXml(id)) {
                for (int event = xml.getEventType(); event != XmlResourceParser.END_DOCUMENT; event = xml.next()) {
                    if (event != XmlResourceParser.START_TAG) continue;
                    if (xml.getName().equals("cloud-backup") || xml.getName().equals("device-transfer")) section = xml.getName();
                    if (xml.getName().equals("exclude")) {
                        assertEquals(".", xml.getAttributeValue(null, "path"));
                        domains.computeIfAbsent(section, key -> new HashSet<>()).add(xml.getAttributeValue(null, "domain"));
                    }
                }
            }
            assertEquals(resource.equals("backup_rules") ? 1 : 2, domains.size());
            for (Set<String> excluded : domains.values()) {
                for (String domain : new String[]{"root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"}) assertTrue(excluded.contains(domain));
            }
        }
    }
}
