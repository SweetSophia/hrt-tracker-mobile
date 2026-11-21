import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { interruptPendingPreview, parsePendingPreview } from '../../scripts/mobile/screen-interruption.mjs';

const boundary = (pid = 123) => ({
    phase: 'pendingRestartSeed',
    outcome: 'waiting',
    pid,
    cleaned: true,
    previewOpen: true,
    unchanged: true,
    holdMillis: 60000,
    snapshotSha256: 'a'.repeat(64),
});
const start =
    'INSTRUMENTATION_STATUS: class=org.askarys.hrttracker.storage.ScreenMigrationTest\nINSTRUMENTATION_STATUS: test=pendingRestartSeed\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 1\n';
const marker = (value = boundary()) =>
    start + `INSTRUMENTATION_STATUS: screen_boundary=${JSON.stringify(value)}\nINSTRUMENTATION_STATUS_CODE: 2\n`;
const childFor = (mode: 'blocked' | 'normal' | 'empty' | 'duplicate' = 'blocked') =>
    spawn(
        process.execPath,
        [
            '-e',
            `
    const text=${JSON.stringify(marker())}.replace('"pid":123','"pid":'+process.pid);
    if (${JSON.stringify(mode)}==='empty') process.exit(0);
    process.stdout.write(text.slice(0,37));
    setTimeout(()=>{
      process.stdout.write(text.slice(37));
      if (${JSON.stringify(mode)}==='duplicate') process.stdout.write(text);
      if (${JSON.stringify(mode)}==='normal') process.stdout.write('INSTRUMENTATION_STATUS_CODE: 0\\nOK (1 test)\\nINSTRUMENTATION_CODE: -1\\n');
      process.stdout.write('FIXTURE_READY\\n');
      setInterval(()=>{},1000);
    },10);
`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
const options = (child: ReturnType<typeof childFor>) => ({
    getPid: async () => (child.exitCode === null && child.signalCode === null ? String(child.pid) : ''),
    stop: async () => {
        child.kill('SIGKILL');
    },
    timeoutMs: 2000,
    stopTimeoutMs: 1000,
});

it('streams a live split boundary and interrupts before normal teardown without inventing a JUnit pass', async () => {
    const child = childFor();
    const result = await interruptPendingPreview(child, options(child));
    expect(result.phase).toBe('pendingRestartSeed');
    expect(result.cases).toEqual([]);
    expect(result.interruption).toMatchObject({ forceStopReturned: true, processGone: true, livePid: child.pid });
    expect(result.report.outcome).toBe('waiting');
    expect(result.output).not.toContain('OK (1 test)');
});

it('rejects normal seed completion, early exit and duplicate live reports', async () => {
    for (const mode of ['normal', 'empty', 'duplicate'] as const) {
        const child = childFor(mode);
        let transcript = '';
        const ready = new Promise<void>(resolve => {
            child.stdout.on('data', chunk => {
                transcript += chunk;
                if (transcript.includes('FIXTURE_READY\n')) resolve();
            });
        });
        const opts = options(child);
        const getPid = opts.getPid;
        // Negative suffixes must arrive before the mocked host is allowed to stop the child.
        opts.getPid = async () => {
            await ready;
            return getPid();
        };
        await expect(interruptPendingPreview(child, opts)).rejects.toThrow(
            mode === 'normal' ? /completed or failed/ : mode === 'duplicate' ? /Duplicate/ : /exited/,
        );
    }
});

it('rejects an unrelated PID, failed stop and a process still alive after stopping', async () => {
    for (const fault of ['pid', 'stop', 'alive'] as const) {
        const child = childFor();
        const opts = options(child);
        if (fault === 'pid') opts.getPid = async () => String(child.pid! + 1);
        if (fault === 'stop')
            opts.stop = async () => {
                throw new Error('stop failed');
            };
        if (fault === 'alive') opts.getPid = async () => String(child.pid);
        await expect(interruptPendingPreview(child, opts)).rejects.toThrow();
    }
});

it('requires the exact live test identity and every boundary field', () => {
    expect(parsePendingPreview(marker())?.pid).toBe(123);
    expect(parsePendingPreview(start)).toBeUndefined();
    for (const key of Object.keys(boundary())) {
        const bad = { ...boundary() };
        delete (bad as Record<string, unknown>)[key];
        expect(() => parsePendingPreview(marker(bad))).toThrow();
    }
    for (const bad of [
        marker() + marker(),
        marker().replace('test=pendingRestartSeed', 'test=other'),
        marker() + 'INSTRUMENTATION_CODE: -1\n',
        marker() + 'INSTRUMENTATION_STATUS_CODE: -2\n',
    ])
        expect(() => parsePendingPreview(bad)).toThrow();
});

it('kills and reaps a stalled command before its deadline rejection settles', async () => {
    const { runInterruptionCommand } = await import('../../scripts/mobile/screen-interruption.mjs');
    const error = await runInterruptionCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100).catch(
        (error: Error & { pid: number; killed: boolean; signal: string }) => error,
    );
    expect(error).toMatchObject({ killed: true, signal: 'SIGKILL' });
    expect(() => process.kill(error.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
});

it('reaps the instrumentation child when forced stop does not close it', async () => {
    const child = childFor();
    await expect(
        interruptPendingPreview(child, { ...options(child), stop: async () => {}, stopTimeoutMs: 50 }),
    ).rejects.toThrow('Instrumentation did not close');
    expect(() => process.kill(child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
});
