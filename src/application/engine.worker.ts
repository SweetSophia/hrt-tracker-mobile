import { executeDemoTask } from './demoTask';
import { DemoProjectionCache } from './demoProjection';
import { executeEngineTask } from './engineTask';
import { executeForecastTask, type ForecastTaskCache } from './forecastTask';
import type { EngineWorkerRequest, EngineWorkerResponse } from './engineProtocol';
import { EngineTaskCache } from './engineTaskCache';

const cache = new EngineTaskCache();
const forecasts: ForecastTaskCache = new Map();
const demos = new DemoProjectionCache();

// The entry has no React, record-store, DOM or remote-service dependency.
const port = globalThis as unknown as {
    onmessage: ((event: { data: EngineWorkerRequest }) => void) | null;
    postMessage(response: EngineWorkerResponse): void;
};
port.onmessage = ({ data }) => {
    if (
        !data ||
        data.version !== 1 ||
        (data.kind !== 'calculate' && data.kind !== 'forecast' && data.kind !== 'demo') ||
        !Number.isSafeInteger(data.id) ||
        data.id <= 0
    )
        return;
    port.postMessage({ version: 1, kind: 'started', id: data.id });
    try {
        if (data.kind === 'demo')
            port.postMessage({
                version: 1,
                kind: 'demo-result',
                id: data.id,
                output: executeDemoTask(data.input, demos),
            });
        else if (data.kind === 'forecast')
            port.postMessage({
                version: 1,
                kind: 'forecast-result',
                id: data.id,
                output: executeForecastTask(data.input, forecasts),
            });
        else
            port.postMessage({ version: 1, kind: 'result', id: data.id, output: executeEngineTask(data.input, cache) });
    } catch {
        port.postMessage({ version: 1, kind: 'error', id: data.id });
    }
};
