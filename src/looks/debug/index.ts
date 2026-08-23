/**
 * THE DEBUG LOOK (engine-plan §9 "Debug look (engine milestone)").
 *
 * "flat white-ish dots (age → gray), plain cyan lines, red dog cloud, plain circle halo +
 * printed audibleRadius/energy, no post."
 *
 * This is the engine's own read of its data, not an art direction. Its job is to make every
 * failure legible: if a dot is in the wrong place it is a white dot in the wrong place, with no
 * bloom, no hue ramp and no depth trick to hide behind. The three authored looks (phosphor,
 * blueprint, signal) will be judged against what this one shows, so it stays deliberately ugly
 * and deliberately literal.
 *
 * WHAT IS STILL LAW HERE, because these are vision laws and not styling (vision §3, §12):
 *
 *   - Absence is black. Nothing is drawn that sound has not reached, except the 2 m contact
 *     shell of vision §3.1. No ambient light, no fog, no outlines, no grid.
 *   - Age is a color. Fresh reads white, old cools to gray, and a painted surfel NEVER falls
 *     below the SKELETON_ALPHA floor: you lose the fine read, never the map (vision §3.6).
 *   - The wavefront is real. A surfel whose `paintTime` is still in the future is not drawn, so
 *     a detonation's paint arrives outward over d/waveSpeed seconds rather than all at once.
 *   - Hard window: 45 m radius and ±1 floor, as a cut and not a fade (vision §3.6, §12).
 *   - Distance discipline: dots thin and dim past ~20 m so the far read biases to edges —
 *     "distance reads as a drawing, nearby as a cloud" (vision §12).
 *   - Dots are matter, lines are holds (vision §5). One encoding, everywhere, forever.
 *   - Colorblind-safe by construction: the dot/line distinction is SHAPE, and the hold accent is
 *     brightness + a doubled stroke, never hue alone (vision §12).
 *
 * The thinning is done with the surfel's own stable `dither`, never with a random draw, so the
 * same dots survive from frame to frame: a cloud that reshuffles every frame is unreadable at
 * parkour speed and unsurvivable through stream compression (vision §12 "temporally stable").
 *
 * Shared-geometry discipline (engine-plan §9): this look creates materials, a scene and HUD
 * nodes, and disposes exactly those. The two BufferGeometries belong to the SurfelField and hold
 * the paint — which is what lets you flip looks mid-run and compare the same painted world.
 */

import { LineSegments, Points, Scene, ShaderMaterial } from 'three';
import type { Look, LookContext } from '../types.js';

/**
 * Reference loudness for the halo ring's brightness, in metres. Vision §3.8 fixes the MEANING
 * ("brightness equals your current audible radius"); the metres-to-brightness mapping is a
 * display choice and therefore lives in the look. 30 m is the loudest thing the player can
 * routinely be: an E-ping's far end.
 */
const HALO_FULL_M = 30;

/** `paintTime` sentinel test. UNPAINTED is −1e9; anything below −1e8 has never been lit. */
const NEVER_PAINTED = -1.0e8;

/** View-space nudge toward the camera for line vertices, metres — beats surfel z-fighting. */
const LINE_LIFT = 0.02;

/**
 * Upper bound on a splat, in device pixels.
 *
 * Vision §12 sizes a splat to its voxel footprint and puts no ceiling on it, and none is needed
 * for cost: footprint splatting is self-balancing, since a surfel that doubles in size halves the
 * number of its neighbours you can see. The ceiling exists for one artifact only — WebGL culls a
 * point whose CENTRE leaves the viewport, so a very large splat pops out at the frame edge while
 * half of it is still on screen. 64 px binds only inside ~1.7 m of a surface (0.22 m lattice, 92°
 * FOV, 1080-tall), where the wall fills the view anyway, and keeps that pop under half a splat.
 */
const SPLAT_CAP_PX = 64;

const DOT_VERT = /* glsl */ `
attribute float dither;
attribute float paintTime;
attribute float paintIntensity;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeFlash;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uSpacing;
uniform float uProjScale;
uniform float uPixelRatio;
uniform float uSplatMin;
uniform float uSplatNear;
uniform float uSplatCap;

varying float vAlpha;
varying float vAge;

// Clip-space nowhere. A vertex pushed outside the volume with zero size costs one rasteriser
// reject and nothing else — cheaper and more portable than a discard in the fragment stage.
#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

// Vision §3.1 measures the contact shell from your BODY, not your eye — and it has to be the
// body, or the shell is invisible: standing still, the nearest floor the camera can actually see
// is 2.2 m from the eye and only 1.6 m from the capsule. Distance to the feet-head segment.
float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

// Faint but not imaginary: flat across the reachable part of the shell, feathered only at its
// edge. A linear falloff from the body centre puts everything real at a quarter of uShellAlpha,
// which rounds to nothing in 8 bits — an invisible shell is not a shell.
float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

void main() {
  float camDist = distance(position, uCamPos);

  // The hard window (vision §3.6). A cut, not a fade: outside it there is no world.
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  // age < 0 means the sound has been emitted but has not travelled this far yet. That is the
  // expanding wavefront, and it is why a detonation blooms outward instead of blinking on.
  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  // Age -> alpha, with the permanent memory-skeleton floor under it.
  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float aged = mix(1.0, uSkeletonAlpha, cool);
  float alpha = lit * max(uSkeletonAlpha, aged * mix(0.55, 1.0, paintIntensity));

  // Distance discipline. "far" is 0 inside uFarBias and 1 at the cut; dots dim, and the cloud
  // thins against each dot's own stable dither so the survivors never flicker.
  float far = smoothstep(uFarBias, uWindowRadius, camDist);
  if (dither > 1.0 - far) alpha = 0.0;
  alpha *= 1.0 - 0.6 * far;

  // Contact shell (vision §3.1): the only geometry visible without sound. Faint, 2 m, always on.
  alpha = max(alpha, shellAlpha(position));
  if (alpha <= 0.003) CULL()

  vAlpha = alpha;
  vAge = lit > 0.5 ? age : -1.0;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // A splat IS the projected footprint of its lattice cell (vision §12 "splats sized to voxel
  // footprint"). This is not decoration, it is the whole reason "nearby reads as a cloud": the
  // lattice is fixed in WORLD space, so up close you see FEWER dots covering MORE solid angle.
  // Draw them at a fixed small size and a wall 2 m away becomes a starfield with 50 px of black
  // between neighbours — the exact inverse of the law.
  //
  // The two px constants are FLOORS on that footprint, not sizes (visual-brief §2 "splats >= 2-3
  // px and temporally stable" — a sub-pixel dot dies in stream compression and shimmers). The
  // floor relaxes with distance because the far field is meant to thin toward a drawing: near
  // dots hold uSplatNear, far dots may go down to uSplatMin. At normal resolutions the footprint
  // clears both; on a small canvas or a wide FOV they are what keeps the image alive.
  // Foreshortening. The cell is a square in the SURFACE, so what it covers on screen is an
  // ellipse with semi-axes a and a*|n.v| — a floor seen edge-on covers a fraction of what the
  // same cell covers face-on. A round sprite cannot be that ellipse, so it is drawn at the
  // equal-area radius, a*sqrt(|n.v|). Without this, every grazing surface (which is most of a
  // corridor) overlaps itself into a solid white sheet and the cloud stops being a cloud.
  vec3 toCam = normalize(uCamPos - position);
  float foot = uProjScale * uSpacing / max(0.05, -mv.z);
  foot *= sqrt(clamp(abs(dot(normal, toCam)), 0.15, 1.0));
  gl_PointSize = clamp(foot, mix(uSplatNear, uSplatMin, far), uSplatCap) * uPixelRatio;
}
`;

const DOT_FRAG = /* glsl */ `
uniform float uAgeCool;

varying float vAlpha;
varying float vAge;

void main() {
  // Round splat: a square lattice of square dots reads as a screen door, not as a surface.
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;

  // Flat white aging to gray. No hue: in the debug look the matter layer carries no colour at
  // all, so anything coloured on screen is provably an event marker and not geometry.
  float grey = mix(1.0, 0.42, clamp(vAge / uAgeCool, 0.0, 1.0));
  vec3 c = vec3(grey);
  // Shell-only dots read cool rather than neutral, so "I am touching this" and "I heard this"
  // are never the same pixel. The DIMNESS is carried by alpha, not by the colour: at 0.05 alpha
  // a dark colour rounds to black in 8 bits and the shell disappears entirely.
  if (vAge < 0.0) c = vec3(0.66, 0.78, 0.88);
  gl_FragColor = vec4(c, vAlpha);
}
`;

const LINE_VERT = /* glsl */ `
attribute float dither;
attribute float flagsHold;
attribute float paintTime;
attribute float paintIntensity;

uniform float uNow;
uniform vec3  uCamPos;
uniform float uFloorCentre;
uniform float uFloorSpan;
uniform float uWindowRadius;
uniform float uFarBias;
uniform float uAgeFlash;
uniform float uAgeSkeleton;
uniform float uSkeletonAlpha;
uniform float uSkeletonAlphaEdge;
uniform float uShellRadius;
uniform float uShellAlpha;
uniform vec3  uBodyFeet;
uniform vec3  uBodyHead;
uniform float uHoldOnly;
uniform vec2  uOffsetPx;
uniform vec2  uViewport;
uniform float uLift;

varying float vAlpha;
varying float vHold;
varying float vAge;

#define CULL() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

float bodyDist(vec3 p) {
  vec3 ab = uBodyHead - uBodyFeet;
  float t = clamp(dot(p - uBodyFeet, ab) / max(1.0e-5, dot(ab, ab)), 0.0, 1.0);
  return distance(p, uBodyFeet + ab * t);
}

float shellAlpha(vec3 p) {
  return uShellAlpha * (1.0 - smoothstep(uShellRadius * 0.9, uShellRadius, bodyDist(p)));
}

void main() {
  float hold = step(0.5, flagsHold);
  if (uHoldOnly > 0.5 && hold < 0.5) CULL()

  float camDist = distance(position, uCamPos);
  if (camDist > uWindowRadius || abs(position.y - uFloorCentre) > uFloorSpan) CULL()

  float age = uNow - paintTime;
  float lit = (paintTime > ${NEVER_PAINTED.toExponential()} && age >= 0.0) ? 1.0 : 0.0;

  float cool = smoothstep(uAgeFlash, uAgeSkeleton, age);
  float floorA = mix(uSkeletonAlpha, uSkeletonAlphaEdge, hold);
  float alpha = lit * max(floorA, mix(1.0, floorA, cool) * mix(0.6, 1.0, paintIntensity));

  // Edge-biased retention (vision §12): lines keep far more of their strength at range than
  // dots do, which is what turns the far field into a drawing.
  alpha *= 1.0 - 0.35 * smoothstep(uFarBias, uWindowRadius, camDist);

  // The contact shell reaches holds too: a rail 1 m from your body is contact geometry.
  alpha = max(alpha, shellAlpha(position));
  if (alpha <= 0.003) CULL()

  vAlpha = alpha;
  vHold = hold;
  vAge = lit > 0.5 ? age : -1.0;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z += uLift; // toward the camera: a crease line sits ON the surfels it creases
  gl_Position = projectionMatrix * mv;
  // gl_LineWidth is fixed at 1 in WebGL, so "thicker" is a second offset pass over the same
  // geometry (see makeLineMaterial). The offset is screen-space, so it holds at every distance.
  gl_Position.xy += uOffsetPx * (2.0 / uViewport) * gl_Position.w;
}
`;

const LINE_FRAG = /* glsl */ `
varying float vAlpha;
varying float vHold;
varying float vAge;

void main() {
  // Plain cyan. Holds read brighter AND doubled (the offset pass) — brightness plus stroke, so
  // the hold/edge distinction survives any colour vision (vision §12).
  vec3 c = mix(vec3(0.20, 0.68, 0.80), vec3(0.62, 0.97, 1.0), vHold);
  if (vAge < 0.0) c = vec3(0.45, 0.72, 0.82); // shell-only: dimmed by alpha, not by colour
  gl_FragColor = vec4(c, vAlpha);
}
`;

type Uniforms = Record<string, { value: unknown }>;

export function createDebugLook(id = 'debug', title = 'debug', note = ''): Look {
  let ctx: LookContext | null = null;
  const scene = new Scene();

  let dotMat: ShaderMaterial | null = null;
  let lineMat: ShaderMaterial | null = null;
  let holdMat: ShaderMaterial | null = null;
  let dots: Points | null = null;
  let lines: LineSegments | null = null;
  let holds: LineSegments | null = null;

  let hudRoot: HTMLDivElement | null = null;
  let halo: HTMLDivElement | null = null;
  let readout: HTMLDivElement | null = null;
  let readoutAcc = 0;

  let viewW = 1;
  let viewH = 1;

  const shared = (c: LookContext): Uniforms => ({
    uNow: { value: 0 },
    uCamPos: { value: [0, 0, 0] },
    uFloorCentre: { value: c.floorCentre },
    uFloorSpan: { value: c.floorSpan },
    uWindowRadius: { value: c.constants.WINDOW_RADIUS },
    uFarBias: { value: c.constants.FAR_BIAS_START },
    uAgeFlash: { value: c.constants.AGE_FLASH },
    uAgeSkeleton: { value: c.constants.AGE_SKELETON },
    uSkeletonAlpha: { value: c.constants.SKELETON_ALPHA },
    uShellRadius: { value: c.constants.CONTACT_SHELL_RADIUS },
    uShellAlpha: { value: c.constants.CONTACT_SHELL_ALPHA },
    uBodyFeet: { value: [0, 0, 0] },
    uBodyHead: { value: [0, 0, 0] },
  });

  const makeLineMaterial = (c: LookContext, holdOnly: boolean): ShaderMaterial =>
    new ShaderMaterial({
      uniforms: {
        ...shared(c),
        uSkeletonAlphaEdge: { value: c.constants.SKELETON_ALPHA_EDGE },
        uHoldOnly: { value: holdOnly ? 1 : 0 },
        uOffsetPx: { value: holdOnly ? [0.85, 0.85] : [0, 0] },
        uViewport: { value: [1, 1] },
        uLift: { value: LINE_LIFT },
      },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthTest: true,
      // Lines never occlude the cloud they annotate; they are read THROUGH.
      depthWrite: false,
    });

  const setUniform = (m: ShaderMaterial | null, name: string, v: unknown): void => {
    const u = m?.uniforms[name];
    if (u) u.value = v;
  };

  return {
    id,
    title,

    init(c: LookContext): void {
      ctx = c;

      dotMat = new ShaderMaterial({
        uniforms: {
          ...shared(c),
          uAgeCool: { value: c.constants.AGE_COOL },
          uSpacing: { value: c.constants.SURFEL_SPACING },
          uProjScale: { value: 500 },
          uPixelRatio: { value: 1 },
          uSplatMin: { value: c.constants.SPLAT_MIN_PX },
          uSplatNear: { value: c.constants.SPLAT_NEAR_PX },
          uSplatCap: { value: SPLAT_CAP_PX },
        },
        vertexShader: DOT_VERT,
        fragmentShader: DOT_FRAG,
        transparent: true,
        depthTest: true,
        // Dots DO write depth: a near surface must hide the room behind it, or the memory
        // skeleton of the next room reads as if it were in this one.
        depthWrite: true,
      });
      lineMat = makeLineMaterial(c, false);
      holdMat = makeLineMaterial(c, true);

      dots = new Points(c.surfelGeom, dotMat);
      dots.frustumCulled = false; // one object holds the whole floor; the shader does the culling
      lines = new LineSegments(c.edgeGeom, lineMat);
      lines.frustumCulled = false;
      lines.renderOrder = 1;
      holds = new LineSegments(c.edgeGeom, holdMat);
      holds.frustumCulled = false;
      holds.renderOrder = 2;
      scene.add(dots, lines, holds);

      // --- HUD: reticle, halo ring, printed readout (engine-plan §9) ----------------------
      hudRoot = document.createElement('div');
      hudRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

      const reticle = document.createElement('div');
      reticle.style.cssText =
        'position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;' +
        'border-radius:50%;background:rgba(235,245,255,0.75);';
      hudRoot.appendChild(reticle);

      halo = document.createElement('div');
      halo.style.cssText =
        'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;' +
        'border-radius:50%;border:1px solid rgba(235,245,255,0);';
      hudRoot.appendChild(halo);

      readout = document.createElement('div');
      readout.style.cssText =
        'position:absolute;left:50%;top:50%;margin:38px 0 0 -110px;width:220px;text-align:center;' +
        'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(190,205,215,0.72);' +
        'white-space:pre;text-shadow:0 0 6px #000;';
      hudRoot.appendChild(readout);

      if (note) {
        const banner = document.createElement('div');
        banner.style.cssText =
          'position:absolute;left:0;right:0;top:12px;text-align:center;' +
          'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(190,205,215,0.55);';
        banner.textContent = note;
        hudRoot.appendChild(banner);
      }

      c.hud.appendChild(hudRoot);
      this.resize(viewW, viewH);
    },

    /** Nothing to spawn: the debug look draws paint and holds, and no event decoration at all. */
    onEvent(): void {},

    update(now: number, dt: number): void {
      const c = ctx;
      if (!c) return;

      const cam = c.camera;
      const camPos = [cam.position.x, cam.position.y, cam.position.z];
      // The shell is measured off the body: feet from the interpolated player pose, head at the
      // eye. Both are picture-side values (engine-plan §11.1) — they must not swim at 144 Hz.
      const feet = [c.player.pos[0], c.player.pos[1], c.player.pos[2]];
      for (const m of [dotMat, lineMat, holdMat]) {
        setUniform(m, 'uNow', now);
        setUniform(m, 'uCamPos', camPos);
        setUniform(m, 'uBodyFeet', feet);
        setUniform(m, 'uBodyHead', camPos);
        setUniform(m, 'uFloorCentre', c.floorCentre);
        setUniform(m, 'uFloorSpan', c.floorSpan);
      }

      // Pixels per metre at one metre of depth. Recomputed every frame because the FOV moves
      // with the sprint kick — a splat that ignored that would swell as you accelerate.
      const projScale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
      setUniform(dotMat, 'uProjScale', projScale);

      if (!halo || !readout) return;
      const p = c.player;
      const loud = Math.min(1, p.audibleRadius / HALO_FULL_M);
      halo.style.borderColor = `rgba(235,245,255,${(0.06 + 0.62 * loud).toFixed(3)})`;

      readoutAcc += dt;
      if (readoutAcc >= 0.1) {
        readoutAcc = 0;
        // Energy is honestly absent until M4 builds the reactor: it prints as a dash, never as
        // a full bar that would read as "you have 100 energy" (vision §1.2).
        const e = p.energyMax > 0 && p.energy > 0 ? p.energy.toFixed(0) : '—';
        readout.textContent =
          `audible ${p.audibleRadius.toFixed(1).padStart(5)} m    energy ${String(e).padStart(3)}/${p.energyMax}`;
      }
    },

    render(): void {
      const c = ctx;
      if (!c) return;
      c.renderer.render(scene, c.camera);
    },

    resize(w: number, h: number): void {
      viewW = Math.max(1, w);
      viewH = Math.max(1, h);
      const dpr = ctx ? ctx.renderer.getPixelRatio() : 1;
      setUniform(dotMat, 'uPixelRatio', dpr);
      const vp = [viewW * dpr, viewH * dpr];
      setUniform(lineMat, 'uViewport', vp);
      setUniform(holdMat, 'uViewport', vp);
    },

    dispose(): void {
      scene.clear();
      dotMat?.dispose();
      lineMat?.dispose();
      holdMat?.dispose();
      dotMat = lineMat = holdMat = null;
      dots = lines = holds = null;
      hudRoot?.remove();
      hudRoot = null;
      halo = null;
      readout = null;
      ctx = null;
      // NOT disposed, on purpose: ctx.surfelGeom / ctx.edgeGeom are the SurfelField's, and they
      // hold the run's paint. Disposing them here would black the world on every look switch.
    },
  };
}
