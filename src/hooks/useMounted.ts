import { useCallback, useLayoutEffect, useRef } from 'react';

/** Admitted saves finish; a departed view must not run their UI completion. */
export function useMounted() {
    const mounted = useRef(false);
    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    return useCallback(() => mounted.current, []);
}
