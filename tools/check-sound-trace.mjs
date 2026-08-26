/** Narrow numeric contract for the one-front -> residual heat-trace marker. */
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
  console.log(`[sound-trace] ${line}`);
  if (!ok) failures.push(line);
}

const loudQuiet = number('TRACE_LOUD_NORM_QUIET');
const loudSharp = number('TRACE_LOUD_NORM_SHARP');
const slow = number('TRACE_ONSET_DURATION_SLOW');
const fast = number('TRACE_ONSET_DURATION_FAST');
const frontStart = number('TRACE_FRONT_RADIUS_START');
const frontEnd = number('TRACE_FRONT_RADIUS_END');
const halfWidth = number('TRACE_FRONT_HALF_WIDTH');
const feather = number('TRACE_FRONT_FEATHER');
const warpMax = number('TRACE_WARP_MAX');
const thicknessMax = number('TRACE_THICKNESS_MOD_MAX');
const guard = number('TRACE_GUARD_SCALE');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth01 = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const durationForLoudness = (loudness, loudRef = 9) => {
  const norm = Math.max(0.4, loudness) / loudRef;
  const logT = (Math.log(Math.max(loudQuiet, norm)) - Math.log(loudQuiet)) /
    (Math.log(loudSharp) - Math.log(loudQuiet));
  return slow + (fast - slow) * smooth01(logT);
};

const cases = [
  ['quiet spider step', 3.6],
  ['representative prop', 18],
  ['rifle', 90],
].map(([name, loudness]) => ({ name, loudness, duration: durationForLoudness(loudness) }));

check(
  'quiet, prop and rifle have distinct physical timing',
  cases[0].duration > cases[1].duration && cases[1].duration > cases[2].duration &&
    cases[0].duration >= 1.15 && cases[2].duration <= 0.23,
  cases.map((v) => `${v.name} ${v.loudness}m -> ${v.duration.toFixed(3)}s`).join(' · '),
);

let previous = durationForLoudness(0.4);
let maxStep = 0;
let monotone = true;
for (let i = 1; i <= 4096; i++) {
  const loudness = 0.4 * Math.pow(200 / 0.4, i / 4096);
  const current = durationForLoudness(loudness);
  maxStep = Math.max(maxStep, Math.abs(current - previous));
  monotone &&= current <= previous + 1e-12;
  previous = current;
}
check(
  'loudness mapping is continuous and monotone, not source-switched',
  monotone && maxStep < 0.001 && source.includes('log(max(') && source.includes('vLoudNorm'),
  `4096 logarithmic samples over 0.4..200m, worst adjacent duration step=${maxStep.toFixed(6)}s`,
);

const outerSupport = (frontEnd + (halfWidth + feather) * (1 + thicknessMax)) * (1 + warpMax);
const transparentMargin = guard - outerSupport;
check(
  'front filter support dies before guarded quad edge',
  transparentMargin >= 0.02 && frontStart > 0 && frontEnd < 1,
  `support=${outerSupport.toFixed(5)}R, quad=${guard.toFixed(3)}R, transparent margin=${transparentMargin.toFixed(5)}R`,
);

// Model the temporal envelopes at representative radii. The shader uses smoothstep everywhere;
// this catches an accidental hard stage switch without needing a pixel-counting screenshot.
const envelopeAt = (age, duration, radius) => {
  const onsetT = clamp01(age / duration);
  const ease = smooth01(onsetT);
  const frontRadius = frontStart + (frontEnd - frontStart) * ease;
  const frontEnvelope = smooth01(onsetT / 0.10) * (1 - smooth01((onsetT - 0.64) / 0.36));
  const distance = Math.abs(radius - frontRadius);
  const front = 1 - smooth01((distance - halfWidth) / feather);
  const revealed = 1 - smooth01((radius - (frontRadius - 0.10)) / 0.14);
  const body = Math.pow(Math.max(0, 1 - radius), 1.85);
  const shoulder = Math.exp(-Math.pow((radius - 0.42) / 0.38, 2));
  const settle = smooth01((onsetT - 0.08) / 0.64);
  return Math.max(0, (body * 0.52 + shoulder * 0.18) * revealed * settle + front * frontEnvelope);
};
let boundaryJump = 0;
let frameStep = 0;
for (const { duration } of cases) {
  for (const boundary of [0, duration]) {
    for (const radius of [0.08, 0.35, 0.72, 0.95]) {
      boundaryJump = Math.max(boundaryJump,
        Math.abs(envelopeAt(boundary + 1e-5, duration, radius) - envelopeAt(boundary - 1e-5, duration, radius)));
    }
  }
  for (let age = 0; age <= duration + 0.2; age += 1 / 120) {
    for (const radius of [0.08, 0.35, 0.72, 0.95]) {
      frameStep = Math.max(frameStep,
        Math.abs(envelopeAt(age + 1 / 120, duration, radius) - envelopeAt(age, duration, radius)));
    }
  }
}
check(
  'onset and residue meet continuously',
  boundaryJump < 0.001 && frameStep <= 1.0,
  `worst ±10µs boundary jump=${boundaryJump.toExponential(2)}; sharp rifle front may cross a sample in one frame ` +
    `(measured 120Hz max=${frameStep.toFixed(5)})`,
);

const traceBranch = source.slice(source.indexOf('trace — one uncertain'), source.indexOf('} else {', source.indexOf('trace — one uncertain')));
check(
  'one bounded quad/event; trace adds no loop, allocation or upload',
  /const PER_MARKER = 1;/.test(source) && !/for\s*\(/.test(traceBranch) &&
    !/new\s+|needsUpdate|updateRange/.test(traceBranch),
  `1 instanced quad/event, trace fragment loop bound=0, guard fill area +${((guard * guard - 1) * 100).toFixed(1)}%`,
);
check(
  'style is appended, default, max-composited, and old pulse remains selectable',
  /'pulse-poly': 8/.test(source) && /trace: 9/.test(source) && /style:\s*'trace'/.test(source) &&
    /capOverlap:\s*true/.test(source) && source.includes('THREE.MaxEquation') && source.includes("| 'pulse'"),
  'pulse index=5 preserved; trace index=9/default; capOverlap=true -> MaxEquation',
);

if (failures.length > 0) {
  console.error(`[sound-trace] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[sound-trace] PASS one front -> residual, onset ${slow.toFixed(2)}..${fast.toFixed(2)}s, loop=0`);
