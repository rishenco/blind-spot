/**
 * Dev-only overlays (engine-plan §10). Never part of the game image — vision §12 and
 * visual-brief §1.10 keep the real HUD inside the reticle and the corners empty.
 *
 *   M   top-down orthographic debug view — must read as doc/sample-map.md §1
 *   F3  stats
 *   F6  toggle dog 2's optional patrol (solid when live, dashed when not)
 *
 * The top-down view is drawn on a 2D canvas rather than through the WebGL scene: it is a
 * technical drawing (hatching, dashes, labels, tick rulers) whose only job is to be compared
 * against the authored plan, and it must render even where WebGL does not.
 */

import type { Sim } from './sim.js';
import type { CollisionSolid, World } from './map/build.js';
import { solidAt } from './map/build.js';
import type { DoorDef, MapDef } from './map/types.js';
import { yawToForward } from './math.js';

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
  player: '#ffb347',
  zoneLabel: '#8fd8ee',
  poiLabel: '#6f97a8',
  title: '#cdeffb',
  dim: '#527585',
} as const;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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
  private dpr = 1;
  private w = 0;
  private h = 0;
  readonly state: DebugState = { topDown: false, stats: false };

  // rolling frame stats
  private frames = 0;
  private acc = 0;
  private fps = 0;
  private frameMs = 0;

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
    this.statsEl.style.cssText =
      `position:fixed;right:12px;top:8px;font:11px/1.5 ${MONO};color:${C.dim};` +
      'white-space:pre;pointer-events:none;display:none;text-shadow:0 0 6px #000;';
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
    if (this.state.topDown) this.draw();
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
    if (this.state.stats) {
      const p = this.sim.player;
      this.statsEl.textContent = [
        `fps        ${this.fps.toFixed(0).padStart(5)}   ${this.frameMs.toFixed(2)} ms`,
        `sim        ${this.sim.time.toFixed(2)} s   ${this.sim.steps} steps`,
        `solids     ${this.sim.world.solids.length}  walkable tops ${this.sim.world.walkables.length}`,
        `player     ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}  yaw ${((p.yaw * 180) / Math.PI).toFixed(0)}°`,
        `map        ${this.sim.map.name}`,
      ].join('\n');
    }
    if (this.state.topDown) this.draw();
  }

  dispose(): void {
    this.canvas.remove();
    this.statsEl.remove();
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

      const cx = X((s.minX + s.maxX) / 2);
      const cy = Z((s.minZ + s.maxZ) / 2);
      const half = ctx.measureText(text).width / 2 + 3;
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
    for (const p of this.sim.map.props) {
      if (p.type === 'can') {
        ctx.fillStyle = C.can;
        ctx.beginPath();
        ctx.arc(X(p.x), Z(p.z), Math.max(2.5, S(0.12)), 0, Math.PI * 2);
        ctx.fill();
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
      const on = route.defaultOn;
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
          this.reserveText(`${wp.pause}s`, X(wp.x), Z(wp.z) - 11);
          ctx.fillText(`${wp.pause}s`, X(wp.x), Z(wp.z) - 11);
        }
      }
      const head = route.waypoints[0]!;
      // Tag from the route's own id, never from its on/off state — F6 flips `defaultOn`, and a
      // label derived from that would rename the dogs every time it is pressed.
      const n = route.id.replace(/^dog/, '');
      const tag = route.id === 'dog2' ? `DOG ${n} (F6)` : `DOG ${n}`;
      this.reserveText(tag, X(head.x) + S(0.2), Z(head.z) + 13);
      ctx.fillText(tag, X(head.x) + S(0.2), Z(head.z) + 13);
      ctx.globalAlpha = 1;
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
      // Authored labels always draw; the box is pulled inside the canvas and nudged off
      // anything already placed (a door pip, a route tag) without leaving its own feature.
      const cx = Math.min(Math.max(X(m.x), wpx / 2 + 6), this.w - wpx / 2 - 6);
      let cy = Math.min(Math.max(Z(m.z), 52), this.h - 70);
      for (const dy of [0, -12, 12, -24, 24]) {
        if (this.isFree(cx - wpx / 2 - 4, cy + dy - 8, cx + wpx / 2 + 4, cy + dy + 8)) {
          cy += dy;
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
    this.reserve(px - r - 2, pz - r - 2, px + r + 12 + ctx.measureText('SPAWN').width, pz + r + 2);
    ctx.fillText('SPAWN', px + r + 6, pz - 9);
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
