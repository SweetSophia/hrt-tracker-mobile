import { executeEngineTask } from '../../src/application/engineTask';
import type { EngineOutput } from '../../src/application/engineProtocol';
import {
    digestDeliveryOutput,
    isUnstagedDelivery,
    type DeliveryCommand,
    type DeliveryMessage,
} from './rendererDelivery';
import { packEngineOutput } from './transferableEngineOutput';

const port = globalThis as unknown as {
    onmessage: ((event: { data: DeliveryCommand }) => Promise<void>) | null;
    postMessage(message: DeliveryMessage, transfer?: ArrayBuffer[]): void;
};

let pending:
    | {
          id: number;
          mode: Extract<DeliveryCommand, { kind: 'prepare' }>['mode'];
          output: EngineOutput;
          released: boolean;
      }
    | undefined;
port.onmessage = async ({ data }) => {
    const id = data.kind === 'prepare' ? data.request.id : data.id;
    try {
        if (data.kind === 'prepare') {
            if (pending) return;
            port.postMessage({ kind: 'started', id, version: 1 });
            const output = executeEngineTask(data.request.input);
            pending = { id, output, mode: data.mode, released: false };
            port.postMessage(data.mode ? { kind: 'ready', id } : { kind: 'prepared', id, output });
            return;
        }
        if (pending?.id !== id) return;
        const { output, mode: preparedMode, released } = pending;
        if (data.kind === 'verify' && released && preparedMode) {
            pending = undefined;
            const sha256 = await digestDeliveryOutput(JSON.stringify(output));
            port.postMessage({ kind: 'verified', id, sha256 });
        } else if (data.kind === 'release' && !released) {
            const { mode } = data;
            if (preparedMode !== (isUnstagedDelivery(mode) ? mode : undefined))
                throw new Error('Renderer delivery mode changed');
            if (preparedMode) pending.released = true;
            else pending = undefined;
            if (mode === 'transferable') {
                const { wire, transfer } = packEngineOutput(output);
                port.postMessage({ kind: 'delivery', id, mode, output: wire }, transfer);
                if (transfer.some(buffer => buffer.byteLength !== 0))
                    throw new Error('Result buffers did not transfer');
            } else if (mode === 'preloaded') port.postMessage({ kind: 'delivery', id, mode });
            else port.postMessage({ kind: 'delivery', id, mode, output });
        }
    } catch {
        pending = undefined;
        port.postMessage({ kind: 'error', id, version: 1 });
    }
};
