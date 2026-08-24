/**
 * Debug HUD, hint line, help card and mouse-capture prompt.
 *
 * Plain DOM on top of the canvas — no framework, no per-frame allocation beyond the
 * strings it writes, and every element is pointer-events:none except the help toggle.
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
.bs-scene {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; background: var(--bs-panel); border: 1px solid var(--bs-edge);
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px;
}
.bs-scene .bs-variant { color: var(--bs-accent); }
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

export const DEFAULT_HELP: HelpRow[] = [
  { keys: 'W A S D', action: 'move' },
  { keys: 'Shift', action: 'sprint (forward)' },
  { keys: 'C / Ctrl', action: 'crouch' },
  { keys: 'Space', action: 'jump (tap = hop, hold = full)' },
  { keys: 'Space at a ledge', action: 'climb — vault or pull-up' },
  { keys: 'V', action: 'view — first / third person' },
  { keys: 'R', action: 'respawn' },
  { keys: 'Mouse', action: 'look (click to capture, or drag)' },
  { keys: '1 - 9', action: 'scene variant' },
  { keys: '`', action: 'scene picker' },
  { keys: 'H', action: 'toggle this help' },
];

export const DEFAULT_HINT =
  'WASD move · Shift sprint · C/Ctrl crouch · Space jump/climb · V view · R respawn · H help · ` scenes';

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;
  private readonly perfEl: HTMLDivElement;
  private readonly sceneEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly captureEl: HTMLDivElement;
  private readonly helpEl: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private helpVisible = false;
  private lastDebug = '';
  private lastPerf = '';

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

    this.sceneEl = document.createElement('div');
    this.sceneEl.className = 'bs-scene';

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'bs-hint';
    this.hintEl.textContent = DEFAULT_HINT;

    this.captureEl = document.createElement('div');
    this.captureEl.className = 'bs-capture';

    const reticle = document.createElement('div');
    reticle.className = 'bs-reticle';

    this.helpEl = document.createElement('div');
    this.helpEl.className = 'bs-help bs-hidden';
    this.setHelp(DEFAULT_HELP);

    this.root.append(reticle, this.panelEl, this.sceneEl, this.hintEl, this.captureEl, this.helpEl);
    parent.append(this.root);
  }

  /** Replaces the debug block. Keys are rendered dim, values bright. */
  setDebug(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastDebug) return;
    this.lastDebug = text;
    this.debugEl.textContent = text.trimEnd();
  }

  /** Performance block, written by the harness rather than the active scene. */
  setPerf(rows: Array<[string, string]>): void {
    let text = '';
    for (const [key, value] of rows) text += `${key.padEnd(9)}${value}\n`;
    if (text === this.lastPerf) return;
    this.lastPerf = text;
    this.perfEl.textContent = text.trimEnd();
  }

  setSceneLabel(title: string, variant: string | null): void {
    this.sceneEl.textContent = title;
    if (variant !== null) {
      const span = document.createElement('span');
      span.className = 'bs-variant';
      span.textContent = ` · ${variant}`;
      this.sceneEl.append(span);
    }
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
