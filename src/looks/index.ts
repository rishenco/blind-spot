/**
 * THE LOOK REGISTRY (engine-plan §9 "switch protocol").
 *
 * "Number keys 1/2/3 (0 = debug) hot-switch; paint state persists across switches;
 *  `?look=phosphor` boots directly."
 *
 * Switching is the whole point of the contract: three art directions are going to be compared
 * against the same painted world, live, mid-run. That comparison is only honest if the switch
 * costs nothing but materials — the paint lives in the SurfelField's buffers, which the host
 * never touches, so flipping looks re-skins the same data rather than restarting the run.
 *
 * `LookHost` is the only thing that ever calls `Look.init` / `Look.dispose`, so leak discipline
 * lives in exactly one place.
 */

import { createBlueprintLook } from './blueprint/index.js';
import { createDebugLook } from './debug/index.js';
import { createPhosphorLook } from './phosphor/index.js';
import { createSignalLook } from './signal/index.js';
import type { Look, LookContext } from './types.js';

export const LOOK_IDS = ['debug', 'phosphor', 'blueprint', 'signal'] as const;
export type LookId = (typeof LOOK_IDS)[number];

/** The engine milestone ships with the debug look up: it is the one that shows failures. */
export const DEFAULT_LOOK: LookId = 'debug';

const FACTORIES: Readonly<Record<LookId, () => Look>> = {
  debug: () => createDebugLook(),
  phosphor: createPhosphorLook,
  blueprint: createBlueprintLook,
  signal: createSignalLook,
};

/** Engine-plan §9: 0 is the debug look, 1/2/3 are the three authored directions. */
export const LOOK_BY_KEY: Readonly<Record<string, LookId>> = {
  Digit0: 'debug',
  Digit1: 'phosphor',
  Digit2: 'blueprint',
  Digit3: 'signal',
};

export const isLookId = (v: string): v is LookId => (LOOK_IDS as readonly string[]).includes(v);

/** `?look=` — an unknown or missing value falls back to the debug look rather than failing. */
export const resolveLookId = (raw: string | null | undefined): LookId =>
  raw && isLookId(raw) ? raw : DEFAULT_LOOK;

export const makeLook = (id: LookId): Look => FACTORIES[id]();

/**
 * Owns the live look: construction, disposal, and the frame calls. One instance for the process.
 *
 * The context is built ONCE and shared by every look, because the things in it (the renderer,
 * the camera, the two geometries, the event feed) are core state that a look reads and must not
 * own. `hud` is emptied on switch so a look that forgot to remove a node cannot haunt its
 * successor.
 */
export class LookHost {
  readonly ctx: LookContext;
  private currentId: LookId;
  private currentLook: Look;
  private w = 1;
  private h = 1;

  constructor(ctx: LookContext, id: LookId = DEFAULT_LOOK) {
    this.ctx = ctx;
    this.currentId = id;
    this.currentLook = makeLook(id);
    this.currentLook.init(ctx);
  }

  get id(): LookId {
    return this.currentId;
  }

  get look(): Look {
    return this.currentLook;
  }

  /** Returns false when the id is already live (so a key repeat cannot churn the GPU). */
  switchTo(id: LookId): boolean {
    if (id === this.currentId) return false;
    this.currentLook.dispose();
    // Belt and braces: the contract says a look removes its own HUD nodes, and this makes a
    // look that does not fail visibly in its own folder instead of quietly on top of the next.
    this.ctx.hud.replaceChildren();
    this.currentId = id;
    this.currentLook = makeLook(id);
    this.currentLook.init(this.ctx);
    this.currentLook.resize(this.w, this.h);
    return true;
  }

  onEvent(e: Parameters<Look['onEvent']>[0]): void {
    this.currentLook.onEvent(e);
  }

  update(now: number, dt: number): void {
    this.currentLook.update(now, dt);
  }

  render(): void {
    this.currentLook.render();
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.currentLook.resize(w, h);
  }

  dispose(): void {
    this.currentLook.dispose();
    this.ctx.hud.replaceChildren();
  }
}

export type { Look, LookContext } from './types.js';
