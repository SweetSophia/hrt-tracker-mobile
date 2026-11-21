import { afterEach, expect, it, vi } from 'vitest';
import { markRendererPhase } from '../../mobile/storageQualification/rendererMarks';
const names = ['hrt.renderer.action.0.0', 'hrt.renderer.post.3.8'];
afterEach(() => {
    names.forEach(name => performance.clearMarks(name));
    vi.unstubAllGlobals();
});
it('keeps qualification marks absent unless the profiler handshake is armed', () => {
    vi.stubGlobal('window', {});
    markRendererPhase('action', 0, 0, 12.5);
    expect(performance.getEntriesByName(names[0])).toEqual([]);
    vi.stubGlobal('window', { __hrtRendererProfileArmed: false });
    markRendererPhase('action', 0, 0, 12.5);
    expect(performance.getEntriesByName(names[0])).toEqual([]);
});
it('emits the exact selected request and captured clock, without measuring a later clock', () => {
    vi.stubGlobal('window', { __hrtRendererProfileArmed: true });
    markRendererPhase('post', 3, 8, 17.25);
    expect(performance.getEntriesByName(names[1])).toMatchObject([
        { name: 'hrt.renderer.post.3.8', entryType: 'mark', startTime: 17.25 },
    ]);
});
