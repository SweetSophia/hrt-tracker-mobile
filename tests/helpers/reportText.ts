import { inflateSync } from 'node:zlib';

/** Read text drawn on pages by jsPDF, including its embedded TrueType fonts. */
export function reportText(bytes: Uint8Array): string {
    const raw = Buffer.from(bytes).toString('latin1');
    const objects = new Map<string, string>();
    for (const match of raw.matchAll(/^(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj/gm)) objects.set(match[1], match[2]);
    const stream = (id: string) => {
        const object = objects.get(id) ?? '';
        const header = /\bstream\r?\n/.exec(object);
        if (!header) return '';
        const length = Number(/\/Length\s+(\d+)/.exec(object)?.[1]);
        const start = header.index + header[0].length;
        const body = object.slice(start, start + length);
        return object.slice(0, header.index).includes('FlateDecode')
            ? inflateSync(Buffer.from(body, 'latin1')).toString('latin1')
            : body;
    };
    const fonts = new Map<string, Map<string, string>>();
    for (const font of raw.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
        const id = /\/ToUnicode\s+(\d+) 0 R/.exec(objects.get(font[2]) ?? '')?.[1];
        if (!id) continue;
        const chars = new Map<string, string>();
        for (const block of stream(id).matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
            for (const pair of block[1].matchAll(/<([\da-f]{4})>\s*<([\da-f]{4})>/gi)) {
                chars.set(pair[1].toLowerCase(), String.fromCharCode(parseInt(pair[2], 16)));
            }
        }
        fonts.set(font[1], chars);
    }

    const lines: string[] = [];
    for (const object of objects.values()) {
        if (!/\/Type\s+\/Page\b/.test(object)) continue;
        const id = /\/Contents\s+(\d+) 0 R/.exec(object)?.[1];
        if (!id) continue;
        let chars: Map<string, string> | undefined;
        const operators = /\/(F\d+)\s+[\d.]+ Tf|<([\da-fA-F]+)>\s*Tj|\(((?:\\.|[^)\\])*)\)\s*Tj/g;
        for (const op of stream(id).matchAll(operators)) {
            if (op[1]) chars = fonts.get(op[1]);
            else if (op[2]) lines.push(op[2].toLowerCase().replace(/.{4}/g, glyph => chars?.get(glyph) ?? '�'));
            else lines.push(op[3].replace(/\\([()\\])/g, '$1'));
        }
    }
    return lines.join('\n');
}
