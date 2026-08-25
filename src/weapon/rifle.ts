/**
 * The rifle — M3 "выстрел".
 *
 * Concept: "Оружие — что-то вроде AR-15: хитскан, отдача, вспышка, очень громкий выстрел, пули
 * расшвыривают лёгкие предметы." Every one of those five words is a separate thing this file
 * does, and the milestone lives or dies on three of them:
 *
 *  1. **The flash** — the only real light in the game. It is not made here (see `flash.ts`);
 *     this file only says when it happens and where.
 *  2. **The recoil** — the shot has to be felt in the body. Two different quantities, kept
 *     apart on purpose: a *punch*, which is render-only and gone in a fifth of a second, and an
 *     *aim kick*, which really moves where the barrel points and only partly comes back. A burst
 *     therefore walks off target and stays walked off, which is the whole point of a burst
 *     costing you something.
 *  3. **The price** — a gunshot is by a wide margin the loudest event on the bus. A sprinting
 *     player is 16 m of notice, a barrel going over caps at 34; a rifle is 90, which is longer
 *     than the hall's diagonal. After one shot there is nowhere in the room that did not hear it.
 *
 * And the second honest function of shooting, straight out of the concept: the bullet raises a
 * sound event *where it lands*, so a burst into the dark stipples marks over whatever it hit,
 * far outside lidar range. Shooting is a way of feeling the room at distance, paid for in noise.
 *
 * Determinism: spread and recoil are drawn from a seeded RNG advanced once per shot, and shots
 * are scheduled on the fixed simulation clock. Same seed and same trigger timing give the same
 * bullet holes in the same order, which is what the keyframe generator needs.
 */
import type { SoundBus } from '../events/bus';
import { makeRng, type Rng } from '../core/rng';

export type FireMode = 'auto' | 'single';

export const FIRE_MODES: readonly FireMode[] = ['auto', 'single'];

export interface RifleTunables {
  /**
   * Full auto or one round per pull. Undecided on purpose — the human's answer to "burst only or
   * single too?" was "хз, тоже в настройки давай", so both exist and the switch is in the GUI
   * (and on the `X` key, and in `bs.fireMode()`).
   */
  mode: FireMode;
  /** Cyclic rate, rounds per minute. */
  rpm: number;
  /** How far a bullet is traced, metres. Longer than the hall's diagonal, so nothing escapes. */
  range: number;
  /** Cone half-angle of a first, settled shot, degrees. */
  spreadDeg: number;
  /** Extra half-angle each shot adds while the trigger is held, degrees. */
  spreadPerShot: number;
  /** Ceiling on that bloom, degrees. */
  spreadMax: number;
  /** Degrees per second the bloom bleeds off once you stop. */
  spreadRecover: number;
  /** Aim kick per shot, degrees up. The part that really moves the barrel. */
  risePitchDeg: number;
  /** Aim kick per shot, degrees sideways. Signed by a seeded coin flip, so a burst wanders. */
  riseYawDeg: number;
  /** Degrees per second the aim kick is pulled back once the trigger is released. */
  recoverRate: number;
  /** Seconds after the last shot before recovery starts. */
  recoverDelay: number;
  /** How much of the accumulated kick ever comes back. The rest is what a burst costs you. */
  recoverFraction: number;
  /** View punch per shot, degrees. Render-only: it never moves the bullets. */
  punchPitchDeg: number;
  punchYawDeg: number;
  /** Metres the camera is shoved back along the barrel. Render-only. */
  punchBackM: number;
  /** Per-second decay rate of the punch. High: the body absorbs it inside a couple of frames. */
  punchDecay: number;
  /** Metres of notice for the muzzle blast. The loudest number in the game, by design. */
  gunshotLoudness: number;
  /** Metres of notice for the bullet's arrival. A crack, not a blast — but it is over there. */
  hitLoudness: number;
  /** Impulse handed to whatever the bullet hits, N·s. Light junk gets thrown; a barrel rocks. */
  hitImpulse: number;
  /**
   * Rounds in a magazine. The reason this number exists at all (M6a): unlimited fire is
   * unlimited light, and the game's central trade — see a little now, pay a lot later — stops
   * being a trade when the flash is free.
   */
  magazine: number;
  /** Seconds to swap a magazine. Deliberately long: a moment of being blind and useless. */
  reloadSeconds: number;
  /**
   * Metres of notice for the reload itself. It is not silent — you are fumbling metal in the
   * dark — but next to a 90 m gunshot it is a whisper.
   */
  reloadLoudness: number;
}

export function defaultRifleTunables(): RifleTunables {
  return {
    mode: 'auto',
    rpm: 720,
    range: 90,
    spreadDeg: 0.22,
    spreadPerShot: 0.34,
    spreadMax: 2.6,
    spreadRecover: 3.2,
    // "Собранная тактическая" school, per the human: a shot moves the barrel and you see it
    // move, but the gun comes back on its own and a three-round burst stays on a torso at 15 m.
    // The knobs are in the GUI (`G` -> rifle) because this is exactly the kind of thing that has
    // to be felt rather than argued about.
    //
    // M4d, after a playtest: "отдача винтовки — думаю чуть потяжелее надо". *Чуть.* The weight
    // is bought mostly with the free half — the view punch, which flinches the body and costs no
    // aim (+40% pitch, +36% yaw, +44% shove, and a slower decay so the frame after the shot is
    // still moving) — and only a little with the expensive half, the aim kick the player has to
    // correct by hand (+21% climb, and two points less of it comes back). A five-round burst
    // now climbs ~4.3° instead of ~3.4° and leaves ~0.7° of permanent drift instead of ~0.5°.
    risePitchDeg: 0.75,
    riseYawDeg: 0.31,
    recoverRate: 15,
    recoverDelay: 0.09,
    recoverFraction: 0.84,
    punchPitchDeg: 2.1,
    punchYawDeg: 0.75,
    punchBackM: 0.065,
    punchDecay: 14,
    gunshotLoudness: 90,
    hitLoudness: 15,
    hitImpulse: 6.5,
    magazine: 30,
    reloadSeconds: 3,
    reloadLoudness: 11,
  };
}

/** What a bullet did, kept for the debug tracer overlay and for the keyframe checks. */
export interface Shot {
  readonly seq: number;
  readonly time: number;
  /** Muzzle. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Where the trace ended — the impact point, or `range` metres out if it hit nothing. */
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
  readonly hit: boolean;
  /** Index of the prop hit, or -1 for the hall itself (or nothing). */
  readonly prop: number;
  readonly distance: number;
}

/** What the world has to answer for a hitscan to exist. Implemented by `PropWorld`. */
export interface HitscanWorld {
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
  ): { x: number; y: number; z: number; nx: number; ny: number; nz: number; distance: number; prop: number } | null;
  pushProp(index: number, x: number, y: number, z: number, ix: number, iy: number, iz: number): void;
  materialOf(index: number): string | undefined;
}

export interface RifleStats {
  shots: number;
  hits: number;
  /** Current cone half-angle, degrees — the bloom you have talked yourself into. */
  spreadDeg: number;
  /** Aim kick currently baked into where you are pointing, degrees. */
  risePitchDeg: number;
  riseYawDeg: number;
  ready: boolean;
  /** Rounds left in the magazine. */
  rounds: number;
  /** Magazine size, echoed so a HUD does not have to reach into the tunables. */
  magazine: number;
  /** True while a magazine is being swapped: no rounds leave the barrel. */
  reloading: boolean;
  /** 0..1 through the reload, 1 when not reloading. */
  reloadProgress: number;
}

/**
 * The kick the camera should be drawn with this frame. Render-only, and deliberately separate
 * from the aim kick: mixing the two is how you get a gun that both punches *and* silently
 * teleports your aim, and then nobody can tell which of the two is mistuned.
 */
export interface ViewPunch {
  pitch: number;
  yaw: number;
  back: number;
}

const DEG = Math.PI / 180;

export class Rifle {
  readonly tunables: RifleTunables;
  private readonly rng: Rng;

  private cooldown = 0;
  private sinceShot = 1e9;
  /** Rounds left. Filled in the constructor from the tunable, so a slider change is not retroactive. */
  private rounds: number;
  /** Seconds left in the current magazine swap, 0 when not reloading. */
  private reloadLeft = 0;
  private shots = 0;
  private hits = 0;

  /** Bloom, degrees. */
  private spread = 0;
  /** Aim kick already applied to the player's heading, degrees. */
  private risePitch = 0;
  private riseYaw = 0;
  /** Where recovery is pulling that back to — set when the burst ends. */
  private holdPitch = 0;
  private holdYaw = 0;

  private readonly punch: ViewPunch = { pitch: 0, yaw: 0, back: 0 };

  /** Ring of recent shots, newest last. Debug tracer overlay and keyframe assertions read it. */
  private readonly log: Shot[] = [];
  private readonly logKeep = 64;
  private lastShot: Shot | null = null;

  constructor(
    private readonly bus: SoundBus,
    private readonly world: HitscanWorld,
    seed: number,
    tunables: RifleTunables = defaultRifleTunables(),
  ) {
    this.tunables = tunables;
    this.rounds = Math.max(1, Math.round(tunables.magazine));
    // A stream of its own: the layout RNG must not be perturbed by how much the player shoots.
    this.rng = makeRng((seed ^ 0x5f3b91) >>> 0);
  }

  getStats(): RifleStats {
    return {
      shots: this.shots,
      hits: this.hits,
      spreadDeg: this.tunables.spreadDeg + this.spread,
      risePitchDeg: this.risePitch,
      riseYawDeg: this.riseYaw,
      ready: this.cooldown <= 0 && this.reloadLeft <= 0 && this.rounds > 0,
      rounds: this.rounds,
      magazine: Math.max(1, Math.round(this.tunables.magazine)),
      reloading: this.reloadLeft > 0,
      reloadProgress: this.reloadLeft > 0
        ? 1 - this.reloadLeft / Math.max(0.01, this.tunables.reloadSeconds)
        : 1,
    };
  }

  get recentShots(): readonly Shot[] {
    return this.log;
  }

  get last(): Shot | null {
    return this.lastShot;
  }

  /** The render-only kick. Read once per frame by the renderer; never by the simulation. */
  get viewPunch(): ViewPunch {
    return this.punch;
  }

  /**
   * One fixed tick. `held` is the trigger; the aim is passed in rather than looked up so the
   * rifle has no opinion about where cameras come from.
   *
   * Returns the shots that left the barrel this tick — normally none or one; the caller turns
   * them into a flash and whatever else the frame needs.
   */
  update(
    dt: number,
    held: boolean,
    pressed: boolean,
    mx: number, my: number, mz: number,
    fx: number, fy: number, fz: number,
    time: number,
    out: Shot[],
  ): void {
    const t = this.tunables;
    this.cooldown -= dt;
    this.sinceShot += dt;

    // The magazine swap. It runs on the simulation clock like everything else, and while it runs
    // the trigger does nothing at all — that helplessness is the point of the feature.
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        this.rounds = Math.max(1, Math.round(t.magazine));
        // The noise of the swap lands where the player is, when the magazine seats — not when
        // the button was pressed. Spare magazines are unlimited for now, so there is nothing
        // else to account for.
        this.bus.emit({ source: 'reload', x: mx, y: my, z: mz, loudness: t.reloadLoudness, material: 'steel' });
      }
      this.spread = Math.max(0, this.spread - t.spreadRecover * dt);
    } else if (this.rounds <= 0 && (held || pressed)) {
      // Pulling the trigger on an empty gun starts the swap. No dry-fire click: an empty
      // magazine is a state the instrument reports, not a sound the player discovers.
      this.beginReload();
    }

    // Single fire wants the *edge*: holding the trigger down must produce exactly one round.
    const wants = this.tunables.mode === 'auto' ? held : pressed;
    if (wants && this.cooldown <= 0 && this.reloadLeft <= 0 && this.rounds > 0) {
      // Rounds land on the cyclic rate, not on the tick rate: at 120 Hz sim and 720 rpm a held
      // trigger would otherwise fire on some ticks and not others, and the rhythm would wobble.
      this.cooldown += 60 / t.rpm;
      if (this.cooldown < 0) this.cooldown = 60 / t.rpm;
      this.rounds--;
      out.push(this.shoot(mx, my, mz, fx, fy, fz, time));
      this.sinceShot = 0;
    } else if (!held) {
      // Bloom bleeds off whenever the trigger is not actually producing rounds.
      this.spread = Math.max(0, this.spread - t.spreadRecover * dt);
    }

    // Recovery. Only after the burst is over, and only ever partial: a burst that came back to
    // exactly where it started would cost the player nothing.
    if (!held && this.sinceShot > t.recoverDelay) {
      const rate = t.recoverRate * dt;
      const dPitch = Math.max(-rate, Math.min(rate, this.holdPitch - this.risePitch));
      const dYaw = Math.max(-rate, Math.min(rate, this.holdYaw - this.riseYaw));
      this.risePitch += dPitch;
      this.riseYaw += dYaw;
      // ...and hand the same delta to the camera. Without this the two numbers drift apart: the
      // rifle would believe it had settled while the player's view stayed pointing at the ceiling.
      this.pendingPitch += dPitch * DEG;
      this.pendingYaw += dYaw * DEG;
    }

    const decay = Math.min(1, t.punchDecay * dt);
    this.punch.pitch -= this.punch.pitch * decay;
    this.punch.yaw -= this.punch.yaw * decay;
    this.punch.back -= this.punch.back * decay;
  }

  /**
   * The aim kick produced since the last call, in radians. The caller adds it to the player's
   * heading: the rifle deliberately does not own the camera, it only says how much the barrel
   * climbed.
   */
  private pendingPitch = 0;
  private pendingYaw = 0;

  consumeAimKick(): { pitch: number; yaw: number } {
    const kick = { pitch: this.pendingPitch, yaw: this.pendingYaw };
    this.pendingPitch = 0;
    this.pendingYaw = 0;
    return kick;
  }

  /**
   * Debug/harness only: clears the cyclic-rate cooldown so the next `update` fires immediately.
   * The keyframe generator steps the simulation by hand and needs "one round, now" to mean
   * exactly that, whatever the rpm and whichever fire mode is selected.
   */
  forceReady(): void {
    this.cooldown = 0;
  }

  /**
   * Starts a magazine swap. Refuses if one is already running or the magazine is already full —
   * "R spam" must not be a way to keep the gun permanently unusable *or* permanently noisy.
   */
  beginReload(): boolean {
    const t = this.tunables;
    if (this.reloadLeft > 0) return false;
    if (this.rounds >= Math.max(1, Math.round(t.magazine))) return false;
    this.reloadLeft = Math.max(0.01, t.reloadSeconds);
    return true;
  }

  /**
   * Debug/harness only: a full magazine, right now, with no swap and no noise. The keyframe
   * generator teleports between unrelated scenarios and must not inherit the previous one's
   * ammunition — same reasoning as `resetRecoil`.
   */
  refillMag(): void {
    this.reloadLeft = 0;
    this.rounds = Math.max(1, Math.round(this.tunables.magazine));
  }

  /** Debug/harness only: leave exactly `n` rounds, so "empty magazine" is one call away. */
  setRounds(n: number): void {
    this.reloadLeft = 0;
    this.rounds = Math.max(0, Math.min(Math.max(1, Math.round(this.tunables.magazine)), Math.round(n)));
  }

  /**
   * Drops the accumulated climb, bloom and punch. Used when the player is teleported (respawn,
   * and the harness's `pose`): recoil is a state of the body, and the body that was leaning into
   * the last burst is not the one that just appeared on the other side of the hall. Without this
   * every scenario in the frame generator inherits the previous scenario's drift.
   */
  resetRecoil(): void {
    this.risePitch = 0;
    this.riseYaw = 0;
    this.holdPitch = 0;
    this.holdYaw = 0;
    this.pendingPitch = 0;
    this.pendingYaw = 0;
    this.spread = 0;
    this.punch.pitch = 0;
    this.punch.yaw = 0;
    this.punch.back = 0;
  }

  private shoot(
    mx: number, my: number, mz: number,
    fx: number, fy: number, fz: number,
    time: number,
  ): Shot {
    const t = this.tunables;

    // --- spread: a cone around the barrel, sampled uniformly by area -------
    const half = (t.spreadDeg + this.spread) * DEG;
    const u = this.rng();
    const phi = this.rng() * Math.PI * 2;
    const theta = half * Math.sqrt(u);
    const [dx, dy, dz] = tilt(fx, fy, fz, theta, phi);

    // --- the trace --------------------------------------------------------
    const hit = this.world.raycast(mx, my, mz, dx, dy, dz, t.range);
    const ex = hit === null ? mx + dx * t.range : hit.x;
    const ey = hit === null ? my + dy * t.range : hit.y;
    const ez = hit === null ? mz + dz * t.range : hit.z;

    // --- the muzzle blast: the loudest thing in the game -------------------
    this.bus.emit({ source: 'gunshot', x: mx, y: my, z: mz, loudness: t.gunshotLoudness });

    if (hit !== null) {
      this.hits++;
      // Concept: "пуля порождает событие в точке удара". This is the mark that appears far
      // outside the lidar's reach, and it is an event about the world, not a light.
      this.bus.emit({
        source: 'bullet-hit',
        x: hit.x, y: hit.y, z: hit.z,
        loudness: t.hitLoudness,
        material: hit.prop >= 0 ? this.world.materialOf(hit.prop) : undefined,
      });
      // "пули расшвыривают лёгкие предметы" — and whatever that throwing knocks into next is an
      // ordinary physics collision, so the racket a burst starts is not scripted anywhere.
      if (hit.prop >= 0) {
        this.world.pushProp(
          hit.prop, hit.x, hit.y, hit.z,
          dx * t.hitImpulse, dy * t.hitImpulse, dz * t.hitImpulse,
        );
      }
    }

    // --- what the body feels ----------------------------------------------
    const rise = t.risePitchDeg * (0.7 + 0.6 * this.rng());
    const wander = t.riseYawDeg * (this.rng() * 2 - 1);
    this.risePitch += rise;
    this.riseYaw += wander;
    this.pendingPitch += rise * DEG;
    this.pendingYaw += wander * DEG;
    // The burst's floor: what is left when recovery has finished pulling.
    this.holdPitch = this.risePitch * (1 - t.recoverFraction);
    this.holdYaw = this.riseYaw * (1 - t.recoverFraction);

    this.punch.pitch += t.punchPitchDeg * DEG;
    this.punch.yaw += t.punchYawDeg * DEG * (this.rng() * 2 - 1);
    this.punch.back += t.punchBackM;

    this.spread = Math.min(t.spreadMax - t.spreadDeg, this.spread + t.spreadPerShot);

    const shot: Shot = {
      seq: this.shots++,
      time,
      ox: mx, oy: my, oz: mz,
      ex, ey, ez,
      hit: hit !== null,
      prop: hit?.prop ?? -1,
      distance: hit === null ? t.range : hit.distance,
    };
    this.lastShot = shot;
    this.log.push(shot);
    if (this.log.length > this.logKeep) this.log.shift();
    return shot;
  }
}

/**
 * Tilts a unit vector by `theta` radians about an axis `phi` radians around it. Builds the
 * basis from the vector itself rather than from a fixed up, so a shot straight down does not
 * degenerate.
 */
function tilt(
  fx: number, fy: number, fz: number,
  theta: number, phi: number,
): [number, number, number] {
  if (theta <= 0) return [fx, fy, fz];
  // Any vector not parallel to f.
  const ax = Math.abs(fy) < 0.9 ? 0 : 1;
  const ay = Math.abs(fy) < 0.9 ? 1 : 0;
  let rx = ay * fz - 0 * fy;
  let ry = 0 * fx - ax * fz;
  let rz = ax * fy - ay * fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const ox = Math.cos(phi) * s;
  const oy = Math.sin(phi) * s;
  const x = fx * c + rx * ox + ux * oy;
  const y = fy * c + ry * ox + uy * oy;
  const z = fz * c + rz * ox + uz * oy;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
