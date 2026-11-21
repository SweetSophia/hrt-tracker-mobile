import { computePkSandbox } from '../../domain/engine';
import type { PkSandboxInputs, PkSandboxResult } from '../../domain/engine';
export interface SandboxRequest {
    kind: 'sandbox';
    modelId: string;
    inputs: Partial<PkSandboxInputs>;
}
export type SandboxProjection = Pick<PkSandboxResult, 'peak' | 'timeBelow200H' | 'timeBelow100H' | 'derivation'>;
export function projectSandbox(request: SandboxRequest): SandboxProjection {
    const full = computePkSandbox(request.modelId, request.inputs);
    return {
        peak: full.peak,
        timeBelow200H: full.timeBelow200H,
        timeBelow100H: full.timeBelow100H,
        derivation: full.derivation,
    };
}
