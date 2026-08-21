import type { C2S, S2C } from '../shared/proto.ts';

export class Net {
  private ws: WebSocket | null = null;
  onMsg: (m: S2C) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  ping = 0;
  private pingSentAt = 0;
  private pingN = 0;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen();
      setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        this.pingSentAt = performance.now();
        this.send({ t: 'ping', n: ++this.pingN });
      }, 2000);
    };
    ws.onmessage = (e) => {
      const m: S2C = JSON.parse(e.data);
      if (m.t === 'pong') { this.ping = performance.now() - this.pingSentAt; return; }
      this.onMsg(m);
    };
    ws.onclose = () => this.onClose();
  }

  send(m: C2S) { if (this.ws?.readyState === this.ws?.OPEN) this.ws!.send(JSON.stringify(m)); }
  get ready() { return this.ws?.readyState === WebSocket.OPEN; }
}
