import type { EngineOutput, EngineScreenOutput } from '../../src/application/engineProtocol';
import type { SimulationResult } from '../../src/domain/engine';

type PackedColumn<T> = T extends number[] ? Float64Array<ArrayBuffer> : T;
type PackedColumns<T> = { [Key in keyof T]: PackedColumn<T[Key]> };
type PackedSimulation = PackedColumns<SimulationResult>;
type PackedScreen = Omit<PackedColumns<EngineScreenOutput>, 'simulationAhead'> & {
    simulationAhead: PackedSimulation | null;
};
export type PackedEngineOutput = Omit<PackedColumns<EngineOutput>, 'simulation' | 'screen'> & {
    simulation: PackedSimulation | null;
    screen?: PackedScreen;
};

/** Copy the numeric columns only. The computed result stays owned by the worker for the post-frame check. */
export function packEngineOutput(output: EngineOutput): { wire: PackedEngineOutput; transfer: ArrayBuffer[] } {
    const columns = new Map<number[], Float64Array<ArrayBuffer>>();
    function packColumn(values: number[]) {
        const existing = columns.get(values);
        if (existing) return existing;
        const packed = Float64Array.from(values);
        columns.set(values, packed);
        return packed;
    }
    const packPart = <T extends object>(part: T) =>
        Object.fromEntries(
            Object.entries(part).map(([key, value]) => [key, Array.isArray(value) ? packColumn(value) : value]),
        ) as PackedColumns<T>;
    const { screen } = output;
    const wire: PackedEngineOutput = {
        ...packPart(output),
        simulation: output.simulation && packPart(output.simulation),
        screen: screen && {
            ...packPart(screen),
            simulationAhead: screen.simulationAhead && packPart(screen.simulationAhead),
        },
    };
    if (!Object.hasOwn(output, 'screen')) delete wire.screen;
    return { wire, transfer: Array.from(columns.values(), view => view.buffer) };
}

const invalid = () => new Error('Invalid transferable engine output');
function readPart(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
        throw invalid();
    return value as Record<string, unknown>;
}

const simulationColumns = ['timeH', 'concPGmL', 'concPGmL_E2', 'concPGmL_CPA', 'concPGmL_BICA', 'concNGdL_T'];
const factorColumns = ['sampleTimesH', 'factors'];

/** Restore plain arrays before the existing runner validates the result and gives it to the chart. */
export function unpackEngineOutput(value: unknown): { output: EngineOutput; transferredBytes: number } {
    const columns = new Map<ArrayBuffer, number[]>();
    let transferredBytes = 0;
    function unpackColumn(view: Float64Array) {
        const { buffer } = view;
        if (!(buffer instanceof ArrayBuffer) || view.byteOffset !== 0 || view.byteLength !== buffer.byteLength)
            throw invalid();
        const existing = columns.get(buffer);
        if (existing) return existing;
        const unpacked = Array.from(view);
        columns.set(buffer, unpacked);
        transferredBytes += buffer.byteLength;
        return unpacked;
    }
    function unpackPart(part: Record<string, unknown>, required: string[], withFactors = false) {
        if (required.some(key => !(part[key] instanceof Float64Array))) throw invalid();
        if (withFactors && part.factorSDs !== null && !(part.factorSDs instanceof Float64Array)) throw invalid();
        return Object.fromEntries(
            Object.entries(part).map(([key, field]) => {
                if (field instanceof Float64Array) return [key, unpackColumn(field)];
                if (Array.isArray(field) || ArrayBuffer.isView(field) || field instanceof ArrayBuffer) throw invalid();
                return [key, field];
            }),
        );
    }
    const unpackSimulation = (simulation: unknown): SimulationResult | null =>
        simulation === null
            ? null
            : (unpackPart(readPart(simulation), simulationColumns) as unknown as SimulationResult);

    const wire = readPart(value);
    readPart(wire.calibration);
    const output = unpackPart(wire, factorColumns, true) as unknown as EngineOutput;
    output.simulation = unpackSimulation(wire.simulation);
    if (wire.screen !== undefined) {
        const screen = readPart(wire.screen);
        output.screen = unpackPart(screen, factorColumns, true) as unknown as EngineScreenOutput;
        output.screen.simulationAhead = unpackSimulation(screen.simulationAhead);
    }
    return { output, transferredBytes };
}
