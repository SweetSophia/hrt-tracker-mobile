import type { Plugin } from 'vite';

// Bundled assets never receive the Worker's response headers. Keep scripts
// restricted without relaxing the policy for the native bridge.
export const mobileContentPolicy = (): Plugin => ({
    name: 'hrt:mobile-content-policy',
    transformIndexHtml: {
        order: 'pre',
        handler: () => [
            {
                tag: 'meta',
                attrs: {
                    'http-equiv': 'Content-Security-Policy',
                    content: [
                        "default-src 'self'",
                        "script-src 'self'",
                        "worker-src 'self' blob:",
                        "style-src 'self' 'unsafe-inline'",
                        "img-src 'self' data: blob:",
                        "font-src 'self' data:",
                        "connect-src 'self'",
                        "object-src 'none'",
                        "base-uri 'none'",
                        "form-action 'none'",
                        "frame-src 'self'",
                    ].join('; '),
                },
                injectTo: 'head-prepend',
            },
            { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
        ],
    },
});
