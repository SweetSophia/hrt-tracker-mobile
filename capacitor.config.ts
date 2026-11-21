import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'org.askarys.hrttracker.spike',
    appName: 'HRT Tracker Prototype',
    loggingBehavior: 'none',
    webDir: 'dist-mobile',
    includePlugins:
        process.env.HRT_MOBILE_PROBE === '1' ? ['@capacitor/app', '@capacitor-community/sqlite'] : ['@capacitor/app'],
    server: {
        hostname: 'localhost',
        androidScheme: 'https',
        cleartext: false,
        allowNavigation: [],
    },
    plugins: {
        CapacitorHttp: { enabled: false },
        CapacitorSQLite: { androidIsEncryption: true, androidBiometric: { biometricAuth: false } },
    },
};

export default config;
