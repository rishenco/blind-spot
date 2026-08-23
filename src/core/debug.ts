/**
 * Dev-only overlays (engine-plan §10). Never part of the game image — vision §12 and
 * visual-brief §1.10 keep the real HUD inside the reticle and the corners empty.
 *
 *   M   top-down orthographic debug view — must read as doc/sample-map.md §1
 *   F3  stats
 *   F6  toggle dog 2's optional patrol (solid when live, dashed when not)
 *   F7  test detonation 12 m ahead of the camera (`testDetonation`)
 *
 * The top-down view is drawn on a 2D canvas rather than through the WebGL scene: it is a
 * technical drawing (hatching, dashes, labels, tick rulers) whose only job is to be compared
 * against the authored plan, and it must render even where WebGL does not.
 */

import type { SoundEvent } from './events.js';
import type { Sim } from './sim.js';
import type { CollisionSolid, World } from './map/build.js';
import { raycast, solidAt } from './map/build.js';
import type { DoorDef, MapDef } from './map/types.js';
import { angleDelta, yawToForward } from './math.js';

// Palette. Event-layer hues follow vision §3.2 (self amber, dog red-orange, prop pale yellow,
// objective gold) so the debug map teaches the same colour language as the game.
const C = {
  bg: '#04070a',
  interior: '#0a1116',
  grid: '#0f2029',
  gridMajor: '#193846',
  ruler: '#4e7d90',
  wallFill: '#16323f',
  wallLine: '#7fd4ef',
  machineFill: '#1b262e',
  machineLine: '#9fb4c4',
  crateFill: '#182830',
  crateLine: '#bcdcea',
  tankFill: '#1a3a49',
  climbLine: '#8fd0e6',
  overLine: '#5f93a8',
  duckLine: '#c2a3e8',
  subLine: '#3f6a7c',
  holeLine: '#2d5566',
  door: '#6ef0c8',
  ladder: '#8ef0a2',
  can: '#e8e08a',
  chain: '#e8e08a',
  beacon: '#ffd54a',
  route: '#ff8a5c',
  dogBody: '#ff5a2c',
  player: '#ffb347',
  trail: 'rgba(255,179,71,0.45)',
  zoneLabel: '#8fd8ee',
  poiLabel: '#6f97a8',
  title: '#cdeffb',
  dim: '#527585',
} as const;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Player-trail sampling: one breadcrumb per this many metres, this many kept. */
const TRAIL_MIN_STEP = 0.3;
const TRAIL_MAX = 1200;

type SolidClass = 'sub' | 'over' | 'duck' | 'climb' | 'block';

function classify(s: CollisionSolid): SolidClass {
  if (s.maxY <= 0.001) return 'sub';
  if (s.minY >= 1.9) return 'over';
  if (s.minY > 0.35) return 'duck';
  if (s.maxY <= 2.25) return 'climb';
  return 'block';
}

/** Cells of the floor slab that are missing — the corridor pit reads straight out of the data. */
function findFloorHoles(world: World, map: MapDef): Array<[number, number, number, number]> {
  const step = 0.25;
  const y = -0.2;
  const cells: Array<[number, number, number, number]> = [];
  for (let z = 0; z < map.bounds.max[2]; z += step) {
    let runStart = NaN;
    for (let x = 0; x <= map.bounds.max[0]; x += step) {
      const empty = x < map.bounds.max[0] && solidAt(world, x + step / 2, y, z + step / 2) === null;
      if (empty && Number.isNaN(runStart)) runStart = x;
      else if (!empty && !Number.isNaN(runStart)) {
        cells.push([runStart, z, x, z + step]);
        runStart = NaN;
      }
    }
  }
  return cells;
}

interface View {
  scale: number;
  ox: number;
  oy: number;
}

export interface DebugState {
  topDown: boolean;
  stats: boolean;
}

export class DebugOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly statsEl: HTMLDivElement;
  private readonly sim: Sim;
  private holes: Array<[number, number, number, number]> | null = null;
  /** Occupied text boxes for this frame — annotations yield to authored labels, never overlap. */
  private readonly labels: Array<[number, number, number, number]> = [];
  /** The drawn plan's pixel rect [left, top, right, bottom], recomputed each `draw()`. */
  private plan: [number, number, number, number] = [0, 0, 0, 0];
  private dpr = 1;
  private w = 0;
  private h = 0;
  readonly state: DebugState = { topDown: false, stats: false };

  // rolling frame stats
  private frames = 0;
  private acc = 0;
  private fps = 0;
  private frameMs = 0;

  /**
   * Breadcrumbs of where the player has actually been (x, z pairs). A screenshot proves a dot
   * was drawn; the trail is what proves the ROUTE — `npm run verify`'s scripted movement
   * captures are read against it.
   */
  private readonly trail: number[] = [];
  private trailLastX = NaN;
  private trailLastZ = NaN;

  /**
   * Extra F3 lines contributed by the boot layer. The overlay lives in `core/` and the paint
   * pipeline and the look registry do not: engine-plan §10 wants surfel/painted/draw-call counts
   * on this panel, and a callback is how they get there without `core/debug.ts` importing the
   * renderer. Returns lines already formatted; called only while the panel is up.
   */
  extraLines: (() => readonly string[]) | null = null;

  constructor(root: HTMLElement, sim: Sim) {
    this.sim = sim;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:none;';
    root.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('debug overlay: 2D context unavailable');
    this.ctx = ctx;

    // Anchored right: the top-down view's title, axis hint and ruler own the left margin.
    this.statsEl = document.createElement('div');
    // Bottom-right is the free corner: the top-down view's title and axis hint own the top-left,
    // its ruler the left margin, its legend the bottom-left — and corridor C runs along the top
    // edge of a wide map, which is exactly where the scripted routes end. The panel is opaque so
    // it can be read over the drawing rather than through it.
    this.statsEl.style.cssText =
      `position:fixed;right:12px;bottom:96px;font:11px/1.5 ${MONO};color:${C.dim};` +
      'white-space:pre;pointer-events:none;display:none;text-shadow:0 0 6px #000;' +
      `background:${C.bg};border:1px solid ${C.wallFill};border-radius:3px;padding:6px 9px;`;
    root.appendChild(this.statsEl);

    this.resize(window.innerWidth, window.innerHeight);
  }

  toggleTopDown(): void {
    this.state.topDown = !this.state.topDown;
    this.canvas.style.display = this.state.topDown ? 'block' : 'none';
    if (this.state.topDown) this.draw();
  }

  setTopDown(on: boolean): void {
    if (on !== this.state.topDown) this.toggleTopDown();
  }

  toggleStats(): void {
    this.state.stats = !this.state.stats;
    this.statsEl.style.display = this.state.stats ? 'block' : 'none';
  }

  /**
   * F6: flip the second patrol on/off. The route draws solid when live and dashed when not, so
   * the plan can be read either way (sample-map §3 authors dog 2 as the optional second patrol).
   */
  toggleDog2(): void {
    const route = this.sim.map.dogRoutes.find((r) => r.id === 'dog2');
    if (!route) return;
    route.defaultOn = !route.defaultOn;
    // The plan and the world are the same statement (vision §1.2): flipping the flag without
    // spawning the animal would draw a patrol that is not walking, which is the one thing a
    // debug view may never do.
    if (route.defaultOn) this.sim.dogs.spawn(route.id);
    else this.sim.dogs.despawn(route.id);
    if (this.state.topDown) this.draw();
  }

  /** The rolling frame numbers the F3 panel prints — the verify harness asserts against these. */
  get frameStats(): { fps: number; frameMs: number } {
    return { fps: this.fps, frameMs: this.frameMs };
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    if (this.state.topDown) this.draw();
  }

  update(dtMs: number): void {
    this.frames++;
    this.acc += dtMs;
    if (this.acc >= 500) {
      this.fps = (this.frames * 1000) / this.acc;
      this.frameMs = this.acc / this.frames;
      this.frames = 0;
      this.acc = 0;
    }
    this.sampleTrail();
    if (this.state.stats) {
      const p = this.sim.player;
      const m = this.sim.movement;
      const bus = this.sim.bus;
      const c = bus.counts;
      const e = bus.last;
      const extra = this.extraLines ? this.extraLines() : [];
      this.statsEl.textContent = [
        `fps        ${this.fps.toFixed(0).padStart(5)}   ${this.frameMs.toFixed(2)} ms`,
        `sim        ${this.sim.time.toFixed(2)} s   ${this.sim.steps} steps`,
        `solids     ${this.sim.world.solids.length}  walkable tops ${this.sim.world.walkables.length}`,
        `player     ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}  yaw ${((p.yaw * 180) / Math.PI).toFixed(0)}°`,
        `stance     ${p.stance.padEnd(6)} ${m.speedXZ.toFixed(2)} m/s  ground ${p.grounded ? 'yes' : 'no '}  gait ${m.gait}`,
        `verbs      hands ${m.hands.padEnd(6)} stagger ${m.staggerTime.toFixed(2)}  last fall ${m.lastFall.toFixed(2)} m`,
        `events     ${bus.emitted}  walk ${c.walkStep} sprint ${c.sprintStep} crouch ${c.crouchStep} slide ${c.slide} land ${c.landing}`,
        `last       ${e ? `${e.class} @ ${e.time.toFixed(2)}s  paint ${e.paintRadius.toFixed(1)} hear ${e.hearRadius.toFixed(1)}` : '—'}`,
        `map        ${this.sim.map.name}`,
        ...extra,
      ].join('\n');
    }
    if (this.state.topDown) this.draw();
  }

  dispose(): void {
    this.canvas.remove();
    this.statsEl.remove();
  }

  /**
   * The breadcrumbs, flat `[x, z, x, z, …]`. `npm run verify` reads the scripted routes out of
   * here: an end position proves where a body stopped, the trail proves how it got there.
   */
  get trailPoints(): readonly number[] {
    return this.trail;
  }

  private sampleTrail(): void {
    const p = this.sim.player;
    const moved = Math.hypot(p.x - this.trailLastX, p.z - this.trailLastZ);
    if (Number.isFinite(moved) && moved < TRAIL_MIN_STEP) return;
    this.trailLastX = p.x;
    this.trailLastZ = p.z;
    this.trail.push(p.x, p.z);
    if (this.trail.length > TRAIL_MAX * 2) this.trail.splice(0, this.trail.length - TRAIL_MAX * 2);
  }

  // ----------------------------------------------------------------------------------------

  private view(): View {
    const map = this.sim.map;
    const padL = 46;
    const padT = 54;
    const padR = 16;
    const padB = 74;
    const wSpan = map.bounds.max[0] - map.bounds.min[0];
    const dSpan = map.bounds.max[2] - map.bounds.min[2];
    const scale = Math.min((this.w - padL - padR) / wSpan, (this.h - padT - padB) / dSpan);
    return {
      scale,
      ox: padL - map.bounds.min[0] * scale,
      oy: padT - map.bounds.min[2] * scale,
    };
  }

  /** Record a box as taken. */
  private reserve(x0: number, y0: number, x1: number, y1: number): void {
    this.labels.push([x0, y0, x1, y1]);
  }

  /** Record the box of a label centred on (cx, cy), measured with the ctx's current font. */
  private reserveText(text: string, cx: number, cy: number, half = 7): void {
    const w = this.ctx.measureText(text).width;
    this.reserve(cx - w / 2 - 3, cy - half, cx + w / 2 + 3, cy + half);
  }

  /**
   * Slide a label box of half-size `half` back inside the drawn plan — and therefore inside the
   * canvas, which the plan sits within. A height note or a marker is an annotation ABOUT the map
   * and reads as nonsense hanging off its east wall ("HIGH SHELF y3.3" and "y3.05–3.3" both ran
   * past the edge at x 43.6). If the label is wider than the plan itself, leave it where it was
   * and let `isFree` decide — a clamp that cannot succeed must not make things worse.
   */
  private clampLabel(centre: number, half: number, axis: 0 | 1): number {
    const [l, t, r, b] = this.plan;
    const lo = Math.max(2, axis === 0 ? l : t) + half;
    const hi = Math.min(axis === 0 ? this.w - 2 : this.h - 2, axis === 0 ? r : b) - half;
    return hi < lo ? centre : Math.min(Math.max(centre, lo), hi);
  }

  private isFree(x0: number, y0: number, x1: number, y1: number): boolean {
    if (x0 < 2 || x1 > this.w - 2 || y0 < 2 || y1 > this.h - 2) return false;
    for (const [a0, b0, a1, b1] of this.labels) {
      if (x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0) return false;
    }
    return true;
  }

  private draw(): void {
    const { ctx } = this;
    const map = this.sim.map;
    const world = this.sim.world;
    if (!this.holes) this.holes = findFloorHoles(world, map);
    this.labels.length = 0;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const v = this.view();
    const X = (x: number): number => v.ox + x * v.scale;
    const Z = (z: number): number => v.oy + z * v.scale;
    const S = (m: number): number => m * v.scale;
    this.plan = [X(map.bounds.min[0]), Z(map.bounds.min[2]), X(map.bounds.max[0]), Z(map.bounds.max[2])];

    // interior ground
    ctx.fillStyle = C.interior;
    ctx.fillRect(X(0), Z(0), S(45), S(30));

    // Chrome bands (title strip, legend strip) are taken before anything measures free space.
    this.reserve(0, 0, this.w, 44);
    this.reserve(0, this.h - 62, this.w, this.h);

    this.drawGrid(X, Z, S);
    this.drawHoles(X, Z);
    this.drawSolids(X, Z, S);
    this.drawDoors(X, Z, S);
    this.drawLadders(X, Z, S);
    this.drawProps(X, Z, S);
    this.drawRoutes(X, Z, S);
    this.drawMarkers(X, Z);
    this.drawPlayer(X, Z, S);
    this.drawHeights(X, Z); // last: height notes fill the gaps the authored labels leave
    this.drawChrome();

    ctx.restore();
  }

  private drawGrid(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    ctx.lineWidth = 1;
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = 'alphabetic';

    for (let x = 0; x <= 45; x += 4) {
      ctx.strokeStyle = x % 8 === 0 ? C.gridMajor : C.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(X(x)) + 0.5, Z(0));
      ctx.lineTo(Math.round(X(x)) + 0.5, Z(30));
      ctx.stroke();
      ctx.fillStyle = C.ruler;
      ctx.textAlign = 'center';
      ctx.fillText(String(x), X(x), Z(0) - 7);
    }
    for (let z = 0; z <= 30; z += 2) {
      ctx.strokeStyle = z % 10 === 0 ? C.gridMajor : C.grid;
      ctx.beginPath();
      ctx.moveTo(X(0), Math.round(Z(z)) + 0.5);
      ctx.lineTo(X(45), Math.round(Z(z)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = C.ruler;
      ctx.textAlign = 'right';
      ctx.fillText(String(z), X(0) - 8, Z(z) + 3.5);
    }
    // The two ruler gutters belong to the ruler.
    this.reserve(0, Z(0) - 20, this.w, Z(0) - 2);
    this.reserve(0, 0, X(0) - 3, this.h);

    // scale bar: 4 m
    ctx.strokeStyle = C.ruler;
    ctx.beginPath();
    ctx.moveTo(X(0), Z(30) + 16);
    ctx.lineTo(X(0) + S(4), Z(30) + 16);
    ctx.stroke();
    ctx.fillStyle = C.ruler;
    ctx.textAlign = 'left';
    ctx.fillText('4 m', X(0) + S(4) + 6, Z(30) + 19);
  }

  private drawHoles(X: (n: number) => number, Z: (n: number) => number): void {
    const { ctx } = this;
    if (!this.holes?.length) return;
    ctx.save();
    ctx.beginPath();
    for (const [x0, z0, x1, z1] of this.holes) ctx.rect(X(x0), Z(z0), X(x1) - X(x0), Z(z1) - Z(z0));
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = C.holeLine;
    ctx.lineWidth = 1;
    const span = this.w + this.h;
    ctx.beginPath();
    for (let d = -this.h; d < span; d += 7) {
      ctx.moveTo(d, 0);
      ctx.lineTo(d + this.h, this.h);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawSolids(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    const order: SolidClass[] = ['sub', 'over', 'climb', 'duck', 'block'];
    const solids = this.sim.world.solids;

    for (const cls of order) {
      for (const s of solids) {
        if (s.kind === 'ceiling' || s.kind === 'floor') continue; // slabs are implied; their holes are drawn
        if (classify(s) !== cls) continue;
        const isCyl = s.shape === 'cyl';
        const x = X(s.minX);
        const z = Z(s.minZ);
        const w = S(s.maxX - s.minX);
        const d = S(s.maxZ - s.minZ);

        ctx.save();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.25;
        switch (cls) {
          case 'sub':
            ctx.strokeStyle = C.subLine;
            ctx.setLineDash([2, 3]);
            ctx.lineWidth = 1;
            break;
          case 'over':
            ctx.fillStyle = 'rgba(95,147,168,0.10)';
            ctx.strokeStyle = C.overLine;
            ctx.setLineDash([5, 4]);
            break;
          case 'duck':
            ctx.fillStyle = 'rgba(194,163,232,0.12)';
            ctx.strokeStyle = C.duckLine;
            ctx.setLineDash([2, 2]);
            break;
          case 'climb':
            ctx.fillStyle = s.kind === 'pedestal' ? '#2a2417' : C.crateFill;
            ctx.strokeStyle = s.kind === 'pedestal' ? C.beacon : C.climbLine;
            break;
          default:
            ctx.fillStyle = s.kind === 'machine' ? C.machineFill : s.kind === 'tank' ? C.tankFill : C.wallFill;
            ctx.strokeStyle = s.kind === 'machine' ? C.machineLine : C.wallLine;
            ctx.lineWidth = 1.5;
            break;
        }

        ctx.beginPath();
        if (isCyl) ctx.arc(X(s.cx), Z(s.cz), S(s.r), 0, Math.PI * 2);
        else ctx.rect(x, z, w, d);
        if (cls !== 'sub') ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

  }

  /**
   * Height notes for anything off walking level. Drawn last and only where the box is free:
   * an unreadable pile of numbers would defeat the one job this view has.
   */
  private drawHeights(X: (n: number) => number, Z: (n: number) => number): void {
    const { ctx } = this;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of this.sim.world.solids) {
      if (s.kind === 'ceiling' || s.kind === 'floor') continue;
      const cls = classify(s);
      if ((s.maxX - s.minX) * (s.maxZ - s.minZ) < 2.2) continue;
      let text = '';
      if (cls === 'over') text = `y${s.minY.toFixed(2).replace(/0$/, '')}–${s.maxY}`;
      else if (cls === 'duck') text = `under y${s.minY}`;
      else if (cls === 'climb') text = `h${s.maxY}`;
      if (!text) continue;

      const half = ctx.measureText(text).width / 2 + 3;
      const cx = this.clampLabel(X((s.minX + s.maxX) / 2), half, 0);
      const cy = this.clampLabel(Z((s.minZ + s.maxZ) / 2), 6, 1);
      let placed: number | null = null;
      for (const dy of [0, -11, 11, -22, 22]) {
        if (this.isFree(cx - half, cy + dy - 6, cx + half, cy + dy + 6)) {
          placed = dy;
          break;
        }
      }
      if (placed === null) continue;
      this.reserve(cx - half, cy + placed - 6, cx + half, cy + placed + 6);
      ctx.fillStyle = cls === 'duck' ? C.duckLine : cls === 'climb' ? C.climbLine : C.overLine;
      ctx.fillText(text, cx, cy + placed);
    }
  }

  private drawDoors(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const dr of this.sim.map.doors) {
      const walk = dr.walkable;
      ctx.strokeStyle = walk ? C.door : C.overLine;
      ctx.lineWidth = walk ? 3 : 2;
      ctx.setLineDash(walk ? [] : [3, 3]);
      ctx.beginPath();
      let lx: number, lz: number;
      if (dr.axis === 'z') {
        ctx.moveTo(X(dr.from), Z(dr.at));
        ctx.lineTo(X(dr.to), Z(dr.at));
        lx = (dr.from + dr.to) / 2;
        lz = dr.at;
      } else {
        ctx.moveTo(X(dr.at), Z(dr.from));
        ctx.lineTo(X(dr.at), Z(dr.to));
        lx = dr.at;
        lz = (dr.from + dr.to) / 2;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (!walk) continue;
      const off = dr.axis === 'z' ? [0, -S(1.15)] : [S(1.15), 0];
      const px = X(lx) + off[0]!;
      const pz = Z(lz) + off[1]!;
      this.reserve(px - 9, pz - 9, px + 9, pz + 9);
      ctx.fillStyle = C.bg;
      ctx.beginPath();
      ctx.arc(X(lx) + off[0]!, Z(lz) + off[1]!, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.door;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = C.door;
      ctx.font = `bold 10px ${MONO}`;
      ctx.fillText(dr.id, X(lx) + off[0]!, Z(lz) + off[1]! + 0.5);
    }
  }

  private drawLadders(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    ctx.strokeStyle = C.ladder;
    ctx.fillStyle = C.ladder;
    ctx.lineWidth = 1.5;
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = 'middle';
    for (const l of this.sim.world.ladders) {
      const x0 = X(l.minX);
      const z0 = Z(l.minZ);
      const w = X(l.maxX) - x0;
      const d = Z(l.maxZ) - z0;
      ctx.setLineDash([]);
      ctx.strokeRect(x0, z0, w, d);
      const along = Math.abs(l.outX) > 0.5 ? 'z' : 'x';
      ctx.beginPath();
      for (let i = 1; i <= 3; i++) {
        const t = i / 4;
        if (along === 'z') {
          ctx.moveTo(x0, z0 + d * t);
          ctx.lineTo(x0 + w, z0 + d * t);
        } else {
          ctx.moveTo(x0 + w * t, z0);
          ctx.lineTo(x0 + w * t, z0 + d);
        }
      }
      ctx.stroke();
      ctx.textAlign = l.outX < 0 ? 'right' : 'left';
      const lx = l.outX < 0 ? x0 - 5 : x0 + w + 5;
      const text = `LADDER y${l.yBase}→${l.yTop}`;
      const tw = ctx.measureText(text).width;
      this.reserve(l.outX < 0 ? lx - tw - 3 : lx - 3, z0 + d / 2 - 7, l.outX < 0 ? lx + 3 : lx + tw + 3, z0 + d / 2 + 7);
      ctx.fillText(text, lx, z0 + d / 2);
      void S;
    }
  }

  private drawProps(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    // A can that has been kicked is somewhere else now, and the plan says where: the authored
    // spot is only the truth until someone walks into it (vision §1.2).
    const moved = new Map(this.sim.props.cans.map((c) => [c.id, c]));
    for (const p of this.sim.map.props) {
      if (p.type === 'can') {
        const live = moved.get(p.id);
        ctx.fillStyle = C.can;
        ctx.globalAlpha = live ? 1 : 0.45;
        ctx.beginPath();
        ctx.arc(X(live ? live.x : p.x), Z(live ? live.z : p.z), Math.max(2.5, S(0.12)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.type === 'chain') {
        ctx.strokeStyle = C.chain;
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        if (p.thinAxis === 'z') {
          const z = (p.min[2] + p.max[2]) / 2;
          ctx.moveTo(X(p.min[0]), Z(z));
          ctx.lineTo(X(p.max[0]), Z(z));
        } else {
          const x = (p.min[0] + p.max[0]) / 2;
          ctx.moveTo(X(x), Z(p.min[2]));
          ctx.lineTo(X(x), Z(p.max[2]));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = C.beacon;
        ctx.fillStyle = C.beacon;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(X(p.x), Z(p.z), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(X(p.x), Z(p.z), 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = `9px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        this.reserve(X(p.x) - 12, Z(p.z) - 12, X(p.x) + 12, Z(p.z) + 25);
        ctx.fillText('BEACON', X(p.x), Z(p.z) + 13);
      }
    }
  }

  private drawRoutes(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const route of this.sim.map.dogRoutes) {
      // Solid means WALKING, not authored-on: `?dogs=` decides membership at boot (core/roster.ts)
      // and F6 changes it mid-run, so the plan reads the live roster and never the intent.
      const on = this.sim.dogs.has(route.id);
      ctx.strokeStyle = C.route;
      ctx.globalAlpha = on ? 0.95 : 0.4;
      ctx.lineWidth = on ? 1.75 : 1.25;
      ctx.setLineDash(on ? [] : [6, 5]);
      ctx.beginPath();
      route.waypoints.forEach((wp, i) => {
        if (i === 0) ctx.moveTo(X(wp.x), Z(wp.z));
        else ctx.lineTo(X(wp.x), Z(wp.z));
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.route;
      for (const wp of route.waypoints) {
        ctx.beginPath();
        ctx.arc(X(wp.x), Z(wp.z), wp.pause ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (wp.pause) {
          ctx.fillStyle = C.bg;
          ctx.beginPath();
          ctx.arc(X(wp.x), Z(wp.z), 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = C.route;
          // Patrols hug the walls by design, so their annotations are the ones most likely to
          // hang off the plan: dog 1's first waypoint is (2, 28), two metres from the west wall
          // and two from the south. Clamp both axes, same as the height notes and the markers.
          const px = this.clampLabel(X(wp.x), this.ctx.measureText(`${wp.pause}s`).width / 2 + 3, 0);
          const pz = this.clampLabel(Z(wp.z) - 11, 7, 1);
          this.reserveText(`${wp.pause}s`, px, pz);
          ctx.fillText(`${wp.pause}s`, px, pz);
        }
      }
      const head = route.waypoints[0]!;
      // Tag from the route's own id, never from its on/off state — F6 flips `defaultOn`, and a
      // label derived from that would rename the dogs every time it is pressed.
      const n = route.id.replace(/^dog/, '');
      const tag = route.id === 'dog2' ? `DOG ${n} (F6)` : `DOG ${n}`;
      const tx = this.clampLabel(X(head.x) + S(0.2), ctx.measureText(tag).width / 2 + 3, 0);
      const tz = this.clampLabel(Z(head.z) + 13, 7, 1);
      this.reserveText(tag, tx, tz);
      ctx.fillText(tag, tx, tz);
      ctx.globalAlpha = 1;
    }

    // Where the animals ACTUALLY are. This is the plan, not the game: the first-person image is
    // forbidden to draw a dog from its position (vision §6), and the top-down view exists to be
    // compared against that — you read the route here and check what the ear reported there.
    for (const d of this.sim.dogs.bodies) {
      const [fx, fz] = yawToForward(d.yaw);
      ctx.fillStyle = C.dogBody;
      ctx.strokeStyle = C.dogBody;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(X(d.x), Z(d.z), 4.5, 0, Math.PI * 2);
      ctx.fill();
      // A nose, so the plan says which way it is facing — and a hollow ring while it is stopped,
      // because a stopped dog is a silent dog and silence is the whole mechanic (vision §6).
      ctx.beginPath();
      ctx.moveTo(X(d.x), Z(d.z));
      ctx.lineTo(X(d.x) + fx * 11, Z(d.z) + fz * 11);
      ctx.stroke();
      if (!d.moving) {
        ctx.fillStyle = C.bg;
        ctx.beginPath();
        ctx.arc(X(d.x), Z(d.z), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawMarkers(X: (n: number) => number, Z: (n: number) => number): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of this.sim.map.markers) {
      const zone = m.kind === 'zone';
      ctx.font = zone ? `bold 12px ${MONO}` : `9px ${MONO}`;
      const text = m.label;
      const wpx = ctx.measureText(text).width;
      // Authored labels always draw; the box is pulled inside the drawn plan and nudged off
      // anything already placed (a door pip, a route tag) without leaving its own feature.
      const cx = this.clampLabel(X(m.x), wpx / 2 + 6, 0);
      const cy0 = Math.min(Math.max(this.clampLabel(Z(m.z), 8, 1), 52), this.h - 70);
      let cy = cy0;
      for (const dy of [0, -12, 12, -24, 24]) {
        if (this.isFree(cx - wpx / 2 - 4, cy0 + dy - 8, cx + wpx / 2 + 4, cy0 + dy + 8)) {
          cy = cy0 + dy;
          break;
        }
      }
      this.reserve(cx - wpx / 2 - 4, cy - 8, cx + wpx / 2 + 4, cy + 8);
      ctx.fillStyle = 'rgba(4,7,10,0.72)';
      ctx.fillRect(cx - wpx / 2 - 4, cy - 8, wpx + 8, 16);
      ctx.fillStyle = zone ? C.zoneLabel : C.poiLabel;
      ctx.fillText(text, cx, cy + 0.5);
    }
  }

  private drawPlayer(X: (n: number) => number, Z: (n: number) => number, S: (n: number) => number): void {
    const { ctx } = this;
    const p = this.sim.player;
    const [fx, , fz] = yawToForward(p.yaw);
    const px = X(p.x);
    const pz = Z(p.z);
    const r = Math.max(4, S(0.35));

    if (this.trail.length >= 4) {
      ctx.strokeStyle = C.trail;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(X(this.trail[0]!), Z(this.trail[1]!));
      for (let i = 2; i < this.trail.length; i += 2) ctx.lineTo(X(this.trail[i]!), Z(this.trail[i + 1]!));
      ctx.stroke();
    }

    ctx.strokeStyle = C.player;
    ctx.fillStyle = 'rgba(255,179,71,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, pz, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px + fx * r, pz + fz * r);
    ctx.lineTo(px + fx * r * 2.6, pz + fz * r * 2.6);
    ctx.stroke();
    ctx.fillStyle = C.player;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tag = this.sim.player.stance.toUpperCase();
    this.reserve(px - r - 2, pz - r - 2, px + r + 12 + ctx.measureText(tag).width, pz + r + 2);
    ctx.fillText(tag, px + r + 6, pz - 9);
  }

  private drawChrome(): void {
    const { ctx } = this;
    const map = this.sim.map;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.title;
    ctx.font = `bold 14px ${MONO}`;
    ctx.fillText(`${map.name.toUpperCase()} — TOP-DOWN DEBUG [M]`, 14, 22);
    ctx.fillStyle = C.dim;
    ctx.font = `10px ${MONO}`;
    ctx.fillText('x east →   z south ↓   grid 4 m × 2 m   interior 45 × 30 × 7 m', 14, 38);

    const items: Array<[string, string, 'fill' | 'dash' | 'line' | 'dot']> = [
      ['wall / column / tank', C.wallLine, 'fill'],
      ['machine mass', C.machineLine, 'fill'],
      ['climbable (crate, row)', C.climbLine, 'fill'],
      ['overhead slab (catwalk, beam, lintel)', C.overLine, 'dash'],
      ['duck-under (duct)', C.duckLine, 'dash'],
      ['below floor (trench)', C.subLine, 'dash'],
      ['floor hole (pit)', C.holeLine, 'fill'],
      ['door opening', C.door, 'line'],
      ['ladder', C.ladder, 'line'],
      ['prop (can / chain)', C.can, 'dot'],
      ['beacon (objective)', C.beacon, 'dot'],
      ['dog route', C.route, 'line'],
      ['player', C.player, 'dot'],
      ['player trail', C.trail, 'line'],
    ];
    const y0 = this.h - 46;
    let x = 14;
    let y = y0;
    ctx.font = `10px ${MONO}`;
    for (const [label, colour, style] of items) {
      const wpx = ctx.measureText(label).width + 30;
      if (x + wpx > this.w - 14) {
        x = 14;
        y += 15;
      }
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(style === 'dash' ? [4, 3] : []);
      if (style === 'dot') {
        ctx.beginPath();
        ctx.arc(x + 6, y - 3, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === 'fill') {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, y - 8, 13, 10);
        ctx.globalAlpha = 1;
        ctx.strokeRect(x + 0.5, y - 7.5, 12, 9);
      } else {
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + 13, y - 3);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = C.dim;
      ctx.fillText(label, x + 19, y);
      x += wpx;
    }
  }
}

/** Doors that a walker can actually use — the map-sanity specs and the view share this filter. */
export const walkableDoors = (map: MapDef): DoorDef[] => map.doors.filter((d) => d.walkable);

// ------------------------------------------------------------------------------------------
// F7 — the test detonation (engine-plan §10)
// ------------------------------------------------------------------------------------------

/** How far back from a hit surface the blast is placed, metres. */
const DETONATION_BACKOFF = 0.35;
/** Closest the blast may ever be placed to the eye, metres — a face full of white helps nobody. */
const DETONATION_MIN = 1.0;

/**
 * "F7: test detonation 12 m ahead of the camera (paints through floors, white flash class) —
 * the loudest-flashbulb showcase without dog AI." (engine-plan §10)
 *
 * It is a REAL event through the real bus — same class row, same paint path, same delivery gate
 * as a dog blowing itself up in M5. Nothing about F7 is special-cased downstream, which is the
 * point: if the flashbulb looks wrong, the pipeline is wrong.
 *
 * The one piece of care it needs is aim. "12 m ahead" walks straight into a wall in most of this
 * map, and a sound emitted INSIDE a solid is a sound with a wall between it and the entire world
 * — `applyEvent` rescues that case (a blast radiates out of the solid it is buried in) but the
 * picture is still a smear, so the ray is traced and the blast parked just short of what it hits.
 * That also makes F7 repeatable: the same stance and aim always produce the same origin.
 */
export function testDetonation(sim: Sim, distance = 12): SoundEvent {
  const p = sim.player;
  const [fx, , fz] = yawToForward(p.yaw);
  const cp = Math.cos(p.pitch);
  // Eye, not feet, and the SIM's posture rather than the rig's smoothed one: an event origin is
  // simulation truth, not picture (engine-plan §11.1).
  const ex = p.x;
  const ey = p.y + sim.movement.eyeTarget;
  const ez = p.z;
  const dx = fx * cp;
  const dy = Math.sin(p.pitch);
  const dz = fz * cp;

  let reach = distance;
  const hit = raycast(sim.world, ex, ey, ez, dx, dy, dz, distance);
  if (hit && !hit.inside) reach = Math.min(reach, hit.t - DETONATION_BACKOFF); // RayHit.t is metres
  if (reach < DETONATION_MIN) reach = DETONATION_MIN;

  return sim.bus.emit({
    class: 'detonation',
    source: 'detonation',
    x: ex + dx * reach,
    y: ey + dy * reach,
    z: ez + dz * reach,
  });
}

// ------------------------------------------------------------------------------------------
// Scripted input (`?sim=script`) — the movement harness
// ------------------------------------------------------------------------------------------

/**
 * A deterministic input timeline, keyed on SIM time (never wall-clock), driving the same
 * `MoveInput` a human's keyboard drives. It is the seed of engine-plan §10's `?autotest`: M6
 * grows it into the full demo (pings, aging, top-down), M2 uses it to prove the verbs move a
 * body along a known route in `npm run verify`.
 *
 * A segment REPLACES the whole intent — an omitted field means "not held" — so a route reads as
 * a list of what you are doing at each moment, with no leftover state from the segment before.
 */
export interface ScriptSegment {
  /** Sim time this intent takes effect. */
  readonly at: number;
  /** Absolute target yaw; applied through the same look path as the mouse. */
  readonly yaw?: number;
  /**
   * Absolute target pitch, same path as yaw. A route that only ever looks level does not need
   * this, but a route whose subject is BELOW it does: the Lantern read (vision §15.2) watches a
   * dog on the floor from the top of the machinery row, and at that depression angle a level
   * camera has the dog outside the frustum entirely.
   */
  readonly pitch?: number;
  readonly forward?: number;
  readonly right?: number;
  readonly sprint?: boolean;
  readonly crouch?: boolean;
  /** One jump press at the segment boundary. */
  readonly jump?: boolean;
  readonly note?: string;
}

/**
 * One press of E or Q on the route's own timeline. A ping is not part of the movement intent —
 * it is a separate edge-triggered latch the step consumes (core/player.ts) — so it gets its own
 * track rather than a field on `ScriptSegment`: a route may ping while holding any movement, or
 * while holding none, and the two must not have to be authored in lockstep.
 */
export interface ScriptPing {
  /** Sim time the key goes down. Fired for exactly one step, like a real keypress. */
  readonly at: number;
  readonly mode: 'e' | 'q';
  readonly note?: string;
}

export interface ScriptDef {
  readonly id: string;
  readonly title: string;
  /** Sim time at which the route is finished and input goes quiet. */
  readonly end: number;
  readonly segments: readonly ScriptSegment[];
  readonly pings?: readonly ScriptPing[];
  /**
   * Which dogs and props the route needs alive (core/roster.ts). Omitted means NONE: a route is a
   * reproducible measurement, and every other emitter in the world adds paint to the same shared
   * buffer, so a route that did not ask for company must not get any. A route that is ABOUT a dog
   * says so here, and that declaration is part of the route the same way its waypoints are.
   */
  readonly dogs?: readonly string[];
  readonly props?: readonly string[];
}

/**
 * Routes over `doc/sample-map.md` §4's suggested choreography.
 *
 * `corridor` is choreography 1–2: sprint C end to end, slide the duct, jump, then drop into the
 * pit on purpose and climb out the silent way. `mantle` is the B-hall traverse to the listening
 * post of choreography 5 — the machinery row's top is at exactly MANTLE_MAX_HEIGHT. `ping` is the
 * sonar beat: walk somewhere quiet, read the room, then ask one directed question of the tank.
 */
export const SCRIPTS: Record<string, ScriptDef> = {
  corridor: {
    id: 'corridor',
    title: 'C corridor: sprint · slide · jump · drop · ladder',
    end: 11.0,
    segments: [
      { at: 0.0, yaw: -Math.PI / 2, forward: 1, note: 'walk north onto the door line' },
      { at: 0.55, note: 'settle' },
      { at: 0.85, yaw: 0, forward: 1, sprint: true, note: 'sprint east through door [a]' },
      { at: 3.1, forward: 1, sprint: true, jump: true, note: 'jump — 1.1 m, under the landing threshold' },
      { at: 4.2, forward: 1, sprint: true, crouch: true, note: 'slide under the duct at x 24' },
      { at: 5.0, forward: 1, sprint: true, note: 'stand up, run at the pit' },
      // Braking before the lip is the point, not timidity: carry the sprint over and you fly the
      // 2.8 m gap and catch the ladder in mid-air, which is a legal play but emits no landing.
      // Stepping off at a crouch drops you short of the rungs, so the trench floor gets heard.
      { at: 5.3, note: 'brake at the lip' },
      { at: 5.6, yaw: 0, forward: 1, crouch: true, note: 'crouch off the lip: a 2.8 m drop into the trench' },
      { at: 7.0, yaw: 0, forward: 1, note: 'landed — walk east to the rungs' },
      { at: 7.6, yaw: 0, forward: 1, note: 'grab the trench ladder and climb (silent)' },
      { at: 9.4, yaw: 0, forward: 1, note: 'topped out — back on the corridor floor' },
    ],
  },
  mantle: {
    id: 'mantle',
    title: 'B hall: cross the machine hall · mantle the machinery row',
    end: 6.4,
    segments: [
      { at: 0.0, yaw: Math.PI / 2, forward: 1, note: 'walk south through door [d]' },
      { at: 1.2, yaw: 1.19, forward: 1, sprint: true, note: 'sprint south-east between the column rows' },
      { at: 3.7, yaw: Math.PI / 2, forward: 1, sprint: true, note: 'square up on the machinery row' },
      { at: 4.4, yaw: Math.PI / 2, forward: 1, jump: true, note: 'mantle the 2.2 m row' },
      { at: 5.3, note: 'standing on the row — the listening post' },
    ],
  },
  /**
   * The sonar beat (vision §3.5): the only route whose paint is bought with the reactor rather
   * than with footfalls.
   *
   * It walks due south out of A along x = 3 — clear of the column rows at x = 6 — and stops on
   * the tank's own centre line (the tank is a Ø6 cylinder at (16, 16), the map's one large
   * silhouette). Then it goes quiet for over a second, so everything the walk painted has landed
   * before the first ping and the ping's own contribution is measurable as a delta.
   *
   * Q first: the room-read, 360° and 12 m, from a body that is standing still. Then a square turn
   * onto the tank and E: a 25° cone whose axis lands on the tank's near face 10 m away — real
   * geometry, so the beam has a real impact centre to make its far end at (engine-plan §6). The
   * two are 1.5 s apart, twice the shared cooldown, so neither is refused.
   */
  ping: {
    id: 'ping',
    title: 'B hall: walk quiet · Q the room · E the tank',
    end: 7.5,
    segments: [
      { at: 0.0, yaw: Math.PI / 2, forward: 1, note: 'walk south out of A through door [d]' },
      { at: 3.6, note: 'stop on the tank’s centre line and let the room go quiet' },
      { at: 5.8, yaw: 0, note: 'square up on the tank' },
    ],
    pings: [
      { at: 5.0, mode: 'q', note: 'Q — read the room' },
      { at: 6.5, mode: 'e', note: 'E — one directed question, at the tank' },
    ],
  },
  /**
   * The Lantern rig (vision §15.2): stand still behind a wall and track a patrolling dog by the
   * sound-paint it makes for you.
   *
   * The route is the `mantle` traverse plus a walk west along the top of the machinery row to a
   * post at x 13, and then nothing at all — the player is silent for the whole read. Everything
   * that happens after that is dog 1's, which is the entire point: the geometry beyond
   * `w-listening` is painted by an animal that does not know it is holding a lamp (vision §6).
   *
   * The post is ON the row rather than on the hall floor beside it. At floor level the dog's
   * sound reaches the ear through the wall AND through the row, and two walls is silence
   * (vision §3.4); from the top the row is under the ear and the wall is the only thing between.
   *
   * The end time sits just after dog 1 leaves its (14, 28) pause heading west, so the read runs
   * through the closest approach of the whole patrol — and it is the LAST leg of the loop, so a
   * capture that keeps stepping for another second or two sees more of the same pass rather than
   * an empty hall.
   */
  lantern: {
    id: 'lantern',
    title: 'B hall: mantle the row · go silent · hear dog 1 through the wall',
    end: 32.0,
    dogs: ['dog1'],
    segments: [
      { at: 0.0, yaw: Math.PI / 2, forward: 1, note: 'walk south through door [d]' },
      { at: 1.2, yaw: 1.19, forward: 1, sprint: true, note: 'sprint south-east between the column rows' },
      { at: 3.7, yaw: Math.PI / 2, forward: 1, sprint: true, note: 'square up on the machinery row' },
      { at: 4.4, yaw: Math.PI / 2, forward: 1, jump: true, note: 'mantle the 2.2 m row' },
      { at: 5.3, yaw: 0, forward: 1, note: 'walk east along the top of the row' },
      { at: 6.6, note: 'stop' },
      { at: 7.0, yaw: Math.PI / 2, pitch: -0.42, note: 'face the wall, ear down — and go silent' },
    ],
  },
};

/** `?sim=` values, so the query string can stay human ( `?sim=script` = the corridor route ). */
export const SCRIPT_ALIASES: Record<string, string> = {
  script: 'corridor',
  script1: 'corridor',
  corridor: 'corridor',
  script2: 'mantle',
  mantle: 'mantle',
  script3: 'ping',
  ping: 'ping',
  script4: 'lantern',
  lantern: 'lantern',
};

export class ScriptedInput {
  readonly def: ScriptDef;
  private readonly sim: Sim;
  private next = 0;
  private nextPing = 0;
  done = false;
  note = '';
  /** Pings the route has actually pressed, so a harness can tell "not yet" from "refused". */
  pressed = 0;

  constructor(sim: Sim, def: ScriptDef) {
    this.sim = sim;
    this.def = def;
  }

  /** Call immediately before every fixed step. */
  sync(): void {
    const t = this.sim.time;
    const input = this.sim.input;
    while (this.next < this.def.segments.length && this.def.segments[this.next]!.at <= t) {
      const s = this.def.segments[this.next]!;
      this.next++;
      input.forward = s.forward ?? 0;
      input.right = s.right ?? 0;
      input.sprint = s.sprint ?? false;
      input.crouch = s.crouch ?? false;
      if (s.jump) input.jumpPressed = true;
      if (s.yaw !== undefined) input.yawDelta = angleDelta(this.sim.player.yaw, s.yaw);
      if (s.pitch !== undefined) input.pitchDelta = s.pitch - this.sim.player.pitch;
      this.note = s.note ?? '';
    }
    // The ping track sets the same latch a keydown sets, for one step, and lets the step decide:
    // a scripted route is subject to the cooldown and the reactor exactly as a player is, so a
    // route that presses too fast records a refusal rather than a free ping (vision §3.5, §4).
    const pings = this.def.pings;
    if (pings) {
      while (this.nextPing < pings.length && pings[this.nextPing]!.at <= t) {
        const p = pings[this.nextPing]!;
        this.nextPing++;
        this.pressed++;
        if (p.mode === 'e') this.sim.playerSystems.intent.pingE = true;
        else this.sim.playerSystems.intent.pingQ = true;
        if (p.note) this.note = p.note;
      }
    }
    if (!this.done && t >= this.def.end) {
      this.done = true;
      input.forward = 0;
      input.right = 0;
      input.sprint = false;
      input.crouch = false;
      this.note = 'done';
    }
  }
}
