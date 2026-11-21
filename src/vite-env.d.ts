/// <reference types="vite/client" />

declare const __HRT_BUILD_TARGET__: 'web' | 'mobile';
declare const __HRT_MOBILE_PROBE__: boolean;
declare const __HRT_NATIVE_RECORDS__: boolean;
declare const __HRT_STORAGE_QUALIFICATION__: boolean;

interface ImportMetaEnv {
    readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
