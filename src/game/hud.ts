// Minimal DOM overlay: title, result, pause, whiteout/flash. Very little text by design.

const css = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: 'Luckiest Guy', Impact, 'Arial Black', sans-serif;
  color: #fff; user-select: none; }
#hud .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  transition: opacity .35s; }
#hud .split { justify-content: space-between; padding: max(4vh, 18px) 16px max(5vh, 22px); box-sizing: border-box; }
#hud .split > div { display: flex; flex-direction: column; align-items: center; }
#hud .hidden { opacity: 0; }
#hud h1 { margin: 0; font-size: min(12vw, 13vh, 116px); letter-spacing: 2px; line-height: .9; text-align: center;
  color: #ffd23f; -webkit-text-stroke: 4px #3b1d10; paint-order: stroke fill; text-shadow: 0 8px 0 #3b1d10, 0 14px 30px rgba(0,0,0,.35);
  transform: rotate(-3deg); }
#hud .big { font-size: min(16vw, 17vh, 140px); color: #fff; -webkit-text-stroke: 5px #3b1d10; paint-order: stroke fill;
  text-shadow: 0 8px 0 #3b1d10; transform: rotate(-4deg); }
#hud .cta { margin-top: 18px; font-size: 30px; -webkit-text-stroke: 2px #3b1d10; paint-order: stroke fill; animation: pulse 1s ease-in-out infinite; }
#hud .keys { display: flex; gap: 18px; margin-top: 0; flex-wrap: wrap; justify-content: center; padding: 0 16px; }
#hud .key { display: flex; align-items: center; gap: 8px; font-size: 20px; -webkit-text-stroke: 1.5px #3b1d10; paint-order: stroke fill; }
#hud .cap { min-width: 34px; height: 34px; padding: 0 8px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  background: #fff; color: #3b1d10; border-radius: 8px; border: 3px solid #3b1d10; box-shadow: 0 4px 0 #3b1d10; font-size: 16px;
  -webkit-text-stroke: 0; }
#hud .corner { position: absolute; left: 16px; bottom: 16px; transform-origin: left bottom; transform: scale(.8); transition: opacity 1s; }
#hud .corner .keys { justify-content: flex-start; margin: 0; padding: 0; }
#hud #white { position: absolute; inset: 0; background: #fff; opacity: 0; }
#hud #flash { position: absolute; inset: 0; background: #fff6dc; opacity: 0; }
@keyframes pulse { 50% { transform: scale(1.08); } }
`;

const KEYS = `
<div class="keys">
  <div class="key"><span class="cap">W</span><span class="cap">A</span><span class="cap">S</span><span class="cap">D</span> MOVE</div>
  <div class="key"><span class="cap">SPACE</span> DODGE</div>
  <div class="key"><span class="cap">MOUSE</span> LOOK</div>
</div>`;

export class Hud {
  private title: HTMLElement;
  private result: HTMLElement;
  private resultText: HTMLElement;
  private pause: HTMLElement;
  private corner: HTMLElement;
  private white: HTMLElement;
  private flash: HTMLElement;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `
      <div id="white"></div><div id="flash"></div>
      <div class="center split" id="title"><div><h1>RAMPAGE<br>PEAK</h1></div><div>${KEYS}<div class="cta">CLICK TO FIGHT</div></div></div>
      <div class="center split hidden" id="result"><div><div class="big" id="resultText"></div></div><div><div class="cta">CLICK</div></div></div>
      <div class="center hidden" id="pause"><div class="cta">CLICK TO RESUME</div></div>
      <div class="corner hidden" id="corner">${KEYS}</div>`;
    document.body.appendChild(hud);
    const $ = (id: string) => hud.querySelector<HTMLElement>('#' + id)!;
    this.title = $('title');
    this.result = $('result');
    this.resultText = $('resultText');
    this.pause = $('pause');
    this.corner = $('corner');
    this.white = $('white');
    this.flash = $('flash');
  }

  private show(el: HTMLElement, on: boolean): void {
    el.classList.toggle('hidden', !on);
  }

  showTitle(on: boolean): void {
    this.show(this.title, on);
  }

  showResult(text: string | null): void {
    if (text) this.resultText.textContent = text;
    this.show(this.result, !!text);
  }

  showPause(on: boolean): void {
    this.show(this.pause, on);
  }

  showControls(on: boolean): void {
    this.show(this.corner, on);
  }

  setWhiteout(v: number): void {
    this.white.style.opacity = String(Math.max(0, Math.min(1, v)));
  }

  setFlash(v: number): void {
    this.flash.style.opacity = String(Math.max(0, Math.min(1, v)));
  }
}
