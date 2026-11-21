import type { DemoTaskInput, DemoOutput } from '../../src/application/demoProtocol';
import type { Page } from '@playwright/test';
import { baseStorage } from '../helpers';
import type {
    EngineInput,
    EngineOutput,
    EngineWorkerRequest,
    ForecastTaskInput,
} from '../../src/application/engineProtocol';
import type { ForecastProjection } from '../../src/application/forecastProjection';

interface WorkerScreenState {
    hold: boolean;
    holdForecast: boolean;
    holdDemo: boolean;
    fail: boolean;
    failForecast: boolean;
    failDemo: boolean;
    failMethod?: EngineInput['calibrationMethod'];
    requests: { input: EngineInput }[];
    results: EngineOutput[];
    forecastRequests: ForecastTaskInput[];
    forecastResults: { input: ForecastTaskInput; output: ForecastProjection; workerId: number }[];
    demoRequests: DemoTaskInput[];
    demoResults: { input: DemoTaskInput; output: DemoOutput; workerId: number }[];
    demoWorkerIds: number[];
    modelWorkerIds: number[];
    forecastWorkerIds: number[];
    workersCreated: number;
    pending: (() => void)[];
    release(): void;
}
declare global {
    interface Window {
        screenWorkerTest: WorkerScreenState;
    }
}

export async function observeWorkers(
    page: Page,
    initial: {
        hold?: boolean;
        holdForecast?: boolean;
        holdDemo?: boolean;
        fail?: boolean;
        failForecast?: boolean;
        failDemo?: boolean;
        failMethod?: EngineInput['calibrationMethod'];
    } = {},
) {
    await page.addInitScript(controls => {
        const state: WorkerScreenState = {
            hold: controls.hold ?? false,
            holdForecast: controls.holdForecast ?? false,
            holdDemo: controls.holdDemo ?? false,
            fail: controls.fail ?? false,
            failForecast: controls.failForecast ?? false,
            failDemo: controls.failDemo ?? false,
            failMethod: controls.failMethod,
            requests: [],
            results: [],
            forecastRequests: [],
            forecastResults: [],
            demoRequests: [],
            demoResults: [],
            demoWorkerIds: [],
            modelWorkerIds: [],
            forecastWorkerIds: [],
            workersCreated: 0,
            pending: [],
            release() {
                this.hold = this.holdForecast = this.holdDemo = false;
                for (const send of this.pending.splice(0)) send();
            },
        };
        window.screenWorkerTest = state;
        window.Worker = new Proxy(window.Worker, {
            construct(target, args) {
                if (state.fail) throw new Error('synthetic worker unavailable');
                const worker: Worker = Reflect.construct(target, args);
                const workerId = ++state.workersCreated;
                const requests = new Map<number, EngineWorkerRequest>();
                worker.addEventListener('message', event => {
                    const result = event.data;
                    if (result?.kind === 'result') state.results.push(result.output);
                    if (result?.kind === 'demo-result') {
                        const request = requests.get(result.id);
                        if (request?.kind === 'demo')
                            state.demoResults.push({ input: request.input, output: result.output, workerId });
                    }
                    if (result?.kind === 'forecast-result') {
                        const request = requests.get(result.id);
                        if (request?.kind === 'forecast')
                            state.forecastResults.push({ input: request.input, output: result.output, workerId });
                    }
                });
                const post = worker.postMessage.bind(worker);
                worker.postMessage = (message: unknown) => {
                    const request = message as EngineWorkerRequest;
                    requests.set(request.id, request);
                    if (request.kind === 'calculate') {
                        state.requests.push(request);
                        state.modelWorkerIds.push(workerId);
                        if (state.failMethod !== undefined && state.failMethod === request.input.calibrationMethod)
                            throw new Error('synthetic method failure');
                    } else if (request.kind === 'forecast') {
                        state.forecastRequests.push(request.input);
                        state.forecastWorkerIds.push(workerId);
                        if (state.failForecast) throw new Error('synthetic Forecast failure');
                    }
                    if (request.kind === 'demo') {
                        state.demoRequests.push(request.input);
                        state.demoWorkerIds.push(workerId);
                        if (state.failDemo) throw new Error('synthetic demo failure');
                    }
                    if (
                        state.hold ||
                        (state.holdForecast && request.kind === 'forecast') ||
                        (state.holdDemo && request.kind === 'demo')
                    )
                        state.pending.push(() => post(message));
                    else post(message);
                };
                return worker;
            },
        });
    }, initial);
}
export const seed = () => {
    const hour = Date.now() / 3_600_000;
    const event = { timeH: hour - 24, route: 'injection', extras: {} };
    return baseStorage({
        'hrt-events': JSON.stringify([{ ...event, id: 'synthetic-f', ester: 'EV', doseMG: 4 }]),
        'hrt-masc-events': JSON.stringify([{ ...event, id: 'synthetic-m', ester: 'TE', doseMG: 50 }]),
        'hrt-lab-results': JSON.stringify([
            { id: 'synthetic-lab', timeH: hour - 8.123, concValue: 100, unit: 'pg/ml' },
        ]),
        'hrt-cal-method': 'ou_kalman',
        'hrt-cal-history-mode': 'forward',
    });
};
export const resultCount = (page: Page) => page.evaluate(() => window.screenWorkerTest.results.length as number);
