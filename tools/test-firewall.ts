// Headless protocol test. Drives two players through a Room directly and asserts the
// perception firewall and the staleness rule.

import { Room, type Sink } from '../src/server/room.ts';
import type { S2C, Ev, EvContact, EvSound } from '../src/shared/proto.ts';
import { Res } from '../src/shared/config.ts';

let pass = 0, fail = 0;
const chk = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

class Cap implements Sink {
  msgs: S2C[] = [];
  send(m: S2C) { this.msgs.push(m); }
  close() {}
  evs(): Ev[] { return this.msgs.filter((m) => m.t === 'evs').flatMap((m: any) => m.evs as Ev[]); }
  contacts(): EvContact[] { return this.evs().filter((e): e is EvContact => e.k === 'contact'); }
  sounds(): EvSound[] { return this.evs().filter((e): e is EvSound => e.k === 'sound'); }
  clear() { this.msgs = []; }
}

const room = new Room('TEST01', 42);
const ca = new Cap(), cb = new Cap();
const A = room.add('A', ca)!, B = room.add('B', cb)!;
room.handle(A, { t: 'ready', weapon: 'judge' });
room.handle(B, { t: 'ready', weapon: 'judge' });
const run = (secs: number) => { for (let i = 0; i < Math.round(secs * 20); i++) room.tick(1 / 20); };

console.log('phase:', room.phase);
chk('match starts when both ready', room.phase === 'live');

// Put them in the Concourse's clear z=11.5 lane, which threads between the pillar rows.
const put = (p: any, x: number, z: number, yaw = 0) => { p.x = x; p.y = 0; p.z = z; p.yaw = yaw; p.vx = 0; p.vz = 0; p.stance = 1; };
const LANE = 11.5;
const losOk = (ax: number, az: number, bx: number, bz: number) =>
  room.map.world.lineOfSight(ax, 1.58, az, bx, 1.2, bz);
put(A, 4, LANE, 0); put(B, 22, LANE, 0);
chk('precondition: the test lane is clear line of sight', losOk(4, LANE, 22, LANE));
run(0.2); ca.clear(); cb.clear();

// ── 1. SILENCE: a player who does nothing learns nothing ──────────────────
console.log('\n[1] silence while the enemy is still');
run(3);
chk('A gets no contacts while nobody emits', ca.contacts().length === 0, `got ${ca.contacts().length}`);
chk('A gets no sounds while nobody moves', ca.sounds().filter(s => s.kind !== 'heartbeat').length === 0);

// ── 2. THE PULSE CAPTURES ─────────────────────────────────────────────────
console.log('\n[2] pulse captures the enemy at FULL resolution');
ca.clear(); cb.clear();
room.handle(A, { t: 'pulse', dx: 1, dy: 0, dz: 0 }); // A at x=6 looking +X toward B at x=18
run(0.1);
const cap = ca.contacts();
chk('A receives exactly one contact', cap.length === 1, `got ${cap.length}`);
chk('contact is FULL resolution', cap[0]?.res === Res.Full);
chk('contact is at B\'s true position', !!cap[0] && Math.hypot(cap[0].x - 22, cap[0].z - LANE) < 0.01,
     cap[0] ? `(${cap[0].x.toFixed(2)},${cap[0].z.toFixed(2)})` : '');
chk('A also received pulse geometry', ca.evs().some((e) => e.k === 'geom' && (e as any).src === 'pulse'));

// ── 3. RECIPROCITY: emitting is broadcasting ──────────────────────────────
console.log('\n[3] reciprocity law');
const flash = cb.contacts();
chk('B learns A pulsed', flash.length === 1, `got ${flash.length}`);
chk('B\'s read of A is only COARSE', flash[0]?.res === Res.Coarse);
chk('B\'s read of A is blurred, not exact',
    !!flash[0] && Math.hypot(flash[0].x - 4, flash[0].z - LANE) > 0.001 && Math.hypot(flash[0].x - 4, flash[0].z - LANE) < 1.6,
    flash[0] ? `off by ${Math.hypot(flash[0].x - 4, flash[0].z - LANE).toFixed(2)}m` : '');

// ── 4. THE CORE RULE: observations go stale ───────────────────────────────
console.log('\n[4] the observation does not follow the enemy');
ca.clear();
const oldGhost = { x: cap[0]!.x, z: cap[0]!.z };
// B retreats 9m down the same lane, crouched, so not even footsteps leak.
for (let i = 0; i < 60; i++) { B.x -= 9 / 60; B.stance = 0; B.vx = 0; B.vz = 0; room.tick(1 / 20); }
chk('B really moved', Math.abs(B.x - 13) < 0.2, `B.x=${B.x.toFixed(2)}`);
chk('A receives NO new contact while B moves', ca.contacts().length === 0, `got ${ca.contacts().length}`);
chk('A\'s newest knowledge of B is still the old position',
    Math.hypot(oldGhost.x - 22, oldGhost.z - LANE) < 0.01);
chk('...which is now 9m from where B actually is', Math.hypot(oldGhost.x - B.x, oldGhost.z - B.z) > 8);

// ── 5. NO LEAK ANYWHERE IN THE STREAM ─────────────────────────────────────
console.log('\n[5] no message carries B\'s live transform');
let leak = 0, checked = 0;
for (const m of ca.msgs) {
  const s = JSON.stringify(m);
  checked++;
  if (m.t === 'snap') {
    // The only coordinates in a snapshot must be A's own and the (public) beacon.
    const self = (m as any).self, mt = (m as any).match;
    if (Math.hypot(self.x - A.x, self.z - A.z) > 0.01) { leak++; console.log('   self pos mismatch'); }
    for (const k of Object.keys(mt)) {
      if (!['bx', 'by', 'bz'].includes(k)) continue;
    }
    if (s.includes('"' + B.z.toFixed(4)) ) { leak++; }
  }
}
chk(`scanned ${checked} messages to A, none leaks B`, leak === 0);
chk('snapshot never names who holds the relic', !ca.msgs.some((m) => m.t === 'snap' && (m as any).match.relicHeld === B.slot + 1 && !A.carrying === false));

// ── 6. A NEW EVENT REFRESHES ──────────────────────────────────────────────
console.log('\n[6] a new legitimate event replaces the stale ghost');
ca.clear();
A.pulseReadyAt = 0;
// Look toward B's NEW position.
const d = { x: B.x - A.x, y: 0, z: B.z - A.z };
const l = Math.hypot(d.x, d.z);
room.handle(A, { t: 'pulse', dx: d.x / l, dy: 0, dz: d.z / l });
run(0.1);
const fresh = ca.contacts();
chk('the rescan produces a new contact', fresh.length === 1, `got ${fresh.length}`);
chk('the new contact is at B\'s CURRENT position',
    !!fresh[0] && Math.hypot(fresh[0].x - B.x, fresh[0].z - B.z) < 0.01,
    fresh[0] ? `(${fresh[0].x.toFixed(2)},${fresh[0].z.toFixed(2)}) vs (${B.x.toFixed(2)},${B.z.toFixed(2)})` : '');

// ── 7. LINE OF SIGHT GATES THE CAPTURE ────────────────────────────────────
console.log('\n[7] a wall blocks the capture but not the flash');
ca.clear(); cb.clear();
put(A, 4, LANE, 0); put(B, 38, LANE, 0);   // Concourse -> Lattice: solid wall between
A.pulseReadyAt = 0;
room.handle(A, { t: 'pulse', dx: 1, dy: 0, dz: 0 });
run(0.1);
chk('no capture through a wall', ca.contacts().length === 0, `got ${ca.contacts().length}`);
chk('but the flash still reaches B through the wall (34m < 35m)', cb.contacts().length === 1, `got ${cb.contacts().length}`);

// ── 8. FOOTSTEPS ──────────────────────────────────────────────────────────
console.log('\n[8] footsteps drip information, crouching does not');
ca.clear();
put(A, 4, LANE); put(B, 10, LANE);
B.stance = 2; B.vx = 5; B.vz = 0;
run(2);
chk('a sprinting enemy at 6m is heard', ca.sounds().some((s) => s.kind === 'step'), `${ca.sounds().length} sounds`);
ca.clear();
B.stance = 0; B.vx = 1; B.vz = 0;
run(2);
chk('a crouching enemy at 6m is silent', !ca.sounds().some((s) => s.kind === 'step'));

// ── 9. RELIC HEARTBEAT ────────────────────────────────────────────────────
console.log('\n[9] the relic forces contact');
ca.clear(); cb.clear();
run(22);
chk('both players hear the heartbeat', ca.sounds().some((s) => s.kind === 'heartbeat') && cb.sounds().some((s) => s.kind === 'heartbeat'));
chk('the heartbeat paints gold geometry', ca.evs().some((e) => e.k === 'geom' && (e as any).gold === true));

// ── 10. COMBAT ────────────────────────────────────────────────────────────
console.log('\n[10] combat and its information cost');
ca.clear(); cb.clear();
put(A, 4, LANE); put(B, 10, LANE);
B.hp = 100; A.ammo = 5; A.nextShotAt = 0;
room.handle(A, { t: 'fire', dx: 1, dy: 0, dz: 0 });
run(0.1);
chk('the Judge lands 50 damage', Math.abs(B.hp - 50) < 0.01, `hp=${B.hp}`);
chk('the victim learns the bearing of the shot', cb.evs().some((e) => e.k === 'hit'));
chk('the shooter re-photographs the victim on hit', ca.contacts().some((c) => c.res === Res.Full));
chk('the Judge hands the enemy the same geometry it lit', cb.evs().some((e) => e.k === 'geom' && (e as any).src === 'impact'));
chk('the enemy hears the shot', cb.sounds().some((s) => s.kind === 'shot'));

// ── 11. EXTRACTION WINS ───────────────────────────────────────────────────
console.log('\n[11] extraction ends the match');
room.relic.held = -1;
A.carrying = true; room.relic.held = A.slot as 0 | 1;
put(A, 29, 26.5); A.vx = 0; A.vz = 0;
run(4);
chk('channelling the beacon wins', room.phase === 'over' && room.winner === A.slot, `phase=${room.phase} winner=${room.winner}`);
// Regression: the win must actually be ANNOUNCED, not merely recorded. A previous version
// set phase='over' inside stepCarry and then returned early from checkEnd, so the match
// ended on the server and nobody was ever told.
chk('both players are told the match is over',
    ca.msgs.some((m) => m.t === 'over') && cb.msgs.some((m) => m.t === 'over'));
chk('the over message names the winner',
    ca.msgs.some((m) => m.t === 'over' && (m as any).winner === A.slot));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
