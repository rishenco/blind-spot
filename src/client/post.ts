// Post chain. Additive point clouds clip to flat white the instant geometry gets close;
// rendering to a half-float buffer and tone-mapping on the way out keeps dense returns
// readable, and a restrained bloom gives the points the glow that sells "these are
// luminous measurements floating in a void" rather than "white dots".

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Final grade: ACES-ish tone map, subtle vignette, and a touch of scan-line grain. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1.12 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure, uVignette, uGrain, uTime;
    varying vec2 vUv;

    vec3 aces(vec3 x) {
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
      c = aces(c);
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * dot(d, d) * 1.9;
      // Sensor grain: sells the "this is a machine reconstruction" read and hides banding.
      c += (hash(vUv * 1024.0 + fract(uTime)) - 0.5) * uGrain;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export class Post {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: 0,
    }));
    this.composer.addPass(new RenderPass(scene, camera));
    // Half-resolution bloom: at this blur radius the difference is invisible and it
    // roughly quarters the cost of the most expensive pass in the chain.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x * 0.5, size.y * 0.5), 0.46, 0.34, 0.58);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.bloom.setSize(w * 0.5, h * 0.5);
  }

  render(now: number) {
    (this.grade.uniforms as any).uTime.value = now;
    this.composer.render();
  }
}
