import type { BackPort } from '../platform/contracts/lifecycle';

export const BACK_PRIORITY = { form: 10, input: 20, prompt: 30 } as const;

/** Explicit owners keep one native Back from closing an interaction and navigating underneath it. */
export class BackOwners {
    private owners: { priority: number; handle: () => void }[] = [];
    register(priority: number, handle: () => void): () => void {
        const owner = { priority, handle };
        this.owners.push(owner);
        return () => {
            this.owners = this.owners.filter(item => item !== owner);
        };
    }
    handle(): boolean {
        let selected: (typeof this.owners)[number] | undefined;
        for (const owner of this.owners) if (!selected || owner.priority >= selected.priority) selected = owner;
        if (!selected) return false;
        selected.handle();
        return true;
    }
}

export const appBackOwners = new BackOwners();

/** Registration may finish after cleanup (including StrictMode). Never remove another subscriber's listeners. */
export function connectBackNavigation(
    port: BackPort,
    owners: BackOwners,
    navigateBack: () => boolean,
    reportError: (error: unknown) => void,
): () => void {
    let stopped = false,
        leaving = false;
    let remove: (() => Promise<void>) | undefined;
    const back = async () => {
        if (stopped || leaving) return;
        try {
            if (owners.handle() || navigateBack()) return;
            leaving = true;
            await port.leaveRoot();
        } catch (error) {
            reportError(error);
        } finally {
            leaving = false;
        }
    };
    void (async () => {
        try {
            const dispose = await port.listenBack(() => {
                void back();
            });
            if (stopped) await dispose();
            else remove = dispose;
        } catch (error) {
            reportError(error);
        }
    })();
    return () => {
        if (stopped) return;
        stopped = true;
        if (remove) void remove().catch(reportError);
    };
}
