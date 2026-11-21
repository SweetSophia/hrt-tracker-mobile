import { memo, type ReactNode } from 'react';
import type { AppModelStatus } from '../hooks/appModelTypes';

interface PresentationProps {
    ready: boolean;
    snapshot: object;
    children: ReactNode;
}
// Retain coherent hidden estimates and their layout during readout-only work.
// Record controls and scenario editors must live outside this boundary.
// A changed record snapshot releases the old tree, including its pending effects.
const Presentation = memo(
    function Presentation({ ready, children }: PresentationProps) {
        return ready ? children : null;
    },
    (previous, next) => !next.ready && previous.snapshot === next.snapshot,
);

export function ModelBoundary({
    status,
    snapshot,
    children,
}: {
    status: AppModelStatus;
    snapshot: object;
    children: ReactNode;
}) {
    const ready = status === 'ready';
    return (
        <div
            style={{ visibility: ready ? undefined : 'hidden', opacity: ready ? undefined : 0 }}
            aria-hidden={!ready || undefined}
            {...(ready ? {} : { inert: '' })}
        >
            <Presentation ready={ready} snapshot={snapshot}>
                {children}
            </Presentation>
        </div>
    );
}
