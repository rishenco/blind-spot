/**
 * The player's own HUD layer: the direction he was bitten from, the noise compass, and the
 * frame going dark when he is hurt.
 *
 * A separate 2D canvas over the WebGL one, and not DOM: everything here is soft fields and a
 * handful of strokes, and a couple of canvas fills are cheaper and far easier to keep honest
 * than a dozen transformed divs. It costs nothing when there is nothing to draw — the frame is
 * cleared once and the function returns before it touches a path.
 *
 * ## Why this file was rewritten: what actually broke the immersion
 *
 * The M5 version drew one thing, one way: two mathematically exact rings centred on the
 * reticle, at 42% and 74% of the half-axis, in saturated orange. The player's verdict was that
 * it looked "стеклом поверх игры", and the reasons are nameable, not a matter of opacity:
 *
 *  1. **Perfect circles.** There is not one circle in this game. The hall is boxes, the lidar
 *     is dots, the sound layer is lopsided blobs. A `ctx.arc` at a constant radius is the only
 *     Euclidean object on screen and the eye finds it instantly and files it under "menu".
 *  2. **Always there, always identical.** Same radius, same thickness, same hue, every time,
 *     with no lag, no drift and no noise. A device that never errs is not a device; it is a
 *     label. The lore in `concept.md` says the HUD is a *прибор* — so it is allowed to lag,
 *     to quantise, to smear, to be attached to a physical piece of glass in front of a face.
 *  3. **Pinned to the pixel grid.** When a bite knocks the head, the entire world lurches and
 *     the HUD does not move by a pixel. That single mismatch is the whole "stuck on the
 *     monitor" feeling, and it is free to fix.
 *  4. **It owns the muzzle flash's hue.** Saturated amber-orange is the colour of the only real
 *     light in the game. A HUD painted in it is competing with illumination, and the brain
 *     files warm+bright as "fire", i.e. as part of the world, i.e. as a lie.
 *  5. **Vector-crisp.** Antialiased strokes with butt caps are the only hard-edged clean
 *     geometry in a frame otherwise made of blur and speckle. It reads as a second renderer.
 *
 * So this file no longer has *a* look. It has four, switchable at runtime (GUI → player / hud →
 * look, or `bs.vitals.hudStyle(name)`), the way the sound-marker styles were offered — because
 * the last time a look was argued about, the human picked from seven and not from one polished
 * guess. Each is a different theory of what the HUD *is*, not a different opacity:
 *
 *  - `visor`  it is a physical piece of glass in front of his face. Nothing is drawn as a
 *             shape; heat and dirt bloom into the corner the event came from, off-centre and
 *             lopsided, and the whole layer *lags* the head when he is hit — glass has mass.
 *             No circle, no ring, no line anywhere in it.
 *  - `sonar`  it is a device with a refresh rate. It is stale: readings step at 4 Hz, snapped
 *             to 32 sectors and three brightness levels, so a bite appears a beat *after* it
 *             lands. Thin, dim, colourless ticks. It reads as an instrument because it is
 *             visibly worse than the truth.
 *  - `bone`   there is no instrument. The only thing on screen is the dark closing in, and it
 *             closes in harder from the side that hurt him, and it breathes with a pulse that
 *             quickens as he bleeds out. Zero marks, zero lines, zero colour: the most literal
 *             possible reading of law 1.
 *  - `ring`   the M5 layer, kept verbatim so the other three can be judged against the thing
 *             that was rejected rather than against memory.
 *
 * **Why nothing here is a red flash.** The default frame of this game is black; anything
 * full-screen and bright is instantly the loudest thing that has ever been on it, and it wipes
 * the lidar map, the marks and the muzzle flash out of the player's eye for half a second. So
 * the response to a bite goes the other way in every style: the edge of the frame *closes
 * down*. Nothing in this file brightens a pixel by more than a smear at the rim.
 *
 * Determinism: the only stochastic-looking things are `hash()` of an event id against the
 * quantised clock, so a keyframe replays every flicker and every lobe to the pixel.
 */
import type { PlayerVitals, DamageMark } from './vitals';

/** The four theories. See the file header for what each one is arguing. */
export type HudStyle = 'visor' | 'sonar' | 'bone' | 'ring';

/**
 * Boot order — first entry is what the game starts in. `sonar` since 2026-08-25: the human
 * played all four and picked it, with "мб потом все таки визор заюзаем", so `visor` stays in
 * the set and stays finished rather than being deleted as the runner-up.
 */
export const HUD_STYLES: readonly HudStyle[] = ['sonar', 'visor', 'bone', 'ring'];

export interface HudLayerTunables {
  /** Which look. Undecided on purpose — the human picks by eye, as with the marker styles. */
  style: HudStyle;
  /** Damage-wedge ring radius, as a fraction of half the shorter screen axis. `ring` only. */
  wedgeRadius: number;
  /** Angular half-width of a wedge, degrees. `ring` only. */
  wedgeSpreadDeg: number;
  /** Wedge thickness in CSS pixels at full strength. `ring` only. */
  wedgeThickness: number;
  /** How dark the frame's edge goes at a fresh bite, 0..1. */
  stingDark: number;
  /** How dark it stays while health is low, 0..1. */
  lowDark: number;
  /** Overall opacity of everything on this layer. */
  brightness: number;
  /**
   * How far the layer swings when the head is knocked, in pixels per radian of flinch. The
   * layer moves *against* the punch: the head goes, the heavy glass follows late. Zero pins it
   * back to the pixel grid, which is exactly the thing that broke the immersion.
   */
  lagPx: number;
  /** `sonar`: readings per second. Low on purpose — the staleness is the characterisation. */
  refreshHz: number;
  /** `sonar`: how many sectors a bearing is rounded to. */
  sectors: number;
  /**
   * The instrument cluster (M6a): how bright the ammunition / scanner / hand readouts are, 0
   * turns them off entirely.
   */
  instBright: number;
  /**
   * Seconds a readout stays up after the thing it reports changed. It is not a permanent bar:
   * law 1 says nothing renders "просто так", so at rest — full magazine, charged scanner, empty
   * hand — this cluster draws exactly zero pixels. It appears when something *happened*, and it
   * stays up as long as something is wrong (empty, reloading, still charging).
   */
  instHold: number;
  /** Width of the cluster, as a fraction of half the shorter screen axis. */
  instSpan: number;
  /** How far below centre the cluster sits, same unit. */
  instDrop: number;
}

export function defaultHudLayerTunables(): HudLayerTunables {
  return {
    style: 'sonar',
    wedgeRadius: 0.42,
    wedgeSpreadDeg: 26,
    wedgeThickness: 7,
    stingDark: 0.62,
    lowDark: 0.34,
    brightness: 1,
    lagPx: 620,
    refreshHz: 4,
    sectors: 32,
    instBright: 1,
    instHold: 2.5,
    instSpan: 0.52,
    instDrop: 0.74,
  };
}

/**
 * What the kit knows about the player's own hands (M6a): how many rounds, whether the scanner
 * has come back, and whether there is anything in the left hand.
 *
 * Three readings and no fourth. The human's brief was explicit — "не заливай экран цифрами" —
 * so this struct is deliberately the *whole* of what the instrument cluster is allowed to know.
 * Anything that is not one of these three states cannot be drawn, because there is nowhere to
 * put it.
 */
export interface Instruments {
  /** Rounds left in the magazine. */
  rounds: number;
  magazine: number;
  reloading: boolean;
  /** 0..1 through the swap; 1 when not reloading. */
  reloadProgress: number;
  /** 0..1 towards the next scanner charge. */
  scanCharge: number;
  scanReady: boolean;
  /** Is there something in the left hand. */
  held: boolean;
}

/** One notch on the noise ring, already resolved to screen space by the caller. */
export interface CompassNotch {
  /** Screen bearing, radians clockwise from straight up. */
  angle: number;
  /** 0..1 — fade times loudness. */
  strength: number;
  /**
   * Something alive that is not you made this noise. The *only* thing colour is allowed to say
   * on this layer — see the palette note in `src/hud/compass.ts`. Styles that cannot use hue
   * (`bone` draws with darkness alone) use it as weight instead, never as brightness.
   */
  alien: boolean;
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

/** Everything one style needs for one frame, resolved once by `draw`. */
interface Frame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  half: number;
  marks: readonly DamageMark[];
  notches: readonly CompassNotch[];
  compass: CompassDraw;
  /** 0..1 how far the edge has closed in, before any style-specific shaping. */
  dark: number;
  down: boolean;
  degrade: number;
  time: number;
  yaw: number;
  vitals: PlayerVitals;
  /** Bearing of the newest live bite in screen space, or null. */
  hurtFrom: number | null;
  /** 0..1 freshness of that bite. */
  hurtHot: number;
  /** The hands, and how visible each of the three readouts is right now, 0..1. */
  inst: Instruments | null;
  instAmmo: number;
  instScan: number;
  instHand: number;
}

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

  /*
   * Instrument-cluster memory: the moment each of the three readouts last had something to say.
   * It lives here rather than in the caller because it is purely presentation — the rifle knows
   * how many rounds are left, it has no business knowing how long a HUD lingers.
   */
  private ammoAt = -1e9;
  private scanAt = -1e9;
  private handAt = -1e9;
  private lastRounds = -1;
  private lastReloading = false;
  private lastScanReady = true;
  private lastHeld = false;

  constructor(
    readonly tunables: HudLayerTunables = defaultHudLayerTunables(),
    parent: HTMLElement = document.body,
  ) {
    this.canvas = document.createElement('canvas');
    // z-index 9: under the debug HUD (10) so a panel is never obscured by the layer, over the
    // WebGL canvas so it is not eaten by the black clear.
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
    // One device pixel per CSS pixel is plenty for soft fields, and it keeps the per-frame
    // clear off the list of things that could ever cost a millisecond.
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

  setStyle(style: HudStyle): void {
    this.tunables.style = style;
    this.dirty = true;
  }

  get style(): HudStyle {
    return this.tunables.style;
  }

  /**
   * One frame. `yaw` is the *render* camera's yaw, so a bearing tracks a head turn with no lag,
   * and `time` is the render clock, so a fade is smooth between simulation ticks.
   */
  draw(
    vitals: PlayerVitals,
    yaw: number,
    time: number,
    notches: readonly CompassNotch[],
    compass: CompassDraw,
    inst: Instruments | null = null,
  ): void {
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

    const lit = this.instrumentFade(inst, time);
    const instOn = lit.ammo + lit.scan + lit.hand > 0.004;

    if (marks.length === 0 && notches.length === 0 && dark <= 0.001 && !down && !instOn) {
      // Nothing to say. Clear once, then stop paying for the layer entirely.
      if (this.dirty) {
        ctx.clearRect(0, 0, w, h);
        this.dirty = false;
      }
      return;
    }
    ctx.clearRect(0, 0, w, h);
    this.dirty = true;

    const newest = marks.length > 0 ? marks[marks.length - 1]! : null;
    const life = vitals.tunables.markLife;
    const hot = newest === null ? 0 : Math.max(0, 1 - (time - newest.at) / life);

    const f: Frame = {
      cx: w * 0.5,
      cy: h * 0.5,
      w,
      h,
      half: Math.min(w, h) * 0.5,
      marks,
      notches,
      compass,
      dark: down ? Math.max(dark, 0.86) : dark,
      down,
      degrade,
      time,
      yaw,
      vitals,
      hurtFrom: newest === null ? null : screenAngle(newest.bearing, yaw),
      hurtHot: hot * hot,
      inst,
      instAmmo: lit.ammo,
      instScan: lit.scan,
      instHand: lit.hand,
    };

    /*
     * The lag. The head is knocked; the kit strapped to it arrives late and swings the other
     * way. One `translate` + `rotate` for the whole layer, and it is the single cheapest thing
     * in this file that stops it reading as a decal on the monitor. `ring` is deliberately
     * excluded — it is the exhibit of what was wrong, and pinning it is half of what was wrong.
     */
    const punch = vitals.viewPunch;
    const lag = t.style === 'ring' ? 0 : t.lagPx;
    ctx.save();
    if (lag !== 0 && (punch.yaw !== 0 || punch.pitch !== 0 || punch.roll !== 0)) {
      ctx.translate(f.cx + punch.yaw * lag, f.cy - punch.pitch * lag);
      ctx.rotate(-punch.roll * 0.55);
      ctx.translate(-f.cx, -f.cy);
    }

    switch (t.style) {
      case 'visor':
        this.drawVisor(f);
        break;
      case 'sonar':
        this.drawSonar(f);
        break;
      case 'bone':
        this.drawBone(f);
        break;
      default:
        this.drawRing(f);
        break;
    }
    // `bone` renders literally zero pixels by design; it does not get a cockpit either.
    if (instOn && t.style !== 'bone') this.drawInstruments(f);
    ctx.restore();
    if (f.down) this.drawDown(f.cx, f.cy);
  }

  /**
   * How visible each of the three readouts is this frame.
   *
   * Two rules, and the first one is law 1: a readout is drawn only when it has something to say.
   * Something *happened* — a round left the barrel, the swap finished, the scanner came back, the
   * hand closed on a can — buys `instHold` seconds and then fades out. Something is *wrong* —
   * empty magazine, swap in progress, scanner still charging, something still in the hand — is
   * held up for as long as it is true, because that is the state the player is paying for.
   *
   * At rest, with a full magazine and a charged scanner and an empty hand, all three are zero and
   * the cluster costs nothing and draws nothing.
   */
  private instrumentFade(
    inst: Instruments | null,
    time: number,
  ): { ammo: number; scan: number; hand: number } {
    if (inst === null || this.tunables.instBright <= 0) return { ammo: 0, scan: 0, hand: 0 };
    // A teleport or a reload rewinds the clock in the harness; never hold a stamp from the future.
    if (time + 1e-3 < this.ammoAt) this.ammoAt = -1e9;
    if (time + 1e-3 < this.scanAt) this.scanAt = -1e9;
    if (time + 1e-3 < this.handAt) this.handAt = -1e9;

    if (inst.rounds !== this.lastRounds || inst.reloading !== this.lastReloading) this.ammoAt = time;
    if (inst.scanReady !== this.lastScanReady) this.scanAt = time;
    if (inst.held !== this.lastHeld) this.handAt = time;
    this.lastRounds = inst.rounds;
    this.lastReloading = inst.reloading;
    this.lastScanReady = inst.scanReady;
    this.lastHeld = inst.held;

    const hold = Math.max(0.1, this.tunables.instHold);
    const decay = (at: number): number => {
      const age = time - at;
      if (age < 0 || age > hold) return 0;
      // Flat for the first two thirds, then out. A readout that starts dimming immediately reads
      // as a flicker rather than as a device that latched a value.
      return Math.min(1, Math.max(0, (hold - age) / (hold * 0.34)));
    };
    const wrong = (v: boolean): number => (v ? 1 : 0);
    return {
      ammo: Math.max(decay(this.ammoAt), wrong(inst.reloading || inst.rounds <= 0)),
      scan: Math.max(decay(this.scanAt), wrong(!inst.scanReady)),
      hand: Math.max(decay(this.handAt), wrong(inst.held)),
    };
  }

  // =========================================================================
  // visor — a physical piece of glass. No shapes, only stains.
  // =========================================================================

  /**
   * Nothing in here is a figure. A bite is heat soaking into the glass off in the corner it
   * came from; a noise is a faint smudge at the rim. Each stain is three overlapping lobes at
   * seeded offsets that drift slowly, so no two are the same shape and none of them is round —
   * which is the entire answer to "it looks like a menu".
   *
   * The vignette is pushed *away* from the bite, so the dark closes in from the side that hurt
   * him. Direction is carried by the shape of the darkness as much as by the stain.
   */
  private drawVisor(f: Frame): void {
    const t = this.tunables;
    const b = t.brightness;

    if (f.dark > 0.001) {
      const push = f.hurtFrom === null ? 0 : 0.16 * f.hurtHot;
      this.edge(
        f,
        f.dark,
        f.hurtFrom === null ? 0 : Math.sin(f.hurtFrom) * push * f.half,
        f.hurtFrom === null ? 0 : -Math.cos(f.hurtFrom) * push * f.half,
        [22, 6, 5],
      );
    }

    // Noise first, damage over it: a bite is the more urgent stain and must not be buried.
    for (const n of f.notches) {
      let s = n.strength * f.compass.brightness;
      if (f.degrade > 0) {
        const frame = Math.floor(f.time * 18);
        if (hash(n.seq, frame) < f.degrade * 0.55) continue;
        s *= 1 - f.degrade * 0.35 * hash(n.seq, frame + 7);
      }
      if (s <= 0.01) continue;
      const [r, g, bl] = n.color;
      // Desaturated hard: the muzzle flash owns saturated amber, and the compass borrowing it
      // is one of the things that made the layer read as light rather than as a reading.
      this.stain(f, n.angle, 0.86, f.half * 0.5, r * 0.75 + 60, g * 0.7 + 60, bl * 0.7 + 62, 0.075 * s * b, n.seq);
    }

    for (const m of f.marks) {
      const age = Math.min(1, Math.max(0, (f.time - m.at) / f.vitals.tunables.markLife));
      const fade = (1 - age) * (1 - age);
      if (fade <= 0.004) continue;
      const bite = Math.min(1.4, m.amount / Math.max(1, f.vitals.tunables.biteDamage));
      const a = screenAngle(m.bearing, f.yaw);
      // Two passes, both soft: a wide dirty bleed and a smaller hotter core, pushed further out
      // so the pair reads as one lopsided smear rather than as two circles.
      this.stain(f, a, 0.74, f.half * (0.95 + 0.25 * bite), 150, 44, 30, 0.3 * fade * b, m.seq);
      this.stain(f, a, 0.9, f.half * (0.45 + 0.14 * bite), 255, 132, 96, 0.26 * fade * b, m.seq + 977);
    }
  }

  /**
   * One stain: three seeded lobes around a point pushed `reach` of the way to the rim in
   * direction `angle`. Filled through the bounding box of each lobe, never the whole screen, so
   * twenty of them is still a few hundred thousand pixels and not twenty megapixels.
   */
  private stain(
    f: Frame,
    angle: number,
    reach: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    seed: number,
  ): void {
    if (alpha <= 0.002) return;
    const ctx = this.ctx;
    // Reach is measured to the frame edge along the bearing, not on a circle: a stain on the
    // glass sits at the edge of the *frame*, and a 16:9 frame is not round.
    const sx = Math.sin(angle);
    const sy = -Math.cos(angle);
    const span = Math.min(
      Math.abs(sx) < 1e-3 ? 1e9 : (f.w * 0.5) / Math.abs(sx),
      Math.abs(sy) < 1e-3 ? 1e9 : (f.h * 0.5) / Math.abs(sy),
    );
    const px = f.cx + sx * span * reach;
    const py = f.cy + sy * span * reach;

    for (let i = 0; i < 3; i++) {
      const h1 = hash(seed, i * 31 + 1);
      const h2 = hash(seed, i * 31 + 2);
      // A slow drift, so the stain is never quite still. Two decimal Hz: felt, not seen.
      const drift = Math.sin(f.time * (0.23 + 0.11 * h1) + h2 * 6.283) * radius * 0.09;
      const ox = px + (h1 - 0.5) * radius * 0.85 + drift;
      const oy = py + (h2 - 0.5) * radius * 0.85 - drift * 0.6;
      const rad = radius * (0.55 + 0.6 * hash(seed, i * 31 + 3));
      const a = alpha * (i === 0 ? 1 : 0.6);
      const grd = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      grd.addColorStop(0, `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(4)})`);
      grd.addColorStop(0.4, `rgba(${r | 0},${g | 0},${b | 0},${(a * 0.34).toFixed(4)})`);
      grd.addColorStop(1, `rgba(${r | 0},${g | 0},${b | 0},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(ox - rad, oy - rad, rad * 2, rad * 2);
    }
  }

  // =========================================================================
  // sonar — a device with a refresh rate, and a bad one.
  // =========================================================================

  /**
   * Everything here is computed from a *quantised* clock and a quantised bearing. The reading
   * is therefore always a little stale and always a little wrong, which is the cheapest and
   * most convincing way to say "this is a machine's opinion, not the world".
   *
   * It is also the dimmest and the thinnest of the four: single hue, three brightness steps,
   * two-pixel ticks, and no ring drawn between them, so at rest the screen is empty.
   */
  private drawSonar(f: Frame): void {
    const t = this.tunables;
    const ctx = this.ctx;
    const step = 1 / Math.max(0.5, t.refreshHz);
    const qt = Math.floor(f.time / step) * step;
    const sectors = Math.max(4, Math.round(t.sectors));
    const snap = (a: number): number => (Math.round((a / (Math.PI * 2)) * sectors) / sectors) * Math.PI * 2;
    // Three levels. A device with a bar readout does not have 256 of them.
    const quant = (v: number): number => Math.min(1, Math.max(0, Math.ceil(v * 3) / 3));

    if (f.dark > 0.001) this.edge(f, quant(f.dark) * 0.9, 0, 0, [10, 10, 12]);

    ctx.save();
    ctx.lineCap = 'butt';

    // The noise readout: one tick per sector that had an event by the last refresh.
    const rn = f.half * f.compass.radius;
    for (const n of f.notches) {
      const age = f.time - qt;
      // Stale on purpose: a reading is drawn at the strength it had at the last refresh.
      let s = quant(n.strength * f.compass.brightness * (1 - 0.25 * (age / step)));
      if (f.degrade > 0) {
        if (hash(n.seq, Math.floor(qt * t.refreshHz)) < f.degrade * 0.55) continue;
        s = quant(s * (1 - f.degrade * 0.4));
      }
      if (s <= 0.01) continue;
      const a = snap(n.angle);
      /*
       * Hue is the source and nothing else (2026-08-25). The readout stays a phosphor readout
       * — one dim green-grey for everything the world does — and the single exception is a
       * living thing that is not you, which comes back red. A device with two lamps, not a
       * palette: a red tick means "that was alive", never "that was loud" or "that was close",
       * both of which are already brightness and length.
       *
       * The alien tick is also longer and drawn brighter, because it has to be legible at a
       * glance in the corner of the eye — it is the one reading in the game worth turning for.
       */
      const [cr, cg, cb] = n.color;
      const gain = n.alien ? 0.9 : 0.5;
      this.tick(
        f.cx, f.cy, rn, a,
        (n.alien ? 11 : 7) + 5 * s, 2,
        `rgba(${cr | 0},${cg | 0},${cb | 0},${(s * gain * t.brightness).toFixed(3)})`,
      );
    }

    // The damage readout: a stack of three ticks at the sector the bite came from, which is
    // both coarser and later than the truth — you get the beat, not the bearing.
    for (const m of f.marks) {
      const age = Math.min(1, Math.max(0, (qt - m.at) / f.vitals.tunables.markLife));
      if (age <= 0) continue; // not yet refreshed: the device has not noticed
      const s = quant((1 - age) * (1 - age));
      if (s <= 0.01) continue;
      const a = snap(screenAngle(m.bearing, f.yaw));
      const rd = f.half * 0.58;
      // A stack of three, longest first: the closest a bar readout gets to saying "hard".
      for (let i = 0; i < 3; i++) {
        this.tick(f.cx, f.cy, rd + i * 8, a, 9 - i * 2, 2, `rgba(222,146,126,${(s * 0.8 * t.brightness).toFixed(3)})`);
      }
    }
    ctx.restore();
  }

  // =========================================================================
  // the instrument cluster — rounds, scanner, left hand
  // =========================================================================

  /**
   * The three readings the human asked for, in the one alphabet this HUD already speaks: short
   * hard ticks, one hue, three brightness steps, no digits and no arcs.
   *
   * It is one row low in the frame, read left to right the way a hand is: what is in the left
   * hand, what is in the magazine, what the scanner has left to do. They share a row on purpose —
   * three separate widgets in three corners is a cockpit, and the game is about not being able to
   * see. One glance down, one row, three answers.
   *
   *  - **rounds** — one tick each. Fired rounds stay drawn, at a sixth of the brightness, so the
   *    magazine has a length and "three left" is a shape rather than a number you have to count.
   *    During a swap the row fills left to right with the progress: that sweep *is* the three
   *    seconds, and it is the only clock the player gets for them.
   *  - **scanner** — one tick that grows. Stub while it charges, full length and bright when it
   *    is back. Ten seconds of a bar creeping up is the price the concept charges for geometry,
   *    made visible.
   *  - **left hand** — a bracket, two ticks with a gap. Present or absent, and nothing else: the
   *    kit can tell you your hand is full, it cannot tell you what a can is.
   *
   * `bone` is excluded by the caller — that style's whole thesis is that there is no instrument.
   */
  private drawInstruments(f: Frame): void {
    const inst = f.inst;
    if (inst === null) return;
    const t = this.tunables;
    const b = t.instBright * t.brightness;
    if (b <= 0) return;
    const ctx = this.ctx;
    const y = f.cy + f.half * t.instDrop;
    const span = f.half * t.instSpan;
    const left = f.cx - span * 0.5;
    // The one hue. Same cold phosphor as the rest of the readout: a colour here would have to
    // mean something, and these three readings are already brightness and length.
    const hue = (a: number): string => `rgba(150,166,158,${Math.max(0, Math.min(1, a)).toFixed(3)})`;

    ctx.save();
    ctx.lineCap = 'butt';

    // --- rounds -----------------------------------------------------------
    if (f.instAmmo > 0.004) {
      const n = Math.max(1, Math.round(inst.magazine));
      const gap = span / n;
      const a = f.instAmmo * b;
      const filled = inst.reloading ? Math.floor(inst.reloadProgress * n) : inst.rounds;
      for (let i = 0; i < n; i++) {
        const x = left + gap * (i + 0.5);
        const on = i < filled;
        const len = on ? 9 : 5;
        // A spent round is not erased: the empty half of the row is what "nearly out" looks like.
        this.bar(x, y, len, 2, hue(a * (on ? 0.55 : 0.09)));
      }
    }

    // --- the scanner ------------------------------------------------------
    if (f.instScan > 0.004) {
      const a = f.instScan * b;
      const x = f.cx + span * 0.5 + 18;
      const charge = inst.scanReady ? 1 : Math.max(0, Math.min(1, inst.scanCharge));
      // The stub is always drawn while the readout is up: an empty scanner still has to be a
      // thing on the screen, or "charging" and "gone" look the same.
      this.bar(x, y, 3, 2, hue(a * 0.1));
      if (charge > 0.02) this.bar(x, y, 3 + 9 * charge, 2, hue(a * (inst.scanReady ? 0.62 : 0.3)));
    }

    // --- the left hand ----------------------------------------------------
    if (f.instHand > 0.004) {
      const a = f.instHand * b * (inst.held ? 0.5 : 0.16);
      const x = f.cx - span * 0.5 - 18;
      this.bar(x - 3, y, 7, 2, hue(a));
      this.bar(x + 3, y, 7, 2, hue(a));
    }

    ctx.restore();
  }

  /** One vertical tick of the cluster, centred on `y`. The row's only primitive. */
  private bar(x: number, y: number, len: number, width: number, style: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y - len * 0.5);
    ctx.lineTo(x, y + len * 0.5);
    ctx.stroke();
  }

  /** One radial tick: a short segment pointing out along `angle`. No arcs anywhere. */
  private tick(cx: number, cy: number, r: number, angle: number, len: number, width: number, style: string): void {
    const ctx = this.ctx;
    const sx = Math.sin(angle);
    const sy = -Math.cos(angle);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cx + sx * r, cy + sy * r);
    ctx.lineTo(cx + sx * (r + len), cy + sy * (r + len));
    ctx.stroke();
  }

  // =========================================================================
  // bone — there is no instrument.
  // =========================================================================

  /**
   * The extreme reading of law 1: nothing is drawn at all, ever. The only element is the dark,
   * and it carries all three messages by shape alone —
   *
   *  - it closes in *harder from the side the bite came from*, so direction survives;
   *  - it leans in from the bearing of a noise, so the compass survives as a pressure rather
   *    than a marker;
   *  - it breathes, at a rate that climbs from 1.0 Hz healthy to 1.9 Hz at the floor, so how
   *    badly he is hurt is felt rather than read.
   *
   * A hit is the one moment it is allowed to be strong. At rest, with full health and nothing
   * making noise, this style renders literally zero pixels.
   */
  private drawBone(f: Frame): void {
    const v = f.vitals;
    // The heartbeat: a sharp systolic kick and a long slack, not a sine — a sine reads as a
    // fade, and this has to read as a body.
    const hz = 1.0 + 0.9 * (1 - v.healthFrac);
    const phase = (f.time * hz) % 1;
    const beat = Math.exp(-phase * 7) * 0.55 + Math.exp(-Math.max(0, phase - 0.28) * 9) * 0.3;
    const pulseAmt = (0.12 + 0.5 * f.degrade) * beat;

    const base = f.dark;
    const amt = Math.min(0.95, base + pulseAmt * (base > 0.001 || f.marks.length > 0 ? 1 : 0));
    const push = f.hurtFrom === null ? 0 : 0.3 * f.hurtHot;
    if (amt > 0.001) {
      this.edge(
        f,
        amt,
        f.hurtFrom === null ? 0 : Math.sin(f.hurtFrom) * push * f.half,
        f.hurtFrom === null ? 0 : -Math.cos(f.hurtFrom) * push * f.half,
        // Pure black, no dried-blood tint: this style's whole claim is that it never adds a
        // photon, and the keyframe pass checks it as a number against the layer-off frame.
        [0, 0, 0],
      );
    }

    // A noise leans the dark in from its bearing. It never brightens anything — the channel is
    // told by *subtraction*, which is the one thing a black game has in unlimited supply.
    for (const n of f.notches) {
      let s = n.strength * f.compass.brightness;
      if (f.degrade > 0) {
        const frame = Math.floor(f.time * 18);
        if (hash(n.seq, frame) < f.degrade * 0.55) continue;
      }
      if (s <= 0.02) continue;
      s = Math.min(1, s);
      // `bone` has no hue to spend, so identity is spent as weight: something alive leans the
      // dark in harder and wider than a falling crate does. Still pure subtraction (law 2).
      this.lobe(f, n.angle, f.half * (n.alien ? 1.08 : 0.95), (n.alien ? 0.62 : 0.4) * s);
    }
  }

  /** A soft wedge of extra darkness pressing in from `angle`. Bounded fill, never full-screen. */
  private lobe(f: Frame, angle: number, radius: number, alpha: number): void {
    const ctx = this.ctx;
    const sx = Math.sin(angle);
    const sy = -Math.cos(angle);
    const span = Math.min(
      Math.abs(sx) < 1e-3 ? 1e9 : (f.w * 0.5) / Math.abs(sx),
      Math.abs(sy) < 1e-3 ? 1e9 : (f.h * 0.5) / Math.abs(sy),
    );
    const px = f.cx + sx * span * 1.05;
    const py = f.cy + sy * span * 1.05;
    const grd = ctx.createRadialGradient(px, py, 0, px, py, radius);
    grd.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
    grd.addColorStop(0.5, `rgba(0,0,0,${(alpha * 0.42).toFixed(3)})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
  }

  // =========================================================================
  // ring — the M5 layer, kept as the control.
  // =========================================================================

  private drawRing(f: Frame): void {
    const t = this.tunables;
    if (f.dark > 0.001) this.edge(f, f.dark, 0, 0, [26, 4, 4]);
    if (f.notches.length > 0) this.drawCompassRing(f);
    for (const m of f.marks) this.drawWedge(f, m, t);
  }

  /**
   * The frame closing in. A radial gradient that is fully transparent across the middle and
   * reaches `amount` at the corners — the visual of tunnel vision, and the only full-screen
   * element on the layer. It never brightens a pixel. `ox/oy` offsets its centre, which is how
   * `visor` and `bone` make the dark come in from a direction.
   */
  private edge(f: Frame, amount: number, ox: number, oy: number, mid: [number, number, number]): void {
    const ctx = this.ctx;
    const cx = f.cx + ox;
    const cy = f.cy + oy;
    const outer = Math.hypot(f.w, f.h) * 0.5;
    const g = ctx.createRadialGradient(cx, cy, outer * (0.34 - 0.1 * amount), cx, cy, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    // A hint of dried blood in the middle stop rather than a red screen: at full strength this
    // is about a 6% red lift on pixels that are already 60% black.
    g.addColorStop(0.62, `rgba(${mid[0]},${mid[1]},${mid[2]},${(amount * 0.5).toFixed(3)})`);
    g.addColorStop(1, `rgba(0,0,0,${amount.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, f.w, f.h);
  }

  /**
   * The bite wedge: a thick arc on the inner ring, at the world bearing of whatever bit you,
   * re-projected onto the screen every frame so it slides round as you turn to face it.
   */
  private drawWedge(f: Frame, mark: DamageMark, t: HudLayerTunables): void {
    const life = f.vitals.tunables.markLife;
    const age = Math.min(1, Math.max(0, (f.time - mark.at) / life));
    // Fades fast at first and then lingers: you are told immediately, and reminded quietly.
    const fade = (1 - age) * (1 - age);
    if (fade <= 0.004) return;

    const bite = Math.min(1.4, mark.amount / Math.max(1, f.vitals.tunables.biteDamage));
    const angle = screenAngle(mark.bearing, f.yaw);
    const r = f.half * t.wedgeRadius;
    const spread = t.wedgeSpreadDeg * DEG * (0.75 + 0.35 * bite);
    const ctx = this.ctx;
    const cx = f.cx;
    const cy = f.cy;

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
    // A short spur pointing inward, at the exact bearing.
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
   */
  private drawCompassRing(f: Frame): void {
    const ctx = this.ctx;
    const c = f.compass;
    const r = f.half * c.radius;
    const spread = c.widthDeg * DEG;
    const frame = Math.floor(f.time * 18);
    ctx.save();
    ctx.lineCap = 'butt';
    for (const n of f.notches) {
      let s = n.strength * c.brightness;
      if (f.degrade > 0) {
        const noise = hash(n.seq, frame);
        if (noise < f.degrade * 0.55) continue; // the set drops it entirely
        s *= 1 - f.degrade * 0.35 * hash(n.seq, frame + 7);
      }
      if (s <= 0.01) continue;
      const [cr, cg, cb] = n.color;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(s * 0.24).toFixed(3)})`;
      ctx.lineWidth = c.thickness * 3;
      arc(ctx, f.cx, f.cy, r, n.angle, spread * 1.3);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(s * 0.9).toFixed(3)})`;
      ctx.lineWidth = c.thickness;
      arc(ctx, f.cx, f.cy, r, n.angle, spread);
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
