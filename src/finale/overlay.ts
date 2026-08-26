export type FinaleKind = 'playing' | 'won' | 'dead';

/**
 * A deliberately separate layer from the normal HUD. The end of a round is not another status
 * message: death leaves the hall on screen, while victory gets its own small scene in WebGL.
 * This DOM layer is text only. It owns no game state and can therefore be driven deterministically by scene
 * time in the harness.
 */
export class FinaleOverlay {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private kind: FinaleKind = 'playing';

  constructor(parent: HTMLElement = document.body) {
    const style = document.createElement('style');
    style.textContent = `
      .bs-finale { position:fixed; inset:0; z-index:20; pointer-events:none; display:none;
        font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#eef6fa;
        text-align:center; overflow:hidden; }
      .bs-finale.show { display:block; }
      .bs-finale .card { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        padding:18px 26px; min-width:280px; background:rgba(3,5,8,.62); border:1px solid rgba(190,220,235,.35);
        text-shadow:0 2px 5px #000; letter-spacing:.14em; }
      .bs-finale .title { font-size:20px; letter-spacing:.28em; }
      .bs-finale .detail { margin-top:8px; color:rgba(225,240,248,.75); font-size:12px; letter-spacing:.07em; }
    `;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'bs-finale';
    this.card = document.createElement('div'); this.card.className = 'card';
    this.title = document.createElement('div'); this.title.className = 'title';
    this.detail = document.createElement('div'); this.detail.className = 'detail';
    this.card.append(this.title, this.detail); this.root.append(this.card); parent.append(this.root);
  }

  show(kind: Exclude<FinaleKind, 'playing'>, elapsedSeconds: number): void {
    this.kind = kind;
    this.root.className = `bs-finale show ${kind}`;
    if (kind === 'dead') {
      this.title.textContent = 'GAME OVER';
      this.detail.textContent = 'ENTER TO RESTART';
    } else {
      this.title.textContent = 'YOU GOT OUT';
      this.detail.textContent = `${formatTime(elapsedSeconds)}  ·  ENTER TO RESTART`;
    }
  }

  hide(): void { this.kind = 'playing'; this.root.className = 'bs-finale'; }
  state(): FinaleKind { return this.kind; }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}
