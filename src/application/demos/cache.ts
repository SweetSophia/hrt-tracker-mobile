/** Per worker or web hook; values never cross the message boundary. */
export class DemoProjectionCache {
    private values = new Map<string, unknown>();
    read<T>(parts: unknown[], build: () => T): T {
        const key = JSON.stringify(parts);
        if (this.values.has(key)) return this.values.get(key) as T;
        if (this.values.size > 40) this.values.clear();
        const value = build();
        this.values.set(key, value);
        return value;
    }
}
export function clock<T>(nowMs: number, run: () => T): T {
    const before = Date.now;
    try {
        Date.now = () => nowMs;
        return run();
    } finally {
        Date.now = before;
    }
}
