package org.askarys.hrttracker.updates;

/** Snapshot reported to the interface; null available or dismissed means none. */
final class ReleaseUpdateState {
    final long revision;
    final String installedVersion;
    final boolean automatic;
    final String availableVersion;
    final String dismissedVersion;

    ReleaseUpdateState(long revision, String installedVersion, boolean automatic, String availableVersion, String dismissedVersion) {
        this.revision = revision;
        this.installedVersion = installedVersion;
        this.automatic = automatic;
        this.availableVersion = availableVersion;
        this.dismissedVersion = dismissedVersion;
    }
}
