// Wire protocol.
//
// THE PERCEPTION FIREWALL LIVES HERE. The server never puts an opponent's live
// transform into any message. The only way information about the other player crosses
// this boundary is inside an `Ev` produced by a legitimate information event, and the
// server degrades that payload to the event's resolution BEFORE sending it — a client
// that reads its own socket learns nothing it was not entitled to see.

import type { Res } from './config.ts';
import type { WeaponId } from './config.ts';

export type Stance = 0 | 1 | 2; // 0 crouch, 1 walk, 2 sprint

/** Geometry reveal: the client raycasts its own copy of the static map from these params. */
export interface EvGeom {
  k: 'geom';
  t: number;
  src: 'pulse' | 'echo' | 'impact' | 'heartbeat' | 'tracer' | 'flashArc';
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  half: number;   // cone half-angle, >= PI for omni
  range: number;
  rays: number;
  speed: number;  // wavefront propagation speed
  seed: number;
  /** For tracers: the far end of the line. */
  ex?: number; ey?: number; ez?: number;
  gold?: boolean;
}

/** An entity was observed. Frozen at capture; the client must never update it. */
export interface EvContact {
  k: 'contact';
  t: number;
  id: number;           // which entity (player slot, or a decoy id)
  x: number; y: number; z: number;
  yaw: number;
  stance: Stance;
  vx: number; vz: number;
  res: Res;
  /** True when this contact came from a decoy. The receiver is NOT told this; used server-side only. */
  fake?: boolean;
}

/** A noise was heard. Position is already degraded to the event's resolution. */
export interface EvSound {
  k: 'sound';
  t: number;
  x: number; y: number; z: number;
  kind: 'step' | 'shot' | 'hiss' | 'pulse' | 'sing' | 'heartbeat' | 'device' | 'relicdrop' | 'spike';
  res: Res;
}

export interface EvHit {
  k: 'hit';
  t: number;
  dmg: number;
  hp: number;
  /** Unit direction the shot came from, in world space. */
  fx: number; fy: number; fz: number;
}

export interface EvNotice {
  k: 'notice';
  t: number;
  text: string;
  tone?: 'info' | 'warn' | 'good' | 'bad';
}

export type Ev = EvGeom | EvContact | EvSound | EvHit | EvNotice;

// ── client -> server ────────────────────────────────────────────────
export type C2S =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'ready'; weapon: WeaponId }
  | { t: 'input'; seq: number; x: number; y: number; z: number; yaw: number; pitch: number; stance: Stance; vx: number; vz: number }
  | { t: 'pulse'; dx: number; dy: number; dz: number }
  | { t: 'fire'; dx: number; dy: number; dz: number }
  | { t: 'reload' }
  | { t: 'gadget'; g: 'spike' | 'decoy' | 'echo'; dx: number; dy: number; dz: number }
  | { t: 'upgrade'; id: string }
  | { t: 'rematch' }
  | { t: 'ping'; n: number };

// ── server -> client ────────────────────────────────────────────────
export interface SelfState {
  x: number; y: number; z: number;
  hp: number;
  alive: boolean;
  respawnIn: number;
  weapon: WeaponId;
  ammo: number;
  reloading: number;
  pulseCd: number;
  spikes: number;
  decoys: number;
  echoes: number;
  echoCd: number;
  xp: number;
  level: number;
  carrying: boolean;
  channel: number;      // 0..1 extraction progress
  upgrades: string[];
}

export interface MatchState {
  t: number;            // seconds since match start
  phase: 'lobby' | 'live' | 'over';
  overdrive: boolean;
  relicHeld: 0 | 1 | 2; // 0 = loose, else the slot carrying it (never says WHO to the client — see room.ts)
  beaconLit: boolean;
  bx: number; by: number; bz: number; // extraction beacon (known to both once lit)
}

export type S2C =
  | { t: 'hello'; slot: number; code: string }
  | { t: 'lobby'; code: string; players: { name: string; ready: boolean; weapon: WeaponId }[]; you: number }
  | { t: 'start'; at: number }
  | { t: 'snap'; self: SelfState; match: MatchState }
  | { t: 'evs'; evs: Ev[] }
  | { t: 'offer'; level: number; cards: { id: string; name: string; text: string }[] }
  | { t: 'over'; winner: number; reason: string; you: number }
  | { t: 'err'; msg: string }
  | { t: 'pong'; n: number };
