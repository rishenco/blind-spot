/**
 * Selective bloom for the reveal.
 *
 * Contours are thin bright lines on black, which is exactly what a mild bloom flatters: the ink
 * gains a halo and the lattice stays quiet. It is also what gives a fresh return somewhere to go
 * above 1.0 — a bare additive line has no way to look brighter than full white — so the
 * difference between "this just came back" and "I remember this" stops depending on hue alone.
 *
 * Two rules govern the implementation:
 *
 *  - **Off must cost exactly zero.** The composer is built lazily on first use and the game
 *    simply does not call this at all while bloom is off, so the frame goes straight through
 *    `renderer.render` on the path it always took.
 *
 *  - **On must not re-grade the picture.** The reveal shaders write their colours straight to
 *    the framebuffer (they carry no tone-mapping or colour-space chunk), so the chain here is
 *    render → bloom → screen with no `OutputPass`: adding one would apply the renderer's tone
 *    map and an sRGB encode to values that are already display-referred, and the whole look
 *    would quietly change the moment bloom was switched on.
 *
 * Software GL (headless SwiftShader) is detected and reported. Five mip levels of separable
 * gaussian at full resolution is a lot of fill for a CPU rasteriser, so the pass runs at a
 * reduced internal resolution there and the caller is free to leave it off by default.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface BloomTunables {
  /** How much of the blurred image is added back. The reference sits at 0.42-0.46. */
  strength: number;
  /** How far the glow spreads. */
  radius: number;
  /** Luminance a pixel needs before it blooms at all. */
  threshold: number;
}

export function defaultBloomTunables(): BloomTunables {
  return { strength: 0.44, radius: 0.26, threshold: 0.3 };
}

/**
 * True when WebGL is being rasterised on the CPU. Chromium reports SwiftShader/ANGLE through
 * the unmasked renderer string; Mesa's software paths announce themselves as llvmpipe or
 * softpipe. Anything unrecognised is assumed to be real hardware.
 */
export function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const names: string[] = [];
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info !== null) {
      names.push(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL ?? 0x9246)));
      names.push(String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL ?? 0x9245)));
    }
  } catch {
    // getExtension can throw in hardened contexts; the RENDERER string below still works.
  }
  names.push(String(gl.getParameter(gl.RENDERER)));
  return names.some((n) => /swiftshader|llvmpipe|softpipe|software/i.test(n));
}

export class BloomChain {
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private readonly size = new THREE.Vector2();
  private readonly resolution = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly tunables: BloomTunables,
    /** Fraction of the drawing buffer the blur pyramid runs at. */
    private readonly scale: number,
  ) {}

  /** Renders `scene` through the bloom chain. Builds the chain on first call. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.getDrawingBufferSize(this.size);
    if (this.composer === null) this.build(scene, camera);
    const composer = this.composer!;
    this.renderPass!.scene = scene;
    this.renderPass!.camera = camera;
    const bloom = this.bloom!;
    bloom.strength = this.tunables.strength;
    bloom.radius = this.tunables.radius;
    bloom.threshold = this.tunables.threshold;
    if (Math.abs(this.resolution.x - this.size.x) > 0.5 || Math.abs(this.resolution.y - this.size.y) > 0.5) {
      this.resolution.copy(this.size);
      composer.setSize(this.size.x, this.size.y);
      bloom.setSize(this.size.x * this.scale, this.size.y * this.scale);
    }
    composer.render();
  }

  private build(scene: THREE.Scene, camera: THREE.Camera): void {
    const target = new THREE.WebGLRenderTarget(
      Math.max(1, this.size.x),
      Math.max(1, this.size.y),
      {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
      },
    );
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(1);
    this.renderPass = new RenderPass(scene, camera);
    composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.size.x * this.scale, this.size.y * this.scale),
      this.tunables.strength,
      this.tunables.radius,
      this.tunables.threshold,
    );
    composer.addPass(this.bloom);
    // The bloom pass is last, so it is the one that writes to the canvas. No OutputPass: see
    // the header — our shaders are already display-referred.
    this.bloom.renderToScreen = true;
    this.resolution.copy(this.size);
    composer.setSize(this.size.x, this.size.y);
    this.composer = composer;
  }

  dispose(): void {
    this.composer?.dispose();
    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
  }
}
