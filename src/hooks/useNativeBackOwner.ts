import { createContext, createElement, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { appBackOwners, BACK_PRIORITY } from '../application/backNavigation';

const ActiveBackScope = createContext(true);

/** Retained, inert forms and all their nested inputs must relinquish native Back together. */
export function NativeBackScope({ active, children }: { active: boolean; children: ReactNode }) {
    const parent = useContext(ActiveBackScope);
    return createElement(ActiveBackScope.Provider, { value: parent && active }, children);
}

/** Adds native Back ownership without changing the component's web/Escape behavior. */
export function useNativeBackOwner(handle: () => void, active = true, priority: number = BACK_PRIORITY.form) {
    const inScope = useContext(ActiveBackScope);
    const current = useRef(handle);
    useLayoutEffect(() => {
        current.current = handle;
    });
    useEffect(() => {
        if (!active || !inScope) return;
        return appBackOwners.register(priority, () => current.current());
    }, [active, inScope, priority]);
}
