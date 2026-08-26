/** Narrow numeric gate for the bounded sequential-wave pulse shader. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve('src/sound/markers.ts'), 'utf8');
const failures = [];

function number(name) {
  const match = source.match(new RegExp(`export const ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`missing numeric contract ${name}`);
  return Number(match[1]);
}

function check(label, ok, detail) {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`;
  console.log(`[sound-pulse] ${line}`);
  if (!ok) failures.push(line);
}

const count = number('PULSE_WAVE_COUNT');
const period = number('PULSE_WAVE_PERIOD');
const speed = number('PULSE_WAVE_SPEED');
const firstRadius = number('PULSE_DEATH_RADIUS_FIRST');
const lastRadius = number('PULSE_DEATH_RADIUS_LAST');
const fadeStart = number('PULSE_WAVE_FADE_START');
const launchFade = number('PULSE_WAVE_LAUNCH_FADE');
const polySides = number('PULSE_POLY_SIDES');
const polyAxisDeform = number('PULSE_POLY_AXIS_DEFORM');
const frontEnd = number('PULSE_FRONT_FADE_END');
const halfWidth = number('PULSE_LINE_HALF_WIDTH');
const feather = number('PULSE_LINE_FEATHER');
const thicknessModMax = number('PULSE_THICKNESS_MOD_MAX');
const warpMax = number('PULSE_WARP_MAX');
const guardScale = number('PULSE_GUARD_SCALE');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth01 = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const launchAt = (i) => i * period;
const deathRadiusAt = (i) => {
  const generation = i / (count - 1);
  return firstRadius + (lastRadius - firstRadius) * smooth01(generation);
};
const deathAt = (i) => launchAt(i) + deathRadiusAt(i) / speed;
const alphaAt = (i, time) => {
  const localAge = time - launchAt(i);
  if (localAge <= 0) return 0;
  const progress = speed * localAge / deathRadiusAt(i);
  return smooth01(localAge / launchFade) * (1 - smooth01((progress - fadeStart) / (1 - fadeStart)));
};

const launches = Array.from({ length: count }, (_, i) => launchAt(i));
const radii = Array.from({ length: count }, (_, i) => deathRadiusAt(i));
const deaths = Array.from({ length: count }, (_, i) => deathAt(i));

const fieldPhase = (generation, time, seed) => seed + generation * 0.55 + time * 0.34;
const warpAt = (angle, generation, time, seed) => {
  const phase = fieldPhase(generation, time, seed);
  const ampMix = 0.5 + 0.5 * Math.sin(seed * 0.61 + generation * 0.8 + time * 0.17);
  const a2 = 0.044 + (0.052 - 0.044) * ampMix;
  const a3 = 0.028 + (0.024 - 0.028) * ampMix;
  return 1 + a2 * Math.sin(angle * 2 + phase) + a3 * Math.sin(angle * 3 - phase * 0.7);
};
const widthAt = (angle, generation, time, seed) => {
  const phase = fieldPhase(generation, time, seed);
  return 1 + 0.15 * Math.sin(angle * 3 + phase * 1.3) + 0.07 * Math.sin(angle * 5 - phase * 1.9);
};

check(
  'births are periodic and start at the centre',
  launches[0] === 0 && launches.slice(1).every((v, i) => Math.abs(v - launches[i] - period) < 1e-12),
  `N=${count}, period=${period.toFixed(2)}s, launches 0..${launches.at(-1).toFixed(2)}s; front(localAge=0)=0R`,
);
check(
  'death-radius curve is smooth and strictly decreasing',
  radii.every((radius, i) => i === 0 || radius < radii[i - 1]) &&
    Math.abs(radii[0] - firstRadius) < 1e-12 && Math.abs(radii.at(-1) - lastRadius) < 1e-12,
  `smoothstep generations: ${radii.map((v) => v.toFixed(3)).join(', ')}R`,
);
check(
  'first wave reaches large and last wave dies near centre',
  Math.abs(radii[0] - 1.04) < 1e-12 && radii.at(-1) <= 0.18,
  `first=${radii[0].toFixed(2)}R, last=${radii.at(-1).toFixed(2)}R`,
);
check(
  'generator is finite and finishes inside marker life',
  count <= 12 && launches.at(-1) < 7 && deaths.at(-1) < 7,
  `last birth X=${launches.at(-1).toFixed(2)}s, no i>=${count} loop iteration, last death=${deaths.at(-1).toFixed(2)}s`,
);

let concurrentMax = 0;
let concurrentAt = 0;
for (let time = 0; time <= 7; time += 0.001) {
  const concurrent = launches.filter((_, i) => alphaAt(i, time) > 1e-6).length;
  if (concurrent > concurrentMax) {
    concurrentMax = concurrent;
    concurrentAt = time;
  }
}
check(
  'bounded loop has natural overlapping generations',
  concurrentMax >= 3 && concurrentMax <= 6,
  `measured max concurrent=${concurrentMax} at ${concurrentAt.toFixed(3)}s; shader bound=${count}`,
);

let adjacentWarpDelta = 0;
let adjacentWidthDelta = 0;
let adjacentPolyFieldDelta = 0;
for (const time of [0, 1.7, 3.4, 5.8]) {
  for (let i = 0; i < count - 1; i++) {
    const g0 = i / (count - 1);
    const g1 = (i + 1) / (count - 1);
    for (let step = 0; step < 720; step++) {
      const angle = step / 720 * Math.PI * 2;
      adjacentWarpDelta = Math.max(adjacentWarpDelta, Math.abs(warpAt(angle, g1, time, 1.73) - warpAt(angle, g0, time, 1.73)));
      adjacentWidthDelta = Math.max(adjacentWidthDelta, Math.abs(widthAt(angle, g1, time, 1.73) - widthAt(angle, g0, time, 1.73)));
      const phase0 = fieldPhase(g0, time, 1.73);
      const phase1 = fieldPhase(g1, time, 1.73);
      const poly0 = [1 + polyAxisDeform * Math.sin(phase0), 1 + polyAxisDeform * Math.cos(phase0 * 0.83 + 0.4), 0.12 * Math.sin(phase0 * 0.73)];
      const poly1 = [1 + polyAxisDeform * Math.sin(phase1), 1 + polyAxisDeform * Math.cos(phase1 * 0.83 + 0.4), 0.12 * Math.sin(phase1 * 0.73)];
      adjacentPolyFieldDelta = Math.max(adjacentPolyFieldDelta, ...poly0.map((v, axis) => Math.abs(v - poly1[axis])));
    }
  }
}
check(
  'deformation field is continuous across generation boundaries',
  adjacentWarpDelta < 0.01 && adjacentWidthDelta < 0.04 && adjacentPolyFieldDelta < 0.01,
  `worst adjacent-generation rounded warp Δ=${adjacentWarpDelta.toFixed(5)}, thickness Δ=${adjacentWidthDelta.toFixed(5)}, polygon transform Δ=${adjacentPolyFieldDelta.toFixed(5)}`,
);

const epsilon = 1e-3;
const launchJumps = launches.map((time, i) => Math.abs(alphaAt(i, time + epsilon) - alphaAt(i, time - epsilon)));
const deathJumps = deaths.map((time, i) => Math.abs(alphaAt(i, time + epsilon) - alphaAt(i, time - epsilon)));
let maxFrameStep = 0;
for (let i = 0; i < count; i++) {
  for (let time = launches[i] - 1 / 120; time <= deaths[i] + 1 / 120; time += 1 / 120) {
    maxFrameStep = Math.max(maxFrameStep, Math.abs(alphaAt(i, time + 1 / 120) - alphaAt(i, time)));
  }
}
check(
  'launch and fade are continuous with no switch cut',
  Math.max(...launchJumps, ...deathJumps) < 1e-4 && maxFrameStep < 0.065,
  `max ±1ms boundary jump=${Math.max(...launchJumps, ...deathJumps).toExponential(2)}, worst 120Hz alpha step=${maxFrameStep.toFixed(5)}`,
);

const outerSupport = (frontEnd + (halfWidth + feather) * (1 + thicknessModMax)) * (1 + warpMax);
const transparentMargin = guardScale - outerSupport;
const minCoreThickness = halfWidth * 2 * (1 - thicknessModMax);
const maxCoreThickness = halfWidth * 2 * (1 + thicknessModMax);
const maxSupportThickness = (halfWidth + feather) * 2 * (1 + thicknessModMax);
const guardFillCost = guardScale ** 2 - 1;
const polyStretch = 1 / (1 - polyAxisDeform);
check(
  'largest wave filter support ends before guarded quad edge',
  transparentMargin >= 0.015 && Math.abs(firstRadius - frontEnd) < 1e-12,
  `support=${outerSupport.toFixed(4)}R, quad=${guardScale.toFixed(4)}R, transparent margin=${transparentMargin.toFixed(4)}R`,
);
check(
  'organic thickness remains continuous and non-zero',
  minCoreThickness > 0 && maxSupportThickness <= 0.05,
  `core ${minCoreThickness.toFixed(4)}..${maxCoreThickness.toFixed(4)}R; feathered max ${maxSupportThickness.toFixed(4)}R`,
);
check(
  'polygon variant is bounded by the same guard',
  polySides >= 10 && polySides <= 16 && polyStretch <= 1 + warpMax && /'pulse-poly': 8/.test(source),
  `${polySides}-gon, max affine stretch=${polyStretch.toFixed(5)} <= rounded guard shape factor ${(1 + warpMax).toFixed(5)}; style index=8 appended`,
);
check(
  'one instance and one compile-time bounded fragment loop remain',
  /const PER_MARKER = 1;/.test(source) && source.includes(`for (int i = 0; i < \${PULSE_WAVE_COUNT}; i++)`),
  `1 quad/event, loop<=${count}, measured concurrent<=${concurrentMax}, guard bounding area +${(guardFillCost * 100).toFixed(2)}%`,
);
check(
  'approved pulse experiment remains selectable at its original index',
  /pulse:\s*5/.test(source) && source.includes("| 'pulse'"),
  'pulse index=5/selectable (boot style is owned by the current visual experiment)',
);

if (failures.length > 0) {
  console.error(`[sound-pulse] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(
  `[sound-pulse] PASS N=${count} period=${period.toFixed(2)}s speed=${speed.toFixed(2)}R/s ` +
    `r=${firstRadius.toFixed(2)}→${lastRadius.toFixed(2)}R concurrentMax=${concurrentMax} X=${launches.at(-1).toFixed(2)}s`,
);
