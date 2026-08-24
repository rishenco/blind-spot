/**
 * SIGNAL — shader chunks shared by the matter layer and the event layer.
 *
 * Kept in one place so the two layers cannot disagree about the shape of a square, the phase of
 * the frame dither, or where the hard window is. Every chunk here is pure GLSL text; nothing in
 * this file knows about three.js.
 *
 * NOTE ON DIALECT: three compiles every non-raw ShaderMaterial as `#version 300 es` with GLSL1
 * compatibility shims (`#define attribute in`, `#define varying out`, `gl_FragColor`), so these
 * chunks are written in the familiar GLSL1 spelling and may still use ES 3.00 built-ins such as
 * `gl_VertexID`. That is what lets the hold dash be measured in real screen pixels without
 * writing a single byte into the SHARED edge geometry (engine-plan §9).
 */

/** `paintTime` sentinel test. UNPAINTED is -1e9; anything below -1e8 has never been lit. */
export const NEVER_PAINTED = -1.0e8;

/** Clip-space nowhere: one rasteriser reject, no fragment stage, no discard. */
export const CULL_POINT = /* glsl */ `
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
`;

export const CULL_LINE = /* glsl */ `
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
`;

/**
 * Interleaved gradient noise — a texture-free, screen-static, blue-noise-like value in [0,1).
 *
 * Static in SCREEN space on purpose: a dither that moves is a shimmer, and signal.md forbids any
 * glitch at rest. No texture means nothing to allocate, upload or dispose.
 */
export const IGN = /* glsl */ `
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
`;

/**
 * Signed distance to an axis-aligned rounded square of half-extent `h` with corner radius `r`.
 * `r` is what keeps a square sample from alias-crawling when you strafe (signal.md "Don'ts").
 */
export const ROUND_BOX = /* glsl */ `
float roundBox(vec2 p, float h, float r) {
  vec2 d = abs(p) - vec2(h - r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
`;

/**
 * The matter ramp (signal.md "Palette" + "Edges & aging"), as a function of age in seconds.
 *
 * Four bands, and only the third is quantized: hot -> mid steps in `uPosterize` visible levels
 * ("data losing precision"), everything after it is continuous. The rim's white is added by the
 * caller, not here — the rim is a separate read that sits ON TOP of whatever the ramp says.
 */
export const MATTER_RAMP = /* glsl */ `
uniform vec3  uFlash;
uniform vec3  uHot;
uniform vec3  uMid;
uniform vec3  uCool;
uniform vec3  uSkel;
uniform float uAgeFlash;
uniform float uAgeHot;
uniform float uAgeMid;
uniform float uAgeCool;
uniform float uAgeSkeleton;
uniform float uPosterize;

vec3 matterRamp(float age) {
  if (age < uAgeFlash) return mix(uFlash, uHot, clamp(age / max(1.0e-4, uAgeFlash), 0.0, 1.0));
  if (age < uAgeMid) {
    float t = clamp((age - uAgeHot) / max(1.0e-4, uAgeMid - uAgeHot), 0.0, 1.0);
    float q = min(1.0, floor(t * uPosterize) / max(1.0, uPosterize - 1.0));
    return mix(uHot, uMid, q);
  }
  if (age < uAgeCool) {
    return mix(uMid, uCool, clamp((age - uAgeMid) / max(1.0e-4, uAgeCool - uAgeMid), 0.0, 1.0));
  }
  return mix(uCool, uSkel, clamp((age - uAgeCool) / max(1.0e-4, uAgeSkeleton - uAgeCool), 0.0, 1.0));
}
`;

/**
 * The contact shell (vision §3.1) — measured from the BODY segment, not the eye, or it is
 * invisible: standing still, the nearest floor the camera can see is 2.2 m from the eye and only
 * 1.6 m from the capsule.
 */
export const BODY_SHELL = /* glsl */ `
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;

float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}
`;

/** 2D value hash, for the stains' interior interference texture. */
export const HASH22 = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;
