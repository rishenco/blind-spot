// Captures what the game ACTUALLY looks like in play: a player who has walked a route and
// scanned along the way, so the frame contains accumulated blue memory plus a fresh cone.
import { launch, openGame, settle, shot, place, solo, pulse } from './shot.ts';
import type { Page } from 'playwright';

const b = await launch();
const p = await openGame(b, undefined, 1280, 760);
await solo(p);

/** Teleport along a path so the touch radius lays down a trail, pulsing at each stop. */
async function walk(route: [number, number, number][], pulseAt: number[]) {
  for (let i = 0; i < route.length; i++) {
    const [x, z, yaw] = route[i]!;
    await place(p, x, z, yaw, 0);
    await settle(p, 0.35);
    if (pulseAt.includes(i)) { await pulse(p); await settle(p, 1.1); }
  }
}

// A run from the Concourse, down the Spine, into the Well.
await walk([
  [23, 11.5, Math.PI / 2],
  [18, 11.5, Math.PI / 2],
  [13, 11.5, Math.PI / 2],
  [8, 11.5, Math.PI * 0.75],
  [6, 17, Math.PI],
  [6, 23, Math.PI],
  [7, 26.5, -Math.PI / 2],
  [13, 26.5, -Math.PI / 2],
  [19, 26.5, -Math.PI / 2],
], [0, 2, 4, 6, 8]);
await settle(p, 0.6);
await shot(p, 'play-1-spine-run');

// Turn and look back the way we came: pure memory, no fresh scan.
await place(p, 19, 26.5, Math.PI / 2, 0);
await settle(p, 0.8);
await shot(p, 'play-2-looking-back-at-memory');

// Now scan forward into the unknown, from the same spot.
await place(p, 19, 26.5, -Math.PI / 2, 0);
await pulse(p);
await settle(p, 1.3);
await shot(p, 'play-3-fresh-over-memory');

// Arrive at the Well.
await walk([[24, 26.5, -Math.PI / 2], [27, 27, -Math.PI / 2]], [1]);
await settle(p, 0.8);
await shot(p, 'play-4-the-well');
console.log('captured');
await b.close();
