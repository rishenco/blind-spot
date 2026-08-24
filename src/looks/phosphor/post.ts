/**
 * PHOSPHOR — the post chain: persistence, glass grain, line pattern (doc/looks/phosphor.md).
 *
 * THE SCHOOL SIGNATURE IS THIS FILE. Everything else in the look is a phosphor-coloured point
 * cloud; what makes it a scope is that the glass keeps glowing after the beam has moved on. Three
 * passes, in the brief's order and no others:
 *
 *   1. the scene, into an offscreen buffer;
 *   2. accumulation — `max(scene, previous × decay)` — into a ping-ponged buffer;
 *   3. output to the canvas, with a static chroma-free grain and a static 1-px line pattern.
 *
 * NO BLOOM ANYWHERE (the brief, and vision §12): the micro-glow is baked into each grain's sprite,
 * which is what keeps a bright frame from fusing into porridge. There is also no rolling scanline,
 * no chromatic aberration, no vignette and no curvature — this is a phosphor, not a CRT.
 *
 * WHY PEAK-HOLD AND NOT ADDITIVE. A phosphor is struck to a brightness and then decays from it; it
 * does not sum. `max(scene, prev × decay)` is that, and it has a property additive accumulation
 * does not: it is BOUNDED by the brightest thing on screen. A static bright wall accumulated
 * additively at mix 0.9 settles at ten times its own brightness — a white sheet where the wall was,
 * and exactly the porridge visual-brief §2 forbids. This composite cannot do that.
 *
 * WHY THE DECAY IS DERIVED FROM `dt`. The brief quotes the mix per frame at 60 Hz. Used as a
 * literal per-frame constant it would decay 2.4× faster in wall time at 144 Hz — the one thing this
 * look is about would depend on the monitor. `params.accumMix(dt)` converts it once into a time
 * constant and back, so the trail is the same length in SECONDS everywhere.
 *
 * THE VOID STAYS BLACK. Both output textures are multiplied, never added: unknown space is nothing,
 * not a very dark something (vision §1 law 3). Grain over black is black.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
} from 'three';
import type { Camera, WebGLRenderer } from 'three';
import { GRAIN_AMT, SCANLINE_AMT, accumMix } from './params.js';

/** Clip-space triangle that covers the frame; `position.xy` IS the clip position. */
const fullscreenTriangle = (): BufferGeometry => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
};

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const ACCUM_FRAG = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uPrev;
uniform float uDecay;
varying vec2 vUv;

void main() {
  vec3 s = texture2D(uScene, vUv).rgb;
  vec3 p = texture2D(uPrev, vUv).rgb * uDecay;
  // Peak-hold: struck to a brightness, decaying from it. Never summed — see the header.
  gl_FragColor = vec4(max(s, p), 1.0);
}
`;

const OUT_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform float uGrain;
uniform float uScan;
uniform float uDpr;
varying vec2 vUv;

// Static, per-pixel, and deterministic: the grain is the glass, so it does not move. An animated
// grain is a full-screen flicker, which vision §12's comfort floor rules out and which stream
// compression would spend its entire bitrate on.
float glass(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 c = texture2D(uSrc, vUv).rgb;

  // Chroma-free and MULTIPLICATIVE, so the void stays exactly #000000.
  c *= 1.0 - uGrain * glass(gl_FragCoord.xy);

  // One CSS pixel of line, unmoving. Measured in CSS px so the pattern is the same weight on a
  // retina panel as on a 1× one, instead of vanishing into the device grid.
  float line = mod(floor(gl_FragCoord.y / max(1.0, uDpr)), 2.0);
  c *= 1.0 - uScan * line;

  gl_FragColor = vec4(c, 1.0);
}
`;

const makeTarget = (w: number, h: number, depth: boolean): WebGLRenderTarget =>
  new WebGLRenderTarget(w, h, {
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });

/**
 * The persistence chain. Owns three render targets, two materials and one triangle, and disposes
 * exactly those — the renderer is shared and must be handed back with its state untouched
 * (looks/types.ts).
 */
export class PhosphorPost {
  private readonly renderer: WebGLRenderer;
  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadGeom = fullscreenTriangle();
  private readonly accumMat: ShaderMaterial;
  private readonly outMat: ShaderMaterial;
  private readonly quad: Mesh;

  private sceneRT: WebGLRenderTarget;
  private accumA: WebGLRenderTarget;
  private accumB: WebGLRenderTarget;
  /** True when accumA holds the most recent composite. */
  private aIsCurrent = true;
  private pixW = 1;
  private pixH = 1;
  /** Cleared on the next composite: a freshly sized buffer holds nothing, not old light. */
  private needsClear = true;

  constructor(renderer: WebGLRenderer, w: number, h: number) {
    this.renderer = renderer;
    const dpr = renderer.getPixelRatio();
    this.pixW = Math.max(1, Math.round(w * dpr));
    this.pixH = Math.max(1, Math.round(h * dpr));

    this.sceneRT = makeTarget(this.pixW, this.pixH, true);
    this.accumA = makeTarget(this.pixW, this.pixH, false);
    this.accumB = makeTarget(this.pixW, this.pixH, false);

    this.accumMat = new ShaderMaterial({
      uniforms: {
        uScene: { value: null },
        uPrev: { value: null },
        uDecay: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: ACCUM_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.outMat = new ShaderMaterial({
      uniforms: {
        uSrc: { value: null },
        uGrain: { value: GRAIN_AMT },
        uScan: { value: SCANLINE_AMT },
        uDpr: { value: dpr },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: OUT_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new Mesh(this.quadGeom, this.accumMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Draw one frame: scene → offscreen, composite with the previous composite, present.
   *
   * `dt` is real elapsed seconds. It is clamped because a tab that was in the background for a
   * minute would otherwise hand this a `dt` that wipes the whole afterglow in one step — the trail
   * would blink out on the first frame after every alt-tab.
   */
  render(scene: Scene, camera: Camera, dt: number): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;

    const read = this.aIsCurrent ? this.accumA : this.accumB;
    const write = this.aIsCurrent ? this.accumB : this.accumA;

    r.autoClear = true;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    if (this.needsClear) {
      // A render target is allocated with undefined contents; the first composite must not read it.
      this.needsClear = false;
      r.setRenderTarget(read);
      r.clear();
    }

    this.accumMat.uniforms.uScene!.value = this.sceneRT.texture;
    this.accumMat.uniforms.uPrev!.value = read.texture;
    this.accumMat.uniforms.uDecay!.value = accumMix(Math.min(0.1, Math.max(0, dt)));
    this.quad.material = this.accumMat;
    r.setRenderTarget(write);
    r.clear();
    r.render(this.quadScene, this.quadCam);

    this.outMat.uniforms.uSrc!.value = write.texture;
    this.quad.material = this.outMat;
    r.setRenderTarget(null);
    r.clear();
    r.render(this.quadScene, this.quadCam);

    this.aIsCurrent = !this.aIsCurrent;

    // Hand the shared renderer back exactly as it was found (looks/types.ts).
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  setSize(w: number, h: number): void {
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    this.outMat.uniforms.uDpr!.value = dpr;
    if (pw === this.pixW && ph === this.pixH) return;
    this.pixW = pw;
    this.pixH = ph;
    this.sceneRT.setSize(pw, ph);
    this.accumA.setSize(pw, ph);
    this.accumB.setSize(pw, ph);
    this.needsClear = true;
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.accumA.dispose();
    this.accumB.dispose();
    this.accumMat.dispose();
    this.outMat.dispose();
    this.quadGeom.dispose();
    this.quadScene.clear();
  }
}
