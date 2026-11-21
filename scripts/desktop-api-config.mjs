import { readFileSync } from 'node:fs';

const { tauri } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const api = new URL(process.env.VITE_API_ORIGIN);
if (api.username || api.password || !/^https?:\/\/[a-z\d.:[\]-]+$/i.test(api.origin)) {
    throw new Error('VITE_API_ORIGIN must identify an HTTP(S) backend without credentials.');
}

const csp = tauri.security.csp;
const directive = /(^|;)\s*connect-src\s+[^;]+/;
if (!directive.test(csp)) throw new Error('The base Tauri policy must define connect-src.');
const security = {
    csp: csp.replace(directive, (_, prefix) => `${prefix} connect-src 'self' ${api.origin}`.trimStart()),
};
console.log(JSON.stringify({ tauri: { security } }));
