import { getBuildTarget } from '../platform/runtime';
import { useWebAppModel } from './useWebAppModel';
import { useWorkerAppModel } from './useWorkerAppModel';

// Build target is immutable for this module's lifetime; hook order cannot switch.
export const useAppModel = getBuildTarget() === 'mobile' ? useWorkerAppModel : useWebAppModel;
