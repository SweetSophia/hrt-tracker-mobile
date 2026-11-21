import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationRuntime, createWebRuntime } from '../../src/application/runtime';
import { createNativeRuntime } from '../../src/application/nativeRuntime';
import type { RecordStore, SecretStore } from '../../src/platform/contracts';
import type { FileSavePort, FileSaveResult } from '../../src/platform/contracts/files';
import { WebFileSavePort } from '../../src/platform/web/files';
import { getCapabilities } from '../../src/platform/runtime';
import { recordNamespace } from '../../src/records/scope';
import { NOW_H } from '../helpers';

class MemoryStorage implements Storage {
    data = new Map<string, string>();
    get length() {
        return this.data.size;
    }
    key(index: number) {
        return [...this.data.keys()][index] ?? null;
    }
    clear() {
        this.data.clear();
    }
    getItem = vi.fn((key: string) => this.data.get(key) ?? null);
    setItem = vi.fn((key: string, value: string) => {
        this.data.set(key, value);
    });
    removeItem(key: string) {
        this.data.delete(key);
    }
}

class AnchorDouble {
    href = '';
    download = '';
    parent: BodyDouble | null = null;
    clicked = false;
    removed = false;
    clickImpl: () => void = () => undefined;
    click() {
        this.clicked = true;
        this.clickImpl();
    }
    remove() {
        this.removed = true;
        if (!this.parent) return;
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
    }
}

class BodyDouble {
    children: AnchorDouble[] = [];
    appendChild(node: AnchorDouble) {
        node.parent = this;
        this.children.push(node);
    }
}

class DocumentDouble {
    readonly body = new BodyDouble();
    readonly created: AnchorDouble[] = [];
    clickImpl: () => void = () => undefined;
    createElement(tag: string) {
        if (tag !== 'a') throw new Error('unexpected element ' + tag);
        const anchor = new AnchorDouble();
        anchor.clickImpl = () => this.clickImpl();
        this.created.push(anchor);
        return anchor;
    }
}

function installDocument() {
    const documentDouble = new DocumentDouble();
    vi.stubGlobal('document', documentDouble);
    return documentDouble;
}

function controlTimers() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(NOW_H * 3600 * 1000);
}

async function bytesAt(url: string) {
    const response = await fetch(url);
    return { type: response.headers.get('content-type'), bytes: new Uint8Array(await response.arrayBuffer()) };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_H * 3600 * 1000);
});

it('does not touch the document or blob URLs when the browser adapter is imported or constructed', async () => {
    vi.resetModules();
    const reads: string[] = [];
    vi.stubGlobal(
        'document',
        new Proxy(
            {},
            {
                get(_target, property) {
                    reads.push(String(property));
                    return undefined;
                },
            },
        ),
    );
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const loaded = await import('../../src/platform/web/files');
    const port = new loaded.WebFileSavePort();
    expect(port).toBeInstanceOf(loaded.WebFileSavePort);
    expect(reads).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
});

it('snapshots unicode text and binary subarray bytes and requests a download', async () => {
    controlTimers();
    const documentDouble = installDocument();
    const port = new WebFileSavePort();
    const text = new TextEncoder().encode('剂量' + String.fromCharCode(0) + '😀');
    const textRequest = port.save({ name: 'hrt-剂量.json', mimeType: 'application/json', bytes: text });
    text[0] = 0;
    const textAnchor = documentDouble.created[0];
    expect(textAnchor.clicked).toBe(true);
    expect(textAnchor.download).toBe('hrt-剂量.json');
    expect(textAnchor.removed).toBe(true);
    expect(documentDouble.body.children).toEqual([]);
    const textBody = await bytesAt(textAnchor.href);
    expect(await textRequest).toBe('download-requested');
    expect(textBody.type).toContain('application/json');
    expect(textBody.bytes).toEqual(new TextEncoder().encode('剂量' + String.fromCharCode(0) + '😀'));

    const source = new Uint8Array([0xaa, 0x00, 0xff, 0xfe, 0x11]);
    const view = source.subarray(1, 4);
    documentDouble.clickImpl = () => {
        view[0] = 0x7f;
        source[2] = 0x22;
        source[0] = 0x33;
    };
    const binaryRequest = port.save({
        name: 'report.bin',
        mimeType: 'application/octet-stream',
        bytes: view,
    });
    view[1] = 0x44;
    const binaryAnchor = documentDouble.created[1];
    expect(binaryAnchor.clicked).toBe(true);
    expect(binaryAnchor.download).toBe('report.bin');
    const binaryBody = await bytesAt(binaryAnchor.href);
    expect(await binaryRequest).toBe('download-requested');
    expect(binaryBody.type).toContain('application/octet-stream');
    expect(binaryBody.bytes).toEqual(new Uint8Array([0x00, 0xff, 0xfe]));
});

it('removes the anchor immediately and revokes the object URL 1000ms after dispatch', async () => {
    controlTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const documentDouble = installDocument();
    let hrefAtClick = '';
    documentDouble.clickImpl = () => {
        hrefAtClick = documentDouble.created[0]?.href ?? '';
        expect(documentDouble.body.children).toHaveLength(1);
        expect(revoke).not.toHaveBeenCalled();
    };
    const result = await new WebFileSavePort().save({
        name: 'snapshot.bin',
        mimeType: 'application/octet-stream',
        bytes: Uint8Array.of(1, 2, 3),
    });
    expect(result).toBe('download-requested');
    expect(hrefAtClick.startsWith('blob:')).toBe(true);
    expect(documentDouble.created[0].removed).toBe(true);
    expect(documentDouble.body.children).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect((await bytesAt(hrefAtClick)).bytes).toEqual(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(999);
    expect(revoke).not.toHaveBeenCalled();
    expect((await bytesAt(hrefAtClick)).bytes).toEqual(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(hrefAtClick);
    await expect(bytesAt(hrefAtClick)).rejects.toThrow();
});

it('cleans up and rejects without logging when the anchor click throws', async () => {
    controlTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const logs = ['debug', 'error', 'info', 'log', 'warn'].map(method => vi.spyOn(console, method as 'log'));
    const documentDouble = installDocument();
    const failure = new Error('synthetic click failed SENTINEL-file-bytes');
    let hrefAtClick = '';
    documentDouble.clickImpl = () => {
        hrefAtClick = documentDouble.created[0].href;
        throw failure;
    };
    const pending = new WebFileSavePort().save({
        name: 'secret.bin',
        mimeType: 'application/octet-stream',
        bytes: new TextEncoder().encode('SENTINEL-file-bytes'),
    });
    await expect(pending).rejects.toBe(failure);
    expect(documentDouble.created).toHaveLength(1);
    expect(documentDouble.created[0].clicked).toBe(true);
    expect(documentDouble.created[0].removed).toBe(true);
    expect(documentDouble.body.children).toEqual([]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(hrefAtClick);
    await expect(bytesAt(hrefAtClick)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it('defaults web files to browser delivery and injects native document ports', async () => {
    const storage = new MemoryStorage();
    const web = await createWebRuntime(storage, 'web');
    const again = await createWebRuntime(new MemoryStorage(), 'web');
    expect(web.files).toBeInstanceOf(WebFileSavePort);
    expect(again.files).toBeInstanceOf(WebFileSavePort);
    expect(again.files).not.toBe(web.files);
    expect(storage.setItem).not.toHaveBeenCalled();

    const secrets: SecretStore = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    const namespace = recordNamespace({ backend: 'offline', owner: 'local', mode: 'transfem' });
    const records = {
        initialize: vi.fn(async () => {}),
        read: vi.fn(async (ns: string) => ({
            revision: 2,
            entries: ns === namespace ? { 'hrt-masc-events': '[{"id":"synthetic"}]' } : { 'app-theme': 'dark' },
        })),
        commit: vi.fn(),
    } as RecordStore;
    const device = {
        getItem: vi.fn((key: string) => (key === 'app-onboarded' ? 'true' : null)),
        setItem: vi.fn(),
    };
    const documents = { save: vi.fn(async (): Promise<FileSaveResult> => 'saved'), pick: vi.fn(async () => null) };
    const native = await createNativeRuntime(device, { records, secrets }, documents);
    expect(native.secrets).toBe(secrets);
    expect(native.files).toBe(documents);
    expect(native.filePicker).toBe(documents);
    expect(getCapabilities().nativeFiles).toBe(false);
    expect(device.setItem).not.toHaveBeenCalled();

    const injected: FileSavePort = { save: vi.fn(async (): Promise<FileSaveResult> => 'cancelled') };
    const custom = new ApplicationRuntime(
        web.controller,
        web.backend,
        storage,
        web.getState().device,
        web.hasPriorRecords,
        secrets,
        injected,
    );
    expect(custom.secrets).toBe(secrets);
    expect(custom.files).toBe(injected);
    const secretsOnly = new ApplicationRuntime(web.controller, web.backend, storage, {}, false, secrets);
    expect(secretsOnly.secrets).toBe(secrets);
    expect(secretsOnly.files).toBeInstanceOf(WebFileSavePort);
    expect(secretsOnly.files).not.toBe(injected);
});
