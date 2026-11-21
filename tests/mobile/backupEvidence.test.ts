import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveEvidence } from '../../scripts/mobile/backup-evidence.mjs';

const folders: string[] = [];
const prefix = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrt-evidence-test-'));
    folders.push(dir);
    return join(dir, 'run');
};
afterEach(() => {
    for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
it('reserves the whole output group before another process can claim it', () => {
    const path = prefix();
    const evidence = reserveEvidence(path);
    try {
        const script = `import { reserveEvidence } from ${JSON.stringify(new URL('../../scripts/mobile/backup-evidence.mjs', import.meta.url).href)};
            try { const claim=reserveEvidence(process.argv[1]); claim.write('json','intruder'); claim.close(); process.exitCode=2; }
            catch(error) { if (error.code !== 'EEXIST') throw error; }`;
        execFileSync(process.execPath, ['--input-type=module', '-e', script, path]);
        for (const kind of ['xml', 'json', 'log']) evidence.write(kind, `owner-${kind}`);
        expect(() => evidence.write('json', 'overwrite')).toThrow();
    } finally {
        evidence.close();
    }
    for (const kind of ['xml', 'json', 'log']) expect(readFileSync(`${path}.${kind}`, 'utf8')).toBe(`owner-${kind}`);
    expect(() => reserveEvidence(path)).toThrow();
});
it.each(['xml', 'log', 'json'])('preserves a pre-existing %s even when other outputs are absent', kind => {
    const path = prefix();
    writeFileSync(`${path}.${kind}`, 'existing evidence');
    expect(() => reserveEvidence(path)).toThrow();
    expect(readFileSync(`${path}.${kind}`, 'utf8')).toBe('existing evidence');
});
it('keeps interrupted reservations fail-closed and rejects writes after release', () => {
    const path = prefix();
    const evidence = reserveEvidence(path);
    evidence.write('json', '{"outcome":"fail"}');
    evidence.close();
    expect(() => evidence.write('log', 'late write')).toThrow();
    expect(() => reserveEvidence(path)).toThrow();
    expect(readFileSync(path + '.json', 'utf8')).toBe('{"outcome":"fail"}');
});

it('allows exactly one simultaneous writer and never mixes a completed evidence group', async () => {
    const path = prefix();
    const script = `import { once } from 'node:events';
        import { reserveEvidence } from ${JSON.stringify(new URL('../../scripts/mobile/backup-evidence.mjs', import.meta.url).href)};
        process.send('ready'); await once(process,'message');
        try { const claim=reserveEvidence(process.argv[1]); process.send({claimed:true});
            await once(process,'message');
            for(const kind of ['xml','log','json']) claim.write(kind,process.argv[2]); claim.close();
        } catch(error) { process.send({claimed:false,code:error.code}); }
        process.disconnect();`;
    const workers = ['first', 'second'].map(id => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, id], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        return { child, ready: once(child, 'message'), exited: once(child, 'close') };
    });
    try {
        await Promise.all(workers.map(worker => worker.ready));
        const claims = workers.map(worker => once(worker.child, 'message'));
        workers.forEach(worker => worker.child.send('start'));
        const results = (await Promise.all(claims)).map(([message]) => message);
        expect(results.filter(result => result.claimed)).toHaveLength(1);
        expect(results.filter(result => !result.claimed).map(result => result.code)).toEqual(['EEXIST']);
        workers.forEach((worker, index) => {
            if (results[index].claimed) worker.child.send('finish');
        });
        expect((await Promise.all(workers.map(worker => worker.exited))).map(([code]) => code)).toEqual([0, 0]);
        const contents = ['xml', 'json', 'log'].map(kind => readFileSync(`${path}.${kind}`, 'utf8'));
        expect(new Set(contents).size).toBe(1);
        expect(['first', 'second']).toContain(contents[0]);
    } finally {
        for (const { child } of workers) if (child.exitCode === null) child.kill();
    }
});

it('reserves optional trace output before work and never replaces an existing trace', () => {
    const path = prefix();
    const evidence = reserveEvidence(path, ['trace.json']);
    try {
        evidence.write('trace.json', '{"traceEvents":[]}');
        expect(() => evidence.write('trace.json', 'replace')).toThrow();
    } finally {
        evidence.close();
    }
    expect(readFileSync(path + '.trace.json', 'utf8')).toBe('{"traceEvents":[]}');
    const occupied = prefix();
    writeFileSync(occupied + '.trace.json', 'existing trace');
    expect(() => reserveEvidence(occupied, ['trace.json'])).toThrow();
    expect(readFileSync(occupied + '.trace.json', 'utf8')).toBe('existing trace');
});
