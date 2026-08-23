/**
 * Lab harness: a tiny registry of self-contained experiment scenes plus the host that
 * swaps between them. Adding a scene later means one `registerScene` call and nothing else.
 */

import * as THREE from 'three';
import type GUI from 'lil-gui';
import type { Input } from '../core/input';
import type { Hud } from '../ui/hud';

export interface SceneCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  input: Input;
  gui: GUI;
  hud: Hud;
}

export interface LabScene {
  id: string;
  title: string;
  /** Display names of the scene's variants; switched with number keys 1..9. */
  variants?: string[];
  init(ctx: SceneCtx): void;
  /** Fixed-step simulation tick. */
  update(dt: number): void;
  /** Optional per-frame hook; `alpha` is the fraction into the next sim step. */
  render?(alpha: number): void;
  setVariant?(index: number): void;
  /** Optional structured state for the screenshot driver and other tooling. */
  debugState?(): Record<string, unknown>;
  dispose(): void;
}

export interface SceneEntry {
  id: string;
  title: string;
  create: () => LabScene;
}

const registry = new Map<string, SceneEntry>();

export function registerScene(entry: SceneEntry): void {
  if (registry.has(entry.id)) throw new Error(`Duplicate lab scene id: ${entry.id}`);
  registry.set(entry.id, entry);
}

export function listScenes(): SceneEntry[] {
  return [...registry.values()];
}

export function hasScene(id: string): boolean {
  return registry.has(id);
}

/** Releases GPU resources owned by a subtree (the harness makes no ownership assumptions). */
export function disposeObject3D(root: THREE.Object3D): void {
  const seenMaterials = new Set<THREE.Material>();
  root.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
      if (seenMaterials.has(mat)) continue;
      seenMaterials.add(mat);
      for (const value of Object.values(mat)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      mat.dispose();
    }
  });
}

/**
 * Owns the active scene: builds a fresh THREE.Scene and GUI root per activation so scenes
 * cannot leak state into each other.
 */
export class SceneHost {
  private active: LabScene | null = null;
  private activeEntry: SceneEntry | null = null;
  private threeScene = new THREE.Scene();
  private sceneGui: GUI | null = null;
  private variantIndex = 0;

  constructor(
    private readonly deps: {
      camera: THREE.PerspectiveCamera;
      renderer: THREE.WebGLRenderer;
      input: Input;
      hud: Hud;
      gui: GUI;
    },
  ) {}

  get scene(): THREE.Scene {
    return this.threeScene;
  }

  get current(): LabScene | null {
    return this.active;
  }

  get currentId(): string | null {
    return this.activeEntry?.id ?? null;
  }

  get currentVariantName(): string | null {
    const variants = this.active?.variants;
    if (!variants || variants.length === 0) return null;
    return variants[this.variantIndex] ?? null;
  }

  get currentVariantIndex(): number {
    return this.variantIndex;
  }

  activate(id: string): void {
    const entry = registry.get(id);
    if (entry === undefined) throw new Error(`Unknown lab scene: ${id}`);
    this.disposeActive();

    this.threeScene = new THREE.Scene();
    this.sceneGui = this.deps.gui.addFolder(entry.title);

    const scene = entry.create();
    this.active = scene;
    this.activeEntry = entry;
    this.variantIndex = 0;
    scene.init({
      scene: this.threeScene,
      camera: this.deps.camera,
      renderer: this.deps.renderer,
      input: this.deps.input,
      gui: this.sceneGui,
      hud: this.deps.hud,
    });
  }

  setVariant(index: number): void {
    const scene = this.active;
    if (!scene?.variants || !scene.setVariant) return;
    if (index < 0 || index >= scene.variants.length) return;
    this.variantIndex = index;
    scene.setVariant(index);
  }

  update(dt: number): void {
    this.active?.update(dt);
  }

  render(alpha: number): void {
    this.active?.render?.(alpha);
  }

  private disposeActive(): void {
    this.active?.dispose();
    this.active = null;
    this.activeEntry = null;
    disposeObject3D(this.threeScene);
    this.threeScene.clear();
    this.sceneGui?.destroy();
    this.sceneGui = null;
  }

  dispose(): void {
    this.disposeActive();
  }
}
