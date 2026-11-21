import type { DeliveryMark } from './rendererDelivery';

type RendererPhase = 'action' | 'post' | 'started' | 'result' | 'cancel' | 'frame';

/** Optional instrumentation only; use the trace's captured clock rather than a later sample. */
export function markRendererPhase(
    phase: RendererPhase | DeliveryMark,
    workerId: number,
    requestId: number,
    startTime: number,
) {
    if (Reflect.get(window, '__hrtRendererProfileArmed') !== true) return;
    performance.mark(`hrt.renderer.${phase}.${workerId}.${requestId}`, { startTime });
}
