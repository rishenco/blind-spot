/**
 * The paint system — vision doc §3, and the reason the game exists.
 *
 * It subscribes to the sound bus and, for every event it can hear, casts rays from the
 * event's *origin* against the static AABB world; every ray that lands inside the event's
 * paint radius deposits a blip. Nothing else draws the world: the meshes are dark, the lights
 * are off, and this point cloud is the entire picture.
 *
 * Five properties are load-bearing:
 *
 *  1. **Sound travels.** A blip is not born when the event fires, it is born when the event's
 *     wavefront physically *reaches* it: birth = `event.time + distance / waveSpeed`. Before
 *     that instant the shader will not draw it. A ping is therefore a front sweeping outward
 *     across the geometry — near walls answer first, the far end of the room a third of a
 *     second later — and the delay is real information: you can hear how far away a thing is
 *     by *when* it lit. See "The wave engine" below.
 *
 *  2. **Rays answer visibility; splats carry density.** A ray is a cone, not a line: everything
 *     inside its share of the solid angle landed on the patch of surface it found, so it
 *     deposits blips across that whole footprint. Because the footprints tile the surface,
 *     asking each one for `targetDensity × footprintArea` blips yields exactly `targetDensity`
 *     blips per m² — at any distance, any incidence, and any height above the floor. The §3.1
 *     quadratic falloff is then applied to `targetDensity` explicitly, relative to the event's
 *     own radius, which is what makes a bigger radius read as *louder = denser* at a fixed
 *     point: a sprint step and a crouch step both cover their own radius, so at 1.5 m the
 *     sprint step is five times the density of the crouch step.
 *
 *  3. **Age is the colour axis for matter (§3.2).** In looks 1-3 blips are cyan-family
 *     regardless of what painted them: ice-white → cyan → dim navy → a permanent skeleton at
 *     alpha 0.22. Look 4 ("Afterimage") is a candidate that spends the hue on *material* and
 *     carries age in brightness and a violet drift instead; the two share one ramp and are
 *     separated by a single `materialMix` uniform, so the law and the experiment cannot drift
 *     apart. See `materials.ts`.
 *
 *  4. **Ageing is free.** Points are written once, with a birth stamp, into a preallocated
 *     ring buffer; the shader derives everything from `now - birth`. No per-point CPU work
 *     ever runs per frame — only when an event actually paints.
 *
 *  5. **Re-hearing a surface refreshes it.** A blip is a voxel of knowledge, not a particle:
 *     a hit that lands in an already-occupied cell restamps that point instead of stacking a
 *     second one on top of it. That is what keeps repeat-scanned floors from blowing out into
 *     white mush, and it bounds the buffer by the surface area of the level rather than by how
 *     long the player has been walking around.
 *
 * ## The wave engine, and the one rule that governs it
 *
 * Every blip carries *two* stamps instead of one.
 *
 *   `aBirth` — when this event's front arrives here. Ahead of the front this is in the future.
 *   `aPrior` — the arrival stamp this blip had *before* the new event restamped it, or -1e9 if
 *              this is the first time anything has ever painted here.
 *
 * `aPrior` is therefore not only a fallback: it is the answer to "was this ground already
 * known?", and that question decides everything about how the new event is allowed to look.
 *
 *  - **Virgin ground gets the wave.** Nothing is drawn here until the front physically arrives;
 *    at arrival the blip eases up over ~120 ms, flashing ice-white and swelling, and settles into
 *    the age ramp. That is the front made visible, and it is the whole of "sound paints the
 *    world": the picture arrives at the speed of the thing that painted it.
 *
 *  - **Known ground refreshes silently.** No arrival flash, no wave gating, no re-sweep — the
 *    blip simply grows younger, easing from the age it had to the age it now has over ~0.3 s.
 *    Re-hearing a wall you already know is not news, and drawing it as news was the single worst
 *    artefact this system has produced: a second front visibly re-scanning the room on every
 *    ping, and the ground under a sprinting player strobing three times a second because each
 *    footfall re-flashed the floor it had already painted. A refresh is information — the paint
 *    gets younger, which is *exactly* what the age ramp is for — but it is quiet information.
 *
 * The two cases share one branch on `aPrior`, so the policy cannot drift between them, and both
 * are free: the front is still a comparison against a uniform rather than a list the CPU walks.
 *
 * The arrival flash is scaled per event class (`rimScaleFor`). A ping is a deliberate question
 * and answers at full brightness; footsteps, which fire three times a second, answer at a
 * fraction of it. Sprinting into unpainted ground should read as headlights, never as a strobe.
 * `waveFx.ts` adds the part of a front that happens in the air.
 *
 * The wave also pays for itself on the CPU. Because a blip's stamp is a function of the event's
 * own time and the distance to it — and of nothing about *when* it was sampled — the sampler is
 * free to take several frames over a ping without anyone being able to tell: a ray cast three
 * frames late deposits a blip that lights at exactly the instant it would have anyway. That is
 * what lets a 110° beam cost ten thousand rays without ever costing one frame more than a few
 * milliseconds (`chunkRays`/`chunkMs`).
 *
 * Known v0 limits: when the ring wraps, the oldest blips are silently overwritten (at the
 * default cap and cell size that is several levels' worth of surface, so it is a theoretical
 * concern for now); propagation through walls (§3.4) is not modelled — a ray stops at the
 * first surface, so sound does not yet leak into the next room at reduced radius.
 */

import * as THREE from 'three';
import type { Aabb, StaticWorld } from '../core/collision';
import type { SoundClass, SoundEvent } from './soundEvents';
import {
  MATERIAL_COUNT,
  MATERIAL_VOICES,
  MATTER_COLD,
  MATTER_FRESH,
  MATTER_MID,
  VIOLET,
} from './materials';
import { MAX_LIVE_WAVES, TracerStreaks, WaveDust, type LiveWave } from './waveFx';
import {
  StructuredPaint,
  defaultStructuredTunables,
  type StructuredTunables,
} from './structured';

// ---------------------------------------------------------------------------
// Look profiles
// ---------------------------------------------------------------------------

/**
 * One "look" of the point cloud. Looks 1-3 are the same physics with different sampling and
 * splat parameters — the readability question they answer is whether the dark reads better as
 * fine dust, as sparse sonar blips, or as noisy grain. Look 4 additionally turns on the
 * material palette, the sub-linear depth curve and the per-grain cooling spread.
 */
export interface PaintProfile {
  readonly name: string;
  /** Multiplies every class's ray budget. */
  density: number;
  /** Deduplication cell size, metres — effectively the cloud's spatial resolution. */
  cellSize: number;
  /** Blip diameter in world metres (before jitter). */
  sizeWorld: number;
  /** Screen-space clamp on the splat, in drawing-buffer pixels. */
  minPixels: number;
  maxPixels: number;
  /**
   * Exponent on depth in the splat's screen size. 1 is a true world-space disc. Below 1 the
   * splat grows more slowly as you close on a surface and more quickly as it recedes, which
   * pulls a distant wall together into continuous texture without letting a near one become a
   * field of dinner plates — the reference's trick, and the reason look 4 can be this dense.
   */
  depthExp: number;
  /** 0 = crisp disc, 1 = fully feathered. */
  softness: number;
  /** ±fraction of per-point size jitter. */
  sizeJitter: number;
  /** ±fraction of per-point brightness jitter. */
  brightJitter: number;
  /** Overall output gain. */
  brightness: number;
  /** 0 = cyan band only (§3.2, the law). 1 = material voices (look 4, the candidate). */
  materialMix: number;
  /**
   * ±fraction of per-grain spread on the *cooling rate*. At 0 a scanned surface cools as one
   * sheet; turned up, each grain ages at its own pace and the cloud visibly breaks apart into
   * the skeleton grain by grain — the reference's dissolve, except that ours never reaches
   * zero (§3.6: the map is never lost, only the fine read).
   */
  dissolve: number;
  /**
   * Multiplier on how fast this look walks the shared age ramp. 1 is the ramp as authored.
   *
   * A look parameter, not a law: §3.2 fixes that age is the axis, not how many seconds a stage
   * takes. Look 4 turns it up because that is measurably what the reference does — its returns
   * settle out of the hot phase on a ~1 s exponential and are down to a fifth of their return
   * brightness inside ten seconds, where our authored ramp holds near-full brightness for
   * twenty. A room that is *all* fresh is the brightest thing this renderer can produce, and
   * spamming pings holds it there; cooling out of the fresh phase quickly is how the reference
   * keeps that from being painful.
   */
  coolRate: number;
  /** Whether this look asks for the bloom pass by default. */
  bloom: boolean;
  /**
   * True for a look that answers events with the *structured* reveal of `structured.ts` — exact
   * lattices and contours unlocked by sound — instead of the stochastic splat path. The two
   * never run at once: only one of them may consume an event, and switching looks clears both
   * (see `setProfile`), because a room half-painted in blips and half in contours would be two
   * pictures of the same room drawn to different laws.
   */
  structured: boolean;
}

export function paintProfiles(): PaintProfile[] {
  return [
    {
      // Scanner Sombre register: many small points, geometry read from density alone.
      name: 'Dust',
      density: 1.0,
      cellSize: 0.1,
      sizeWorld: 0.065,
      minPixels: 1.0,
      maxPixels: 18,
      depthExp: 1.0,
      softness: 0.3,
      sizeJitter: 0.15,
      brightJitter: 0.12,
      brightness: 1.0,
      materialMix: 0,
      dissolve: 0,
      coolRate: 1,
      bloom: false,
      structured: false,
    },
    {
      // Sonar register: fewer, fatter, soft-edged returns. Reads at a glance, loses detail.
      name: 'Blips',
      density: 0.6,
      cellSize: 0.28,
      sizeWorld: 0.175,
      minPixels: 1.6,
      maxPixels: 40,
      depthExp: 1.0,
      softness: 0.92,
      sizeJitter: 0.3,
      brightJitter: 0.15,
      brightness: 0.95,
      materialMix: 0,
      dissolve: 0,
      coolRate: 1,
      bloom: false,
      structured: false,
    },
    {
      // Textured register: mid density, heavy per-point jitter — noisy, filmic, less clinical.
      name: 'Grain',
      density: 0.8,
      cellSize: 0.16,
      sizeWorld: 0.115,
      minPixels: 1.2,
      maxPixels: 26,
      depthExp: 1.0,
      softness: 0.5,
      sizeJitter: 0.8,
      brightJitter: 0.55,
      brightness: 0.95,
      materialMix: 0,
      dissolve: 0,
      coolRate: 1,
      bloom: false,
      structured: false,
    },
    {
      /*
       * Afterimage register, ported from the reference: dense fine grain at a nearly uniform
       * point size, so salience is carried by *brightness* and never by size; concrete cools
       * white → cyan and metal white → gold, so the cloud tells you what a thing is made of;
       * grains cool at their own pace so the picture breaks up rather than dimming as a sheet;
       * and bloom does the rest.
       *
       * Density is up and cell size is down because the whole character depends on the grain
       * being finer than the eye can resolve individually at a distance — the reference runs a
       * ~6 cm near-field spacing, and 7.5 cm is what our budget buys over a whole room.
       *
       * Brightness and `coolRate` are the batch-2.3 fidelity pass, and both are measurements off
       * the reference rather than taste. Its hot phase is an exponential with a ~1 s time
       * constant (`exp(-age*0.95)` on the colour, `0.20 + 0.80*exp(-age*0.34)` on the strength),
       * so a scanned surface is out of the white within a second and down to a fifth of its
       * return brightness inside ten; ours held 90 % of full for twenty seconds, which is what
       * made a spammed ping stack a whole room's worth of near-maximum paint on screen at once.
       * 1.8× the ramp puts our fresh stage at ~1.1 s, and the gain comes down to match a look
       * that no longer has an arrival flash multiplying it (see `MATTER_VERTEX`).
       */
      name: 'Afterimage',
      density: 1.6,
      cellSize: 0.075,
      sizeWorld: 0.042,
      minPixels: 1.0,
      maxPixels: 7,
      depthExp: 0.85,
      softness: 0.4,
      sizeJitter: 0.14,
      brightJitter: 0.34,
      brightness: 1.0,
      materialMix: 1,
      dissolve: 0.55,
      coolRate: 1.8,
      bloom: true,
      structured: false,
    },
    {
      /*
       * Blueprint (Чертёж) — the structured candidate, and the only look that is not a cloud.
       *
       * Nothing here is sampled: the level's geometry is known, so a sound *unlocks* the part of
       * it that the sound actually reached — a uniform lattice of dim dots across every revealed
       * face and a bright contour along every revealed edge. What the player reads is a CAD
       * drawing being surveyed by ear, arriving as a *single* pressure front (see
       * `structured.ts`): the ring displaces and burns the lattice as it passes, and the contours
       * ink themselves in at the ring, segment by segment, not behind it.
       *
       * The splat fields below are inert for this look — it never deposits a blip — and are kept
       * at look 1's values purely so the shared Paint folder has something sane to show.
       */
      name: 'Blueprint',
      density: 1.0,
      cellSize: 0.1,
      sizeWorld: 0.065,
      minPixels: 1.0,
      maxPixels: 18,
      depthExp: 1.0,
      softness: 0.3,
      sizeJitter: 0.15,
      brightJitter: 0.12,
      brightness: 1.0,
      materialMix: 0,
      dissolve: 0,
      coolRate: 1,
      // Contours are thin bright lines on black, which is exactly what a mild bloom flatters:
      // the ink gains a halo and the lattice stays quiet. Vetoed automatically under software GL.
      bloom: true,
      structured: true,
    },
  ];
}

/**
 * Age ramp (§3.2 and §3.6). Times are seconds on the paint clock; the last stage never
 * completes — a surface cools into the permanent memory skeleton and stays there.
 */
export interface AgeRamp {
  /** Ice-white → cyan. */
  freshSeconds: number;
  /** Cyan → dim navy. */
  coolSeconds: number;
  /** Navy → memory skeleton. */
  coldSeconds: number;
  /** Alpha floor of the skeleton (§3.6 asks for ~0.22). */
  skeletonAlpha: number;
  /** Size multiplier once fully cooled — the skeleton is thinner as well as dimmer. */
  skeletonSize: number;
}

export function defaultAgeRamp(): AgeRamp {
  return {
    freshSeconds: 2,
    coolSeconds: 20,
    coldSeconds: 60,
    skeletonAlpha: 0.22,
    skeletonSize: 0.7,
  };
}

/**
 * The wave's own numbers: how the front announces itself, what the firing looks like, and
 * whether the air shows it. Speeds live on the sound classes (`WAVE_SPEEDS`), because how fast
 * a noise travels is a property of the noise, not of how we draw it.
 */
export interface WaveTunables {
  /**
   * Brightness *added* at the instant of arrival, on top of the ice-white flash.
   *
   * Added, not multiplied, and that is the reference's mechanism rather than a detail: it drives
   * its flash as `bright += flash * 2.1` over a return strength of order one. A multiplier gives
   * the brightest returns — the near-field floor right under you — the biggest absolute flash,
   * which is precisely the wrong place to put a strobe; an addend gives a dim distant return the
   * same visible arrival as a hot near one, which is what makes a front read as a front all the
   * way out.
   */
  rimBoost: number;
  /** Time constant of that flash, seconds — the visible thickness of the front is speed × this. */
  rimSeconds: number;
  /** How much the splat swells at arrival (0 = none). */
  rimSize: number;
  /**
   * How long a *virgin* blip takes to ease up to full at arrival, seconds.
   *
   * Zero would be the old behaviour: a blip is nowhere, and one frame later it is at full flash.
   * At a walking pace that is a pop under every footfall. A ramp this short is still an arrival —
   * it is under two frames at 60 fps — but it is an arrival with an edge on it rather than a
   * switch being thrown.
   */
  arriveSeconds: number;
  /**
   * How long a *known* blip takes to ease from its old age to its refreshed one, seconds.
   *
   * The whole of the silent refresh. The blip never dims, never flashes and never waits for the
   * front to reach it — it just gets younger over this long, so re-hearing a place you know
   * brightens it smoothly instead of re-scanning it.
   */
  refreshSeconds: number;
  /**
   * Arrival-flash scale for the footstep classes (pings and landings answer at 1).
   *
   * Steps fire three or four times a second, and at full rim scale that is the strobe the
   * playtest complained about even on genuinely virgin ground. At 0.4 a sprint into unpainted
   * space still lights the way — the paint is there, at full steady brightness — but the *edge*
   * of it stops shouting.
   */
  stepRim: number;
  /** Lifetime of the E-ping's tracer streak, seconds (§brief: ≤0.3). */
  tracerSeconds: number;
  /** How far ahead of the rig the fan begins, metres. */
  tracerStart: number;
  /** How far along the aim the streak reaches from there, metres. */
  tracerLength: number;
  /** How far below the emission point the fan starts, metres — a small drop puts it under the
   *  reticle instead of concentric with it, which reads as coming from the rig. */
  tracerDrop: number;
  /** Streak gain. Dim on purpose: this is a question being asked, not a shot being fired. */
  tracerBrightness: number;
  /** Whether suspended particulate shows the front crossing empty air. */
  dust: boolean;
  /** Mote gain. */
  dustGain: number;
  /** Mote diameter, world metres. */
  dustSize: number;
  /** Thickness of the lit shell behind the front, metres. Distance, never time: the shell must
   *  look the same at 25 m/s and at 45 m/s or the fast beam reads as a filled cone. */
  dustShell: number;
}

export function defaultWaveTunables(): WaveTunables {
  return {
    // The reference's flash is exp(-age * 7) with an addend of 2.1; ours is
    // exp(-age * 3 / rimSeconds), so 0.42 s reproduces its shape exactly and the default sits a
    // little tighter than that. The addend is the reference's, unchanged.
    rimBoost: 2.1,
    rimSeconds: 0.28,
    rimSize: 1.35,
    arriveSeconds: 0.12,
    refreshSeconds: 0.3,
    stepRim: 0.4,
    tracerSeconds: 0.25,
    tracerStart: 1.4,
    tracerLength: 3.2,
    tracerDrop: 0.05,
    tracerBrightness: 0.55,
    /*
     * Off by default (batch 2.3, playtest). The lit air is a real effect and a genuinely pretty
     * one, but at 17 motes per m³ what it actually reads as in play is a shell of grain crossing
     * the room *in front of* the answer — a second thing arriving, on every ping, competing with
     * the geometry for the eye. The checkbox stays; the default is quiet. Off costs exactly
     * nothing: the field's object is `visible = false` and never enters the draw list.
     */
    dust: false,
    dustGain: 1.7,
    dustSize: 0.02,
    dustShell: 2.0,
  };
}

/**
 * How loud a class's arrival flash is allowed to be, 0-1.
 *
 * A ping is a deliberate question and gets the full answer; a landing is a flashbulb by design
 * (§5: a hard landing pays in a loud paint flash); footsteps repeat several times a second and
 * are scaled down, because the arrival edge of a footfall is the one thing in this system that a
 * player sees hundreds of times a minute.
 */
function rimScaleFor(cls: SoundClass, wave: WaveTunables): number {
  return cls === 'crouch-step' || cls === 'walk-step' || cls === 'sprint-step' ? wave.stepRim : 1;
}

/** Event-layer palette (§3.2): self is amber, and the pings are the same self, brighter. */
const EVENT_COLORS: Record<SoundClass, number> = {
  'crouch-step': 0xd98a2b,
  'walk-step': 0xffa63c,
  'sprint-step': 0xffb95a,
  landing: 0xffd08a,
  'q-ping': 0xffe6b4,
  'e-ping': 0xfff0cc,
};

/**
 * Ray budget per event at profile density 1 and intensity 1.
 *
 * These set *angular resolution*, not density — the splat handles density. A budget of n rays
 * resolves features about `sqrt(4/n)` radians wide, so a walk step can tell a crate from a wall
 * and the E-ping can pick a railing out across the room. Rays are also the expensive half of
 * painting (a cast costs roughly four times a blip), which is why they are spent on the events
 * whose whole job is to answer a question.
 *
 * The E-ping's budget went up with its cone: 110° is eighteen times the solid angle of the old
 * 25° slit, and at 5600 rays that cone would have resolved nothing finer than a doorway. 9000
 * over 2.68 sr gives a ~0.01 rad footprint — 21 cm at the 22 m limit — which is a handrail.
 */
const CLASS_RAYS: Record<SoundClass, number> = {
  'crouch-step': 260,
  'walk-step': 760,
  'sprint-step': 1200,
  landing: 1900,
  'q-ping': 3600,
  'e-ping': 9000,
};

// ---------------------------------------------------------------------------
// Tunables that are not per-look
// ---------------------------------------------------------------------------

export interface PaintTunables {
  /** §3.1: paint is only received from events inside your own hearing range, metres. */
  hearingRange: number;
  /** §3.6: only blips within this radius of the listener are drawn, metres. */
  windowRadius: number;
  /** Fraction of the paint radius after which hits start thinning out to a soft rim. */
  featherStart: number;
  /** Dimming applied to a blip at the very edge of its event (1 = none). */
  rimDim: number;
  /** Distance past which E-ping returns start collapsing to silhouettes, metres (§3.5). */
  edgeStart: number;
  /** Distance at which that collapse is complete, metres. */
  edgeFull: number;
  /** How close to a face's border counts as an edge, metres. */
  edgeBand: number;
  /** Fraction of far, non-edge E-ping hits that survive. */
  farThin: number;
  /** Brightness multiplier on far edge hits — what turns the survivors into lines. */
  edgeBoost: number;
  /** Blips are floated this far off the surface so they read as sitting on it, metres. */
  surfaceOffset: number;
  /** Voxel dedup on/off. Off is the naive "one point per hit" behaviour. */
  dedupe: boolean;
  /** Most blips one ray may splat across its footprint — a safety valve, not a tuning knob. */
  splatCap: number;
  /** Peak blip density as a fraction of the dedup grid's saturation (1 = a blip per cell). */
  splatFill: number;
  /**
   * §3.1's quadratic falloff, in units of the event's own radius: density at distance t is
   * `peak / (1 + falloffK · (t/paintRadius)²)`. 0 would paint a hard-edged slab of uniform
   * density; higher values pull the paint in toward the origin.
   */
  falloffK: number;
  /**
   * Return at a grazing surface, relative to a head-on one (1 = no incidence dimming). Kept
   * mild: it is the cheapest shape cue the cloud has, but almost every floor you walk on is
   * grazing, so a hard incidence penalty just turns the ground grey.
   */
  grazeDim: number;
  /** Fraction of a cone's outer angle over which returns feather out. */
  coneFeather: number;
  /** Hard ceiling on blips deposited by one event, so no ping can stall a frame. */
  maxPerEvent: number;
  /** Hard ceiling on rays cast by one event, whatever the class and profile ask for. */
  rayCap: number;
  /**
   * Most rays one *chunk* of sampling may cast, and the wall-clock budget it may spend.
   *
   * A 110° E-ping is ten thousand rays and forty thousand blips; done in one tick that is a
   * 30 ms hitch, and law 5 says movement never pays for information. So sampling is amortised:
   * the event is planned in the tick it fires, the first chunk runs immediately so the ping
   * always answers on the same frame, and the rest are drained a chunk per frame. This is only
   * possible *because* of the wave — a blip's arrival stamp comes from the event's own time and
   * the distance to it, so a point sampled three frames late still lights at exactly the
   * instant the front reaches it, and no one can tell.
   */
  chunkRays: number;
  chunkMs: number;
  /**
   * Most blips one chunk may lay down, wall clock notwithstanding.
   *
   * The clock is polled every sixteenth ray, and a ray in a dense look can splat a hundred and
   * twenty blips, so the poll alone lets a chunk run two thousand deposits past its deadline —
   * measured at three times the budget on a loaded software rasteriser. Deposits are what the
   * time actually goes on, so counting them is the bound that holds when the wall clock's
   * resolution does not.
   */
  chunkBlips: number;
  /** Minimum wall-clock gap between chunks, ms — what makes it one chunk per frame. */
  chunkGapMs: number;
  /**
   * Screen-size ceiling on a blip, in drawing-buffer pixels.
   *
   * A world-sized splat grows as 1/depth, so at arm's length from a wall one return covers a
   * quarter of the screen and the frame becomes a wall of overlapping dinner plates — the
   * single ugliest thing the old E-ping did, and the reason "ping the wall you are hugging"
   * looked like a bug. The clamp is a soft knee rather than a `min`, so nothing below about
   * half the cap is touched at all and there is no visible size cliff.
   */
  pixelCap: number;
  /** Scale on the per-material micro-relief the deposit is displaced by (0 = perfectly flat). */
  roughness: number;
}

export function defaultPaintTunables(): PaintTunables {
  return {
    hearingRange: 18,
    windowRadius: 45,
    featherStart: 0.72,
    rimDim: 0.6,
    // Pulled in with the E-ping's range: the silhouette collapse has to finish inside the beam
    // to mean anything, and a 22 m beam that only starts thinning at 10 m and never completes
    // is just a dimmer beam.
    edgeStart: 12,
    edgeFull: 22,
    edgeBand: 0.5,
    farThin: 0.3,
    edgeBoost: 2.4,
    surfaceOffset: 0.012,
    dedupe: true,
    splatCap: 128,
    splatFill: 0.9,
    falloffK: 4,
    grazeDim: 0.68,
    coneFeather: 0.32,
    maxPerEvent: 60_000,
    rayCap: 10_000,
    chunkRays: 2500,
    chunkMs: 4,
    chunkBlips: 6000,
    chunkGapMs: 6,
    pixelCap: 10,
    roughness: 1,
  };
}

/** Default ring capacity. 500k blips × 32 B of attributes ≈ 16 MB on the GPU and again on the CPU. */
export const DEFAULT_CAPACITY = 500_000;
/** How many event-layer markers can be alive at once. */
const EVENT_CAPACITY = 512;
/** Event marker fade, seconds (§3.2 asks for 2.5-6 s). */
const EVENT_FADE = 2.5;
/** Event marker diameter, world metres. */
const EVENT_SIZE = 0.55;
/**
 * Motes in the dust field, and the side of the cube they wrap around the listener in.
 *
 * These two are really one number — motes per m³ — because that is what decides how many grains
 * a passing shell actually lights, and the count in view is what makes it read as a front rather
 * than as noise. The shell's lit volume grows as r², so a field big enough to cover a 22 m beam
 * is a field too thin to see: 14k motes in a 34 m cube (0.36/m³, the first pass) lit about forty
 * grains anywhere in view, which looked like sensor noise. 48k in a 14 m cube is 17 per m³ — 50×
 * denser, a few hundred grains at the front — at the price of the effect being a near-field one.
 * That is the right trade: past a few metres the front is already carried by the geometry it is
 * painting, and dust that dims with distance is what suspended particulate actually does.
 *
 * The reference gets away with 0.25 motes/m³ because its field carries an ambient term: its motes
 * glow faintly at all times, so the air reads as a medium and a passing front reads as that
 * medium brightening. Law 3 forbids us that — unlit air is never drawn — so here the front has to
 * carry the whole effect on its own, and density is the only lever left.
 */
const DUST_COUNT = 48_000;
const DUST_EXTENT = 14;
/** Birth stamp meaning "nothing was ever known here". */
const NEVER = -1e9;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * How far a grazing hit may stretch its footprint before the smear stops growing.
 *
 * The stretch is what keeps a floor covered — a surface met at 80° carries six times the area
 * per unit of solid angle that a wall met head-on does — but the flat ellipse the splat uses is
 * only a good stand-in for the real footprint while the whole patch sits at roughly one
 * distance. Past ~12 the ellipse would reach back behind the sound itself, so it is clamped and
 * that last sliver of grazing floor is allowed to thin out instead.
 */
const MAX_FOOTPRINT_STRETCH = 12;

/** mulberry32 — small, fast, and seedable so screenshots of different looks are comparable. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Colours are authored in sRGB and written straight to the framebuffer by the raw shader. */
function rawColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

/**
 * Value noise on a 3D lattice, one octave.
 *
 * Only the deposit path uses it, once per ray, to displace a whole footprint along the surface
 * normal by the material's micro-relief. Coherence is the point: a per-blip random offset is
 * just fuzz, whereas a field that varies over ~30 cm reads as a *surface* — pitted concrete,
 * milled metal, cut stone. One sample per footprint is plenty; the patch is 20 cm across.
 */
function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  let out = 0;
  for (let k = 0; k < 8; k++) {
    const cx = xi + (k & 1);
    const cy = yi + ((k >> 1) & 1);
    const cz = zi + ((k >> 2) & 1);
    let h = Math.imul(cx, 374761393) ^ Math.imul(cy, 668265263) ^ Math.imul(cz, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const g = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    const wx = (k & 1) === 1 ? u : 1 - u;
    const wy = ((k >> 1) & 1) === 1 ? v : 1 - v;
    const wz = ((k >> 2) & 1) === 1 ? w : 1 - w;
    out += g * wx * wy * wz;
  }
  return out * 2 - 1;
}

// ---- ray / AABB -----------------------------------------------------------

/** Nearest-hit scratch, reused for every ray. */
const hit = {
  t: 0,
  axis: -1,
  box: null as Aabb | null,
};

/**
 * Per-event bounding spheres of the candidate boxes, in a flat array of (cx, cy, cz, r).
 * A ray-vs-sphere reject is about a third of the cost of the slab test and throws out most
 * of the room for most rays, which is where the ping's frame budget actually goes.
 */
const spheres: number[] = [];

function buildSpheres(candidates: readonly Aabb[]): void {
  spheres.length = candidates.length * 4;
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i]!;
    const hx = (b.maxX - b.minX) / 2;
    const hy = (b.maxY - b.minY) / 2;
    const hz = (b.maxZ - b.minZ) / 2;
    const o = i * 4;
    spheres[o] = b.minX + hx;
    spheres[o + 1] = b.minY + hy;
    spheres[o + 2] = b.minZ + hz;
    spheres[o + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
  }
}

/**
 * Nearest intersection of a ray with a candidate list, using the slab test.
 * Returns false when nothing was hit inside `maxT`. Boxes the origin is already inside are
 * skipped: a sound made *inside* a wall is not a thing the game can produce.
 */
function castRay(
  candidates: readonly Aabb[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): boolean {
  let nearest = maxT;
  let nearestAxis = -1;
  let nearestBox: Aabb | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const o4 = i * 4;
    const r = spheres[o4 + 3]!;
    const ex = spheres[o4]! - ox;
    const ey = spheres[o4 + 1]! - oy;
    const ez = spheres[o4 + 2]! - oz;
    const proj = ex * dx + ey * dy + ez * dz;
    if (proj - r > nearest) continue; // entirely past the closest hit so far
    if (proj < -r) continue; // entirely behind the ray
    const perp = ex * ex + ey * ey + ez * ez - proj * proj;
    if (perp > r * r) continue; // the ray line misses the bounding sphere

    const b = candidates[i]!;
    let tmin = 0;
    let tmax = nearest;
    let axis = -1;
    let miss = false;

    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
      const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
      if (d > -1e-9 && d < 1e-9) {
        if (o < lo || o > hi) {
          miss = true;
          break;
        }
        continue;
      }
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) {
        miss = true;
        break;
      }
    }
    // axis < 0 means the origin started inside this box on every slab — not a surface hit.
    if (miss || axis < 0 || tmin >= nearest) continue;
    nearest = tmin;
    nearestAxis = axis;
    nearestBox = b;
  }

  if (nearestBox === null) return false;
  hit.t = nearest;
  hit.axis = nearestAxis;
  hit.box = nearestBox;
  return true;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Everything about a blip's appearance is a function of its own attributes and the clock, so
 * all of it is computed once per vertex and handed to the fragment stage as a colour and an
 * alpha. The fragment shader's only job is the splat's shape.
 */
const MATTER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSizeWorld;
  uniform float uProjScale;
  uniform float uMinPixels;
  uniform float uMaxPixels;
  uniform float uPixelCap;
  uniform float uDepthExp;
  uniform float uSizeJitter;
  uniform float uBrightJitter;
  uniform float uBrightness;
  uniform float uWindowRadius;
  uniform float uSkeletonAlpha;
  uniform float uSkeletonSize;
  uniform float uRimK;
  uniform float uRimBoost;
  uniform float uRimSize;
  uniform float uArriveSeconds;
  uniform float uRefreshSeconds;
  uniform float uDissolve;
  uniform float uCoolRate;
  uniform float uMaterialMix;
  uniform vec3  uListener;
  uniform vec3  uRampTimes;      // fresh, cool, cold
  uniform vec3  uFresh;
  uniform vec3  uMid;
  uniform vec3  uCold;
  uniform vec3  uViolet;
  uniform vec3  uMatHot[${MATERIAL_COUNT}];
  uniform vec3  uMatCool[${MATERIAL_COUNT}];
  uniform float uMatSize[${MATERIAL_COUNT}];

  attribute float aBirth;
  attribute float aPrior;
  attribute float aIntensity;
  attribute float aSeed;
  attribute float aMat;
  attribute float aRim;

  varying vec3  vColor;
  varying float vAlpha;

  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

  void main() {
    vColor = vec3(0.0);
    vAlpha = 0.0;

    // §3.6: the map persists, the *rendering* is windowed. Outside the window, drop the vertex.
    if (distance(position, uListener) > uWindowRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    /*
     * The restamp policy, in eight lines (see the header).
     *
     * aPrior is the discriminator: no prior means nobody has ever painted this voxel, and the
     * new event is *news*, so it gets the whole wave — invisible until the front arrives, then
     * an eased arrival with a flash on it. A prior means this is known ground, and the refresh
     * is silent: never gated, never flashed, the age simply eases from what it was to what it
     * now is. Both branches are continuous at the arrival instant, which is the point — the old
     * hard switch is what produced a travelling band on every re-ping.
     */
    float ageNew = uTime - aBirth;
    float age;
    float flash = 0.0;
    float appear = 1.0;
    if (aPrior <= -1.0e8) {
      if (ageNew < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      age = ageNew;
      flash = exp(-ageNew * uRimK) * aRim;
      appear = smoothstep(0.0, max(0.001, uArriveSeconds), ageNew);
    } else {
      float ageOld = uTime - aPrior;
      if (ageOld < 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      // Both ages advance at the same rate, so this is a smooth slide from one to the other:
      // exactly the old age while the front is still coming, exactly the new one 0.3 s after it
      // passed, and no discontinuity anywhere between.
      age = mix(ageOld, ageNew, smoothstep(0.0, max(0.001, uRefreshSeconds), ageNew));
    }

    // Per-grain cooling spread: at uDissolve = 0 the surface cools as one sheet.
    float grain = 1.0 + uDissolve * (hash11(aSeed * 91.7) - 0.5) * 2.0;
    float rampAge = age * max(0.08, grain) * uCoolRate;

    // Material voice. Looks 1-3 hold uMaterialMix at 0 and never leave the cyan band (§3.2).
    vec3 hot = uMatHot[0];
    vec3 cool = uMatCool[0];
    float matSize = uMatSize[0];
    for (int i = 1; i < ${MATERIAL_COUNT}; i++) {
      if (abs(float(i) - aMat) < 0.5) {
        hot = uMatHot[i];
        cool = uMatCool[i];
        matSize = uMatSize[i];
      }
    }
    // Size, like hue, is a material cue only where a look has asked for one.
    matSize = mix(1.0, matSize, uMaterialMix);
    vec3 cFresh = mix(uFresh, hot, uMaterialMix);
    vec3 cMid = mix(uMid, cool, uMaterialMix);
    vec3 cCold = mix(uCold, mix(cool, uViolet, 0.85), uMaterialMix);

    vec3 col;
    float alpha;
    if (rampAge < uRampTimes.x) {
      float t = rampAge / max(0.001, uRampTimes.x);
      col = mix(cFresh, cMid, t * t);
      alpha = mix(1.0, 0.9, t);
    } else if (rampAge < uRampTimes.y) {
      float t = (rampAge - uRampTimes.x) / max(0.001, uRampTimes.y - uRampTimes.x);
      col = mix(cMid, cCold, t);
      alpha = mix(0.9, 0.42, t);
    } else {
      float t = clamp((rampAge - uRampTimes.y) / max(0.001, uRampTimes.z - uRampTimes.y), 0.0, 1.0);
      col = cCold;
      alpha = mix(0.42, uSkeletonAlpha, t);
    }
    // The instant of return: the front itself, drawn on the surface it just reached.
    col = mix(col, vec3(1.0), flash * 0.88);

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = max(0.001, -mv.z);
    float cooled = clamp(rampAge / max(0.001, uRampTimes.z), 0.0, 1.0);
    float jitter = 1.0 + uSizeJitter * (aSeed - 0.5) * 2.0;
    float shrink = mix(1.0, uSkeletonSize, cooled);
    float want = uSizeWorld * jitter * shrink * matSize * (1.0 + flash * uRimSize)
      * uProjScale / pow(depth, uDepthExp);
    // Soft knee into the screen-size cap: transparent below half of it, asymptotic above.
    float q = want / max(0.5, uPixelCap);
    float px = want / pow(1.0 + q * q * q, 0.33333334);
    px = min(px, uMaxPixels);
    px = max(px, uMinPixels);
    // Below the minimum splat size the blip covers more screen than it should; give back the
    // difference in brightness so distant clouds fade out instead of aliasing into a bright wash.
    float coverage = min(1.0, (want * want) / (px * px));

    // The flash is added to the return, not multiplied into it (see rimBoost), and the whole
    // thing is scaled by the arrival ramp so a virgin blip rises rather than pops.
    float bright = (aIntensity + uRimBoost * flash) * appear * uBrightness * coverage
      * (1.0 + uBrightJitter * (fract(aSeed * 37.13) - 0.5) * 2.0);

    vColor = col * max(0.0, bright);
    vAlpha = alpha;
    gl_PointSize = px;
    gl_Position = projectionMatrix * mv;
  }
`;

const MATTER_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uSoftness;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    float r = length(pc) * 2.0;
    float inner = 1.0 - clamp(uSoftness, 0.0, 0.999);
    float shape = 1.0 - smoothstep(inner, 1.0, r);
    if (shape <= 0.002) discard;
    gl_FragColor = vec4(vColor, shape * vAlpha);
  }
`;

const EVENT_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  uniform float uProjScale;
  uniform float uSizeWorld;

  attribute float aBirth;
  attribute float aScale;
  attribute vec3  aColor;

  varying float vT;
  varying vec3  vColor;

  void main() {
    vT = (uTime - aBirth) / max(0.001, uFade);
    vColor = aColor;
    if (vT < 0.0 || vT >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float grow = 0.6 + 0.55 * smoothstep(0.0, 0.4, vT);
    gl_PointSize = clamp(uSizeWorld * aScale * grow * uProjScale / max(0.001, -mv.z), 4.0, 72.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const EVENT_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vT;
  varying vec3  vColor;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float core = 1.0 - smoothstep(0.0, 0.4, r);
    float glow = pow(1.0 - r, 2.5);
    float fade = 1.0 - vT;
    float a = (core * 0.85 + glow * 0.5) * fade * fade;
    gl_FragColor = vec4(vColor * (0.55 + 0.6 * core), a);
  }
`;

// ---------------------------------------------------------------------------

export interface PaintStats {
  /** Blips currently in the buffer. */
  points: number;
  capacity: number;
  /** True once the ring has wrapped and started overwriting the oldest blips. */
  wrapped: boolean;
  /** Rays cast by the most recent event. */
  lastRays: number;
  /** Blips deposited by the most recent event. */
  lastDeposited: number;
  /** Existing blips restamped by the most recent event. */
  lastRefreshed: number;
  /** Wall-clock cost of the most recent event's sampling, ms, summed over its chunks. */
  lastPaintMs: number;
  /** Worst single chunk of that sampling, ms — the actual frame stall the player pays. */
  lastChunkMs: number;
  /** How many chunks the most recent event took. */
  lastChunks: number;
  /** Rays of the most recent event still unsampled. */
  pendingRays: number;
  /** Distance of the most distant blip the last event produced, metres. */
  lastMaxRange: number;
  /** How many of the last event's blips landed beyond `FAR_RANGE`. */
  lastFar20: number;
  /** Horizontal angular spread of the last cone event's returns, degrees. */
  lastSpanDeg: number;
  /** Furthest a return of the last cone event landed from the beam axis, metres. */
  lastLateral: number;
}

/** Reporting threshold for "this event reached across the room", metres. */
const FAR_RANGE = 20;

/**
 * How far out "under the player's feet" reaches, metres.
 *
 * A walk step paints a 4 m puddle (§3.3) and its front crosses this in under a tenth of a
 * second, so a radius of three takes in the ground a moving player is actually looking at
 * without dragging in the far wall's slower, calmer paint.
 */
const NEAR_RADIUS = 3;

/**
 * A read-only snapshot of the wave in flight and of the splat sizes on screen. The screenshot
 * driver asserts against this: it is the only way to prove from outside that a front really is
 * a front and not a fade, and that the near-field cap is doing its job.
 */
export interface PaintDiagnostics {
  /** True while the newest event's front is still expanding. */
  waveLive: boolean;
  /** Radius the newest front has reached, metres. */
  waveFront: number;
  /** That front's full paint radius. */
  waveRange: number;
  /** 0-1 along its travel. */
  waveProgress: number;
  /**
   * Furthest *drawable* blip from the newest event's origin. On a cleared map this must never
   * exceed `waveFront`: anything past the front has a birth stamp in the future and the shader
   * refuses to draw it.
   */
  arrivedMax: number;
  /** Nearest blip the front has not reached yet — the other side of the same edge. */
  pendingMin: number;
  /** Blips currently drawable. */
  visible: number;
  /**
   * Virgin blips currently inside their arrival ramp — drawn, but not yet at full strength.
   *
   * This is the batch-2.3 fade-in, counted from the same stamps the shader eases on, so a
   * non-zero count is the proof that new paint rises into view over a window of frames instead
   * of popping. It is zero except while a front is crossing unpainted ground.
   */
  ramping: number;
  /**
   * Known blips currently inside their silent-refresh ease: restamped by the newest event, with
   * their age gliding from what it was to zero. They are never gated and never flashed — the
   * count exists so a test can prove a re-ping went through this branch rather than the other.
   */
  refreshing: number;
  /** Drawable blips within `NEAR_RADIUS` of the listener — the ground under the player's feet. */
  nearBlips: number;
  /**
   * Mean age of those blips under the shipped curve: eased across a restamp exactly as
   * `MATTER_VERTEX` eases it.
   *
   * Age is what every visual property is a function of, so a jump here is a jump on screen. This
   * is the number the flicker complaint is really about, and it is continuous by construction.
   */
  nearAgeEased: number;
  /**
   * The same mean under the *pre-2.3* curve: the restamped age taken the instant the new front
   * lands, with no ease at all.
   *
   * It is computed for one reason — so a test can watch both curves on the same blips in the
   * same frames and show that the old one steps and the new one does not. Nothing renders from
   * it; delete it and the picture is unchanged.
   */
  nearAgeStep: number;
  /** Largest splat on screen, in drawing-buffer pixels. */
  maxBlipPixels: number;
  /** What that splat's size would have been without the near-field cap. */
  maxBlipWant: number;
}

export class PaintSystem {
  readonly tunables: PaintTunables;
  readonly ramp: AgeRamp;
  readonly wave: WaveTunables;
  readonly profiles = paintProfiles();

  private profileIndex = 0;
  private readonly capacity: number;

  // ---- matter layer ring buffer -------------------------------------------
  private readonly positions: Float32Array;
  /** When this event's front reaches this blip. May be in the future. */
  private readonly births: Float32Array;
  /** The arrival stamp this blip had before the newest event restamped it, or NEVER. */
  private readonly priors: Float32Array;
  private readonly intensities: Float32Array;
  private readonly seeds: Float32Array;
  private readonly mats: Float32Array;
  /**
   * Arrival-flash scale of the event that *first* painted this blip.
   *
   * Written once, on deposit, and never touched again: only a virgin blip ever flashes, so a
   * restamp has no rim to record. That also keeps it out of the restamp upload range — it rides
   * along with position, seed and material in the append range, which is the cheap one.
   */
  private readonly rims: Float32Array;
  /** Dedup cell key currently held by each slot, or -1. Lets a ring wrap unmap cleanly. */
  private readonly slotKeys: Float64Array;
  private readonly cells = new Map<number, number>();
  private writeIndex = 0;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;

  // ---- event layer ---------------------------------------------------------
  private readonly eventPositions = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventColors = new Float32Array(EVENT_CAPACITY * 3);
  private readonly eventBirths = new Float32Array(EVENT_CAPACITY);
  private readonly eventScales = new Float32Array(EVENT_CAPACITY);
  private eventIndex = 0;
  private readonly eventGeometry = new THREE.BufferGeometry();
  private readonly eventMaterial: THREE.ShaderMaterial;
  private readonly eventPoints: THREE.Points;

  // ---- wave layer ----------------------------------------------------------
  private readonly waves: LiveWave[] = [];
  private readonly tracer: TracerStreaks;
  private readonly dust: WaveDust;

  /** The structured reveal of look 5. Inert — and unbuilt — until that look is selected. */
  readonly structured: StructuredPaint;

  private readonly root = new THREE.Group();

  private time = 0;
  private rng = makeRng(0x5eed);
  private seed = 0x5eed;
  /** Angular radius of one ray's share of the current event's solid angle, radians. */
  private spread = 0.03;
  /** Peak blips per m² for the current event, before the distance falloff. */
  private targetDensity = 90;
  /** Blips the current event may still deposit. */
  private budget = 0;
  // Where and when the event being sampled went off, and one over how fast its front travels.
  // Held here rather than threaded through the splat loop: every blip of an event needs them,
  // and they are what `arrivalAt` turns into a birth stamp.
  private emitX = 0;
  private emitY = 0;
  private emitZ = 0;
  private emitTime = 0;
  private emitInvSpeed = 0;
  /** Arrival-flash scale of the event being sampled (§`rimScaleFor`). */
  private emitRim = 1;
  private readonly candidates: Aabb[] = [];
  private readonly listener = new THREE.Vector3();
  private readonly viewportSize = new THREE.Vector2();
  private readonly scratchColor = new THREE.Color();
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3(0, 0, -1);
  private projScale = 500;

  // Dirty tracking: appended blips are contiguous, restamped ones are scattered, so the two
  // get separate ranges — a ping in a well-scanned room must not re-upload the whole buffer.
  private appendMin = Infinity;
  private appendMax = -Infinity;
  private touchMin = Infinity;
  private touchMax = -Infinity;

  /**
   * Sampling work still to do for the most recent event. At most one exists at a time: a new
   * event drains the outstanding one first, which is also what keeps the module-level candidate
   * and bounding-sphere scratch valid across the chunks of a single job.
   */
  private job: {
    event: SoundEvent;
    cone: boolean;
    candidates: readonly Aabb[];
    n: number;
    cursor: number;
    phi0: number;
    cosMax: number;
    ux: number;
    uy: number;
    uz: number;
    tx: number;
    ty: number;
    tz: number;
  } | null = null;
  private lastChunkAt = 0;

  private stats: PaintStats = {
    points: 0,
    capacity: 0,
    wrapped: false,
    lastRays: 0,
    lastDeposited: 0,
    lastRefreshed: 0,
    lastPaintMs: 0,
    lastChunkMs: 0,
    lastChunks: 0,
    pendingRays: 0,
    lastMaxRange: 0,
    lastFar20: 0,
    lastSpanDeg: 0,
    lastLateral: 0,
  };

  private diag: PaintDiagnostics = {
    waveLive: false,
    waveFront: 0,
    waveRange: 0,
    waveProgress: 0,
    arrivedMax: 0,
    pendingMin: Infinity,
    visible: 0,
    ramping: 0,
    refreshing: 0,
    nearBlips: 0,
    nearAgeEased: 0,
    nearAgeStep: 0,
    maxBlipPixels: 0,
    maxBlipWant: 0,
  };
  private diagTime = Number.NaN;

  constructor(
    private readonly world: StaticWorld,
    options: {
      capacity?: number;
      tunables?: PaintTunables;
      ramp?: AgeRamp;
      wave?: WaveTunables;
      structured?: StructuredTunables;
    } = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.tunables = options.tunables ?? defaultPaintTunables();
    this.ramp = options.ramp ?? defaultAgeRamp();
    this.wave = options.wave ?? defaultWaveTunables();
    this.structured = new StructuredPaint(
      world,
      this.ramp,
      options.structured ?? defaultStructuredTunables(),
    );
    this.stats.capacity = this.capacity;

    this.positions = new Float32Array(this.capacity * 3);
    this.births = new Float32Array(this.capacity);
    this.priors = new Float32Array(this.capacity);
    this.intensities = new Float32Array(this.capacity);
    this.seeds = new Float32Array(this.capacity);
    this.mats = new Float32Array(this.capacity);
    this.rims = new Float32Array(this.capacity);
    this.slotKeys = new Float64Array(this.capacity).fill(-1);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(this.births, 1));
    this.geometry.setAttribute('aPrior', new THREE.BufferAttribute(this.priors, 1));
    this.geometry.setAttribute('aIntensity', new THREE.BufferAttribute(this.intensities, 1));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    this.geometry.setAttribute('aMat', new THREE.BufferAttribute(this.mats, 1));
    this.geometry.setAttribute('aRim', new THREE.BufferAttribute(this.rims, 1));
    this.geometry.setDrawRange(0, 0);

    const p = this.profiles[0]!;
    const hotColors = MATERIAL_VOICES.map((m) => new THREE.Vector3(...m.hot));
    const coolColors = MATERIAL_VOICES.map((m) => new THREE.Vector3(...m.cool));
    const matSizes = MATERIAL_VOICES.map((m) => m.sizeBias);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSizeWorld: { value: p.sizeWorld },
        uProjScale: { value: 500 },
        uMinPixels: { value: p.minPixels },
        uMaxPixels: { value: p.maxPixels },
        uPixelCap: { value: this.tunables.pixelCap },
        uDepthExp: { value: p.depthExp },
        uSizeJitter: { value: p.sizeJitter },
        uBrightJitter: { value: p.brightJitter },
        uBrightness: { value: p.brightness },
        uSoftness: { value: p.softness },
        uWindowRadius: { value: this.tunables.windowRadius },
        uListener: { value: new THREE.Vector3() },
        uRampTimes: {
          value: new THREE.Vector3(
            this.ramp.freshSeconds,
            this.ramp.coolSeconds,
            this.ramp.coldSeconds,
          ),
        },
        uSkeletonAlpha: { value: this.ramp.skeletonAlpha },
        uSkeletonSize: { value: this.ramp.skeletonSize },
        uRimK: { value: 3 / this.wave.rimSeconds },
        uRimBoost: { value: this.wave.rimBoost },
        uRimSize: { value: this.wave.rimSize },
        uArriveSeconds: { value: this.wave.arriveSeconds },
        uRefreshSeconds: { value: this.wave.refreshSeconds },
        uDissolve: { value: p.dissolve },
        uCoolRate: { value: p.coolRate },
        uMaterialMix: { value: p.materialMix },
        uFresh: { value: rawColor(MATTER_FRESH) },
        uMid: { value: rawColor(MATTER_MID) },
        uCold: { value: rawColor(MATTER_COLD) },
        uViolet: { value: new THREE.Vector3(...VIOLET) },
        uMatHot: { value: hotColors },
        uMatCool: { value: coolColors },
        uMatSize: { value: matSizes },
      },
      vertexShader: MATTER_VERTEX,
      fragmentShader: MATTER_FRAGMENT,
      transparent: true,
      // The cloud is memory, not line of sight (§3.6): it draws through walls, and nothing
      // else in this scene writes depth anyway.
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;

    this.eventGeometry.setAttribute('position', new THREE.BufferAttribute(this.eventPositions, 3));
    this.eventGeometry.setAttribute('aColor', new THREE.BufferAttribute(this.eventColors, 3));
    this.eventGeometry.setAttribute('aBirth', new THREE.BufferAttribute(this.eventBirths, 1));
    this.eventGeometry.setAttribute('aScale', new THREE.BufferAttribute(this.eventScales, 1));
    this.eventGeometry.setDrawRange(0, 0);
    this.eventBirths.fill(NEVER);

    this.eventMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: EVENT_FADE },
        uProjScale: { value: 500 },
        uSizeWorld: { value: EVENT_SIZE },
      },
      vertexShader: EVENT_VERTEX,
      fragmentShader: EVENT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.eventPoints = new THREE.Points(this.eventGeometry, this.eventMaterial);
    this.eventPoints.frustumCulled = false;
    this.eventPoints.renderOrder = 2;

    this.tracer = new TracerStreaks(rawColor(EVENT_COLORS['e-ping']));
    this.tracer.setLook(this.wave.tracerSeconds, this.wave.tracerBrightness);
    this.dust = new WaveDust(DUST_COUNT, DUST_EXTENT, makeRng(0xd0757));
    this.dust.setLook(this.wave.dustGain, this.wave.dustSize, this.wave.dustShell);

    this.births.fill(NEVER);
    this.priors.fill(NEVER);

    this.root.add(
      this.points,
      this.eventPoints,
      this.tracer.object,
      this.dust.object,
      this.structured.object,
    );
    this.structured.applyLook(this.tunables.windowRadius, this.wave.refreshSeconds);
  }

  /** The object to add to the scene. */
  get object(): THREE.Object3D {
    return this.root;
  }

  get profile(): PaintProfile {
    return this.profiles[this.profileIndex]!;
  }

  get profileName(): string {
    return this.profile.name;
  }

  getStats(): PaintStats {
    this.stats.points = Math.min(this.writeIndex, this.capacity);
    this.stats.wrapped = this.writeIndex >= this.capacity;
    return this.stats;
  }

  /**
   * Switches look. Repainting is deliberate rather than optional: density and cell size are
   * *sampling* parameters, so the honest comparison is the same events resampled, not the same
   * blips restyled. Reseeding keeps the shots comparable.
   */
  setProfile(index: number): void {
    if (index < 0 || index >= this.profiles.length) return;
    this.profileIndex = index;
    this.applyProfile();
    /*
     * Clear-on-switch, for both representations at once.
     *
     * The two paint paths answer the same events in incompatible currencies — one deposits
     * blips, the other unlocks known geometry — so a run that crossed a look switch would leave
     * the room drawn half one way and half the other, with the halves ageing on two clocks. The
     * doctrine that already governs looks 1-4 (density and cell size are *sampling* parameters,
     * so the honest comparison is the same events resampled, never the same paint restyled)
     * gives the same answer here, and it is the only policy that cannot double-paint.
     */
    this.structured.setActive(this.profile.structured);
    this.points.visible = !this.profile.structured;
    this.clear();
  }

  applyProfile(): void {
    const p = this.profile;
    const u = this.material.uniforms;
    u.uSizeWorld!.value = p.sizeWorld;
    u.uMinPixels!.value = p.minPixels;
    u.uMaxPixels!.value = p.maxPixels;
    u.uDepthExp!.value = p.depthExp;
    u.uSizeJitter!.value = p.sizeJitter;
    u.uBrightJitter!.value = p.brightJitter;
    u.uBrightness!.value = p.brightness;
    u.uSoftness!.value = p.softness;
    u.uDissolve!.value = p.dissolve;
    u.uCoolRate!.value = p.coolRate;
    u.uMaterialMix!.value = p.materialMix;
  }

  /** Pushes ramp/window/wave edits from the GUI into the shaders. */
  applyTunables(): void {
    const u = this.material.uniforms;
    (u.uRampTimes!.value as THREE.Vector3).set(
      this.ramp.freshSeconds,
      this.ramp.coolSeconds,
      this.ramp.coldSeconds,
    );
    u.uSkeletonAlpha!.value = this.ramp.skeletonAlpha;
    u.uSkeletonSize!.value = this.ramp.skeletonSize;
    u.uWindowRadius!.value = this.tunables.windowRadius;
    u.uPixelCap!.value = this.tunables.pixelCap;
    u.uRimK!.value = 3 / Math.max(0.02, this.wave.rimSeconds);
    u.uRimBoost!.value = this.wave.rimBoost;
    u.uRimSize!.value = this.wave.rimSize;
    u.uArriveSeconds!.value = this.wave.arriveSeconds;
    u.uRefreshSeconds!.value = this.wave.refreshSeconds;
    this.tracer.setLook(this.wave.tracerSeconds, this.wave.tracerBrightness);
    this.dust.setLook(this.wave.dustGain, this.wave.dustSize, this.wave.dustShell);
    this.structured.applyLook(this.tunables.windowRadius, this.wave.refreshSeconds);
  }

  /**
   * Advances the paint clock and everything derived from it: which fronts are still expanding,
   * and what the air between them looks like. The scene owns the clock so it can be scaled for
   * ageing and wave-travel tests.
   */
  advance(seconds: number): void {
    this.time = seconds;
    this.material.uniforms.uTime!.value = seconds;
    this.eventMaterial.uniforms.uTime!.value = seconds;
    this.tracer.setTime(seconds);

    // One chunk of outstanding sampling per frame. The gap is wall clock, not sim time, which
    // is what makes it self-limiting: a frame's worth of fixed updates all run back to back in
    // under a millisecond, so only the first of them is ever old enough to take a turn.
    if (this.job !== null && performance.now() - this.lastChunkAt >= this.tunables.chunkGapMs) {
      this.runChunk(this.tunables.chunkRays, this.tunables.chunkMs);
    }
    // The structured backend amortises its unlocking the same way and for the same reason.
    this.structured.advance(seconds, this.tunables.chunkGapMs);

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]!;
      if ((seconds - w.t0) * w.speed > w.radius) this.waves.splice(i, 1);
    }
    this.dust.update(seconds, this.listener, this.waves, this.wave.dust);
  }

  get clock(): number {
    return this.time;
  }

  /** Where the ears are: gates which events are heard and which blips are drawn. */
  setListener(x: number, y: number, z: number): void {
    this.listener.set(x, y, z);
    (this.material.uniforms.uListener!.value as THREE.Vector3).set(x, y, z);
    this.structured.setListener(x, y, z);
  }

  /**
   * Recomputes the world-units-to-pixels factor for `gl_PointSize`. Depends on the vertical
   * FOV and the drawing buffer height, so it is refreshed every frame rather than cached.
   */
  updateView(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.viewportSize);
    this.projScale = (camera.projectionMatrix.elements[5] ?? 1) * this.viewportSize.y * 0.5;
    this.material.uniforms.uProjScale!.value = this.projScale;
    this.eventMaterial.uniforms.uProjScale!.value = this.projScale;
    this.dust.setProjScale(this.projScale);
    this.structured.setProjScale(this.projScale);
    camera.getWorldPosition(this.camPos);
    camera.getWorldDirection(this.camDir);
  }

  /** Discards every blip and reseeds the sampler. */
  clear(): void {
    this.writeIndex = 0;
    this.cells.clear();
    this.slotKeys.fill(-1);
    this.births.fill(NEVER);
    this.priors.fill(NEVER);
    this.eventIndex = 0;
    this.eventBirths.fill(NEVER);
    this.rng = makeRng(this.seed);
    this.waves.length = 0;
    this.tracer.clear();
    // Cancel outstanding sampling too. Since a ping is now spread over several frames, a clear
    // that only emptied the buffer would be undone a frame later by the chunks still queued for
    // the event that was in flight when the key was pressed.
    this.job = null;
    this.stats.pendingRays = 0;
    // Nothing needs re-uploading: the draw range is zero, so whatever stale bytes the GPU
    // still holds beyond it are never read, and the next event overwrites from slot 0 up.
    this.geometry.setDrawRange(0, 0);
    this.eventGeometry.setDrawRange(0, 0);
    this.appendMin = Infinity;
    this.appendMax = -Infinity;
    this.touchMin = Infinity;
    this.touchMax = -Infinity;
    this.stats.lastRays = 0;
    this.stats.lastDeposited = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastPaintMs = 0;
    this.stats.lastMaxRange = 0;
    this.stats.lastFar20 = 0;
    this.stats.lastSpanDeg = 0;
    this.stats.lastLateral = 0;
    this.diagTime = Number.NaN;
    this.structured.clear();
    this.flushEvents();
  }

  /** Fixes the sampling seed — tooling uses it to make variant screenshots comparable. */
  setSeed(seed: number): void {
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);
  }

  // ---- the hook the bus calls ---------------------------------------------

  handle = (event: SoundEvent): void => {
    // Whatever the last event still owed gets paid before this one starts: the sampler's
    // scratch arrays are shared, and its statistics belong to the event that earned them.
    this.drain();

    this.stats.lastRays = 0;
    this.stats.lastDeposited = 0;
    this.stats.lastRefreshed = 0;
    this.stats.lastPaintMs = 0;
    this.stats.lastChunkMs = 0;
    this.stats.lastChunks = 0;
    this.stats.pendingRays = 0;
    this.stats.lastMaxRange = 0;
    this.stats.lastFar20 = 0;
    this.stats.lastSpanDeg = 0;
    this.stats.lastLateral = 0;

    // §3.1: no free intel. An event you cannot hear paints you nothing.
    const heard = Math.hypot(
      event.x - this.listener.x,
      event.y - this.listener.y,
      event.z - this.listener.z,
    );
    if (heard <= this.tunables.hearingRange) {
      // Saturating the dedup grid is the densest a look can usefully be: past that every extra
      // blip lands in a cell that already has one and only restamps it.
      const cell = this.profile.cellSize;
      this.targetDensity = this.tunables.splatFill / (cell * cell);
      this.addEventMarker(event);
      this.addWave(event);
      if (event.class === 'e-ping') this.fireTracer(event);
      /*
       * One representation consumes the event, never both. Everything above this line — the
       * event marker, the travelling front, the firing streak — belongs to the *sound* and is
       * shared; everything below is how a look chooses to answer it.
       */
      if (this.profile.structured) {
        this.structured.handle(event, this.time);
      } else {
        if (event.coneAngleDeg >= 359.9) this.planOmni(event);
        else this.planCone(event);
        // The first chunk runs now, whatever the budget: a ping must answer on the frame it is
        // pressed, even if the far half of the answer catches up over the next two.
        if (this.job !== null) this.runChunk(this.tunables.chunkRays, this.tunables.chunkMs);
      }
    }
    this.diagTime = Number.NaN;
  };

  /** Finishes any outstanding sampling immediately, whatever it costs. */
  private drain(): void {
    let guard = 0;
    while (this.job !== null && guard++ < 64) this.runChunk(Infinity, Infinity);
    this.job = null;
  }

  /** Fronts still expanding, newest last. Read by the dust field and by the diagnostics. */
  get liveWaves(): readonly LiveWave[] {
    return this.waves;
  }

  /** Whether the air is currently showing a front. False costs nothing at all — the field is
   *  not in the draw list. */
  get dustLit(): boolean {
    return this.dust.object.visible;
  }

  get tracerAlive(): boolean {
    return this.tracer.alive(this.time);
  }

  get tracerAge(): number {
    return this.time - this.tracer.lastFired;
  }

  private addWave(event: SoundEvent): void {
    const omni = event.coneAngleDeg >= 359.9;
    this.waves.push({
      x: event.x,
      y: event.y,
      z: event.z,
      dirX: event.dirX,
      dirY: event.dirY,
      dirZ: event.dirZ,
      cosHalf: omni ? -1 : Math.cos((event.coneAngleDeg * Math.PI) / 360),
      t0: event.time,
      speed: event.waveSpeed,
      radius: event.paintRadius,
      intensity: event.intensity,
    });
    while (this.waves.length > MAX_LIVE_WAVES) this.waves.shift();
  }

  private fireTracer(event: SoundEvent): void {
    this.tracer.fire(
      event.x,
      event.y - this.wave.tracerDrop,
      event.z,
      event.dirX,
      event.dirY,
      event.dirZ,
      this.wave.tracerStart,
      this.wave.tracerLength,
      event.time,
    );
  }

  // ---- sampling -----------------------------------------------------------

  private rayBudget(event: SoundEvent): number {
    const base = CLASS_RAYS[event.class];
    const want = Math.round(base * this.profile.density * event.intensity);
    return Math.max(16, Math.min(this.tunables.rayCap, want));
  }

  /**
   * Drops candidates the event cannot physically reach, before a single ray is cast.
   *
   * The world query is a box, and a 110° cone's bounding box is most of the room — so without
   * this every ray pays the full slab test against every wall in the level. A sphere-vs-cone
   * and sphere-vs-range reject costs sixty tests once instead of ten thousand times sixty.
   */
  private cull(
    list: Aabb[],
    ox: number,
    oy: number,
    oz: number,
    radius: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    half: number,
  ): void {
    const cone = half < Math.PI / 2 + 1e-3;
    let keep = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const hx = (b.maxX - b.minX) / 2;
      const hy = (b.maxY - b.minY) / 2;
      const hz = (b.maxZ - b.minZ) / 2;
      const br = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const ex = cx - ox;
      const ey = cy - oy;
      const ez = cz - oz;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d - br > radius) continue;
      if (cone && d > br) {
        const cosA = (ex * dirX + ey * dirY + ez * dirZ) / d;
        const angle = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
        if (angle - Math.asin(Math.min(1, br / d)) > half) continue;
      }
      list[keep++] = b;
    }
    list.length = keep;
  }

  private planOmni(event: SoundEvent): void {
    const r = event.paintRadius;
    const candidates = this.world.query(
      event.x - r,
      event.y - r,
      event.z - r,
      event.x + r,
      event.y + r,
      event.z + r,
      this.candidates,
    );
    this.cull(candidates, event.x, event.y, event.z, r, 0, 0, 0, Math.PI);
    if (candidates.length === 0) return;
    buildSpheres(candidates);

    const n = this.rayBudget(event);
    this.stats.lastRays = n;
    // Angular radius of one ray's share of the sphere. Everything within it is what that ray
    // actually "heard", so that is the patch its return gets splatted over.
    this.spread = Math.sqrt(4 / n);
    this.budget = this.tunables.maxPerEvent;

    this.job = {
      event,
      cone: false,
      candidates,
      n,
      cursor: 0,
      phi0: this.rng() * Math.PI * 2,
      cosMax: -1,
      ux: 0,
      uy: 0,
      uz: 0,
      tx: 0,
      ty: 0,
      tz: 0,
    };
  }

  private planCone(event: SoundEvent): void {
    const r = event.paintRadius;
    const half = (event.coneAngleDeg * Math.PI) / 360;
    const cosMax = Math.cos(half);
    // A cone wider than a right angle has no finite far cap; its bounding box is the sphere.
    const capRadius = half >= Math.PI / 2 - 1e-3 ? r : r * Math.tan(half);

    // Conservative AABB of the cone: the apex plus the far cap's bounding cube.
    const cx = event.x + event.dirX * r;
    const cy = event.y + event.dirY * r;
    const cz = event.z + event.dirZ * r;
    const candidates = this.world.query(
      Math.min(event.x, cx - capRadius),
      Math.min(event.y, cy - capRadius),
      Math.min(event.z, cz - capRadius),
      Math.max(event.x, cx + capRadius),
      Math.max(event.y, cy + capRadius),
      Math.max(event.z, cz + capRadius),
      this.candidates,
    );
    this.cull(candidates, event.x, event.y, event.z, r, event.dirX, event.dirY, event.dirZ, half);
    if (candidates.length === 0) return;
    buildSpheres(candidates);

    // Orthonormal basis around the aim.
    const ax = Math.abs(event.dirY) < 0.9 ? 0 : 1;
    let tx = ax === 0 ? 0 : 1;
    let ty = ax === 0 ? 1 : 0;
    let tz = 0;
    // u = normalize(up x dir)
    let ux = ty * event.dirZ - tz * event.dirY;
    let uy = tz * event.dirX - tx * event.dirZ;
    let uz = tx * event.dirY - ty * event.dirX;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // t = dir x u
    tx = event.dirY * uz - event.dirZ * uy;
    ty = event.dirZ * ux - event.dirX * uz;
    tz = event.dirX * uy - event.dirY * ux;

    const n = this.rayBudget(event);
    this.stats.lastRays = n;
    const solidAngle = 2 * Math.PI * (1 - cosMax);
    this.spread = Math.sqrt(solidAngle / (Math.PI * n));
    this.budget = this.tunables.maxPerEvent;

    this.job = {
      event,
      cone: true,
      candidates,
      n,
      cursor: 0,
      phi0: this.rng() * Math.PI * 2,
      cosMax,
      ux,
      uy,
      uz,
      tx,
      ty,
      tz,
    };
  }

  /**
   * Casts the next slice of the outstanding job's rays.
   *
   * Ray directions are a pure function of the ray *index*, so a job can stop and resume between
   * frames without the pattern shifting; the only shared state is the seeded RNG, and nothing
   * else is allowed to draw from it while a job is open.
   */
  private runChunk(maxRays: number, budgetMs: number): void {
    const job = this.job;
    if (job === null) return;
    const t0 = performance.now();
    const { event, candidates, n, phi0, cosMax } = job;
    // Re-seated every chunk, because a job outlives the frame that started it.
    this.emitX = event.x;
    this.emitY = event.y;
    this.emitZ = event.z;
    this.emitTime = event.time;
    this.emitInvSpeed = 1 / event.waveSpeed;
    this.emitRim = rimScaleFor(event.class, this.wave);
    const feather = this.tunables.coneFeather;
    const blipCap =
      this.stats.lastDeposited + this.stats.lastRefreshed + this.tunables.chunkBlips;
    let processed = 0;

    while (job.cursor < n && this.budget > 0) {
      const i = job.cursor++;
      processed++;
      if (job.cone) {
        // Stratified in solid angle: `u` is the fraction of the cap's area, so it is also how
        // far out toward the rim this ray sits — which is exactly what the edge feather wants.
        const u = (i + this.rng()) / n;
        const cosT = 1 - u * (1 - cosMax);
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi =
          i * GOLDEN_ANGLE + phi0 + (this.rng() - 0.5) * (this.spread / Math.max(0.06, sinT));
        const cp = Math.cos(phi) * sinT;
        const sp = Math.sin(phi) * sinT;
        // A beam with a stencilled edge reads as a projected disc, not as a beam.
        let rim = 0;
        if (u > 1 - feather) {
          rim = (u - (1 - feather)) / feather;
          if (this.rng() < rim * rim) {
            if (processed >= maxRays) break;
            continue;
          }
        }
        this.shoot(
          event,
          candidates,
          job.ux * cp + job.tx * sp + event.dirX * cosT,
          job.uy * cp + job.ty * sp + event.dirY * cosT,
          job.uz * cp + job.tz * sp + event.dirZ * cosT,
          true,
          rim,
        );
      } else {
        // A jittered Fibonacci sphere: even coverage without the visible spiral of the pure
        // form. Both jitters earn their keep. Stratifying `y` spaces the rays evenly in polar
        // angle, and scattering `phi` by one footprint's worth of arc breaks up the lattice's
        // spiral arms — which otherwise project onto a floor as concentric rings centred on
        // the player, the most obvious "this is a sampling pattern, not a room" tell the cloud
        // can produce.
        const y = 1 - (2 * (i + this.rng())) / n;
        const rr = Math.sqrt(Math.max(0, 1 - y * y));
        const phi =
          i * GOLDEN_ANGLE + phi0 + (this.rng() - 0.5) * (this.spread / Math.max(0.15, rr));
        this.shoot(event, candidates, Math.cos(phi) * rr, y, Math.sin(phi) * rr, false, 0);
      }
      if (processed >= maxRays) break;
      if (this.stats.lastDeposited + this.stats.lastRefreshed >= blipCap) break;
      // Polled every 16 rays, not every 64: a single ray in a dense look can splat hundreds of
      // blips, so a coarser poll overshot the budget by nearly 2× on the first chunk.
      if ((processed & 15) === 0 && performance.now() - t0 >= budgetMs) break;
    }

    if (job.cursor >= n || this.budget <= 0) this.job = null;
    const ms = performance.now() - t0;
    this.lastChunkAt = performance.now();
    this.stats.lastPaintMs += ms;
    if (ms > this.stats.lastChunkMs) this.stats.lastChunkMs = ms;
    this.stats.lastChunks++;
    this.stats.pendingRays = this.job === null ? 0 : n - job.cursor;
    this.diagTime = Number.NaN;
    this.flush();
  }

  /** Casts one ray and, if it lands, splats its footprint onto the surface it found. */
  private shoot(
    event: SoundEvent,
    candidates: readonly Aabb[],
    dx: number,
    dy: number,
    dz: number,
    edgeBias: boolean,
    rim: number,
  ): void {
    const r = event.paintRadius;
    if (!castRay(candidates, event.x, event.y, event.z, dx, dy, dz, r)) return;

    const t = hit.t;
    const box = hit.box!;
    const axis = hit.axis;
    const rel = t / r;
    const tun = this.tunables;

    // Soft rim: hits thin out over the last stretch of the radius instead of stopping dead at
    // a perfect sphere, which would read as a drawn circle on every flat floor.
    if (rel > tun.featherStart) {
      const fade = (1 - rel) / (1 - tun.featherStart);
      if (this.rng() > fade) return;
    }

    const mat = box.mat ?? 0;
    const voice = MATERIAL_VOICES[mat] ?? MATERIAL_VOICES[0]!;
    // The material voice is a look-4 candidate, not a law (§3.2): where a look has not asked
    // for it, reflectivity and micro-relief blend back to the neutral surface looks 1-3 have
    // always sampled, so switching looks compares sampling and drawing, never two worlds.
    const voiceMix = this.profile.materialMix;

    const dAxis = axis === 0 ? dx : axis === 1 ? dy : dz;
    const normal = dAxis > 0 ? -1 : 1;
    // Micro-relief: a coherent displacement along the normal, so a surface has a grain of its
    // own instead of being a mathematically perfect plane. Sampled once per footprint.
    const relief =
      voiceMix === 0
        ? 0
        : voice.rough *
          tun.roughness *
          voiceMix *
          valueNoise(
            (event.x + dx * t) * 3.1,
            (event.y + dy * t) * 3.1,
            (event.z + dz * t) * 3.1,
          );
    const off = (tun.surfaceOffset + Math.abs(relief)) * normal;
    const px = event.x + dx * t + (axis === 0 ? off : 0);
    const py = event.y + dy * t + (axis === 1 ? off : 0);
    const pz = event.z + dz * t + (axis === 2 ? off : 0);

    // Distance dim, rim dim, and grazing return: a surface met edge-on sends less back, which
    // is both true of sound and the cheapest shape cue the cloud has.
    let intensity =
      event.intensity *
      (1 + (voice.refl - 1) * voiceMix) *
      (tun.rimDim + (1 - tun.rimDim) * (1 - rel)) *
      (tun.grazeDim + (1 - tun.grazeDim) * Math.abs(dAxis)) *
      (1 - 0.55 * rim);

    if (edgeBias && t > tun.edgeStart) {
      // §3.5: at range the beam returns silhouettes, not fog. Distance from the hit to the
      // border of the face it landed on stands in for "is this an edge" — cheap, and exactly
      // right for a world made of boxes.
      const eu =
        axis === 0
          ? Math.min(py - box.minY, box.maxY - py)
          : Math.min(px - box.minX, box.maxX - px);
      const ev =
        axis === 2
          ? Math.min(px - box.minX, box.maxX - px)
          : Math.min(pz - box.minZ, box.maxZ - pz);
      const edgeDist = Math.min(eu, ev);
      const edgeW = Math.max(0, 1 - edgeDist / tun.edgeBand);
      const farT = Math.min(1, (t - tun.edgeStart) / Math.max(0.001, tun.edgeFull - tun.edgeStart));
      const keep = 1 + farT * (tun.farThin + (1 - tun.farThin) * edgeW - 1);
      if (this.rng() > keep) return;
      intensity *= 1 + (tun.edgeBoost - 1) * edgeW * farT;
    }

    if (edgeBias) {
      /*
       * The cone's own geometry readout, taken here — after every rejection — so it describes
       * paint that actually landed rather than rays that were merely fired. How wide the answer
       * came back, and how far off the axis it reached: the only way tooling outside the
       * renderer can prove that a beam is a beam and that its shape is the one that was asked
       * for.
       */
      const along = dx * event.dirX + dy * event.dirY + dz * event.dirZ;
      const offAxis = Math.sqrt(Math.max(0, 1 - along * along));
      const lateral = t * offAxis;
      if (lateral > this.stats.lastLateral) this.stats.lastLateral = lateral;
      // Horizontal span only: a cone aimed at the floor has no meaningful compass bearing.
      if (Math.hypot(event.dirX, event.dirZ) > 0.2 && Math.hypot(dx, dz) > 1e-4) {
        let hAngle = Math.atan2(dz, dx) - Math.atan2(event.dirZ, event.dirX);
        if (hAngle > Math.PI) hAngle -= 2 * Math.PI;
        if (hAngle < -Math.PI) hAngle += 2 * Math.PI;
        const span = 2 * Math.abs(hAngle) * (180 / Math.PI);
        if (span > this.stats.lastSpanDeg) this.stats.lastSpanDeg = span;
      }
    }

    if (t > this.stats.lastMaxRange) this.stats.lastMaxRange = t;
    const far = t >= FAR_RANGE;

    /*
     * A ray heard a *patch*, not a point, so its return is spread over the footprint it
     * actually covers on this face. That footprint is an ellipse, not a disc: a surface met
     * at a grazing angle stretches the same solid angle into a long smear along the line of
     * range, which is why point-cloud floors streak away from you. Splatting a disc instead
     * left gaps between consecutive rays on every floor — the single biggest legibility bug
     * in the first pass of this system.
     *
     * Samples that fall off the face are dropped rather than clamped, so a box's silhouette
     * stays exactly as crisp as the geometry is.
     */
    const footprint = t * this.spread;
    const cosInc = Math.max(0.001, Math.abs(dAxis));
    const stretch = Math.min(MAX_FOOTPRINT_STRETCH, 1 / cosInc);
    // In-face direction of the range axis (the ray's projection onto the face).
    let fu = axis === 0 ? dy : dx;
    let fv = axis === 2 ? dy : dz;
    const fl = Math.hypot(fu, fv);
    if (fl > 1e-6) {
      fu /= fl;
      fv /= fl;
    } else {
      fu = 1;
      fv = 0;
    }

    // Blips per m² this event wants on the surface it just found: the grid's saturation
    // density, thinned quadratically with distance (§3.1). Multiplying by the footprint's area
    // is what turns a target *density* into a per-ray *count*.
    const area = Math.PI * footprint * footprint * stretch;
    const wanted = Math.round(area * this.targetDensity * (1 / (1 + tun.falloffK * rel * rel)));
    const splats = Math.max(1, Math.min(tun.splatCap, wanted));

    for (let s = 0; s < splats; s++) {
      let qx = px;
      let qy = py;
      let qz = pz;
      if (s > 0) {
        const ang = this.rng() * Math.PI * 2;
        const rad = Math.sqrt(this.rng());
        const along = Math.cos(ang) * rad * footprint * stretch;
        const across = Math.sin(ang) * rad * footprint;
        const du = along * fu - across * fv;
        const dv = along * fv + across * fu;
        // Offset within the hit face — the two axes that are not the surface normal.
        if (axis === 0) {
          qy = py + du;
          qz = pz + dv;
        } else if (axis === 1) {
          qx = px + du;
          qz = pz + dv;
        } else {
          qx = px + du;
          qy = py + dv;
        }
        if (axis !== 0 && (qx <= box.minX || qx >= box.maxX)) continue;
        if (axis !== 1 && (qy <= box.minY || qy >= box.maxY)) continue;
        if (axis !== 2 && (qz <= box.minZ || qz >= box.maxZ)) continue;
      }
      if (far) this.stats.lastFar20++;
      this.deposit(qx, qy, qz, intensity, mat);
      if (--this.budget <= 0) return;
    }
  }

  // ---- ring buffer ---------------------------------------------------------

  private cellKey(x: number, y: number, z: number): number {
    const c = this.profile.cellSize;
    const ix = Math.floor(x / c) + 32768;
    const iy = Math.floor(y / c) + 32768;
    const iz = Math.floor(z / c) + 32768;
    return (ix * 65536 + iy) * 65536 + iz;
  }

  /**
   * When the front of the event now being sampled reaches a given place.
   *
   * Taken from the position that will actually be *drawn*, never from the ray's hit distance.
   * A footprint met at a grazing angle stretches radially by up to MAX_FOOTPRINT_STRETCH, so
   * stamping a whole patch with its ray's hit distance lit the far end of the patch metres
   * before the front got there; and a voxel that already holds a blip keeps its stored position,
   * so its stamp has to be recomputed from that position rather than from the new sample that
   * landed a fraction of a cell away. Both together make the invariant exact rather than
   * approximate: no blip is ever visible outside its own front. A blip visible before its wave
   * arrives is the system lying (law 2), which is the one thing it may never do.
   */
  private arrivalAt(x: number, y: number, z: number): number {
    const dx = x - this.emitX;
    const dy = y - this.emitY;
    const dz = z - this.emitZ;
    return this.emitTime + Math.sqrt(dx * dx + dy * dy + dz * dz) * this.emitInvSpeed;
  }

  private deposit(x: number, y: number, z: number, intensity: number, mat: number): void {
    if (this.tunables.dedupe) {
      const key = this.cellKey(x, y, z);
      const existing = this.cells.get(key);
      if (existing !== undefined) {
        /*
         * Already known ground: restamp it rather than pile a second blip on the same voxel.
         *
         * Recording the old arrival in `prior` does two jobs at once. It is what stops a second
         * ping from *erasing* a room while its front crosses it — and it is the flag that says
         * "this voxel was already known", which is what buys the silent refresh in the shader.
         * Only an arrival that has genuinely landed may become that prior: a blip restamped
         * twice in flight was never actually seen, so it stays virgin and still gets its
         * arrival when a front finally reaches it.
         */
        const i3 = existing * 3;
        const arrival = this.arrivalAt(
          this.positions[i3]!,
          this.positions[i3 + 1]!,
          this.positions[i3 + 2]!,
        );
        const oldBirth = this.births[existing]!;
        if (oldBirth <= this.time) this.priors[existing] = oldBirth;
        this.births[existing] = arrival;
        if (intensity > this.intensities[existing]!) this.intensities[existing] = intensity;
        this.markTouched(existing, existing);
        this.stats.lastRefreshed++;
        return;
      }
      const slot = this.writeIndex % this.capacity;
      const stale = this.slotKeys[slot]!;
      if (stale >= 0) this.cells.delete(stale);
      this.slotKeys[slot] = key;
      this.cells.set(key, slot);
      this.writeSlot(slot, x, y, z, intensity, mat, this.arrivalAt(x, y, z));
      return;
    }
    this.writeSlot(
      this.writeIndex % this.capacity,
      x,
      y,
      z,
      intensity,
      mat,
      this.arrivalAt(x, y, z),
    );
  }

  private writeSlot(
    slot: number,
    x: number,
    y: number,
    z: number,
    intensity: number,
    mat: number,
    arrival: number,
  ): void {
    const i3 = slot * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.births[slot] = arrival;
    // A brand-new blip has no history, so there is nothing to show ahead of the front — and
    // NEVER is also what tells the shader this one is virgin and gets the arrival treatment.
    this.priors[slot] = NEVER;
    this.intensities[slot] = intensity;
    this.seeds[slot] = this.rng();
    this.mats[slot] = mat;
    this.rims[slot] = this.emitRim;
    this.markAppended(slot, slot);
    this.markTouched(slot, slot);
    this.writeIndex++;
    this.stats.lastDeposited++;
  }

  private markAppended(lo: number, hi: number): void {
    if (lo < this.appendMin) this.appendMin = lo;
    if (hi > this.appendMax) this.appendMax = hi;
  }

  private markTouched(lo: number, hi: number): void {
    if (lo < this.touchMin) this.touchMin = lo;
    if (hi > this.touchMax) this.touchMax = hi;
  }

  /** Uploads only the slots this event actually changed. */
  private flush(): void {
    const drawn = Math.min(this.writeIndex, this.capacity);
    this.geometry.setDrawRange(0, drawn);

    if (this.appendMax >= this.appendMin) {
      const start = this.appendMin;
      const count = this.appendMax - this.appendMin + 1;
      this.uploadRange('position', start * 3, count * 3);
      this.uploadRange('aSeed', start, count);
      this.uploadRange('aMat', start, count);
      this.uploadRange('aRim', start, count);
      this.appendMin = Infinity;
      this.appendMax = -Infinity;
    }
    if (this.touchMax >= this.touchMin) {
      const start = this.touchMin;
      const count = this.touchMax - this.touchMin + 1;
      this.uploadRange('aBirth', start, count);
      this.uploadRange('aPrior', start, count);
      this.uploadRange('aIntensity', start, count);
      this.touchMin = Infinity;
      this.touchMax = -Infinity;
    }
  }

  /**
   * Queues one sub-range for upload. Ranges are *accumulated*, never cleared here: three
   * merges and clears them itself after the next draw, so several events landing between two
   * frames all survive.
   */
  private uploadRange(name: string, start: number, count: number): void {
    const attr = this.geometry.getAttribute(name) as THREE.BufferAttribute;
    attr.addUpdateRange(start, count);
    attr.needsUpdate = true;
  }

  // ---- diagnostics ---------------------------------------------------------

  /**
   * Walks the live buffer once and reports what a viewer could actually see this instant.
   *
   * This is a measurement, not a restatement: it re-derives visibility from the same birth and
   * prior stamps the vertex shader reads, so "nothing is drawn past the front" is checked
   * against the data rather than against the formula that produced it. Cached per clock value,
   * because the driver polls far faster than the simulation ticks.
   */
  diagnostics(): PaintDiagnostics {
    if (this.diagTime === this.time) return this.diag;
    this.diagTime = this.time;

    const d = this.diag;
    const newest = this.waves.length > 0 ? this.waves[this.waves.length - 1]! : null;
    if (newest === null) {
      d.waveLive = false;
      d.waveFront = 0;
      d.waveRange = 0;
      d.waveProgress = 1;
    } else {
      const front = Math.max(0, (this.time - newest.t0) * newest.speed);
      d.waveLive = front <= newest.radius;
      d.waveFront = Math.min(front, newest.radius);
      d.waveRange = newest.radius;
      d.waveProgress = newest.radius > 0 ? Math.min(1, front / newest.radius) : 1;
    }

    const drawn = Math.min(this.writeIndex, this.capacity);
    const now = this.time;
    const window = this.tunables.windowRadius;
    const lx = this.listener.x;
    const ly = this.listener.y;
    const lz = this.listener.z;
    const cx = this.camPos.x;
    const cy = this.camPos.y;
    const cz = this.camPos.z;
    const dxv = this.camDir.x;
    const dyv = this.camDir.y;
    const dzv = this.camDir.z;
    const ox = newest?.x ?? 0;
    const oy = newest?.y ?? 0;
    const oz = newest?.z ?? 0;

    let arrivedMax = 0;
    let pendingMin = Infinity;
    let visible = 0;
    let minDepth = Infinity;
    let ramping = 0;
    let refreshing = 0;
    let nearBlips = 0;
    let nearEased = 0;
    let nearStep = 0;
    const arriveWindow = this.wave.arriveSeconds;
    const refreshWindow = this.wave.refreshSeconds;
    const nearR2 = NEAR_RADIUS * NEAR_RADIUS;

    for (let i = 0; i < drawn; i++) {
      const i3 = i * 3;
      const px = this.positions[i3]!;
      const py = this.positions[i3 + 1]!;
      const pz = this.positions[i3 + 2]!;
      const wx = px - lx;
      const wy = py - ly;
      const wz = pz - lz;
      const listenerD2 = wx * wx + wy * wy + wz * wz;
      if (listenerD2 > window * window) continue;

      const birth = this.births[i]!;
      const prior = this.priors[i]!;
      const shown = birth <= now || (prior > -1e8 && prior <= now);
      if (newest !== null) {
        const ex = px - ox;
        const ey = py - oy;
        const ez = pz - oz;
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (shown) {
          if (dist > arrivedMax) arrivedMax = dist;
        } else if (dist < pendingMin) pendingMin = dist;
      }
      if (!shown) continue;
      visible++;
      // The two halves of the restamp policy, counted rather than inferred: a virgin blip that
      // has just arrived is easing *in*, a known one that has just been restamped is easing its
      // *age* over. Same stamps the shader branches on, so the counts cannot disagree with it.
      const since = now - birth;
      if (since >= 0) {
        if (prior <= -1e8) {
          if (since < arriveWindow) ramping++;
        } else if (since < refreshWindow) refreshing++;
      }
      /*
       * The two age curves, on the blips close enough to the player to be the ones under their
       * feet. `nearAgeEased` is what the shader draws; `nearAgeStep` is what it drew before this
       * batch. Both are means over the same set in the same frame, which is what makes the pair
       * evidence rather than two unrelated numbers.
       */
      if (listenerD2 <= nearR2) {
        nearBlips++;
        nearStep += since >= 0 ? since : now - prior;
        if (prior <= -1e8) nearEased += since;
        else {
          const ageOld = now - prior;
          const t = Math.min(1, Math.max(0, since / Math.max(0.001, refreshWindow)));
          nearEased += ageOld + (since - ageOld) * t * t * (3 - 2 * t);
        }
      }
      const depth = (px - cx) * dxv + (py - cy) * dyv + (pz - cz) * dzv;
      if (depth > 0.05 && depth < minDepth) minDepth = depth;
    }

    d.arrivedMax = arrivedMax;
    d.pendingMin = pendingMin;
    d.visible = visible;
    d.ramping = ramping;
    d.refreshing = refreshing;
    d.nearBlips = nearBlips;
    d.nearAgeEased = nearBlips > 0 ? nearEased / nearBlips : 0;
    d.nearAgeStep = nearBlips > 0 ? nearStep / nearBlips : 0;

    /*
     * The largest splat on screen. Bounded rather than measured per point: the size formula is
     * monotone in `want`, and `want` is bounded above by the biggest per-point multiplier over
     * the nearest visible blip — which costs one `pow` instead of half a million.
     */
    if (minDepth === Infinity) {
      d.maxBlipPixels = 0;
      d.maxBlipWant = 0;
    } else {
      const p = this.profile;
      // 1.15 is the largest material size bias (stone), and it only applies where a look asked.
      const biggestBias = 1 + 0.15 * p.materialMix;
      const factor = (1 + p.sizeJitter) * (1 + this.wave.rimSize) * biggestBias;
      const want = (p.sizeWorld * factor * this.projScale) / Math.pow(minDepth, p.depthExp);
      const q = want / Math.max(0.5, this.tunables.pixelCap);
      let size = want / Math.cbrt(1 + q * q * q);
      size = Math.min(size, p.maxPixels);
      size = Math.max(size, p.minPixels);
      d.maxBlipWant = want;
      d.maxBlipPixels = size;
    }
    return d;
  }

  // ---- event layer ---------------------------------------------------------

  private addEventMarker(event: SoundEvent): void {
    const slot = this.eventIndex % EVENT_CAPACITY;
    const i3 = slot * 3;
    this.eventPositions[i3] = event.x;
    this.eventPositions[i3 + 1] = event.y;
    this.eventPositions[i3 + 2] = event.z;
    this.scratchColor.setHex(EVENT_COLORS[event.class], THREE.LinearSRGBColorSpace);
    this.eventColors[i3] = this.scratchColor.r;
    this.eventColors[i3 + 1] = this.scratchColor.g;
    this.eventColors[i3 + 2] = this.scratchColor.b;
    this.eventBirths[slot] = this.time;
    this.eventScales[slot] = Math.min(2.2, 0.6 + event.paintRadius * 0.09);
    this.eventIndex++;
    this.flushEvents();
  }

  private flushEvents(): void {
    this.eventGeometry.setDrawRange(0, Math.min(this.eventIndex, EVENT_CAPACITY));
    for (const name of ['position', 'aColor', 'aBirth', 'aScale']) {
      (this.eventGeometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.eventGeometry.dispose();
    this.eventMaterial.dispose();
    this.tracer.dispose();
    this.dust.dispose();
    this.structured.dispose();
    this.root.clear();
  }
}
