/**
 * PHOSPHOR — reserved slot (key 1). Not yet authored.
 *
 * The three art directions (phosphor, blueprint, signal) are built in parallel against the look
 * contract in a later phase; this milestone owns the CONTRACT and the switching machinery, not
 * the art. Until the real look lands, key 1 renders the debug look under its own id so that the
 * hot-switch path is exercised for real — a switch that disposes materials, rebuilds a scene and
 * leaves the shared paint buffers untouched — and it says so on screen rather than pretending to
 * be an art direction (vision §1.2: the system never lies).
 *
 * When the real phosphor look is written it replaces this file wholesale. Nothing outside this
 * folder changes except the one line in `looks/index.ts`.
 */

import { createDebugLook } from '../debug/index.js';
import type { Look } from '../types.js';

export const createPhosphorLook = (): Look =>
  createDebugLook('phosphor', 'phosphor (reserved)', 'phosphor — not yet authored · showing debug look');
