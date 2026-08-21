// BLIND SPOT server: room registry + 20Hz authoritative tick.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, type Sink } from './room.ts';
import { TICK_HZ } from '../shared/config.ts';
import type { C2S, S2C } from '../shared/proto.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = join(process.cwd(), 'dist');

// Unambiguous alphabet: no O/0, no I/1.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map<string, Room>();

function newCode(): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('room code space exhausted');
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// Serves the built client when one exists; in dev, Vite does this and proxies /ws here.
const http = createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  try {
    const url = (req.url ?? '/').split('?')[0]!;
    let p = normalize(join(DIST, url === '/' ? '/index.html' : url));
    if (!p.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
    let s = await stat(p).catch(() => null);
    if (!s?.isFile()) { p = join(DIST, 'index.html'); s = await stat(p).catch(() => null); }
    if (!s?.isFile()) { res.writeHead(404); res.end('build the client first: npm run build'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(500); res.end(); }
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let player: ReturnType<Room['add']> = null;

  const sink: Sink = {
    send(m: S2C) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    close() { ws.close(); },
  };
  const err = (msg: string) => sink.send({ t: 'err', msg });

  ws.on('message', (raw) => {
    let m: C2S;
    try { m = JSON.parse(String(raw)); } catch { return; }

    if (m.t === 'create') {
      if (room) return;
      const code = newCode();
      const r = new Room(code);
      r.onEmpty = () => rooms.delete(code);
      rooms.set(code, r);
      room = r;
      player = r.add(String(m.name ?? 'PLAYER').slice(0, 16) || 'PLAYER', sink);
      console.log(`[room ${code}] created (${rooms.size} live)`);
      return;
    }
    if (m.t === 'join') {
      if (room) return;
      const code = String(m.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const r = rooms.get(code);
      if (!r) return err('NO SUCH ROOM');
      if (r.phase !== 'lobby') return err('MATCH ALREADY RUNNING');
      const p = r.add(String(m.name ?? 'PLAYER').slice(0, 16) || 'PLAYER', sink);
      if (!p) return err('ROOM IS FULL');
      room = r; player = p;
      console.log(`[room ${code}] joined`);
      return;
    }
    if (!room || !player) return;
    room.handle(player, m);
  });

  ws.on('close', () => { if (room && player) room.remove(player); });
  ws.on('error', () => { if (room && player) room.remove(player); });
});

const DT = 1 / TICK_HZ;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  for (const r of rooms.values()) r.tick(dt);
}, Math.round(1000 * DT));

http.listen(PORT, () => console.log(`BLIND SPOT server on :${PORT} (ws /ws, ${TICK_HZ}Hz)`));
