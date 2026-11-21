import { SourceMap } from 'node:module';

const localAsset = /^https:\/\/localhost\/assets\/([A-Za-z0-9_.-]+\.js)$/;
const offset = value => Number.isSafeInteger(value) && value >= 0;
const lineLengths = text => text.split(/\r\n?|\n|\u2028|\u2029/).map(line => line.length);

function prepareMap(asset, { code, map } = {}) {
    if (
        typeof code !== 'string' ||
        map?.version !== 3 ||
        (map.file !== asset && map.file !== 'assets/' + asset) ||
        (map.sourceRoot !== undefined && map.sourceRoot !== '') ||
        !Array.isArray(map.sources) ||
        !map.sources.every(source => typeof source === 'string') ||
        (map.sourcesContent !== undefined && !Array.isArray(map.sourcesContent)) ||
        !Array.isArray(map.names) ||
        !map.names.every(name => typeof name === 'string') ||
        typeof map.mappings !== 'string' ||
        !/^[A-Za-z0-9+/;,]*$/.test(map.mappings)
    )
        throw new Error('Missing, malformed or mismatched renderer source map: ' + asset);
    return {
        mapper: new SourceMap(map),
        lineLengths: lineLengths(code),
        sources: map.sources,
        sourcesContent: map.sourcesContent,
    };
}

function resolvedSource(value) {
    if (!value || typeof value.path !== 'string' || value.path === '' || typeof value.text !== 'string') return null;
    return value;
}

/** Locate V8 leaf positions in verified local chunks while retaining generated coordinates and counts. */
export function mapRendererFrames(frames, { loadAsset, resolveSource }) {
    const maps = new Map();
    const verifiedLines = new Map();
    const locate = frame => {
        const asset = localAsset.exec(frame.url)?.[1];
        if (!asset || !offset(frame.lineNumber) || !offset(frame.columnNumber)) return null;
        if (!maps.has(asset)) maps.set(asset, prepareMap(asset, loadAsset(asset)));
        const prepared = maps.get(asset);
        const { lineNumber: line, columnNumber: column } = frame;
        if (line >= prepared.lineLengths.length || column >= prepared.lineLengths[line]) return null;

        const entry = prepared.mapper.findEntry(line, column);
        if (
            entry.generatedLine !== line ||
            !entry.originalSource ||
            !offset(entry.originalLine) ||
            !offset(entry.originalColumn)
        )
            return null;
        const resolved = resolvedSource(resolveSource(entry.originalSource));
        if (!resolved) return null;
        const index = prepared.sources.indexOf(entry.originalSource);
        if (index < 0) return null;
        if (prepared.sources.indexOf(entry.originalSource, index + 1) !== -1)
            throw new Error('Ambiguous renderer source map source: ' + entry.originalSource);
        const content = prepared.sourcesContent?.[index];
        if (typeof content !== 'string') return null;
        if (content !== resolved.text) throw new Error('Renderer source content mismatch: ' + resolved.path);

        let cached = verifiedLines.get(resolved.path);
        if (!cached || cached.text !== resolved.text) {
            cached = { text: resolved.text, lengths: lineLengths(resolved.text) };
            verifiedLines.set(resolved.path, cached);
        }
        if (entry.originalLine >= cached.lengths.length || entry.originalColumn >= cached.lengths[entry.originalLine])
            return null;
        return {
            path: resolved.path,
            line: entry.originalLine + 1,
            column: entry.originalColumn + 1,
            name: entry.name ?? null,
        };
    };
    return frames.map(frame => ({ ...frame, original: locate(frame) }));
}
