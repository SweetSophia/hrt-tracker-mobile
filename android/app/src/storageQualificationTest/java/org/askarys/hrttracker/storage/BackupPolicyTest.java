package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.*;
import org.junit.Test;

public final class BackupPolicyTest {
    @Test public void compiledPolicyExcludesPrivateStoresFromBothTransports() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(0, context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        for (String resource : Arrays.asList("backup_rules", "data_extraction_rules")) {
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
            assertEquals(resource.equals("backup_rules") ? Collections.singleton("legacy") :
                new HashSet<>(Arrays.asList("cloud-backup", "device-transfer")), domains.keySet());
            for (Set<String> excluded : domains.values()) {
                for (String domain : Arrays.asList("root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref")) {
                    assertTrue(excluded.contains(domain));
                }
            }
        }
    }
}
