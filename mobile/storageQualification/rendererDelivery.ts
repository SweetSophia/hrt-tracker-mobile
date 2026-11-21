import type { EngineOutput, EngineRequest, EngineResponse } from '../../src/application/engineProtocol';
import { unpackEngineOutput, type PackedEngineOutput } from './transferableEngineOutput';

type UnstagedDeliveryMode = 'direct' | 'transferable';
export type DeliveryMode = 'worker' | 'preloaded' | UnstagedDeliveryMode;
export type DeliveryMark = 'delivery-release' | 'delivery-callback' | 'delivery-read' | 'delivery-accept';
export type DeliveryCommand =
    | { kind: 'prepare'; request: EngineRequest; mode?: UnstagedDeliveryMode }
    | { kind: 'release'; id: number; mode: DeliveryMode }
    | { kind: 'verify'; id: number };
export type DeliveryMessage =
    | Extract<EngineResponse, { kind: 'started' | 'error' }>
    | { kind: 'prepared'; id: number; output: EngineOutput }
    | { kind: 'ready'; id: number }
    | { kind: 'delivery'; id: number; mode: 'worker' | 'direct'; output: EngineOutput }
    | { kind: 'delivery'; id: number; mode: 'preloaded' }
    | { kind: 'delivery'; id: number; mode: 'transferable'; output: PackedEngineOutput }
    | { kind: 'verified'; id: number; sha256: string };

export const isUnstagedDelivery = (mode: DeliveryMode | undefined): mode is UnstagedDeliveryMode =>
    mode === 'direct' || mode === 'transferable';

export async function digestDeliveryOutput(json: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

type DeliveryPort = Pick<Worker, 'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'>;
type DeliveryHooks = {
    deliver(response: EngineResponse): void;
    mark(phase: DeliveryMark, time: number): void;
    failed(): void;
};

/** Route the selected measured reply to the real runner and check its output after the chart. */
export function startRendererDelivery(
    port: DeliveryPort,
    request: EngineRequest,
    mode: DeliveryMode,
    hooks: DeliveryHooks,
) {
    const unstaged = isUnstagedDelivery(mode);
    let phase: 'starting' | 'working' | 'ready' | 'released' | 'delivered' | 'closed' = 'starting';
    let staged: EngineOutput | undefined, delivered: EngineOutput | undefined;
    let reply: Extract<DeliveryMessage, { kind: 'delivery' }> | undefined;
    let transferredBytes: number | undefined;
    let proof:
        | { timer: ReturnType<typeof setTimeout>; receive?: (hash: string) => void; reject(error: Error): void }
        | undefined;
    let frame: number | undefined;
    let releaseAt: number, callbackAt: number, readAt: number, acceptedAt: number | undefined;

    const close = () => {
        if (phase === 'closed') return;
        phase = 'closed';
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        if (proof) {
            clearTimeout(proof.timer);
            proof.reject(new Error('Renderer delivery verification interrupted'));
            proof = undefined;
        }
        port.onmessage = port.onerror = port.onmessageerror = null;
        port.terminate();
    };
    const rejectPending = (afterClose?: () => void) => {
        if (phase === 'closed') return;
        close();
        afterClose?.();
        if (acceptedAt === undefined) hooks.deliver({ kind: 'error', id: request.id, version: request.version });
    };
    const fail = () => rejectPending(() => hooks.failed());
    const post = (command: DeliveryCommand) => {
        try {
            port.postMessage(command);
        } catch {
            fail();
        }
    };

    const awaitProof = (serialized: string) => {
        if (phase !== 'delivered' || proof)
            return Promise.reject(new Error('Renderer delivery verification is unavailable'));
        const worker = Promise.withResolvers<string>();
        const cancellation = Promise.withResolvers<never>();
        proof = { timer: setTimeout(fail, 15_000), receive: worker.resolve, reject: cancellation.reject };
        const hashes = Promise.race([
            Promise.all([worker.promise, digestDeliveryOutput(serialized)]),
            cancellation.promise,
        ]);
        post({ kind: 'verify', id: request.id });
        return hashes;
    };

    port.onmessage = event => {
        const entered = performance.now();
        let message: DeliveryMessage;
        try {
            message = event.data as DeliveryMessage;
        } catch {
            fail();
            return;
        }
        const decoded = performance.now();
        if (!message || message.id !== request.id) {
            fail();
            return;
        }
        if (phase === 'starting' && message.kind === 'started' && message.version === request.version) {
            phase = 'working';
            hooks.deliver(message);
            return;
        }
        if (
            phase === 'working' &&
            (unstaged
                ? message.kind === 'ready' && Object.keys(message).length === 2
                : message.kind === 'prepared' && message.output)
        ) {
            if (message.kind === 'prepared') staged = message.output;
            phase = 'ready';
            frame = window.requestAnimationFrame(() => {
                frame = window.requestAnimationFrame(() => {
                    frame = undefined;
                    phase = 'released';
                    releaseAt = performance.now();
                    hooks.mark('delivery-release', releaseAt);
                    post({ kind: 'release', id: request.id, mode });
                });
            });
            return;
        }
        if (proof?.receive && message.kind === 'verified' && /^[a-f0-9]{64}$/.test(message.sha256)) {
            const { receive } = proof;
            proof.receive = undefined;
            receive(message.sha256);
            return;
        }
        if (phase === 'released' && message.kind === 'delivery' && message.mode === mode) {
            try {
                if (message.mode === 'transferable') {
                    const unpacked = unpackEngineOutput(message.output);
                    delivered = unpacked.output;
                    transferredBytes = unpacked.transferredBytes;
                } else delivered = message.mode === 'preloaded' ? staged : message.output;
            } catch {
                fail();
                return;
            }
            if (delivered) {
                phase = 'delivered';
                reply = message;
                callbackAt = entered;
                readAt = decoded;
                hooks.mark('delivery-callback', callbackAt);
                hooks.mark('delivery-read', readAt);
                hooks.deliver({ kind: 'result', id: request.id, version: request.version, output: delivered });
                return;
            }
        }
        fail();
    };
    port.onerror = event => {
        event.preventDefault();
        fail();
    };
    port.onmessageerror = fail;
    post(unstaged ? { kind: 'prepare', request, mode } : { kind: 'prepare', request });
    return {
        close,
        stop: () => rejectPending(),
        accept(value: unknown, now: number) {
            if (phase !== 'delivered' || delivered !== value || acceptedAt !== undefined) return false;
            acceptedAt = now;
            hooks.mark('delivery-accept', now);
            return true;
        },
        async report(frameAt: number) {
            const clocks = [releaseAt, callbackAt, readAt, acceptedAt, frameAt];
            const original = unstaged ? delivered : staged;
            const clocksReady = clocks.every((clock, index) => {
                if (typeof clock !== 'number' || !Number.isFinite(clock)) return false;
                if (index === 0) return true;
                const previous = clocks[index - 1];
                return typeof previous === 'number' && clock >= previous;
            });
            if (!original || !delivered || !reply || !clocksReady || frameAt <= releaseAt)
                throw new Error('Incomplete renderer delivery');
            if (acceptedAt === undefined) throw new Error('Incomplete renderer delivery');
            if (mode === 'preloaded' && Object.keys(reply).length !== 3)
                throw new Error('Preloaded delivery contained extra fields');
            // Serialize after the frame endpoint so evidence work is outside the timed window.
            const encoder = new TextEncoder();
            const serialized = JSON.stringify(original);
            if (unstaged) {
                try {
                    const [expected, actual] = await awaitProof(serialized);
                    if (phase === 'closed') throw new Error('Renderer delivery verification interrupted');
                    if (expected !== actual) throw new Error('Renderer delivery output changed');
                } finally {
                    close();
                }
            } else if (delivered !== original && serialized !== JSON.stringify(delivered)) {
                throw new Error('Renderer delivery output changed');
            }
            const replyJson =
                mode === 'transferable'
                    ? JSON.stringify(reply, (_key, value) => (value instanceof Float64Array ? null : value))
                    : JSON.stringify(reply);
            return {
                mode,
                sameOutput: true,
                outputBytes: encoder.encode(serialized).length,
                replyBytes: encoder.encode(replyJson).length + (transferredBytes ?? 0),
                ...(transferredBytes === undefined ? {} : { transferredBytes }),
                metrics: {
                    releaseToCallbackMs: callbackAt - releaseAt,
                    callbackToReadMs: readAt - callbackAt,
                    readToAcceptedMs: acceptedAt - readAt,
                    acceptedToFrameMs: frameAt - acceptedAt,
                    releaseToFrameMs: frameAt - releaseAt,
                },
            };
        },
    };
}
