/**
 * The mandatory M4 debug tool: *what the pack thinks*.
 *
 * `process.md` asks for it by name — "оверлей состояний пауков: кто где, в каком состоянии,
 * куда идёт, во что верит, что слышал последним" — and the milestone is not accepted without
 * it. Debugging a blind AI in a black room is otherwise impossible: in the game a spider is
 * literally nothing on screen until it clicks, so every question about it ("why did it stop
 * there?", "whose noise is it walking towards?") can only be answered by drawing the numbers.
 *
 * Three separate things live here, because they are switched on by three different reasons:
 *
 *  1. `object` — world-space gizmos (state-coloured body marker, line to the goal, the belief
 *     point with its confidence). Depth test off, so a spider behind a rack is still readable.
 *     Toggled by the overlay key; off by default, because law 1 says nothing renders for free.
 *  2. `bodies` — the *truth* mesh: actual spider geometry, lit like the props. Shown by the
 *     same L switch that lights the hall and by the muzzle flash, and by nothing else. This is
 *     "как есть на самом деле" for the keyframes.
 *  3. the DOM panel — one row per spider with the whole belief state as text.
 *
 * Everything reads a single `Swarm.list()` snapshot per sync, so the overlay costs one array of
 * plain objects per *rendered* frame and exactly zero when it is off.
 */
import * as THREE from 'three';

import { STATE_COLORS, type SpiderSnapshot, type SwarmStats, type Swarm } from './swarm';

const PANEL_STYLE = `
.bs-spiders {
  position: absolute; top: 10px; right: 10px; padding: 8px 10px;
  background: rgba(10,14,18,0.62); border: 1px solid rgba(140,180,200,0.16);
  border-radius: 4px; white-space: pre; max-width: 46vw;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfdbe4; text-shadow: 0 1px 2px rgba(0,0,0,0.85); pointer-events: none;
}
.bs-spiders .bs-sp-head {
  margin-bottom: 5px; padding-bottom: 5px; border-bottom: 1px solid rgba(140,180,200,0.16);
  color: #ffd166; letter-spacing: 0.1em; font-size: 10px;
}
`;

/** Segments per spider in the line buffer: stand stick, to-goal, to-belief, belief cross (2). */
const SEGMENTS = 5;

const ONE = new THREE.Vector3(1, 1, 1);

export class SpiderOverlay {
  /** Gizmos. Added to the scene once; visibility is the only switch. */
  readonly object = new THREE.Group();
  /** Lit truth bodies, shown with the debug lights and inside a muzzle flash. */
  readonly bodies = new THREE.Group();

  private readonly markers: THREE.InstancedMesh;
  private readonly beliefs: THREE.InstancedMesh;
  private readonly lines: THREE.LineSegments;
  private readonly linePos: Float32Array;
  private readonly lineCol: Float32Array;

  private readonly body: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;

  private readonly root: HTMLDivElement;
  private readonly headEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private lastText = '';

  private readonly capacity: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(capacity = 64, parent: HTMLElement = document.body) {
    this.capacity = capacity;

    const flat = (opacity: number) =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      });

    this.markers = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.34, 0),
      flat(0.95),
      capacity,
    );
    this.beliefs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), flat(0.5), capacity);
    for (const mesh of [this.markers, this.beliefs]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 900;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.object.add(mesh);
    }

    this.linePos = new Float32Array(capacity * SEGMENTS * 6);
    this.lineCol = new Float32Array(capacity * SEGMENTS * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 901;
    this.object.add(this.lines);
    this.object.visible = false;

    // The truth body. Flat Lambert, exactly like the props: the concept has no materials, and a
    // shaded monster would be a lie about what the renderer does in the dark.
    const skin = new THREE.MeshLambertMaterial({ color: 0x8b6f63 });
    this.body = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.24, 1), skin, capacity);
    this.head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.13, 0), skin, capacity);
    for (const mesh of [this.body, this.head]) {
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bodies.add(mesh);
    }
    this.bodies.visible = false;

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = PANEL_STYLE;
    document.head.append(this.styleEl);

    // Carries `bs-hud` too, so the harness's `bs.hud(false)` blanks it for the "as the player
    // sees it" frames without the overlay needing its own hook into the screenshot tool.
    this.root = document.createElement('div');
    this.root.className = 'bs-hud bs-spiders';
    this.headEl = document.createElement('div');
    this.headEl.className = 'bs-sp-head';
    this.listEl = document.createElement('div');
    this.root.append(this.headEl, this.listEl);
    this.root.style.display = 'none';
    parent.append(this.root);
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
    this.root.style.display = on ? '' : 'none';
  }

  /** The lit bodies follow the hall's lights and the muzzle flash, not the overlay key. */
  setBodiesVisible(on: boolean): void {
    this.bodies.visible = on;
  }

  /**
   * Pulls one snapshot of the pack and repaints everything that is currently switched on.
   * Called from `render()`, so it is a per-frame cost — hence the early out.
   */
  sync(swarm: Swarm): void {
    if (!this.object.visible && !this.bodies.visible) return;
    const list = swarm.list();
    if (this.bodies.visible) this.drawBodies(list);
    if (this.object.visible) {
      this.drawGizmos(list);
      this.writePanel(list, swarm.getStats());
    }
  }

  private drawBodies(list: SpiderSnapshot[]): void {
    const squash = this.scale.set(1, 0.62, 1);
    let n = 0;
    for (const s of list) {
      if (!s.alive || n >= this.capacity) continue;
      this.q.identity();
      this.m.compose(this.v.set(s.x, s.y + 0.2, s.z), this.q, squash);
      this.body.setMatrixAt(n, this.m);
      // The head leans towards the goal: from above it is the only cue for which way a blind
      // thing is facing, and "which way is it facing" is half of reading an encirclement.
      const dx = s.goalX - s.x;
      const dz = s.goalZ - s.z;
      const d = Math.hypot(dx, dz) || 1;
      this.m.compose(
        this.v.set(s.x + (dx / d) * 0.25, s.y + 0.19, s.z + (dz / d) * 0.25),
        this.q,
        ONE,
      );
      this.head.setMatrixAt(n, this.m);
      n++;
    }
    this.body.count = n;
    this.head.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
  }

  private drawGizmos(list: SpiderSnapshot[]): void {
    const pos = this.linePos;
    const col = this.lineCol;
    let n = 0;
    let seg = 0;
    const put = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cr: number, cg: number, cb: number,
    ): void => {
      const o = seg * 6;
      pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
      pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
      col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
      col[o + 3] = cr; col[o + 4] = cg; col[o + 5] = cb;
      seg++;
    };

    for (const s of list) {
      if (!s.alive || n >= this.capacity) continue;
      this.color.setHex(STATE_COLORS[s.state]);
      const r = this.color.r;
      const g = this.color.g;
      const b = this.color.b;

      // Body marker: size carries courage, so "this one is nearly ready" reads at a glance.
      const k = 0.7 + s.courage * 0.6;
      this.m.compose(this.v.set(s.x, s.y + 0.5, s.z), this.q.identity(), this.scale.set(k, k, k));
      this.markers.setMatrixAt(n, this.m);
      this.markers.instanceColor!.setXYZ(n, r, g, b);

      // Belief marker: dimmed by confidence — a stale belief is a ghost, and it should look it.
      const c = 0.15 + s.belief.confidence * 0.85;
      this.m.compose(this.v.set(s.belief.x, 0.35, s.belief.z), this.q.identity(), ONE);
      this.beliefs.setMatrixAt(n, this.m);
      this.beliefs.instanceColor!.setXYZ(n, r * c, g * c, b * c);

      put(s.x, s.y + 0.5, s.z, s.x, s.y + 0.06, s.z, r, g, b); // where it actually stands
      put(s.x, s.y + 0.5, s.z, s.goalX, 0.5, s.goalZ, r, g, b); // where it is walking
      put(s.x, s.y + 0.5, s.z, s.belief.x, 0.35, s.belief.z, r * c * 0.5, g * c * 0.5, b * c * 0.5);
      put(s.belief.x - 0.4, 0.35, s.belief.z, s.belief.x + 0.4, 0.35, s.belief.z, r * c, g * c, b * c);
      put(s.belief.x, 0.35, s.belief.z - 0.4, s.belief.x, 0.35, s.belief.z + 0.4, r * c, g * c, b * c);

      n++;
    }
    this.markers.count = n;
    this.beliefs.count = n;
    this.markers.instanceMatrix.needsUpdate = true;
    this.beliefs.instanceMatrix.needsUpdate = true;
    this.markers.instanceColor!.needsUpdate = true;
    this.beliefs.instanceColor!.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, seg * 2);
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private writePanel(list: SpiderSnapshot[], stats: SwarmStats): void {
    const counts = Object.entries(stats.byState)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    const head =
      `pack ${stats.mode} · ${stats.count} alive · ${counts || 'none'}\n` +
      `courage ${stats.meanCourage.toFixed(2)} · ready ${stats.ready} · ` +
      `chatter ${stats.chatter.toFixed(1)}/s · ${stats.clicks} clicks · ${stats.strikes} strikes\n` +
      `ai ${stats.updateMs.toFixed(2)} ms · ${stats.decisions} decisions/tick`;

    let text = '';
    for (const s of list) {
      if (!s.alive) continue;
      text +=
        `#${String(s.id).padStart(2, '0')} ${s.state.padEnd(6)} ${s.stateFor.toFixed(1).padStart(4)}s` +
        ` c${s.courage.toFixed(2)}` +
        ` at ${fmt(s.x)},${fmt(s.z)}${s.elevated ? ` up${s.y.toFixed(1)}` : '      '}` +
        ` goal ${fmt(s.goalX)},${fmt(s.goalZ)}` +
        ` bel ${fmt(s.belief.x)},${fmt(s.belief.z)} p${s.belief.confidence.toFixed(2)}` +
        ` d${s.toBelief.toFixed(1)}` +
        ` heard ${s.heard} ${s.heardAgo.toFixed(1)}s\n`;
    }
    const all = `${head} ${text}`;
    if (all === this.lastText) return;
    this.lastText = all;
    this.headEl.textContent = head;
    this.listEl.textContent = text.trimEnd();
  }

  dispose(): void {
    for (const mesh of [this.markers, this.beliefs, this.body, this.head]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.root.remove();
    this.styleEl.remove();
  }
}

function fmt(v: number): string {
  return v.toFixed(1).padStart(5);
}
