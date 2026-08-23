/**
 * SIGNAL — reserved slot (key 3). Not yet authored. See `looks/phosphor/index.ts` for why a
 * reserved slot renders the debug look instead of nothing.
 */

import { createDebugLook } from '../debug/index.js';
import type { Look } from '../types.js';

export const createSignalLook = (): Look =>
  createDebugLook('signal', 'signal (reserved)', 'signal — not yet authored · showing debug look');
