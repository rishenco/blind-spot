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
 *  3. the DOM layer — a compact corner card with the pack summary, and one small label in the
 *     world above each spider carrying that spider's own state, goal and belief. The label is
 *     where the per-spider detail lives now: «надо в мире над ними инфу писать тоже, а не
 *     только в таблице». Both name the key that switched them on, so nobody has to hunt for it.
 *
 * Everything reads a single `Swarm.list()` snapshot per sync, so the overlay costs one array of
 * plain objects per *rendered* frame and exactly zero when it is off.
 */
import * as THREE from 'three';

import { STATE_COLORS, type SpiderSnapshot, type SwarmStats, type Swarm } from './swarm';

/**
 * The panel used to sit top-right at up to 46vw with one long row per spider, i.e. it covered
 * the game — «зачем мне пол экрана перекрывать». It is now a fixed narrow card in the corner
 * that never grows past a quarter of the screen: the summary and the few spiders that matter,
 * with the rest counted rather than listed. Everything per-spider moved into the world, where
 * the human asked for it.
 */
const PANEL_STYLE = `
.bs-spiders {
  position: absolute; right: 10px; bottom: 14px; padding: 6px 8px;
  background: rgba(10,14,18,0.62); border: 1px solid rgba(140,180,200,0.16);
  border-radius: 4px; white-space: pre; width: 300px; max-height: 26vh; overflow: hidden;
  font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfdbe4; text-shadow: 0 1px 2px rgba(0,0,0,0.85); pointer-events: none;
}
.bs-spiders .bs-sp-head {
  margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid rgba(140,180,200,0.16);
  color: #ffd166; letter-spacing: 0.08em; font-size: 9px;
}
.bs-spiders .bs-sp-more { margin-top: 3px; color: #7f8f9c; }
/* In-world labels: one per spider, parked over its head by the projected position. */
.bs-sp-labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.bs-sp-label {
  position: absolute; transform: translate(-50%, -100%); padding: 1px 4px 2px;
  background: rgba(8,11,14,0.58); border-left: 2px solid #888; border-radius: 2px;
  font: 10px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #dbe6ee; text-shadow: 0 1px 2px rgba(0,0,0,0.9); white-space: pre;
}
.bs-sp-label b { font-weight: 600; letter-spacing: 0.06em; }
.bs-sp-label i { font-style: normal; color: #9fb2c0; }
`;

/** Segments per spider in the line buffer: stand stick, to-goal, to-belief, belief cross (2). */
const SEGMENTS = 5;

const ONE = new THREE.Vector3(1, 1, 1);

/** How many world labels are drawn at once, nearest first. More than this is a wall of text. */
const LABELS = 8;
/** How many rows the corner card lists before it starts counting instead. */
const ROWS = 6;

/** Eight-point bearing of a direction, for the "куда идёт" line of a label. */
function compass(dx: number, dz: number): string {
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return '·';
  const a = ((Math.atan2(dz, dx) * 180) / Math.PI + 360) % 360;
  return ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][Math.round(a / 45) % 8]!;
}

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
  private readonly legsA: THREE.InstancedMesh;
  private readonly legsB: THREE.InstancedMesh;

  private readonly labelBox: HTMLDivElement;
  private readonly labels: HTMLDivElement[] = [];
  private readonly root: HTMLDivElement;
  private readonly headEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly moreEl: HTMLDivElement;
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
    // Two crossed spars of legs, so the lit truth body has the same silhouette the lidar's point
    // cloud has. A blob in the lit frame next to a spindly thing in the scan would be two
    // different animals as far as anyone reading the keyframes is concerned.
    this.legsA = new THREE.InstancedMesh(new THREE.BoxGeometry(0.82, 0.038, 0.038), skin, capacity);
    this.legsB = new THREE.InstancedMesh(new THREE.BoxGeometry(0.038, 0.038, 0.82), skin, capacity);
    for (const mesh of [this.body, this.head, this.legsA, this.legsB]) {
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
    this.moreEl = document.createElement('div');
    this.moreEl.className = 'bs-sp-more';
    this.root.append(this.headEl, this.listEl, this.moreEl);
    this.root.style.display = 'none';
    parent.append(this.root);

    this.labelBox = document.createElement('div');
    this.labelBox.className = 'bs-hud bs-sp-labels';
    this.labelBox.style.display = 'none';
    parent.append(this.labelBox);
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setVisible(on: boolean): void {
    this.object.visible = on;
    this.root.style.display = on ? '' : 'none';
    this.labelBox.style.display = on ? '' : 'none';
    if (!on) for (const el of this.labels) el.style.display = 'none';
  }

  /** The lit bodies follow the hall's lights and the muzzle flash, not the overlay key. */
  setBodiesVisible(on: boolean): void {
    this.bodies.visible = on;
  }

  /**
   * Pulls one snapshot of the pack and repaints everything that is currently switched on.
   * Called from `render()`, so it is a per-frame cost — hence the early out.
   */
  sync(swarm: Swarm, camera?: THREE.Camera): void {
    if (!this.object.visible && !this.bodies.visible) return;
    const list = swarm.list();
    if (this.bodies.visible) this.drawBodies(list);
    if (this.object.visible) {
      this.drawGizmos(list);
      this.writePanel(list, swarm.getStats());
      this.writeLabels(list, camera);
    }
  }

  /**
   * The in-world half of the overlay: a small card pinned over each spider's head, projected by
   * hand rather than drawn as a sprite. Text as DOM stays crisp at any distance, costs no
   * texture, and can be read off a screenshot — which is the only reason this tool exists.
   *
   * Labels are hidden for anything behind the camera or off screen, and only the nearest handful
   * are shown at all: fourteen overlapping cards is the same illegible wall the table was.
   */
  private writeLabels(list: SpiderSnapshot[], camera?: THREE.Camera): void {
    const box = this.labelBox;
    if (camera === undefined) {
      for (const el of this.labels) el.style.display = 'none';
      return;
    }
    const w = box.clientWidth || 1;
    const h = box.clientHeight || 1;
    const cam = camera.position;
    const near = list
      .filter((s) => s.alive)
      .map((s) => ({ s, d: Math.hypot(s.x - cam.x, s.z - cam.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LABELS);

    let n = 0;
    for (const { s } of near) {
      this.v.set(s.x, s.y + 0.95, s.z).project(camera);
      if (this.v.z > 1 || this.v.x < -1.1 || this.v.x > 1.1 || this.v.y < -1.1 || this.v.y > 1.1) {
        continue;
      }
      const el = this.label(n);
      const dx = s.goalX - s.x;
      const dz = s.goalZ - s.z;
      const heading = compass(dx, dz);
      const text =
        `<b>#${s.id} g${s.groupId} ${s.state.toUpperCase()}</b> ${s.stateFor.toFixed(1)}s ` +
        // The gait, M6b: which half of the freeze-leap-freeze cycle this one is in. Without it a
        // still frame of a jumping pack is unreadable — everything looks like it is standing.
        `${s.phase === 'air' ? '↗air' : '·still'} ${s.phaseFor.toFixed(2)}s\n` +
        `<i>go</i> ${heading} ${Math.hypot(dx, dz).toFixed(1)}m  <i>c</i>${s.courage.toFixed(2)}` +
        `${s.hp < 2 ? `  <i>hp</i>${s.hp}` : ''}\n` +
        `<i>bel</i> ${s.toBelief.toFixed(1)}m p${s.belief.confidence.toFixed(2)}` +
        `  <i>heard</i> ${s.heard} ${s.heardAgo < 99 ? `${s.heardAgo.toFixed(1)}s` : '-'}`;
      if (el.dataset.text !== text) {
        el.innerHTML = text.replace(/\n/g, '<br>');
        el.dataset.text = text;
      }
      el.style.left = `${((this.v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - this.v.y) / 2) * h}px`;
      el.style.borderLeftColor = `#${STATE_COLORS[s.state].toString(16).padStart(6, '0')}`;
      el.style.display = '';
      n++;
    }
    for (let i = n; i < this.labels.length; i++) this.labels[i]!.style.display = 'none';
  }

  private label(i: number): HTMLDivElement {
    let el = this.labels[i];
    if (el === undefined) {
      el = document.createElement('div');
      el.className = 'bs-sp-label';
      this.labelBox.append(el);
      this.labels[i] = el;
    }
    return el;
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
      this.m.compose(this.v.set(s.x, s.y + 0.11, s.z), this.q, ONE);
      this.legsA.setMatrixAt(n, this.m);
      this.legsB.setMatrixAt(n, this.m);
      n++;
    }
    for (const mesh of [this.body, this.head, this.legsA, this.legsB]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
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

  /**
   * The corner card. Summary first, then only the spiders close enough to be about to matter —
   * the rest are a count. The header names the key, because the previous version did not and the
   * human had to go looking for it.
   */
  private writePanel(list: SpiderSnapshot[], stats: SwarmStats): void {
    const counts = Object.entries(stats.byState)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    // Groups don't talk to each other (M4f), so the pack-wide numbers above hide the split
    // completely — this line is the only place it is visible from the outside.
    const groups = stats.byGroup.map((n, g) => `g${g}:${n}`).join(' ');
    const head =
      `SPIDERS [P] · pack ${stats.mode} · ${stats.count} alive · ${stats.kills} killed\n` +
      `${counts || 'none'}\n` +
      `courage ${stats.meanCourage.toFixed(2)} · ready ${stats.ready} · groups ${groups}\n` +
      `chatter ${stats.chatter.toFixed(1)}/s · ${stats.strikes} bites · ` +
      `air ${stats.airborne}/${stats.count} · ${stats.hops} hops · ` +
      `ai ${stats.updateMs.toFixed(2)} ms`;

    const alive = list.filter((s) => s.alive);
    // Nearest to their own belief first: those are the ones about to do something.
    const shown = alive.slice().sort((a, b) => a.toBelief - b.toBelief).slice(0, ROWS);
    let text = '';
    for (const s of shown) {
      text +=
        `#${String(s.id).padStart(2, '0')} g${s.groupId} ${s.state.padEnd(6)}` +
        ` c${s.courage.toFixed(2)}` +
        ` ${fmt(s.x)},${fmt(s.z)}${s.elevated ? `↑${s.y.toFixed(1)}` : '     '}` +
        ` b${s.belief.confidence.toFixed(2)} d${s.toBelief.toFixed(1)}` +
        ` ${s.heard}\n`;
    }
    const more = alive.length > shown.length ? `+${alive.length - shown.length} more — labels in the world` : '';
    const all = `${head} ${text} ${more}`;
    if (all === this.lastText) return;
    this.lastText = all;
    this.headEl.textContent = head;
    this.listEl.textContent = text.trimEnd();
    this.moreEl.textContent = more;
  }

  dispose(): void {
    for (const mesh of [this.markers, this.beliefs, this.body, this.head, this.legsA, this.legsB]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.root.remove();
    this.labelBox.remove();
    this.styleEl.remove();
  }
}

function fmt(v: number): string {
  return v.toFixed(1).padStart(5);
}
