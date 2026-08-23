/**
 * BLUEPRINT — reserved slot (key 2). Not yet authored. See `looks/phosphor/index.ts` for why a
 * reserved slot renders the debug look instead of nothing.
 */

import { createDebugLook } from '../debug/index.js';
import type { Look } from '../types.js';

export const createBlueprintLook = (): Look =>
  createDebugLook('blueprint', 'blueprint (reserved)', 'blueprint — not yet authored · showing debug look');
