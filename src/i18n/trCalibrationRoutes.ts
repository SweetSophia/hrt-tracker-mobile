import type { Route } from '../domain/types';

export const TR_CALIBRATION_ROUTES = {
    'cal.route.injection': 'enjeksiyon',
    'cal.route.sc': 'deri altı enjeksiyon',
    'cal.route.nasal': 'burun spreyi',
    'cal.route.pellet': 'pelet',
    'cal.route.oral': 'oral',
    'cal.route.sublingual': 'dil altı',
    'cal.route.gel': 'jel',
    'cal.route.patchApply': 'bant',
} as const satisfies Record<`cal.route.${Exclude<Route, Route.patchRemove>}`, string>;
