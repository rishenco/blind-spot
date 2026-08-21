// Authoritative match simulation.
//
// FIREWALL RULE, enforced by construction: nothing in this file ever writes an opponent's
// live transform into a client's outbox. Information about the other player leaves the
// server through exactly one door — `reveal()` — which degrades the payload to the
// resolution of the event that produced it before it is queued. Search this file for
// `p.out.push` and you will find only degraded, event-derived payloads.

import { buildMap, type MapDef } from '../shared/map.ts';
import { movePlayer } from '../shared/collide.ts';
import { dist2D, dirFromAngles, mulberry32, norm, sub } from '../shared/math.ts';
import {
  PLAYER, SOUND, PULSE, MATCH, RELIC, XP, SPIKE, DECOY, ECHO, WEAPONS,
  Res, type WeaponId,
} from '../shared/config.ts';
import { pulseShape, draftFor, type Card } from '../shared/upgrades.ts';
import type { C2S, S2C, Ev, SelfState, MatchState, Stance } from '../shared/proto.ts';

export interface Sink { send(m: S2C): void; close(): void }

const EYE = 1.58, CROUCH_EYE = 0.95;
const eyeOf = (p: Player) => p.y + (p.stance === 0 ? CROUCH_EYE : EYE);

let nextDeviceId = 1000;

class Player {
  slot: 0 | 1;
  name: string;
  sink: Sink;
  ready = false;
  weapon: WeaponId = 'judge';

  // ── simulation truth ──
  x = 0; y = 0; z = 0;
  yaw = 0; pitch = 0;
  stance: Stance = 1;
  vx = 0; vz = 0;
  hp = PLAYER.maxHp;
  alive = true;
  respawnAt = 0;
  lastHurtAt = -999;

  ammo = 0;
  reloadUntil = 0;
  nextShotAt = 0;
  pulseReadyAt = 0;
  spikes = SPIKE.charges;
  decoys = DECOY.charges;
  echoes = ECHO.charges;
  echoReadyAt = 0;

  xp = 0; level = 1;
  upgrades = new Set<string>();
  offer: Card[] | null = null;

  carrying = false;
  channel = 0;
  stepAccum = 0;
  nextStepAt = 0;
  lastPaintAt = -999;
  lastSingAt = 0;
  stillSince = 0;

  out: Ev[] = [];
  seed = 1;

  constructor(slot: 0 | 1, name: string, sink: Sink) {
    this.slot = slot; this.name = name; this.sink = sink;
  }
  get gun() { return WEAPONS[this.weapon]; }
}

interface Device {
  id: number; kind: 'spike' | 'decoy';
  owner: 0 | 1;
  x: number; y: number; z: number;
  armedAt: number; diesAt: number;
  spent?: boolean;
  /** decoys wander their fake footsteps around the landing point */
  phase?: number;
  nextStepAt?: number;
}

export class Room {
  code: string;
  map: MapDef;
  players: (Player | null)[] = [null, null];
  phase: 'lobby' | 'live' | 'over' = 'lobby';
  t = 0;
  startedAt = 0;
  rnd: () => number;

  relic = { x: 0, y: 0, z: 0, held: -1 as -1 | 0 | 1 };
  relicSite = '';
  beacon = { x: 0, y: 0, z: 0 };
  beaconLit = false;
  nextHeartbeatAt = 0;
  devices: Device[] = [];
  winner = -1;
  overReason = '';
  onEmpty?: () => void;

  constructor(code: string, seed = Date.now()) {
    this.code = code;
    this.map = buildMap();
    this.rnd = mulberry32(seed >>> 0);
    const site = this.map.sites[Math.floor(this.rnd() * this.map.sites.length)]!;
    this.relic = { x: site.x, y: 0, z: site.z, held: -1 };
    this.relicSite = site.name;
    // Extraction sits in the Spine, the map's most exposed artery — on purpose.
    this.beacon = { x: 29, y: 0, z: 26.5 };
  }

  // ── membership ────────────────────────────────────────────────────
  add(name: string, sink: Sink): Player | null {
    const slot = this.players[0] === null ? 0 : this.players[1] === null ? 1 : -1;
    if (slot < 0) return null;
    const p = new Player(slot as 0 | 1, name, sink);
    this.players[slot] = p;
    sink.send({ t: 'hello', slot, code: this.code });
    this.pushLobby();
    return p;
  }

  remove(p: Player) {
    this.players[p.slot] = null;
    if (this.phase === 'live') {
      this.phase = 'over';
      this.winner = p.slot === 0 ? 1 : 0;
      this.overReason = 'opponent left';
      this.broadcastOver();
    }
    this.pushLobby();
    if (!this.players[0] && !this.players[1]) this.onEmpty?.();
  }

  private pushLobby() {
    const list = this.players.filter(Boolean).map((p) => ({ name: p!.name, ready: p!.ready, weapon: p!.weapon }));
    for (const p of this.players) if (p) p.sink.send({ t: 'lobby', code: this.code, players: list, you: p.slot });
  }

  private other(p: Player): Player | null {
    return this.players[p.slot === 0 ? 1 : 0];
  }

  // ── input ─────────────────────────────────────────────────────────
  handle(p: Player, m: C2S) {
    switch (m.t) {
      case 'ready': {
        p.weapon = m.weapon === 'whisper' ? 'whisper' : 'judge';
        p.ready = true;
        this.pushLobby();
        const both = this.players[0]?.ready && this.players[1]?.ready;
        if (both && this.phase === 'lobby') this.start();
        break;
      }
      case 'input': this.applyInput(p, m); break;
      case 'pulse': this.doPulse(p, m.dx, m.dy, m.dz); break;
      case 'fire': this.doFire(p, m.dx, m.dy, m.dz); break;
      case 'reload': this.doReload(p); break;
      case 'gadget': this.doGadget(p, m.g, m.dx, m.dy, m.dz); break;
      case 'upgrade': this.doUpgrade(p, m.id); break;
      case 'rematch': this.doRematch(p); break;
      case 'ping': p.sink.send({ t: 'pong', n: m.n }); break;
    }
  }

  private start() {
    this.phase = 'live';
    this.t = 0;
    this.startedAt = Date.now();
    // Spawn assignment is randomised so neither zone is a fixed advantage.
    const flip = this.rnd() < 0.5 ? 0 : 1;
    for (const p of this.players) {
      if (!p) continue;
      const s = this.map.spawns[(p.slot ^ flip) % this.map.spawns.length]!;
      this.respawnAt(p, s);
      p.hp = PLAYER.maxHp; p.alive = true;
      p.ammo = p.gun.mag;
      p.sink.send({ t: 'start', at: 0 });
      this.notice(p, `RELIC IS SINGING SOMEWHERE. LISTEN.`, 'info');
    }
    this.nextHeartbeatAt = 2.0;
  }

  private respawnAt(p: Player, s: { x: number; z: number; yaw: number }) {
    p.x = s.x; p.y = 0; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.vx = 0; p.vz = 0; p.stance = 1; p.channel = 0;
  }

  private applyInput(p: Player, m: Extract<C2S, { t: 'input' }>) {
    if (!p.alive || this.phase !== 'live') return;
    p.yaw = m.yaw; p.pitch = m.pitch;
    p.stance = (m.stance === 0 || m.stance === 2 ? m.stance : 1) as Stance;

    // Validate rather than trust: clamp the claimed step to what the fastest legal
    // stance could cover, then resolve it against the real world geometry.
    const maxStep = (p.carrying ? PLAYER.carrierMaxSpeed : PLAYER.sprintSpeed) * 0.14 + 0.35;
    let dx = m.x - p.x, dz = m.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > maxStep) { const s = maxStep / d; dx *= s; dz *= s; }
    const r = movePlayer(this.map.world, { x: p.x, y: p.y, z: p.z }, dx, -0.6, dz, p.stance === 0 ? 1.05 : 1.72);
    p.x = r.pos.x; p.y = r.pos.y; p.z = r.pos.z;
    p.vx = m.vx; p.vz = m.vz;
    if (d > 0.02) p.stillSince = this.t; // used by COLD BLOOD
    p.stepAccum += Math.hypot(dx, dz);
  }

  // ── the one door through which enemy information leaves ───────────
  /**
   * Queue an observation of `subject` for `to`, degraded to `res`.
   * FULL   — exact pose and velocity.
   * COARSE — position blurred by ~1m, facing quantised to a 45° wedge, velocity dropped.
   * TRACE  — bearing and rough range only: heavy angular and radial jitter.
   * The degradation happens HERE, on the server, so a modified client gains nothing.
   */
  private reveal(to: Player, subject: { x: number; y: number; z: number; yaw: number; stance: Stance; vx: number; vz: number },
                 res: Res, id: number, fake = false) {
    let { x, y, z, yaw, vx, vz } = subject;
    if (res === Res.Coarse) {
      const a = this.rnd() * Math.PI * 2, r = this.rnd() * 1.0;
      x += Math.cos(a) * r; z += Math.sin(a) * r;
      yaw = Math.round(yaw / (Math.PI / 4)) * (Math.PI / 4);
      vx = 0; vz = 0;
    } else if (res === Res.Trace) {
      const dx = x - to.x, dz = z - to.z;
      let bearing = Math.atan2(dz, dx) + (this.rnd() - 0.5) * 0.28;
      const range = Math.hypot(dx, dz) * (0.78 + this.rnd() * 0.44);
      x = to.x + Math.cos(bearing) * range;
      z = to.z + Math.sin(bearing) * range;
      y = to.y;
      yaw = 0; vx = 0; vz = 0;
    }
    to.out.push({ k: 'contact', t: this.t, id, x, y, z, yaw, stance: subject.stance, vx, vz, res, fake });
  }

  private sound(to: Player, x: number, y: number, z: number, kind: Ev extends { k: 'sound' } ? never : any, res: Res) {
    let px = x, pz = z;
    if (res === Res.Coarse) { const a = this.rnd() * 6.283, r = this.rnd() * 1.2; px += Math.cos(a) * r; pz += Math.sin(a) * r; }
    else if (res === Res.Trace) {
      const dx = x - to.x, dz = z - to.z;
      const bearing = Math.atan2(dz, dx) + (this.rnd() - 0.5) * 0.3;
      const range = Math.hypot(dx, dz) * (0.75 + this.rnd() * 0.5);
      px = to.x + Math.cos(bearing) * range; pz = to.z + Math.sin(bearing) * range;
    }
    to.out.push({ k: 'sound', t: this.t, x: px, y, z: pz, kind, res });
  }

  private geom(to: Player, e: Omit<Ev & { k: 'geom' }, 'k' | 't'>) {
    to.out.push({ k: 'geom', t: this.t, ...e } as Ev);
  }

  private notice(to: Player, text: string, tone: 'info' | 'warn' | 'good' | 'bad' = 'info') {
    to.out.push({ k: 'notice', t: this.t, text, tone });
  }

  private award(p: Player, amount: number) {
    if (this.phase !== 'live') return;
    p.xp += amount;
    const thresholds = XP.levels;
    while (p.level < 4 && p.xp >= thresholds[p.level]!) {
      p.level++;
      const tier = Math.min(3, p.level - 1) as 1 | 2 | 3;
      p.offer = draftFor(tier, p.upgrades, this.rnd);
      p.sink.send({ t: 'offer', level: p.level, cards: p.offer.map((c) => ({ id: c.id, name: c.name, text: c.text })) });
    }
  }

  private doUpgrade(p: Player, id: string) {
    if (!p.offer) return;
    const c = p.offer.find((x) => x.id === id);
    if (!c) return;
    p.upgrades.add(c.id);
    p.offer = null;
    this.notice(p, `${c.name} ONLINE`, 'good');
  }

  // ── ECHOLOCATION ──────────────────────────────────────────────────
  private doPulse(p: Player, dx: number, dy: number, dz: number) {
    if (this.phase !== 'live' || !p.alive || this.t < p.pulseReadyAt) return;
    const shape = pulseShape(p.upgrades);
    p.pulseReadyAt = this.t + shape.cd;
    const half = (shape.halfDeg * Math.PI) / 180;
    const d = norm({ x: dx, y: dy, z: dz });
    const ey = eyeOf(p);

    // 1. The scanner gets geometry.
    this.geom(p, {
      src: 'pulse', ox: p.x, oy: ey, oz: p.z, dx: d.x, dy: d.y, dz: d.z,
      half: shape.halfDeg >= 180 ? Math.PI : half, range: shape.range,
      rays: PULSE.rays, speed: PULSE.waveSpeed, seed: (p.seed++ * 2654435761) >>> 0,
    });

    const o = this.other(p);

    // 2. Anything alive inside the cone with line of sight is captured, FULL.
    if (o && o.alive) {
      if (this.inCone(p, o.x, eyeOf(o), o.z, d, half, shape.range) && this.los(p, o)) {
        const cold = o.upgrades.has('coldblood') && o.stance === 0 && this.t - o.stillSince > 0.35;
        if (!cold) {
          this.reveal(p, o, Res.Full, o.slot);
          if (this.t - p.lastPaintAt > XP.firstPaintLockoutS) { p.lastPaintAt = this.t; this.award(p, XP.firstPaint); }
          // RETORT: being photographed becomes a trade the victim can want.
          if (o.upgrades.has('retort')) {
            this.reveal(o, p, Res.Full, p.slot);
            this.notice(o, 'RETORT — YOU SAW THEM BACK', 'good');
          }
        }
      }
      // 3. THE RECIPROCITY LAW: emitting is broadcasting. Through walls.
      if (dist2D(p, o) <= PULSE.flashRadius) {
        this.reveal(o, p, Res.Coarse, p.slot);
        this.sound(o, p.x, eyeOf(p), p.z, 'pulse', Res.Coarse);
      }
    }

    // 4. Decoys answer a pulse with a lie.
    for (const dv of this.devices) {
      if (dv.kind !== 'decoy' || dv.owner === p.slot) continue;
      if (!this.inCone(p, dv.x, dv.y + 1.0, dv.z, d, half, shape.range)) continue;
      if (!this.map.world.lineOfSight(p.x, eyeOf(p), p.z, dv.x, dv.y + 1.0, dv.z)) continue;
      const owner = this.players[dv.owner];
      const strong = owner?.upgrades.has('phantom');
      this.reveal(p, { x: dv.x, y: dv.y, z: dv.z, yaw: dv.phase ?? 0, stance: 1, vx: 0, vz: 0 },
                  strong ? Res.Full : Res.Coarse, dv.id, true);
    }

    // 5. The relic answers in gold if the pulse reaches it.
    if (this.relic.held === -1 && this.inCone(p, this.relic.x, this.relic.y + 0.6, this.relic.z, d, half, shape.range)
        && this.map.world.lineOfSight(p.x, eyeOf(p), p.z, this.relic.x, this.relic.y + 0.6, this.relic.z)) {
      this.geom(p, {
        src: 'heartbeat', ox: this.relic.x, oy: this.relic.y + 0.6, oz: this.relic.z,
        dx: 0, dy: 1, dz: 0, half: Math.PI, range: 2.2, rays: 900, speed: 200,
        seed: (p.seed++ * 40503) >>> 0, gold: true,
      });
    }
  }

  private inCone(p: Player, tx: number, ty: number, tz: number, d: { x: number; y: number; z: number }, half: number, range: number) {
    const ey = eyeOf(p);
    const vx = tx - p.x, vy = ty - ey, vz = tz - p.z;
    const len = Math.hypot(vx, vy, vz);
    if (len > range || len < 1e-3) return len <= range;
    if (half >= Math.PI - 1e-6) return true;
    return (vx * d.x + vy * d.y + vz * d.z) / len >= Math.cos(half);
  }

  private los(a: Player, b: Player) {
    return this.map.world.lineOfSight(a.x, eyeOf(a), a.z, b.x, eyeOf(b), b.z);
  }

  // ── COMBAT ────────────────────────────────────────────────────────
  private doReload(p: Player) {
    if (!p.alive || p.reloadUntil > this.t || p.ammo >= p.gun.mag) return;
    p.reloadUntil = this.t + p.gun.reloadS;
  }

  private doFire(p: Player, dx: number, dy: number, dz: number) {
    if (this.phase !== 'live' || !p.alive) return;
    if (this.t < p.nextShotAt || this.t < p.reloadUntil) return;
    if (p.ammo <= 0) { this.doReload(p); return; }
    const g = p.gun;
    p.ammo--; p.nextShotAt = this.t + g.intervalS;

    let d = norm({ x: dx, y: dy, z: dz });
    if (g.spreadRad > 0) {
      d = norm({ x: d.x + (this.rnd() - 0.5) * g.spreadRad, y: d.y + (this.rnd() - 0.5) * g.spreadRad, z: d.z + (this.rnd() - 0.5) * g.spreadRad });
    }
    const ox = p.x, oy = eyeOf(p), oz = p.z;
    const o = this.other(p);

    // Resolve against geometry and the opponent's capsule; nearest wins.
    const wall = this.map.world.raycast(ox, oy, oz, d.x, d.y, d.z, g.range);
    let hitT = wall ? wall.t : g.range;
    let hitPlayer: Player | null = null;
    if (o && o.alive) {
      const t = capsuleHit(ox, oy, oz, d.x, d.y, d.z, o.x, o.y, o.z, o.stance === 0 ? 1.05 : 1.72, 0.42);
      if (t !== null && t < hitT) { hitT = t; hitPlayer = o; }
    }
    // Decoys are shattered by any bullet, and the shot tells their owner who fired.
    for (const dv of this.devices) {
      if (dv.spent) continue;
      const t = capsuleHit(ox, oy, oz, d.x, d.y, d.z, dv.x, dv.y, dv.z, dv.kind === 'decoy' ? 1.2 : 0.4, 0.3);
      if (t !== null && t < hitT) {
        dv.spent = true;
        const owner = this.players[dv.owner];
        if (owner && dv.owner !== p.slot) {
          this.award(owner, XP.decoyShattered);
          this.reveal(owner, p, Res.Coarse, p.slot);
          this.notice(owner, dv.kind === 'decoy' ? 'THEY SHOT YOUR DECOY' : 'YOUR SPIKE WAS DESTROYED', 'good');
        }
        hitT = t; hitPlayer = null;
      }
    }

    const ex = ox + d.x * hitT, ey2 = oy + d.y * hitT, ez = oz + d.z * hitT;
    const loud = p.weapon === 'judge';
    const ghost = p.upgrades.has('ghostrounds');

    // Every shot is a measurement — the tracer line and the impact bloom are real geometry.
    this.geom(p, { src: 'tracer', ox, oy, oz, dx: d.x, dy: d.y, dz: d.z, half: 0, range: hitT, rays: 200, speed: 400, seed: (p.seed++ * 7919) >>> 0, ex, ey: ey2, ez });
    this.geom(p, { src: 'impact', ox: ex, oy: ey2, oz: ez, dx: 0, dy: 1, dz: 0, half: Math.PI, range: g.impactReveal, rays: loud ? 900 : 260, speed: 90, seed: (p.seed++ * 104729) >>> 0 });

    if (o) {
      // The Judge pays for its damage by handing the enemy the same room it just lit.
      if (loud && !ghost) {
        this.geom(o, { src: 'tracer', ox, oy, oz, dx: d.x, dy: d.y, dz: d.z, half: 0, range: hitT, rays: 180, speed: 400, seed: (p.seed++ * 15485863) >>> 0, ex, ey: ey2, ez });
        this.geom(o, { src: 'impact', ox: ex, oy: ey2, oz: ez, dx: 0, dy: 1, dz: 0, half: Math.PI, range: g.impactReveal, rays: 700, speed: 90, seed: (p.seed++ * 32452843) >>> 0 });
      }
      const heard = dist2D(p, o) <= g.bloomRadius;
      if (heard && !(ghost && !loud)) this.sound(o, p.x, oy, p.z, loud ? 'shot' : 'hiss', loud ? Res.Coarse : Res.Trace);
    }

    if (hitPlayer) {
      let dmg = g.damage;
      if (p.weapon === 'whisper' && hitT > WEAPONS.whisper.falloffRange) dmg = WEAPONS.whisper.falloffDamage;
      this.damage(hitPlayer, dmg, p, d);
    }
  }

  private damage(v: Player, dmg: number, from: Player, d: { x: number; y: number; z: number }) {
    v.hp = Math.max(0, v.hp - dmg);
    v.lastHurtAt = this.t;
    this.award(from, Math.floor(dmg * XP.perDamage));
    // Hit confirm: the shooter briefly re-photographs the victim; the victim learns only
    // the bearing the shot arrived from.
    this.reveal(from, v, Res.Full, v.slot);
    v.out.push({ k: 'hit', t: this.t, dmg, hp: v.hp, fx: -d.x, fy: -d.y, fz: -d.z });
    if (v.hp <= 0) this.kill(v, from);
  }

  private kill(v: Player, by: Player) {
    v.alive = false;
    v.respawnAt = this.t + PLAYER.respawnS;
    this.award(by, XP.kill);
    // Death burst: every death must teach. The victim sees their killer.
    this.reveal(v, by, Res.Full, by.slot);
    this.notice(v, 'YOU WERE KILLED', 'bad');
    this.notice(by, 'KILL', 'good');
    if (v.carrying) {
      v.carrying = false;
      this.relic = { x: v.x, y: v.y, z: v.z, held: -1 };
      this.nextHeartbeatAt = this.t + 1.0;
      for (const p of this.players) if (p) this.notice(p, 'THE RELIC IS LOOSE', 'warn');
    }
  }

  // ── GADGETS ───────────────────────────────────────────────────────
  private doGadget(p: Player, g: 'spike' | 'decoy' | 'echo', dx: number, dy: number, dz: number) {
    if (this.phase !== 'live' || !p.alive) return;
    const d = norm({ x: dx, y: dy, z: dz });
    const ey = eyeOf(p);
    if (g === 'spike') {
      if (p.spikes <= 0) return;
      const h = this.map.world.raycast(p.x, ey, p.z, d.x, d.y, d.z, SPIKE.reach);
      const t = h ? Math.max(0.3, h.t - 0.1) : SPIKE.reach;
      p.spikes--;
      this.devices.push({ id: nextDeviceId++, kind: 'spike', owner: p.slot, x: p.x + d.x * t, y: Math.max(0, ey + d.y * t), z: p.z + d.z * t, armedAt: this.t + SPIKE.armS, diesAt: 1e9 });
      this.notice(p, 'SPIKE ARMED', 'info');
    } else if (g === 'decoy') {
      if (p.decoys <= 0) return;
      p.decoys--;
      const land = this.throwTo(p.x, ey, p.z, d, DECOY.throwSpeed);
      this.devices.push({ id: nextDeviceId++, kind: 'decoy', owner: p.slot, x: land.x, y: land.y, z: land.z, armedAt: this.t + DECOY.delayS, diesAt: this.t + DECOY.delayS + DECOY.durationS, phase: this.rnd() * 6.283, nextStepAt: this.t + DECOY.delayS });
      this.notice(p, 'DECOY THROWN', 'info');
    } else {
      if (p.echoes <= 0 || this.t < p.echoReadyAt) return;
      p.echoes--; p.echoReadyAt = this.t + ECHO.spacingS;
      const land = this.throwTo(p.x, ey, p.z, d, ECHO.throwSpeed);
      // The owner gets a wide, wall-piercing look at a place they are not standing.
      this.geom(p, { src: 'echo', ox: land.x, oy: land.y + 0.5, oz: land.z, dx: 0, dy: 1, dz: 0, half: Math.PI, range: ECHO.revealRadius, rays: ECHO.rays, speed: 55, seed: (p.seed++ * 6700417) >>> 0 });
      const o = this.other(p);
      if (o && o.alive) {
        if (dist2D(land, o) <= ECHO.revealRadius && this.map.world.lineOfSight(land.x, land.y + 0.5, land.z, o.x, eyeOf(o), o.z)) {
          this.reveal(p, o, Res.Full, o.slot);
          if (this.t - p.lastPaintAt > XP.firstPaintLockoutS) { p.lastPaintAt = this.t; this.award(p, XP.firstPaint); }
        }
        // ...but it tells them exactly where you are looking.
        if (dist2D(land, o) <= ECHO.bloomRadius) this.sound(o, land.x, land.y + 0.5, land.z, 'device', Res.Coarse);
      }
      this.notice(p, 'ECHO BOMB', 'info');
    }
  }

  /** Ballistic-ish throw resolved by stepping the arc against the world. */
  private throwTo(x: number, y: number, z: number, d: { x: number; y: number; z: number }, speed: number) {
    let px = x, py = y, pz = z;
    let vx = d.x * speed, vy = d.y * speed, vz = d.z * speed;
    const dt = 1 / 30;
    for (let i = 0; i < 90; i++) {
      vy -= 18 * dt;
      const nx = px + vx * dt, ny = py + vy * dt, nz = pz + vz * dt;
      const seg = Math.hypot(nx - px, ny - py, nz - pz);
      const h = seg > 1e-5 ? this.map.world.raycast(px, py, pz, (nx - px) / seg, (ny - py) / seg, (nz - pz) / seg, seg) : null;
      if (h) return { x: px + ((nx - px) / seg) * h.t * 0.95, y: Math.max(0, py + ((ny - py) / seg) * h.t * 0.95), z: pz + ((nz - pz) / seg) * h.t * 0.95 };
      px = nx; py = ny; pz = nz;
      if (py < 0) return { x: px, y: 0, z: pz };
    }
    return { x: px, y: Math.max(0, py), z: pz };
  }

  // ── TICK ──────────────────────────────────────────────────────────
  tick(dt: number) {
    if (this.phase === 'live') {
      this.t += dt;
      this.stepPlayers(dt);
      this.stepRelic();
      this.stepDevices();
      this.checkEnd();
    }
    this.flush();
  }

  private stepPlayers(dt: number) {
    for (const p of this.players) {
      if (!p) continue;
      if (!p.alive) {
        if (this.t >= p.respawnAt) {
          // Respawn as far from the enemy as the map allows; memory and XP are kept.
          const o = this.other(p);
          let best = this.map.spawns[0]!, bd = -1;
          for (const s of this.map.spawns) {
            const d = o ? dist2D(s, o) : 1;
            if (d > bd) { bd = d; best = s; }
          }
          this.respawnAt(p, best);
          p.hp = PLAYER.maxHp; p.alive = true; p.ammo = p.gun.mag; p.reloadUntil = 0;
        }
        continue;
      }
      if (p.reloadUntil && this.t >= p.reloadUntil) { p.ammo = p.gun.mag; p.reloadUntil = 0; }
      if (this.t - p.lastHurtAt > PLAYER.regenDelayS && p.hp < PLAYER.maxHp) {
        p.hp = Math.min(PLAYER.maxHp, p.hp + PLAYER.regenPerS * dt);
      }
      this.stepFootsteps(p);
      this.stepCarry(p, dt);
    }
  }

  /** Footsteps: a continuous, involuntary drip of information while you move. */
  private stepFootsteps(p: Player) {
    const o = this.other(p);
    const cadence = p.stance === 2 ? SOUND.stepSprintCadence : SOUND.stepWalkCadence;
    const speed = Math.hypot(p.vx, p.vz);
    if (speed < 0.4 || p.stance === 0) { p.nextStepAt = Math.max(p.nextStepAt, this.t + cadence * 0.5); return; }
    if (this.t < p.nextStepAt) return;
    p.nextStepAt = this.t + cadence;
    if (!o || !o.alive) return;
    if (p.upgrades.has('softstep') && p.stance !== 2) return;

    let radius = p.stance === 2 ? SOUND.stepSprintRadius : SOUND.stepWalkRadius;
    if (o.upgrades.has('keenear')) radius *= 2;
    const d = dist2D(p, o);
    if (d <= radius) this.sound(o, p.x, p.y + 0.2, p.z, 'step', p.stance === 2 ? Res.Coarse : Res.Trace);
    // TREMOR SENSE: a panic sprint nearby gives you a real fix, not just a noise.
    if (o.upgrades.has('tremor') && p.stance === 2 && d <= 12) this.reveal(o, p, Res.Trace, p.slot);
  }

  private stepCarry(p: Player, dt: number) {
    if (this.relic.held === -1 && p.alive) {
      if (dist2D(p, this.relic) < 1.1 && Math.abs(p.y - this.relic.y) < 2.2) {
        this.relic.held = p.slot; p.carrying = true;
        this.award(p, XP.pickup);
        if (!this.beaconLit) {
          this.beaconLit = true;
          for (const q of this.players) if (q) this.notice(q, 'EXTRACTION BEACON LIT — THE SPINE', 'warn');
        }
        this.notice(p, 'RELIC TAKEN. YOU ARE SINGING.', 'good');
        const o = this.other(p);
        if (o) this.notice(o, 'THEY HAVE THE RELIC', 'bad');
        p.lastSingAt = this.t;
      }
    }
    if (!p.carrying) { p.channel = 0; return; }
    this.relic.x = p.x; this.relic.y = p.y; this.relic.z = p.z;

    // The carrier sings: the price of holding the win condition.
    const od = this.t >= MATCH.overdriveS;
    let interval = od ? RELIC.singOverdriveS : RELIC.singS;
    let res = Res.Coarse;
    if (p.upgrades.has('deadsong')) { interval = 8; res = Res.Trace; }
    if (this.t - p.lastSingAt >= interval) {
      p.lastSingAt = this.t;
      const o = this.other(p);
      if (o) { this.reveal(o, p, res, p.slot); this.sound(o, p.x, p.y + 1, p.z, 'sing', res); }
    }

    // Extraction: stand still in the ring and be fully lit for 3.5s.
    const inRing = dist2D(p, this.beacon) <= RELIC.ringRadius;
    const still = Math.hypot(p.vx, p.vz) < 0.5;
    if (inRing && still) {
      p.channel += dt;
      const o = this.other(p);
      if (o) this.reveal(o, p, Res.Full, p.slot);
      if (p.channel >= RELIC.channelS) { this.phase = 'over'; this.winner = p.slot; this.overReason = 'extracted the relic'; }
    } else p.channel = 0;
  }

  private stepRelic() {
    if (this.t < this.nextHeartbeatAt) return;
    const od = this.t >= MATCH.overdriveS;
    const base = this.beaconLit ? RELIC.heartbeatDroppedS : RELIC.heartbeatS;
    this.nextHeartbeatAt = this.t + (od ? base * 0.5 : base);
    if (this.relic.held !== -1) return;
    const radius = od ? RELIC.heartbeatRadiusOverdrive : RELIC.heartbeatRadius;
    // The forcing function: both players are told, roughly, where the prize is.
    for (const p of this.players) {
      if (!p) continue;
      this.geom(p, {
        src: 'heartbeat', ox: this.relic.x, oy: this.relic.y + 0.6, oz: this.relic.z,
        dx: 0, dy: 1, dz: 0, half: Math.PI, range: radius, rays: 2600, speed: 42,
        seed: (p.seed++ * 15485867) >>> 0, gold: true,
      });
      this.sound(p, this.relic.x, this.relic.y + 0.6, this.relic.z, 'heartbeat', Res.Full);
    }
  }

  private stepDevices() {
    for (const dv of this.devices) {
      if (dv.spent) continue;
      const owner = this.players[dv.owner];
      if (dv.kind === 'spike') {
        if (this.t < dv.armedAt) continue;
        const o = this.players[dv.owner === 0 ? 1 : 0];
        if (o && o.alive && dist2D(dv, o) <= SPIKE.triggerRadius) {
          dv.spent = true;
          if (owner) {
            this.reveal(owner, o, Res.Full, o.slot);
            this.notice(owner, 'SPIKE TRIPPED', 'good');
            if (this.t - owner.lastPaintAt > XP.firstPaintLockoutS) { owner.lastPaintAt = this.t; this.award(owner, XP.firstPaint); }
          }
        }
      } else {
        // Decoy: fake footsteps, rendered by the enemy with the SAME renderer as real ones.
        if (this.t > dv.diesAt) { dv.spent = true; continue; }
        if (this.t < dv.armedAt || this.t < (dv.nextStepAt ?? 0)) continue;
        const strong = owner?.upgrades.has('phantom');
        dv.nextStepAt = this.t + (strong ? SOUND.stepSprintCadence : SOUND.stepWalkCadence);
        const o = this.players[dv.owner === 0 ? 1 : 0];
        if (!o || !o.alive) continue;
        dv.phase = (dv.phase ?? 0) + 0.7;
        const wx = dv.x + Math.cos(dv.phase) * DECOY.wander;
        const wz = dv.z + Math.sin(dv.phase * 1.3) * DECOY.wander;
        let radius = DECOY.audibleRadius * (strong ? 2 : 1);
        if (o.upgrades.has('keenear')) radius *= 2;
        if (dist2D({ x: wx, z: wz } as any, o) <= radius) {
          this.sound(o, wx, dv.y + 0.2, wz, 'step', strong ? Res.Coarse : Res.Trace);
        }
      }
    }
    this.devices = this.devices.filter((d) => !d.spent);
  }

  private checkEnd() {
    if (this.phase !== 'live') return;
    if (this.t >= MATCH.hardCapS) {
      const carrier = this.players.find((p) => p?.carrying);
      if (carrier) { this.phase = 'over'; this.winner = carrier.slot; this.overReason = 'held the relic at the bell'; }
      else { this.overReason = 'sudden death — first touch wins'; }
    }
    if (this.phase === 'over') this.broadcastOver();
  }

  private broadcastOver() {
    for (const p of this.players) if (p) p.sink.send({ t: 'over', winner: this.winner, reason: this.overReason, you: p.slot });
  }

  private doRematch(p: Player) {
    if (this.phase !== 'over') return;
    p.ready = false;
    const other = this.other(p);
    if (!other) return;
    this.phase = 'lobby';
    this.winner = -1;
    this.devices = [];
    this.beaconLit = false;
    const site = this.map.sites[Math.floor(this.rnd() * this.map.sites.length)]!;
    this.relic = { x: site.x, y: 0, z: site.z, held: -1 };
    this.relicSite = site.name;
    for (const q of this.players) if (q) { q.ready = false; q.xp = 0; q.level = 1; q.upgrades.clear(); q.offer = null; q.carrying = false; q.spikes = SPIKE.charges; q.decoys = DECOY.charges; q.echoes = ECHO.charges; }
    this.pushLobby();
  }

  /** Send each player their own state plus whatever their perception has earned. */
  private flush() {
    const od = this.t >= MATCH.overdriveS;
    for (const p of this.players) {
      if (!p) continue;
      if (this.phase !== 'lobby') {
        const self: SelfState = {
          x: p.x, y: p.y, z: p.z, hp: Math.round(p.hp), alive: p.alive,
          respawnIn: Math.max(0, p.respawnAt - this.t),
          weapon: p.weapon, ammo: p.ammo,
          reloading: Math.max(0, p.reloadUntil - this.t),
          pulseCd: Math.max(0, p.pulseReadyAt - this.t),
          spikes: p.spikes, decoys: p.decoys, echoes: p.echoes,
          echoCd: Math.max(0, p.echoReadyAt - this.t),
          xp: p.xp, level: p.level, carrying: p.carrying,
          channel: Math.min(1, p.channel / RELIC.channelS),
          upgrades: [...p.upgrades],
        };
        // NOTE: `relicHeld` is deliberately reduced to a boolean-ish flag. Telling a client
        // "slot 1 holds it" would leak that the opponent is alive and carrying; telling them
        // "someone holds it" is exactly what the sing event already conveys.
        const match: MatchState = {
          t: this.t, phase: this.phase, overdrive: od,
          relicHeld: this.relic.held === -1 ? 0 : (p.carrying ? 1 : 2),
          beaconLit: this.beaconLit,
          bx: this.beacon.x, by: this.beacon.y, bz: this.beacon.z,
        };
        p.sink.send({ t: 'snap', self, match });
      }
      if (p.out.length) { p.sink.send({ t: 'evs', evs: p.out }); p.out = []; }
    }
  }
}

/** Ray vs upright capsule-ish cylinder. Returns entry distance or null. */
function capsuleHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
                    cx: number, cy: number, cz: number, h: number, r: number): number | null {
  const mx = ox - cx, mz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return null;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  const yAt = oy + dy * t;
  if (yAt < cy || yAt > cy + h) return null;
  return t;
}
