/** Shared persistence protocol; adapters own initialization and durability. */
export type NamespaceId = string;
export interface StoreSnapshot {
    readonly revision: number;
    readonly entries: Readonly<Record<string, string>>;
}
export interface StoreChange {
    readonly namespace: NamespaceId;
    readonly expectedRevision: number;
    readonly puts: Readonly<Record<string, string>>;
    readonly removes: readonly string[];
}
export type StoreSnapshots = Readonly<Record<NamespaceId, StoreSnapshot>>;

export class StaleRevisionError extends Error {
    constructor() {
        super('Records changed; refresh and review the operation again.');
        this.name = 'StaleRevisionError';
    }
}

export interface RecordStore {
    /** Must finish recovery before reads. Repeated calls must be safe. */
    initialize(): Promise<void>;
    /**
     * Missing namespaces return revision 0 and empty entries, without writing defaults.
     * Reads may perform adapter-owned legacy adoption/migration and revision
     * bookkeeping; they are not necessarily side-effect-free. Document those
     * writes and apply the adapter's recovery and coordination guarantees.
     */
    read(namespace: NamespaceId): Promise<StoreSnapshot>;
    /**
     * Validate keys and all expected revisions before writing anything. A native
     * adapter must commit the entire batch atomically or reject without changes.
     * Empty puts/removes still assert a read dependency, without advancing its
     * revision. Each changed namespace advances exactly once. Return every
     * requested namespace, including unchanged dependencies, after durability.
     * Reject duplicate namespaces and overlapping/duplicate keys. Never replay
     * a stale change automatically. A web adapter must document its weaker
     * crash-journal/cross-tab guarantees explicitly.
     */
    commit(changes: readonly StoreChange[]): Promise<StoreSnapshots>;
}

/** Credentials are device-local and never part of portable record snapshots. */
export interface SecretStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
}
