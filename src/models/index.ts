import type { ModelDef } from './types';

// Lazy registry so a broken model doesn't break the others while they're being designed.
export const MODELS: Record<string, () => Promise<{ default: ModelDef }>> = {
  player: () => import('./player'),
  ram: () => import('./ram'),
  world: () => import('./world'),
};
