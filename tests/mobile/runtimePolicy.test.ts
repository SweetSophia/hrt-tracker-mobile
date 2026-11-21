import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
});

it('rejects relative, absolute, URL, and Request inputs before fetch', async () => {
    vi.stubGlobal('__HRT_BUILD_TARGET__', 'mobile');
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const api = await import('../../src/services/apiClient');
    for (const input of [
        '/api/user',
        'https://example.invalid/api/user',
        new URL('https://example.invalid/api/user'),
        new Request('https://example.invalid/api/user'),
    ]) {
        await expect(api.apiFetch(input)).rejects.toMatchObject({ status: 0, code: 'BACKEND_DISABLED' });
    }
    await expect(api.apiRequest('synthetic', '/api/user')).rejects.toMatchObject({
        status: 0,
        code: 'BACKEND_DISABLED',
    });
    expect(() => api.apiEndpoint('/api/notice')).toThrow(expect.objectContaining({ code: 'BACKEND_DISABLED' }));
    expect(fetchSpy).not.toHaveBeenCalled();
});

it('uses standalone capabilities in a mobile browser preview', async () => {
    vi.stubGlobal('__HRT_BUILD_TARGET__', 'mobile');
    const runtime = await import('../../src/platform/runtime');
    expect(runtime.getRuntimeKind()).toBe('web');
    expect(runtime.getCapabilities().remoteBackend).toBe(false);
});

it('keeps the configured origin and API behavior on web', async () => {
    vi.stubGlobal('__HRT_BUILD_TARGET__', 'web');
    vi.stubEnv('VITE_API_ORIGIN', 'https://example.invalid/');
    const fetchSpy = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchSpy);
    const api = await import('../../src/services/apiClient');
    expect(await api.apiRequest('synthetic', '/api/user')).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith('https://example.invalid/api/user', expect.any(Object));
});
