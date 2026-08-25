/**
 * The player's own HUD layer: the direction he was bitten from, the noise compass, and the
 * frame going dark when he is hurt.
 *
 * A separate 2D canvas over the WebGL one, and not DOM: everything here is arcs on a ring, and
 * three canvas strokes are cheaper and far easier to keep honest than a dozen transformed
 * divs. It costs nothing when there is nothing to draw — the frame is cleared once and the
 * function returns before it touches a path.
 *
 * **Where it sits, and why.** Both rings are centred on the reticle, at 42% and 74% of the
 * shorter half-axis. That is the empty middle of the screen: the debug panel lives in the top
 * left, the spider-state panel in the top right, the hint line along the bottom. This layer must
 * never become a third slab of text stacked on those two — on `out/spiders/03-rally-truth.png`
 * the existing two already overprint each other, and adding a third would make the frame
 * unreadable instead of merely crowded. So: no text (except the one word when you are down),
 * no boxes, no corners.
 *
 * **Why nothing here is a red flash.** The default frame of this game is black; anything
 * full-screen and bright is instantly the loudest thing that has ever been on it, and it wipes
 * the lidar map, the marks and the muzzle flash out of the player's eye for half a second. So
 * the response to a bite goes the other way: the edge of the frame *closes down*. The only
 * saturated colour on screen is the wedge itself, and it is a wedge, not a wash.
 */
import type { PlayerVitals, DamageMark } from './vitals';

export interface HudLayerTunables {
  /** Damage-wedge ring radius, as a fraction of half the shorter screen axis. */
  wedgeRadius: number;
  /** Angular half-width of a wedge, degrees. */
  wedgeSpreadDeg: number;
  /** Wedge thickness in CSS pixels at full strength. */
  wedgeThickness: number;
  /** How dark the frame's edge goes at a fresh bite, 0..1. */
  stingDark: number;
  /** How dark it stays while health is low, 0..1. */
  lowDark: number;
  /** Overall opacity of everything on this layer. */
  brightness: number;
}

export function defaultHudLayerTunables(): HudLayerTunables {
  return {
    wedgeRadius: 0.42,
    wedgeSpreadDeg: 26,
    wedgeThickness: 7,
    stingDark: 0.62,
    lowDark: 0.34,
    brightness: 1,
  };
}

/** One notch on the noise ring, already resolved to screen space by the caller. */
export interface CompassNotch {
  /** Screen bearing, radians clockwise from straight up. */
  angle: number;
  /** 0..1 — fade times loudness. */
  strength: number;
  /** Event id, for the deterministic low-health flicker. */
  seq: number;
  color: [number, number, number];
}

export interface CompassDraw {
  radius: number;
  widthDeg: number;
  thickness: number;
  brightness: number;
}

const DEG = Math.PI / 180;

export class PlayerHudLayer {
  /** Master switch for the whole layer. */
  visible = true;
  /** The bite wedge and the darkening. Separately switchable from the compass. */
  showDamage = true;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly markBuf: DamageMark[] = [];
  private dirty = false;
  private width = 1;
  private height = 1;
  private dpr = 1;

  constructor(
    readonly tunables: HudLayerTunables = defaultHudLayerTunables(),
    parent: HTMLElement = document.body,
  ) {
    this.canvas = document.createElement('canvas');
    // z-index 9: under the debug HUD (10) so a panel is never obscured by a wedge, over the
    // WebGL canvas so the ring is not eaten by the black clear.
    this.canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:9';
    parent.append(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    // One device pixel per CSS pixel is plenty for a handful of soft arcs, and it keeps the
    // per-frame clear off the list of things that could ever cost a millisecond.
    this.dpr = 1;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.dirty = true;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.canvas.style.display = on ? 'block' : 'none';
  }

  /**
   * One frame. `yaw` is the *render* camera's yaw, so the wedge tracks a head turn with no lag,
   * and `time` is the render clock, so a fade is smooth between simulation ticks.
   */
  draw(vitals: PlayerVitals, yaw: number, time: number, notches: readonly CompassNotch[], compass: CompassDraw): void {
    if (!this.visible) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const t = this.tunables;

    const marks = this.showDamage ? vitals.liveMarks(this.markBuf) : EMPTY;
    const sting = this.showDamage ? vitals.sting : 0;
    const degrade = vitals.degrade;
    const dark = this.showDamage ? sting * t.stingDark + degrade * t.lowDark : 0;
    const down = this.showDamage && !vitals.alive;

    if (marks.length === 0 && notches.length === 0 && dark <= 0.001 && !down) {
      // Nothing to say. Clear once, then stop paying for the layer entirely.
      if (this.dirty) {
        ctx.clearRect(0, 0, w, h);
        this.dirty = false;
      }
      return;
    }
    ctx.clearRect(0, 0, w, h);
    this.dirty = true;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const half = Math.min(w, h) * 0.5;

    if (dark > 0.001 || down) this.drawEdge(cx, cy, w, h, down ? Math.max(dark, 0.86) : dark);
    if (notches.length > 0) this.drawCompass(cx, cy, half, notches, compass, degrade, time);
    for (const m of marks) this.drawWedge(cx, cy, half, m, vitals, yaw, t, time);
    if (down) this.drawDown(cx, cy);
  }

  /**
   * The frame closing in. A radial gradient that is fully transparent across the middle two
   * thirds and reaches `amount` at the corners — the visual of tunnel vision, and the only
   * full-screen element on the layer. It never brightens a pixel.
   */
  private drawEdge(cx: number, cy: number, w: number, h: number, amount: number): void {
    const ctx = this.ctx;
    const outer = Math.hypot(w, h) * 0.5;
    const g = ctx.createRadialGradient(cx, cy, outer * (0.34 - 0.1 * amount), cx, cy, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    // A hint of dried blood in the middle stop rather than a red screen: at full strength this
    // is about a 6% red lift on pixels that are already 60% black.
    g.addColorStop(0.62, `rgba(26,4,4,${(amount * 0.5).toFixed(3)})`);
    g.addColorStop(1, `rgba(0,0,0,${amount.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * The bite wedge: a thick arc on the inner ring, at the world bearing of whatever bit you,
   * re-projected onto the screen every frame so it slides round as you turn to face it.
   */
  private drawWedge(
    cx: number,
    cy: number,
    half: number,
    mark: DamageMark,
    vitals: PlayerVitals,
    yaw: number,
    t: HudLayerTunables,
    time: number,
  ): void {
    const life = vitals.tunables.markLife;
    const age = Math.min(1, Math.max(0, (time - mark.at) / life));
    // Fades fast at first and then lingers: you are told immediately, and reminded quietly.
    const fade = (1 - age) * (1 - age);
    if (fade <= 0.004) return;

    const bite = Math.min(1.4, mark.amount / Math.max(1, vitals.tunables.biteDamage));
    const angle = screenAngle(mark.bearing, yaw);
    const r = half * t.wedgeRadius;
    const spread = t.wedgeSpreadDeg * DEG * (0.75 + 0.35 * bite);
    const ctx = this.ctx;

    ctx.save();
    ctx.lineCap = 'butt';
    // Two passes: a wide dim bleed under a narrow bright core, which is how you get something
    // that reads as hot on a black frame without any bloom pass.
    ctx.strokeStyle = `rgba(255,86,64,${(0.22 * fade * t.brightness).toFixed(3)})`;
    ctx.lineWidth = t.wedgeThickness * 2.6;
    arc(ctx, cx, cy, r, angle, spread * 1.5);
    ctx.strokeStyle = `rgba(255,138,96,${(0.85 * fade * t.brightness).toFixed(3)})`;
    ctx.lineWidth = t.wedgeThickness * (0.7 + 0.5 * bite);
    arc(ctx, cx, cy, r, angle, spread);
    // A short spur pointing inward, at the exact bearing. The arc says "over there"; the spur
    // says "exactly there", and together they survive being glanced at.
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,210,180,${(0.7 * fade * t.brightness).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(angle) * (r - 13), cy - Math.cos(angle) * (r - 13));
    ctx.lineTo(cx + Math.sin(angle) * (r - 3), cy - Math.cos(angle) * (r - 3));
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The noise ring. Every notch is one event that happened out of frame; nothing is drawn for
   * the ring itself, so an empty ring is genuinely empty screen and law 1 holds.
   *
   * The low-health failure is here rather than in the model: a hurt player's set drops notches
   * and stutters the ones it keeps. The dropout is `hash(seq, frame)`, a pure function of the
   * event id and the simulation clock, so a keyframe replays it exactly.
   */
  private drawCompass(
    cx: number,
    cy: number,
    half: number,
    notches: readonly CompassNotch[],
    c: CompassDraw,
    degrade: number,
    time: number,
  ): void {
    const ctx = this.ctx;
    const r = half * c.radius;
    const spread = c.widthDeg * DEG;
    const frame = Math.floor(time * 18);
    ctx.save();
    ctx.lineCap = 'butt';
    for (const n of notches) {
      let s = n.strength * c.brightness;
      if (degrade > 0) {
        const noise = hash(n.seq, frame);
        if (noise < degrade * 0.55) continue; // the set drops it entirely
        s *= 1 - degrade * 0.35 * hash(n.seq, frame + 7);
      }
      if (s <= 0.01) continue;
      const [cr, cg, cb] = n.color;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(s * 0.24).toFixed(3)})`;
      ctx.lineWidth = c.thickness * 3;
      arc(ctx, cx, cy, r, n.angle, spread * 1.3);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(s * 0.9).toFixed(3)})`;
      ctx.lineWidth = c.thickness;
      arc(ctx, cx, cy, r, n.angle, spread);
    }
    ctx.restore();
  }

  /** Down. One word, dead centre, because at this point there is nothing else to say. */
  private drawDown(cx: number, cy: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,150,130,0.8)';
    ctx.fillText('DOWN  ·  R', cx, cy);
    ctx.restore();
  }

  dispose(): void {
    this.canvas.remove();
  }
}

const EMPTY: DamageMark[] = [];

/**
 * World bearing → screen bearing, radians clockwise from up. `bearing` is
 * `atan2(dx, dz)` towards the thing and `yaw` is the camera's, which at yaw 0 looks down -Z.
 */
export function screenAngle(bearing: number, yaw: number): number {
  let a = -(bearing - yaw + Math.PI);
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function arc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, angle: number, spread: number): void {
  // Canvas angles run clockwise from +X, ours run clockwise from up, hence the -90°.
  const a = angle - Math.PI / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a - spread, a + spread);
  ctx.stroke();
}

/** Deterministic 0..1 from two integers. No RNG state, so it never desynchronises a replay. */
function hash(a: number, b: number): number {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2545f491) >>> 0;
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
}
