import { expect, it, vi } from 'vitest';
import { mapRendererFrames } from '../../scripts/mobile/renderer-source-map.mjs';

const frame = (lineNumber: number | null, columnNumber: number | null, url = 'https://localhost/assets/chunk.js') => ({
    functionName: 'minified',
    url,
    lineNumber,
    columnNumber,
    samples: 7,
});

const sourceText = 'source line\nsecond';
const fixture = {
    code: '0123456789\nxxxxx\nxx',
    map: {
        version: 3,
        file: 'assets/chunk.js',
        sources: ['../src/example.ts'],
        sourcesContent: [sourceText],
        names: ['sourceToken'],
        mappings: 'AAAAA,K,CAACA;;CAACA',
    },
};

const resolveSource = (source: string) =>
    source === '../src/example.ts' ? { path: 'src/example.ts', text: sourceText } : null;

it('preserves generated frames and maps zero-based coordinates to one-based source positions', () => {
    const frames = [frame(0, 0), frame(0, 8)];
    const loadAsset = vi.fn(() => fixture);
    expect(mapRendererFrames(frames, { loadAsset, resolveSource })).toEqual([
        { ...frames[0], original: { path: 'src/example.ts', line: 1, column: 1, name: 'sourceToken' } },
        { ...frames[1], original: { path: 'src/example.ts', line: 1, column: 2, name: 'sourceToken' } },
    ]);
    expect(loadAsset.mock.calls).toEqual([['chunk.js']]);
});

it('keeps unresolved segments, missing coordinates and previous-line matches unmapped', () => {
    const frames = [frame(0, 5), frame(1, 0), frame(2, 0), frame(0, 10), frame(0, null), frame(-1, 0)];
    expect(mapRendererFrames(frames, { loadAsset: () => fixture, resolveSource })).toEqual(
        frames.map(f => ({ ...f, original: null })),
    );
});

it('does not request maps for non-bundle frames', () => {
    const frames = [
        frame(null, null, ''),
        frame(0, 0, 'https://example.com/assets/chunk.js'),
        frame(0, 0, 'https://localhost/elsewhere/chunk.js'),
        frame(0, 0, 'https://localhost/assets/chunk.js?other-code'),
    ];
    const loadAsset = vi.fn();
    expect(mapRendererFrames(frames, { loadAsset, resolveSource })).toEqual(
        frames.map(f => ({ ...f, original: null })),
    );
    expect(loadAsset).not.toHaveBeenCalled();
});

it('reports a verified source position only when the caller can resolve its original path', () => {
    const input = frame(2, 1);
    const loadAsset = () => ({ ...fixture, map: { ...fixture.map, file: 'chunk.js' } });
    const unresolved = vi.fn(() => null);
    expect(mapRendererFrames([input], { loadAsset, resolveSource: unresolved })).toEqual([
        { ...input, original: null },
    ]);
    expect(unresolved).toHaveBeenCalledWith('../src/example.ts');
});

it('maps a nonzero generated line to a nonzero original line for a basename map file', () => {
    const text = 'l0\nl1\nl2xxxx\nl3token';
    const input = frame(2, 1);
    const loadAsset = () => ({
        code: 'a\nb\nxy',
        map: {
            version: 3,
            file: 'chunk.js',
            sources: ['../src/example.ts'],
            sourcesContent: [text],
            names: ['sourceToken'],
            mappings: ';;CAGEA',
        },
    });
    const resolved = vi.fn(() => ({ path: 'src/example.ts', text }));
    expect(mapRendererFrames([input], { loadAsset, resolveSource: resolved })).toEqual([
        { ...input, original: { path: 'src/example.ts', line: 4, column: 3, name: 'sourceToken' } },
    ]);
    expect(resolved).toHaveBeenCalledWith('../src/example.ts');
});

it('throws when resolved source text does not match the map sourcesContent', () => {
    const loadAsset = () => ({
        ...fixture,
        map: { ...fixture.map, sourcesContent: [sourceText + '\n// shifted'] },
    });
    expect(() => mapRendererFrames([frame(0, 0)], { loadAsset, resolveSource })).toThrow(/content mismatch/i);
});

it('leaves the segment unmapped when source content or path is missing', () => {
    const { sourcesContent: _content, ...map } = fixture.map;
    const input = frame(0, 0);
    expect(mapRendererFrames([input], { loadAsset: () => ({ ...fixture, map }), resolveSource })).toEqual([
        { ...input, original: null },
    ]);
    const contentOnly = vi.fn(() => null);
    expect(
        mapRendererFrames([input], {
            loadAsset: () => fixture,
            resolveSource: contentOnly,
        }),
    ).toEqual([{ ...input, original: null }]);
    expect(contentOnly).toHaveBeenCalledWith('../src/example.ts');
});

it('rejects an ambiguous source path pairing', () => {
    const loadAsset = () => ({
        ...fixture,
        map: {
            ...fixture.map,
            sources: ['../src/example.ts', '../src/example.ts'],
            sourcesContent: [sourceText, sourceText + '\n'],
        },
    });
    expect(() => mapRendererFrames([frame(0, 0)], { loadAsset, resolveSource })).toThrow(/ambiguous/i);
});

it('rejects original positions outside cached UTF-16 line lengths', () => {
    const text = 'ab\n\u{1F600}';
    const loadAsset = () => ({
        code: '0123456789\nxxxxx',
        map: {
            version: 3,
            file: 'assets/chunk.js',
            sources: ['../src/example.ts'],
            sourcesContent: [text],
            names: ['sourceToken'],
            mappings: 'AAAEA,CAAFA,CACCA;AACDA',
        },
    });
    const frames = [frame(0, 0), frame(0, 1), frame(0, 2), frame(1, 0)];
    expect(mapRendererFrames(frames, { loadAsset, resolveSource: () => ({ path: 'src/example.ts', text }) })).toEqual([
        { ...frames[0], original: null },
        { ...frames[1], original: { path: 'src/example.ts', line: 1, column: 1, name: 'sourceToken' } },
        { ...frames[2], original: { path: 'src/example.ts', line: 2, column: 2, name: 'sourceToken' } },
        { ...frames[3], original: null },
    ]);
});

it.each([
    undefined,
    { file: 'different.js' },
    { version: 2 },
    { mappings: '%%%invalid' },
    { sourceRoot: 'https://example.com' },
])('rejects unsupported or mismatched maps: %j', change => {
    const loadAsset = () => ({ ...fixture, map: change && { ...fixture.map, ...change } });
    expect(() => mapRendererFrames([frame(0, 0)], { loadAsset, resolveSource })).toThrow(/source map/i);
});
