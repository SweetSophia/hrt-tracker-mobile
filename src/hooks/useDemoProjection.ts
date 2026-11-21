import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DemoCompute, DemoKind, DemoOutput, DemoRequest, DemoValueMap } from '../application/demoProtocol';
import { projectDemo, DemoProjectionCache } from '../application/demoProjection';
import { getActivePKParams } from '../domain/engine';
import { getBuildTarget } from '../platform/runtime';
import type { AppModelStatus } from './appModelTypes';
const requiresWorker = getBuildTarget() === 'mobile';
/** Controls belong to the page; only a matching complete illustration is published. */
export function useDemoProjection<K extends DemoKind>(
    request: Extract<DemoRequest, { kind: K }>,
    compute?: DemoCompute,
) {
    const key = JSON.stringify(request);
    const captured = useMemo(() => JSON.parse(key) as DemoRequest, [key]);
    const [cache] = useState(() => new DemoProjectionCache());
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => setAttempt(n => n + 1), []);
    const [published, setPublished] = useState<{
        key: string;
        compute?: DemoCompute;
        attempt: number;
        output?: DemoOutput;
        failed?: boolean;
    } | null>(null);
    const web = useMemo(() => {
        if (requiresWorker) return null;
        try {
            return {
                output: projectDemo(
                    // eslint-disable-next-line react-hooks/purity -- Retain the synchronous web input snapshot clock.
                    { request: captured, nowMs: Date.now(), pkParams: getActivePKParams() },
                    cache,
                ),
                failed: false,
            };
        } catch {
            return { output: undefined, failed: true };
        }
    }, [captured, attempt, cache]);
    useEffect(() => {
        if (!requiresWorker) return;
        let active = true;
        const abort = new AbortController();
        const timer = window.setTimeout(async () => {
            try {
                if (!compute) throw new Error('Demo worker unavailable.');
                const output = await compute(captured, { signal: abort.signal });
                if (active) setPublished({ key, compute, attempt, output });
            } catch {
                if (active) setPublished({ key, compute, attempt, failed: true });
            }
        }, 80);
        return () => {
            active = false;
            window.clearTimeout(timer);
            abort.abort();
        };
    }, [captured, key, compute, attempt]);
    const matching = published?.key === key && published.compute === compute && published.attempt === attempt;
    const output = requiresWorker ? (matching ? published.output : undefined) : web?.output;
    const status: AppModelStatus = requiresWorker
        ? !matching
            ? 'pending'
            : published.failed
              ? 'error'
              : 'ready'
        : web?.failed
          ? 'error'
          : 'ready';
    return { value: (output?.value ?? null) as DemoValueMap[K] | null, status, retry };
}
