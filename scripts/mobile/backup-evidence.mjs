import { closeSync, mkdirSync, openSync, rmdirSync, writeFileSync } from 'node:fs';

/** Reserve the whole evidence group before device work; never truncate another run. */
export function reserveEvidence(prefix, extraKinds = []) {
    const kinds = ['xml', 'log', 'json', ...extraKinds];
    if (new Set(kinds).size !== kinds.length || kinds.some(kind => !/^[a-z]+(?:\.[a-z]+)?$/.test(kind)))
        throw new Error('Invalid evidence kinds');
    const lock = prefix + '.lock';
    mkdirSync(lock); // Atomic across processes, including different emulator runners.
    const files = new Map();
    const written = new Set();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        try {
            for (const descriptor of files.values()) closeSync(descriptor);
        } finally {
            rmdirSync(lock);
        }
    };
    try {
        for (const kind of kinds) files.set(kind, openSync(`${prefix}.${kind}`, 'wx', 0o600));
    } catch (error) {
        // Leave partial reservations as evidence of an incomplete run. A fresh
        // prefix is required; never delete or replace a competing output file.
        close();
        throw error;
    }
    return {
        write(kind, contents) {
            if (closed || !files.has(kind) || written.has(kind)) throw new Error('Evidence output is not writable');
            written.add(kind);
            writeFileSync(files.get(kind), contents);
        },
        close,
    };
}
