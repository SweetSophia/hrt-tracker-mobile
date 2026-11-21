package org.askarys.hrttracker.network;

import android.app.Activity;
import android.content.Intent;
import androidx.test.runner.AndroidJUnitRunner;
import org.askarys.hrttracker.spike.MainActivity;

/** Substitution lives in the test APK; ordinary Activity and packaged assets stay unchanged. */
public final class NetworkTestRunner extends AndroidJUnitRunner {
    @Override public Activity newActivity(ClassLoader loader, String name, Intent intent)
        throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        if (MainActivity.class.getName().equals(name)) return new RecordingActivity();
        return super.newActivity(loader, name, intent);
    }
}
