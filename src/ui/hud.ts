/**
 * Debug HUD, title, hint line, help card and mouse-capture prompt.
 *
 * Plain DOM on top of the canvas — no framework, no per-frame allocation beyond the
 * strings it writes, and every element is pointer-events:none.
 */

const STYLE = `
.bs-hud, .bs-hud * { box-sizing: border-box; }
.bs-hud {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfdbe4; letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0,0,0,0.85);
  --bs-panel: rgba(10,14,18,0.62);
  --bs-edge: rgba(140,180,200,0.16);
  --bs-accent: #6fd3e0;
}
.bs-debug {
  position: absolute; top: 10px; left: 10px; padding: 8px 10px;
  background: var(--bs-panel); border: 1px solid var(--bs-edge); border-radius: 4px;
  white-space: pre; min-width: 200px;
}
.bs-debug .bs-perf { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--bs-edge); color: #8fa2b0; }
.bs-title {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; background: var(--bs-panel); border: 1px solid var(--bs-edge);
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px;
  color: var(--bs-accent);
}
.bs-hint {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; background: var(--bs-panel); border: 1px solid var(--bs-edge);
  border-radius: 4px; color: #9fb1bd; white-space: nowrap; max-width: 96vw; overflow: hidden;
  text-overflow: ellipsis;
}
/* Sits above the hint line rather than under the reticle: in third person the middle of the
   screen is where the character is, and the prompt was standing on his head. */
.bs-capture {
  position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%);
  padding: 7px 14px; background: rgba(10,14,18,0.72); border: 1px solid var(--bs-edge);
  border-radius: 4px; color: #d8e6ee;
}
.bs-reticle {
  position: absolute; top: 50%; left: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
  border-radius: 50%; background: rgba(210,235,245,0.72);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.55);
}
/* §3.8's ring — "a ring around the reticle whose brightness equals your current audible radius".
   Opacity is the only thing about it that ever moves. A ring that also grew would be a second
   encoding of one quantity, and two encodings of one quantity are two things that can disagree,
   which is the exact failure §3.8 is written to prevent. It is cyan rather than the amber §3.2
   gives self-events because it is not an event and not in the world: it is chrome, reporting a
   state, and an amber disc at the centre of the screen would read as a sound that just happened.
   30 px across on purpose — tools/shoot.mjs punches a 40 px hole at the screen centre out of
   its measurement window, and the ring has to stay inside it or every pixel golden moves. */
.bs-halo {
  position: absolute; top: 50%; left: 50%; width: 30px; height: 30px; margin: -15px 0 0 -15px;
  border-radius: 50%; border: 2px solid var(--bs-accent);
}
.bs-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  padding: 20px 26px; background: rgba(8,11,15,0.93); border: 1px solid var(--bs-edge);
  border-radius: 6px; font-size: 14px; line-height: 1.9; min-width: 340px;
}
.bs-help h2 {
  margin: 0 0 12px; font-size: 12px; letter-spacing: 0.24em; text-transform: uppercase;
  color: var(--bs-accent); font-weight: 600;
}
.bs-help table { border-collapse: collapse; }
.bs-help td { padding: 1px 0; vertical-align: top; }
.bs-help td.k { color: #eef6fa; padding-right: 18px; white-space: nowrap; }
.bs-help td.v { color: #9fb1bd; }
.bs-hidden { display: none; }
`;

export interface HelpRow {
  keys: string;
  action: string;
}

/**
 * How visible the Halo ring is at the *bottom* of its range (§3.8).
 *
 * Not zero, because the bottom of the readout is not silence. `haloBrightness` reads 0 at
 * `HALO_REFERENCE_M` — 1.5 m, the radius the pitch map is referenced to — and "nothing further
 * away than a metre and a half can hear you" is a reading the player is entitled to *see*. Fade
 * the ring to nothing there and the quietest state on the dial becomes indistinguishable from a
 * HUD that is not drawing, which is the complaint §3.8 calls non-negotiable, reintroduced at the
 * one end of the range where a player is most carefully listening for an answer.
 *
 * 0.18 is the same argument §3.6's memory skeleton makes with its alpha floor of ~0.22: dim
 * enough to read as "nearly nothing", bright enough to read as *present*.
 */
export const HALO_RING_MIN_ALPHA = 0.18;

/**
 * Ring brightness (0–1, from `paint/halo`) → the ring's opacity.
 *
 * Affine and nothing more. `haloBrightness` has already done the interesting part — it is derived
 * from `humPitch`, which is what keeps the ring and the hum from disagreeing about which of two
 * states is louder — and a second curve here would undo exactly that. Anything this function does
 * beyond a floor and a scale is a place the two faces of §3.8 can drift apart.
 *
 * Out-of-range and NaN both land on the floor rather than propagating: `brightness > 0` is false
 * for NaN, and a NaN opacity is a ring that vanishes.
 */
export function haloRingAlpha(brightness: number): number {
  const b = brightness > 0 ? (brightness < 1 ? brightness : 1) : 0;
  return HALO_RING_MIN_ALPHA + b * (1 - HALO_RING_MIN_ALPHA);
}

/**
 * How far the opacity must move before the DOM is written again.
 *
 * A write-elision, not a quantization of the readout — 1/2000 is finer than the 1/255 an 8-bit
 * compositor can show, so no state the eye could distinguish is ever collapsed into another. It
 * exists because `setHalo` is called every frame (§3.8's ring is continuous, so it cannot ride
 * the HUD's tenth-of-a-second timer) and a per-frame string assignment to `style.opacity` is the
 * one allocation this file otherwise does not make.
 */
const HALO_ALPHA_EPSILON = 0.0005;


export class Hud {
  private readonly root: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;
  private readonly perfEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly captureEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly haloEl: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private helpVisible = false;
  private lastDebug = '';
  private lastPerf = '';
  private lastHaloAlpha = Number.NaN;

  constructor(parent: HTMLElement = document.body) {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = STYLE;
    document.head.append(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'bs-hud';

    this.panelEl = document.createElement('div');
    this.panelEl.className = 'bs-debug';
    this.debugEl = document.createElement('div');
    this.perfEl = document.createElement('div');
    this.perfEl.className = 'bs-perf';
    this.panelEl.append(this.debugEl, this.perfEl);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'bs-title';

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'bs-hint';

    this.captureEl = document.createElement('div');
    this.captureEl.className = 'bs-capture';

    const reticle = document.createElement('div');
    reticle.className = 'bs-reticle';

    this.haloEl = document.createElement('div');
    this.haloEl.className = 'bs-halo';
    this.setHalo(0);

    this.helpEl = document.createElement('div');
    this.helpEl.className = 'bs-help bs-hidden';

    this.root.append(
      this.haloEl,
      reticle,
      this.panelEl,
      this.titleEl,
      this.hintEl,
      this.captureEl,
      this.helpEl,
    );
    parent.append(this.root);
  }

  /**
   * Points the ring at §3.8's readout: 0 is the quietest reading, 1 the loudest.
   *
   * Takes the brightness and not the radius, because `paint/halo` is where the radius becomes a
   * reading and this class has no business knowing the scale it is drawn against. Called every
   * frame rather than from `publishHud`'s timer: §3.8 says the readout glides, and a ring
   * refreshed at 10 Hz next to a hum that glides at 60 is the two faces disagreeing on the one
   * axis the doc singles out.
   */
  setHalo(brightness: number): void {
    const alpha = haloRingAlpha(brightness);
    if (Math.abs(alpha - this.lastHaloAlpha) < HALO_ALPHA_EPSILON) return;
    this.lastHaloAlpha = alpha;
    this.haloEl.style.opacity = alpha.toFixed(3);
  }

  /** Replaces the debug block. Keys are rendered dim, values bright. */
  setDebug(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastDebug) return;
    this.lastDebug = text;
    this.debugEl.textContent = text.trimEnd();
  }

  /** Performance block, written by the boot loop rather than by the game. */
  setPerf(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastPerf) return;
    this.lastPerf = text;
    this.perfEl.textContent = text.trimEnd();
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  setCapturePrompt(text: string | null): void {
    if (text === null) {
      this.captureEl.classList.add('bs-hidden');
      return;
    }
    this.captureEl.classList.remove('bs-hidden');
    if (this.captureEl.textContent !== text) this.captureEl.textContent = text;
  }

  setHelp(rows: HelpRow[]): void {
    this.helpEl.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Controls';
    const table = document.createElement('table');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.className = 'k';
      k.textContent = row.keys;
      const v = document.createElement('td');
      v.className = 'v';
      v.textContent = row.action;
      tr.append(k, v);
      table.append(tr);
    }
    this.helpEl.append(title, table);
  }

  toggleHelp(): void {
    this.setHelpVisible(!this.helpVisible);
  }

  setHelpVisible(visible: boolean): void {
    this.helpVisible = visible;
    this.helpEl.classList.toggle('bs-hidden', !visible);
  }

  get isHelpVisible(): boolean {
    return this.helpVisible;
  }

  dispose(): void {
    this.root.remove();
    this.styleEl.remove();
  }
}
