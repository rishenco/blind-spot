/**
 * Scene picker overlay: the lab's front door. Backquote toggles it, clicking a row
 * activates that scene. Kept deliberately dumb — it only reports a selection.
 */

import { listScenes, type SceneEntry } from './registry';

const STYLE = `
.bs-picker {
  position: fixed; inset: 0; z-index: 20; display: flex; align-items: center;
  justify-content: center; background: rgba(4,6,9,0.78); backdrop-filter: blur(2px);
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #cfdbe4;
}
.bs-picker.bs-hidden { display: none; }
.bs-picker-card {
  min-width: 380px; max-width: 90vw; max-height: 80vh; overflow: auto;
  background: rgba(10,14,18,0.96); border: 1px solid rgba(140,180,200,0.2);
  border-radius: 6px; padding: 18px 20px;
}
.bs-picker-card h2 {
  margin: 0 0 14px; font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
  color: #6fd3e0; font-weight: 600;
}
.bs-picker-row {
  display: flex; align-items: baseline; gap: 12px; width: 100%; text-align: left;
  padding: 8px 10px; margin: 2px 0; cursor: pointer; border-radius: 4px;
  background: rgba(255,255,255,0.03); border: 1px solid transparent; color: inherit;
  font: inherit;
}
.bs-picker-row:hover { background: rgba(111,211,224,0.12); border-color: rgba(111,211,224,0.35); }
.bs-picker-row.bs-active { border-color: rgba(111,211,224,0.55); }
.bs-picker-row .bs-title { flex: 1; color: #eef6fa; }
.bs-picker-row .bs-id { color: #7f929f; font-size: 11px; }
.bs-picker-foot { margin-top: 12px; color: #7f929f; font-size: 11px; }
`;

export class ScenePicker {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private visible = false;
  private activeId: string | null = null;

  constructor(
    private readonly onSelect: (id: string) => void,
    parent: HTMLElement = document.body,
  ) {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = STYLE;
    document.head.append(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'bs-picker bs-hidden';

    const card = document.createElement('div');
    card.className = 'bs-picker-card';

    const title = document.createElement('h2');
    title.textContent = 'Blind Spot — Lab Scenes';

    this.list = document.createElement('div');

    const foot = document.createElement('div');
    foot.className = 'bs-picker-foot';
    foot.textContent = '` or Esc to close · 1-9 switch variants of the active scene';

    card.append(title, this.list, foot);
    this.root.append(card);
    parent.append(this.root);

    this.root.addEventListener('mousedown', (e) => {
      // Click outside the card closes; the canvas must not receive this click.
      e.stopPropagation();
      if (e.target === this.root) this.setVisible(false);
    });
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.rebuild();
  }

  private rebuild(): void {
    this.list.replaceChildren();
    for (const entry of listScenes()) this.list.append(this.makeRow(entry));
  }

  private makeRow(entry: SceneEntry): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bs-picker-row' + (entry.id === this.activeId ? ' bs-active' : '');
    const title = document.createElement('span');
    title.className = 'bs-title';
    title.textContent = entry.title;
    const id = document.createElement('span');
    id.className = 'bs-id';
    id.textContent = `#${entry.id}`;
    row.append(title, id);
    row.addEventListener('click', () => {
      this.setVisible(false);
      this.onSelect(entry.id);
    });
    return row;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setVisible(visible: boolean): void {
    if (visible) this.rebuild();
    this.visible = visible;
    this.root.classList.toggle('bs-hidden', !visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    this.root.remove();
    this.styleEl.remove();
  }
}
