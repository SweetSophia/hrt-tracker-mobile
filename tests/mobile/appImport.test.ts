import { expect, it, vi } from 'vitest';

// This imports/transforms the whole UI graph alongside the numerical suite.
it('imports the production app without reading browser storage before bootstrap', async () => {
    const read = vi.fn(() => {
        throw new Error('Storage read before initialization');
    });
    vi.stubGlobal('window', { history: { state: null }, addEventListener: vi.fn(), atob, btoa });
    vi.stubGlobal('localStorage', { getItem: read, setItem: read, removeItem: read });
    try {
        await import('../../src/App');
        expect(read).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
}, 30_000);
