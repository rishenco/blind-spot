/**
 * The visible player body: a rigged humanoid driven by the controller's simulation state.
 *
 * Asset: `examples/models/gltf/Xbot.glb`, vendored from mrdoob/three.js @ r180 (the repo is
 * MIT). The rig underneath it is an Adobe Mixamo mannequin, which is a placeholder — it has
 * the clips this batch needs (idle / walk / run / sneak_pose) and none of the game's look, so
 * confirm the licence before it goes anywhere near a shipping build. It is inlined as a
 * base64 `data:` URI (see `env.d.ts`), decoded here and handed to `GLTFLoader.parse`, so the
 * build never issues a network request of any kind.
 *
 * Two layers, same split as everywhere else in this codebase:
 *  - the controller owns simulation and the smoothed facing angle;
 *  - this file owns nothing but what you see — clip weights, playback phase, materials.
 * Nothing here can feed back into the physics.
 *
 * Animation is a single blend tree rather than a state machine with transitions:
 *
 *   base (weights normalised to 1)      idle · walk · run · air · mantle
 *   additive layer                      sneak_pose, weighted by crouch (and a landing dip)
 *
 * `walk` and `run` share one stride phase and are driven by `time`, not by `timeScale`, so
 * they stay foot-locked to each other through the crossfade and to the ground underneath:
 * the phase advances by distance travelled, not by wall-clock.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import xbotUrl from '../assets/Xbot.glb?url';

export interface AvatarTunables {
  /** Height from sole to crown, metres — matched to the collider's standing height. */
  height: number;
  /** Exponential rate (1/s) at which clip weights cross-fade. */
  blendRate: number;
  /** Ground speed the `walk` clip natively depicts, m/s. */
  walkClipSpeed: number;
  /** Ground speed the `run` clip natively depicts, m/s. */
  runClipSpeed: number;
  /** Idle has faded out completely by this speed, m/s. */
  idleFadeSpeed: number;
  /** Locomotion is pure `run` at and above this speed, m/s. */
  runBlendSpeed: number;
  /** Playback rate bounds relative to a clip's native rate — the anti-moonwalk clamp. */
  minTimeScale: number;
  maxTimeScale: number;
  /** Forward lean while climbing, degrees. */
  mantleLeanDeg: number;
  /** Lean per m/s of vertical speed while airborne, degrees (negative = lean back rising). */
  airLeanDegPerMps: number;
  /** Exponential rate (1/s) at which the lean follows its target. */
  leanRate: number;
}

export function defaultAvatarTunables(): AvatarTunables {
  return {
    height: 1.7,
    blendRate: 14,
    walkClipSpeed: 1.55,
    runClipSpeed: 3.4,
    idleFadeSpeed: 0.9,
    runBlendSpeed: 3.2,
    minTimeScale: 0.6,
    maxTimeScale: 1.9,
    mantleLeanDeg: 30,
    airLeanDegPerMps: 1.6,
    leanRate: 18,
  };
}

/** Everything the body needs to know about the sim, sampled at render time. */
export interface AvatarPose {
  x: number;
  y: number;
  z: number;
  /** Body heading, same convention as the camera yaw (0 faces -Z). */
  facingYaw: number;
  /** Horizontal speed, m/s. */
  speed: number;
  verticalSpeed: number;
  grounded: boolean;
  crouched: boolean;
  mantling: boolean;
  /** 0..1 knee-dip impulse, taken from the controller's landing dip. */
  landDip: number;
  visible: boolean;
}

export type AnimState = 'idle' | 'walk' | 'run' | 'air' | 'mantle';

/** Bind-pose height of the source model, sole to crown, metres (mixamorig:HeadTop_End). */
const MODEL_HEIGHT = 1.7746;
/** Mixamo rigs face +Z; the game's yaw 0 faces -Z. */
const MODEL_YAW_OFFSET = Math.PI;
/** Normalised point in the run cycle held while airborne — legs split, arms up. */
const AIR_POSE_PHASE = 0.12;
/** Normalised point in the walk cycle held while climbing — one knee high. */
const MANTLE_POSE_PHASE = 0.3;
/** Additive sneak weight at full crouch. */
const CROUCH_POSE_WEIGHT = 1;
/** Additive sneak weight at the bottom of the deepest landing dip (the knee-dip). */
const LAND_POSE_WEIGHT = 0.55;
/** Additive sneak weight while climbing — folds the torso over the ledge. */
const MANTLE_POSE_WEIGHT = 0.75;

const DEG2RAD = Math.PI / 180;

const BASE_STATES: readonly AnimState[] = ['idle', 'walk', 'run', 'air', 'mantle'];

function smoothFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Decodes a base64 `data:` URI without touching the network stack. */
function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('malformed data: URI');
  const binary = atob(uri.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function fetchModelBytes(url: string): Promise<ArrayBuffer> {
  // Inlined (the normal build) — decode in place. A dev server hands back a real URL instead.
  if (url.startsWith('data:')) return decodeDataUri(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Xbot.glb: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export class PlayerAvatar {
  /** Scene-space root; the scene adds this and nothing else. */
  readonly root = new THREE.Group();
  /** Child that carries the lean, so the root keeps a clean position/heading. */
  private readonly lean = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<AnimState, THREE.AnimationAction>();
  private readonly weights = new Map<AnimState, number>();
  private poseAction: THREE.AnimationAction | null = null;
  private walkDuration = 1;
  private runDuration = 1;

  /** Normalised stride phase shared by walk and run; 1 cycle = 2 footfalls. */
  private stridePhase = 0;
  private leanAngle = 0;
  private poseWeight = 0;
  private lastTime = 0;

  private disposables: Array<{ dispose(): void }> = [];
  private loadError: string | null = null;

  constructor(private readonly tunables: AvatarTunables) {
    this.root.add(this.lean);
    this.root.visible = false;
    for (const s of BASE_STATES) this.weights.set(s, s === 'idle' ? 1 : 0);
  }

  get ready(): boolean {
    return this.mixer !== null;
  }

  get error(): string | null {
    return this.loadError;
  }

  /** The base state currently carrying the most weight — the HUD/tooling readout. */
  get animState(): AnimState {
    let best: AnimState = 'idle';
    let bestWeight = -1;
    for (const s of BASE_STATES) {
      const w = this.weights.get(s) ?? 0;
      if (w > bestWeight) {
        bestWeight = w;
        best = s;
      }
    }
    return best;
  }

  /** Clip time of the dominant base action, seconds — proof the mixer is actually running. */
  get animTime(): number {
    return this.actions.get(this.animState)?.time ?? 0;
  }

  get animWeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of BASE_STATES) out[s] = Number((this.weights.get(s) ?? 0).toFixed(3));
    return out;
  }

  async load(): Promise<void> {
    try {
      const bytes = await fetchModelBytes(xbotUrl);
      const gltf = await new Promise<{
        scene: THREE.Group;
        animations: THREE.AnimationClip[];
      }>((resolve, reject) => {
        new GLTFLoader().parse(bytes, '', (result) => resolve(result), reject);
      });
      this.build(gltf.scene, gltf.animations);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private build(model: THREE.Group, clips: THREE.AnimationClip[]): void {
    this.dressMaterials(model);
    const scale = this.tunables.height / MODEL_HEIGHT;
    model.scale.setScalar(scale);
    this.lean.add(model);

    const mixer = new THREE.AnimationMixer(model);
    this.mixer = mixer;

    const byName = new Map(clips.map((c) => [c.name, c]));
    const idle = byName.get('idle');
    const walk = byName.get('walk');
    const run = byName.get('run');
    const sneak = byName.get('sneak_pose');
    if (!idle || !walk || !run) throw new Error('Xbot.glb is missing a locomotion clip');
    this.walkDuration = walk.duration;
    this.runDuration = run.duration;

    // Looping locomotion. walk/run are position-driven (see the file header), so their own
    // timeScale is switched off and `time` is written every frame instead.
    this.actions.set('idle', this.makeAction(mixer, idle, { timeScale: 1 }));
    this.actions.set('walk', this.makeAction(mixer, walk, { timeScale: 0 }));
    this.actions.set('run', this.makeAction(mixer, run, { timeScale: 0 }));

    // Held poses. Cloned first: an AnimationMixer hands out one action per (clip, root), so a
    // second frozen action of the same clip has to be a second clip.
    const airClip = run.clone();
    airClip.name = 'air_pose';
    const air = this.makeAction(mixer, airClip, { timeScale: 0 });
    air.time = AIR_POSE_PHASE * airClip.duration;
    this.actions.set('air', air);

    const mantleClip = walk.clone();
    mantleClip.name = 'mantle_pose';
    const mantle = this.makeAction(mixer, mantleClip, { timeScale: 0 });
    mantle.time = MANTLE_POSE_PHASE * mantleClip.duration;
    this.actions.set('mantle', mantle);

    // Crouch rides on top as an additive delta, so the legs keep walking underneath it.
    if (sneak) {
      const poseClip = sneak.clone();
      poseClip.name = 'sneak_additive';
      THREE.AnimationUtils.makeClipAdditive(poseClip);
      const pose = mixer.clipAction(poseClip);
      pose.blendMode = THREE.AdditiveAnimationBlendMode;
      pose.loop = THREE.LoopRepeat;
      pose.enabled = true;
      pose.timeScale = 0;
      pose.setEffectiveWeight(0);
      pose.play();
      pose.time = poseClip.duration;
      this.poseAction = pose;
    }

    this.applyWeights();
  }

  private makeAction(
    mixer: THREE.AnimationMixer,
    clip: THREE.AnimationClip,
    opts: { timeScale: number },
  ): THREE.AnimationAction {
    const action = mixer.clipAction(clip);
    action.loop = THREE.LoopRepeat;
    action.clampWhenFinished = false;
    action.enabled = true;
    action.timeScale = opts.timeScale;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  }

  /**
   * Vision §13: sleek and cold. The source mannequin ships in a warm terracotta that reads as
   * a toy, so both of its materials are replaced outright — brushed gunmetal shell, darker
   * joints carrying a low cyan emissive so the rig still registers against a dark floor.
   *
   * Metalness stays low on purpose: there is no environment map in the lab, and a physically
   * metal surface with nothing to reflect renders as a black silhouette.
   */
  private dressMaterials(model: THREE.Object3D): void {
    const shell = new THREE.MeshStandardMaterial({
      color: 0x616d78,
      roughness: 0.5,
      metalness: 0.18,
      emissive: 0x0a2b35,
      emissiveIntensity: 0.5,
    });
    const joints = new THREE.MeshStandardMaterial({
      color: 0x232c33,
      roughness: 0.38,
      metalness: 0.25,
      emissive: 0x146579,
      emissiveIntensity: 0.9,
    });
    this.disposables.push(shell, joints);

    const pick = (mat: THREE.Material): THREE.Material =>
      mat.name.includes('Joints') ? joints : shell;

    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material;
      mesh.material = Array.isArray(source) ? source.map(pick) : pick(source);
      for (const mat of Array.isArray(source) ? source : [source]) mat.dispose();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Skinned bounds are computed in bind space and do not follow the animation, so the
      // usual sphere test would pop the body out of view at the screen edge.
      mesh.frustumCulled = false;
    });
  }

  /**
   * Per rendered frame. Timed off the wall clock rather than the sim tick on purpose: the
   * mixer belongs to the render layer, and the scene's `render(alpha)` hook has no dt to give.
   */
  update(pose: AvatarPose): void {
    const now = performance.now() / 1000;
    let dt = this.lastTime === 0 ? 1 / 60 : now - this.lastTime;
    this.lastTime = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;

    this.root.visible = pose.visible && this.mixer !== null;
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.facingYaw + MODEL_YAW_OFFSET;

    const mixer = this.mixer;
    if (mixer === null) return;

    this.advancePhase(pose, dt);
    this.updateTargets(pose, dt);
    this.applyWeights();
    this.updateLean(pose, dt);
    mixer.update(dt);
  }

  /**
   * 0 = pure `walk`, 1 = pure `run`. The crossover sits where the run clip's own pace does,
   * not where the game calls the gait "walking" — 3.5 m/s is a jog by any animation's measure.
   */
  private locomotionMix(speed: number): number {
    const t = this.tunables;
    return clamp01((speed - t.walkClipSpeed) / Math.max(0.01, t.runBlendSpeed - t.walkClipSpeed));
  }

  /** Stride phase advances with distance covered, clamped to a believable playback rate. */
  private advancePhase(pose: AvatarPose, dt: number): void {
    const t = this.tunables;
    const mix = this.locomotionMix(pose.speed);
    const strideLength =
      t.walkClipSpeed * this.walkDuration +
      (t.runClipSpeed * this.runDuration - t.walkClipSpeed * this.walkDuration) * mix;
    const nativeRate = 1 / this.walkDuration + (1 / this.runDuration - 1 / this.walkDuration) * mix;

    let cycles = pose.speed / Math.max(0.05, strideLength);
    cycles = clamp(cycles, nativeRate * t.minTimeScale, nativeRate * t.maxTimeScale);
    if (!pose.grounded || pose.mantling || pose.speed < 0.05) cycles = 0;

    this.stridePhase = (this.stridePhase + cycles * dt) % 1;
    const walk = this.actions.get('walk');
    const run = this.actions.get('run');
    if (walk) walk.time = this.stridePhase * this.walkDuration;
    if (run) run.time = this.stridePhase * this.runDuration;
  }

  private updateTargets(pose: AvatarPose, dt: number): void {
    const t = this.tunables;
    let idle = 0;
    let walk = 0;
    let run = 0;
    let air = 0;
    let mantle = 0;

    if (pose.mantling) {
      mantle = 1;
    } else if (!pose.grounded) {
      air = 1;
    } else {
      idle = 1 - clamp01(pose.speed / Math.max(0.05, t.idleFadeSpeed));
      const loco = 1 - idle;
      const mix = this.locomotionMix(pose.speed);
      walk = loco * (1 - mix);
      run = loco * mix;
    }

    const targets: Record<AnimState, number> = { idle, walk, run, air, mantle };
    // Leaving the ground and grabbing a ledge are discrete events, and a vault is over in a
    // quarter of a second — those two snap in at twice the locomotion cross-fade rate or the
    // pose never arrives before the move ends.
    const k = smoothFactor(air + mantle > 0.5 ? t.blendRate * 2 : t.blendRate, dt);
    for (const s of BASE_STATES) {
      const current = this.weights.get(s) ?? 0;
      this.weights.set(s, current + (targets[s] - current) * k);
    }
  }

  private applyWeights(): void {
    let sum = 0;
    for (const s of BASE_STATES) sum += this.weights.get(s) ?? 0;
    // Below 1 the mixer would blend the shortfall toward the bind pose (a creeping T-pose),
    // so the base layer is always renormalised to exactly 1.
    const norm = sum > 1e-4 ? 1 / sum : 0;
    for (const s of BASE_STATES) {
      const action = this.actions.get(s);
      if (action) action.setEffectiveWeight((this.weights.get(s) ?? 0) * norm);
    }
  }

  private updateLean(pose: AvatarPose, dt: number): void {
    const t = this.tunables;
    let target = 0;
    if (pose.mantling) target = t.mantleLeanDeg * DEG2RAD;
    else if (!pose.grounded) target = -pose.verticalSpeed * t.airLeanDegPerMps * DEG2RAD;
    target = clamp(target, -0.6, 0.9);
    this.leanAngle += (target - this.leanAngle) * smoothFactor(t.leanRate, dt);
    this.lean.rotation.x = this.leanAngle;

    if (this.poseAction === null) return;
    // One additive channel, three jobs: the crouch it was made for, a knee dip on landing, and
    // the tucked torso of a climb. They never overlap, so the strongest simply wins.
    const crouch = pose.crouched ? CROUCH_POSE_WEIGHT : 0;
    const dip = clamp01(pose.landDip) * LAND_POSE_WEIGHT;
    const climb = pose.mantling ? MANTLE_POSE_WEIGHT : 0;
    const poseTarget = Math.max(crouch, dip, climb);
    this.poseWeight += (poseTarget - this.poseWeight) * smoothFactor(t.blendRate, dt);
    this.poseAction.setEffectiveWeight(this.poseWeight);
  }

  /** Re-applies the height tunable after a live edit in the GUI. */
  refreshScale(): void {
    const model = this.lean.children[0];
    if (model) model.scale.setScalar(this.tunables.height / MODEL_HEIGHT);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.poseAction = null;
    this.root.traverse((obj) => {
      const mesh = obj as Partial<THREE.Mesh>;
      mesh.geometry?.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.root.clear();
    this.root.removeFromParent();
  }
}
