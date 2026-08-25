/**
 * BLIND HANDBALL — the debug playground.
 *
 * The left pane is the truth; the right pane is one player's world, drawn from that player's
 * perception stream and from nothing else. That pairing is the whole tool: a spatial, dynamic,
 * mostly invisible game cannot be debugged by reading numbers, and a bot built on a perception
 * layer nobody has ever *looked* at is a bot nobody can trust.
 *
 * Two decisions worth stating out loud:
 *
 * 1. **The simulation step is never resized.** The previous prototype's loop clamped the
 *    accumulator on a long frame, which silently throws simulation time away — for a match with
 *    bots that is a desync waiting to happen. Here the clock only ever decides HOW MANY fixed
 *    ticks to run; if the browser cannot keep up, the match runs in slow motion and stays
 *    correct. A tick is always exactly `config.dt`.
 *
 * 2. **Scrubbing re-simulates.** A recording is the seed, the config, the roster and the human's
 *    intents — not a dump of state. Dragging the timeline rebuilds the match from tick zero and
 *    replays it, feeding the perceived models on the way, so "what did P2 hear at the goal" is
 *    answered by the real perception pipeline rather than by a cache of pictures.
 */
import GUI from 'lil-gui';

import { cloneConfig, configFromPreset, PRESETS, type SimConfig } from '../sim/config';
import { CONTROLLERS, makeController } from '../sim/controllers';
import { Match, type TimelineEntry } from '../sim/match';
import { newRecording, recordInput, replayTo, serialiseRecording, type Recording } from '../sim/replay';
import type { StepOutput } from '../sim/sim';
import type { ControllerFactory } from '../sim/match';
import type { EntityId, Vec2 } from '../sim/types';
import {
  drawPerceived,
  drawTruth,
  makeCamera,
  type Camera,
  type TruthMark,
} from './draw';
import { HumanInput } from './input';
import { PerceivedModel } from './perceived';
import { findScenario, SCENARIOS } from './scenarios';

const TRAIL = 70;

interface Setup {
  config: SimConfig;
  seed: number;
  controllers: { name: string; make: ControllerFactory }[];
  eyes: EntityId;
  humanSlot: EntityId | null;
}

interface Session {
  match: Match;
  models: PerceivedModel[];
  marks: TruthMark[];
  trails: Vec2[][];
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const truthCanvas = el<HTMLCanvasElement>('truth');
const eyesCanvas = el<HTMLCanvasElement>('eyes-canvas');
const truthCtx = truthCanvas.getContext('2d')!;
const eyesCtx = eyesCanvas.getContext('2d')!;
const views = el<HTMLElement>('views');

const params = {
  preset: 'default',
  seed: 20260825,
  teamSize: 2,
  teamA: 'striker',
  teamB: 'goalie',
  human: 'none',
  scenario: 'none',
  showRadii: true,
  showVectors: true,
  beliefs: 'all' as string,
  paused: false,
  speed: 1,
};

let setup = buildSetup();
let live = makeSession(setup);
let rec: Recording = newRecording(setup.seed, setup.config, setup.controllers.map((c) => c.name));
let replay: Session | null = null;
let layout: 'both' | 'truth' | 'eyes' = 'both';
let playing = true;
/** Harness mode: the keyframe generator drives ticks itself and there is no animation loop. */
const harness = new URLSearchParams(location.search).has('harness');
// Keyframes are about the game, not about the tuning panel.
if (harness) document.body.classList.add('no-gui');

const input = new HumanInput();
input.attach(document.body, [truthCanvas, eyesCanvas]);

// -- setup ----------------------------------------------------------------

function buildSetup(): Setup {
  const config = configFromPreset(params.preset);
  config.teamSize = params.teamSize;
  const size = config.teamSize;
  const controllers = [
    ...Array.from({ length: size }, () => makeController(params.teamA)),
    ...Array.from({ length: size }, () => makeController(params.teamB)),
  ];
  let humanSlot: EntityId | null = null;
  if (params.human !== 'none') {
    humanSlot = Number(params.human);
    controllers[humanSlot] = makeController('human');
  }
  return { config, seed: params.seed, controllers, eyes: humanSlot ?? 0, humanSlot };
}

function makeSession(s: Setup): Session {
  const match = new Match({
    config: s.config,
    seed: s.seed,
    controllers: s.controllers,
    keepLog: true,
  });
  const models = match.controllers.map(
    (_, i) => new PerceivedModel(i, s.config.perception.markerLifeSec, s.config.ping.lifeSec, TRAIL),
  );
  const session: Session = {
    match,
    models,
    marks: [],
    trails: match.sim.state.players.map(() => []),
  };
  ingest(session, { events: [], touches: [], sonar: [], goals: [], turnovers: [] });
  return session;
}

function ingest(session: Session, out: StepOutput): void {
  const { match, models } = session;
  const now = match.sim.state.t;
  for (let i = 0; i < models.length; i++) {
    const frame = match.frameOf(i);
    if (frame) models[i]!.ingest(frame);
    models[i]!.controllerDebug = match.controllers[i]!.debugSnapshot?.() ?? null;
  }
  for (const ev of out.events) {
    session.marks.push({ pos: ev.pos, kind: ev.kind, intensity: ev.intensity, sourceId: ev.sourceId, born: now });
  }
  const life = setup.config.perception.markerLifeSec;
  while (session.marks.length > 0 && now - session.marks[0]!.born > life) session.marks.shift();
  for (const p of match.sim.state.players) {
    const t = session.trails[p.id]!;
    t.push({ x: p.pos.x, y: p.pos.y });
    if (t.length > TRAIL) t.shift();
  }
}

function restart(newSetup = buildSetup()): void {
  setup = newSetup;
  live = makeSession(setup);
  rec = newRecording(setup.seed, setup.config, setup.controllers.map((c) => c.name));
  replay = null;
  refreshEyesOptions();
  render();
}

function loadScenario(name: string): void {
  if (name === 'none') return;
  const scenario = findScenario(name);
  const s = scenario.make();
  restart({
    config: s.config,
    seed: s.seed,
    controllers: s.controllers,
    eyes: s.eyes,
    humanSlot: null,
  });
  params.teamSize = s.config.teamSize;
  // Resolve "stop at the first interception" by running the match once and reading its timeline.
  let target = scenario.ticks ?? 60;
  if (scenario.stopOn) {
    const probe = new Match({ config: s.config, seed: s.seed, controllers: s.controllers });
    const found = probe.run().timeline.find((e) => e.kind === scenario.stopOn!.kind);
    if (found) target = Math.max(1, found.tick - (scenario.stopOn.lead ?? 0));
  }
  for (let i = 0; i < target; i++) tick();
  playing = false;
  syncTransport();
  render();
}

// -- the tick -------------------------------------------------------------

function tick(): void {
  const session = live;
  const { match } = session;
  if (match.isOver) return;
  if (setup.humanSlot !== null) {
    const me = match.sim.state.players[setup.humanSlot]!;
    const intent = input.intent(me.pos, me.aim);
    match.setExternalIntent(setup.humanSlot, intent);
    recordInput(rec, match.sim.state.tick + 1, setup.humanSlot, intent);
  }
  const out = match.step();
  rec.ticks = match.sim.state.tick;
  ingest(session, out);
}

/** Rebuilds the match from the recording up to `targetTick`, perception and all. */
function scrubTo(targetTick: number): void {
  const session = makeSession(setup);
  replayTo(rec, targetTick, (m, out) => {
    void m;
    ingest(session, out);
  }, session.match);
  replay = session;
  playing = false;
  syncTransport();
  render();
}

function current(): Session {
  return replay ?? live;
}

// -- rendering ------------------------------------------------------------

function fitCanvas(canvas: HTMLCanvasElement): Camera {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(64, canvas.clientWidth);
  const h = Math.max(64, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return makeCamera(w, h, cameraField());
}

function cameraField() {
  return current().match.field;
}

let fps = 0;

function render(): void {
  const session = current();
  const state = session.match.sim.state;
  const now = state.t;
  const eyes = clampEyes(setup.eyes);

  const truthCam = fitCanvas(truthCanvas);
  drawTruth(truthCtx, truthCam, {
    state,
    field: session.match.field,
    marks: session.marks,
    trails: session.trails,
    now,
    markLife: setup.config.perception.markerLifeSec,
    showRadii: params.showRadii,
    showVectors: params.showVectors,
    playerRadius: setup.config.player.radius,
    highlight: eyes,
  });

  const eyesCam = fitCanvas(eyesCanvas);
  drawPerceived(eyesCtx, eyesCam, {
    model: session.models[eyes]!,
    now,
    showRadii: params.showRadii,
    showVectors: params.showVectors,
    playerRadius: setup.config.player.radius,
    beliefFilter: params.beliefs,
  });

  el('eyes-title').textContent = `as P${eyes} hears${replay ? ' (replay)' : ''}`;
  el('score').textContent = `${state.score[0]} : ${state.score[1]}`;
  el('clock').textContent = `${state.t.toFixed(1)}s / ${setup.config.match.durationSec}s · ${state.phase}`;
  el('tickinfo').textContent = `tick ${state.tick} · seed ${setup.seed} · ${setup.config.teamSize}v${setup.config.teamSize}`;
  el('fps').textContent = harness ? '' : `${fps.toFixed(0)} fps`;

  const scrub = el<HTMLInputElement>('scrub');
  scrub.max = String(Math.max(1, live.match.sim.state.tick));
  if (!replay) scrub.value = String(state.tick);
  el('scrubinfo').textContent = `${state.tick} / ${live.match.sim.state.tick}`;

  renderPanels(session, eyes);
  renderTimeline();
}

function clampEyes(id: EntityId): EntityId {
  const n = current().match.controllers.length;
  return Math.max(0, Math.min(n - 1, id));
}

function renderPanels(session: Session, eyes: EntityId): void {
  const state = session.match.sim.state;
  const panels = el('panels');
  const cards: string[] = [];
  if (setup.humanSlot !== null) {
    cards.push(
      `<div class="card" style="min-width:260px"><b>you are P${setup.humanSlot}</b><br>` +
        `<span class="k">${input.helpText}</span></div>`,
    );
  }
  for (const p of state.players) {
    const model = session.models[p.id]!;
    const debug = model.controllerDebug;
    const heard = model.recent[0];
    const stats = session.match.stats.players[p.id]!;
    const speed = Math.hypot(p.vel.x, p.vel.y);
    cards.push(
      `<div class="card" style="border-color:${p.id === eyes ? '#4d80b0' : '#1b2735'}">` +
        `<b>P${p.id}</b> <span class="k">${session.match.controllerNames[p.id]}</span>` +
        `${p.hasBall ? ' <b style="color:#ffd166">●ball</b>' : ''}<br>` +
        `<span class="k">pos</span> ${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)} ` +
        `<span class="k">v</span> ${speed.toFixed(2)} m/s<br>` +
        `<span class="k">loud</span> ${p.loudness.toFixed(0)} m ` +
        `<span class="k">ping cd</span> ${p.pingCd.toFixed(2)}<br>` +
        `<span class="k">charge</span> ${p.chargeT.toFixed(2)} ` +
        `${p.diveT > 0 ? '<b>dive</b>' : p.recoverT > 0 ? '<span class="k">recover</span>' : ''}<br>` +
        `<span class="k">heard</span> ${heard ? `${heard.kind} @${heard.distance.toFixed(1)}m ${heard.sourceId === null ? '(?)' : `P${heard.sourceId}`}` : '—'}<br>` +
        `<span class="k">ai</span> ${debug?.label ?? '—'} ` +
        `${debug?.readouts ? Object.entries(debug.readouts).map(([k, v]) => `<span class="k">${k}</span>=${v}`).join(' ') : ''}<br>` +
        // The "why", not just the "what": the chooser's top options with their scores. Without
        // this the overlay shows a decision and hides the decision-making.
        `${debug?.scores?.length ? `<span class="k">opts</span> ${debug.scores.slice(0, 4).map((sc, i) => `${i === 0 ? '<b>' : ''}${sc.action} ${sc.score.toFixed(2)}${i === 0 ? '</b>' : ''}`).join(' · ')}<br>` : ''}` +
        `${debug?.beliefs?.length ? `<span class="k">belief</span> ${debug.beliefs.map((b) => `${b.about} ${b.age.toFixed(1)}s`).join(' · ')}<br>` : ''}` +
        `<span class="k">goals</span> ${stats.goals} <span class="k">int</span> ${stats.interceptions} ` +
        `<span class="k">fum</span> ${stats.fumbles} <span class="k">png</span> ${stats.pings}` +
        `</div>`,
    );
  }
  panels.innerHTML = cards.join('');
}

let timelineSignature = '';

function renderTimeline(): void {
  const entries: TimelineEntry[] = live.match.timeline;
  const signature = `${entries.length}:${live.match.sim.state.tick}`;
  if (signature === timelineSignature) return;
  timelineSignature = signature;
  const box = el('events');
  box.innerHTML = entries
    .slice(-60)
    .reverse()
    .map((e) => `<div data-tick="${e.tick}">${e.t.toFixed(1)}s ${e.label}</div>`)
    .join('');
  for (const node of Array.from(box.querySelectorAll('div'))) {
    node.addEventListener('click', () => scrubTo(Number((node as HTMLElement).dataset.tick)));
  }
}

// -- the loop -------------------------------------------------------------

let accumulator = 0;
let lastMs = 0;
const MAX_TICKS_PER_FRAME = 12;

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  const wall = lastMs === 0 ? 0 : Math.min(0.25, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  fps = fps * 0.9 + (wall > 0 ? (1 / wall) * 0.1 : 0);
  if (playing && !replay) {
    accumulator += wall * params.speed;
    let n = 0;
    while (accumulator >= setup.config.dt && n < MAX_TICKS_PER_FRAME) {
      tick();
      accumulator -= setup.config.dt;
      n++;
    }
    // Out of budget: drop the *wall* time we could not afford, never the simulation's step.
    // A slow browser watches the match in slow motion; it never watches a different match.
    if (n === MAX_TICKS_PER_FRAME) accumulator = 0;
  }
  render();
}

// -- controls -------------------------------------------------------------

function syncTransport(): void {
  el('playpause').textContent = playing ? 'pause' : 'play';
  el('playpause').classList.toggle('on', !playing);
  el('live').classList.toggle('on', replay !== null);
}

el('playpause').addEventListener('click', () => {
  playing = !playing;
  if (playing) replay = null;
  syncTransport();
});
el('stepone').addEventListener('click', () => {
  playing = false;
  replay = null;
  tick();
  syncTransport();
  render();
});
el('live').addEventListener('click', () => {
  replay = null;
  playing = true;
  syncTransport();
  render();
});
el<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  params.speed = Number((e.target as HTMLSelectElement).value);
});
el<HTMLInputElement>('scrub').addEventListener('input', (e) => {
  scrubTo(Number((e.target as HTMLInputElement).value));
});
el('layout').addEventListener('click', () => {
  layout = layout === 'both' ? 'truth' : layout === 'truth' ? 'eyes' : 'both';
  applyLayout();
});
el('save').addEventListener('click', () => {
  const blob = new Blob([serialiseRecording(rec)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `handball-${setup.seed}-${live.match.sim.state.tick}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function applyLayout(): void {
  views.classList.toggle('solo-truth', layout === 'truth');
  views.classList.toggle('solo-eyes', layout === 'eyes');
  el('layout').textContent = layout === 'both' ? 'both views' : layout === 'truth' ? 'truth only' : 'eyes only';
  render();
}

function refreshEyesOptions(): void {
  const select = el<HTMLSelectElement>('eyes');
  const n = live.match.controllers.length;
  select.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">P${i} (${live.match.controllerNames[i]})</option>`).join('');
  select.value = String(clampEyes(setup.eyes));
}
el<HTMLSelectElement>('eyes').addEventListener('change', (e) => {
  setup.eyes = Number((e.target as HTMLSelectElement).value);
  render();
});

// The mouse aims by pointing at a place on the pitch, in either pane.
input.toWorld = (clientX, clientY, target) => {
  const rect = target.getBoundingClientRect();
  const cam = makeCamera(rect.width, rect.height, current().match.field);
  return { x: (clientX - rect.left - cam.ox) / cam.scale, y: -(clientY - rect.top - cam.oy) / cam.scale };
};

// -- lil-gui --------------------------------------------------------------

const gui = new GUI({ title: 'blind handball' });
const setupFolder = gui.addFolder('match');
setupFolder.add(params, 'preset', Object.keys(PRESETS)).onChange(() => restart());
setupFolder.add(params, 'seed', 1, 99999, 1).onChange(() => restart());
setupFolder.add(params, 'teamSize', 1, 4, 1).onChange(() => restart());
setupFolder.add(params, 'teamA', Object.keys(CONTROLLERS)).name('team 0').onChange(() => restart());
setupFolder.add(params, 'teamB', Object.keys(CONTROLLERS)).name('team 1').onChange(() => restart());
setupFolder.add(params, 'human', ['none', '0', '1', '2', '3']).name('human slot').onChange(() => restart());
setupFolder.add({ restart: () => restart() }, 'restart');
setupFolder
  .add(params, 'scenario', ['none', ...SCENARIOS.map((s) => s.name)])
  .onChange((v: string) => loadScenario(v));

const perceptionFolder = gui.addFolder('perception (the difficulty dial)');
const p = () => setup.config.perception;
perceptionFolder.add({ get sigma() { return p().localizationSigmaPerMeter; }, set sigma(v: number) { p().localizationSigmaPerMeter = v; } }, 'sigma', 0, 0.3, 0.005).name('localizationSigma /m');
perceptionFolder.add({ get cap() { return p().localizationSigmaCap; }, set cap(v: number) { p().localizationSigmaCap = v; } }, 'cap', 0, 5, 0.1).name('sigma cap');
perceptionFolder.add({ get anon() { return p().anonymousSources; }, set anon(v: boolean) { p().anonymousSources = v; } }, 'anon').name('anonymousSources');
perceptionFolder.add({ get lat() { return p().reactionLatencySec; }, set lat(v: number) { p().reactionLatencySec = v; } }, 'lat', 0, 1, 0.01).name('reactionLatency');
perceptionFolder.add({ get leak() { return p().truthLeak; }, set leak(v: number) { p().truthLeak = v; } }, 'leak', 0, 1, 0.05).name('truthLeak');
perceptionFolder.add({ get share() { return p().teamShare; }, set share(v: boolean) { p().teamShare = v; } }, 'share').name('teamShare');
perceptionFolder.add({ get hear() { return p().hearingScale; }, set hear(v: number) { p().hearingScale = v; } }, 'hear', 0.2, 3, 0.05).name('hearingScale');
perceptionFolder
  .add({ get wave() { return setup.config.ping.waveSpeed === Infinity ? 200 : setup.config.ping.waveSpeed; },
         set wave(v: number) { setup.config.ping.waveSpeed = v >= 200 ? Infinity : v; } }, 'wave', 5, 200, 1)
  .name('ping waveSpeed (200 = ∞)');

const viewFolder = gui.addFolder('view');
viewFolder.add(params, 'showRadii').name('hearing radii');
viewFolder.add(params, 'showVectors').name('motion vectors');
viewFolder
  .add(params, 'beliefs', ['all', 'opponents', 'mirror', 'none'])
  .name('belief overlay')
  .onChange(() => render());

// -- boot -----------------------------------------------------------------

refreshEyesOptions();
applyLayout();
syncTransport();
if (!harness) requestAnimationFrame(frame);
render();

/**
 * The harness contract, inherited in shape from the previous prototype's `window.bs`: the
 * keyframe generator drives everything through this one object and never touches the DOM.
 */
const hb = {
  get seed() {
    return setup.seed;
  },
  scenario(name: string) {
    loadScenario(name);
    return hb.state();
  },
  setup(next: Partial<typeof params>) {
    Object.assign(params, next);
    restart();
    return hb.state();
  },
  config(): SimConfig {
    return cloneConfig(setup.config);
  },
  stepTicks(n: number) {
    playing = false;
    replay = null;
    for (let i = 0; i < n; i++) tick();
    render();
    return hb.state();
  },
  scrubTo(t: number) {
    scrubTo(t);
    return hb.state();
  },
  eyes(id: number) {
    setup.eyes = id;
    el<HTMLSelectElement>('eyes').value = String(id);
    render();
  },
  /** Which belief clouds the blind pane draws — the keyframes want one layer at a time. */
  beliefs(mode: string) {
    params.beliefs = mode;
    render();
  },
  layout(mode: 'both' | 'truth' | 'eyes') {
    layout = mode;
    applyLayout();
  },
  draw() {
    render();
  },
  /** Pane rectangles in CSS pixels, so a keyframe check can measure inside one pane only. */
  rects() {
    const box = (c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return { truth: box(truthCanvas), eyes: box(eyesCanvas) };
  },
  timeline() {
    return live.match.timeline.map((e) => ({ tick: e.tick, t: e.t, kind: e.kind, label: e.label }));
  },
  stats() {
    return live.match.stats;
  },
  /**
   * What the watched controller believes, in numbers.
   *
   * The keyframe generator needs this to make claims it can check: "the bot's belief peak is
   * seven metres from where the man actually is, on the side he feinted towards" is a statement
   * about two numbers, and a picture of a pink blob is not.
   */
  ai() {
    const session = current();
    const eyes = clampEyes(setup.eyes);
    const debug = session.models[eyes]!.controllerDebug;
    if (!debug) return null;
    const truth = session.match.sim.state.players;
    return {
      eyes,
      label: debug.label ?? null,
      readouts: debug.readouts ?? {},
      scores: (debug.scores ?? []).slice(0, 4),
      beliefs: (debug.beliefs ?? []).map((b) => {
        const peak = b.points[0]?.pos ?? null;
        const about = String(b.about);
        const id = Number(about.replace(/[^0-9]/g, ''));
        const real = truth[id];
        return {
          about,
          age: b.age,
          confidence: b.confidence,
          cells: b.points.length,
          peak,
          // Distance from what the bot thinks to what is true. Computed here, in the harness,
          // where the truth is allowed to live — never inside the bot.
          error: peak && real ? Math.hypot(peak.x - real.pos.x, peak.y - real.pos.y) : null,
        };
      }),
    };
  },
  /** A small, JSON-safe summary — everything a keyframe check might want to assert on. */
  state() {
    const session = current();
    const s = session.match.sim.state;
    const eyes = clampEyes(setup.eyes);
    const model = session.models[eyes]!;
    return {
      tick: s.tick,
      t: s.t,
      phase: s.phase,
      score: [s.score[0], s.score[1]],
      eyes,
      players: s.players.map((pl) => ({
        id: pl.id,
        team: pl.team,
        x: pl.pos.x,
        y: pl.pos.y,
        speed: Math.hypot(pl.vel.x, pl.vel.y),
        hasBall: pl.hasBall,
        loudness: pl.loudness,
      })),
      ball: { x: s.ball.pos.x, y: s.ball.pos.y, carrier: s.ball.carrier },
      pingsInFlight: s.pings.length,
      perceived: {
        marks: model.marks.length,
        sonarPoints: model.sonar.reduce((n, snap) => n + snap.points.length, 0),
        heardKinds: [...new Set(model.marks.map((m) => m.kind))],
        ball: model.ball ? { x: model.ball.pos.x, y: model.ball.pos.y, sigma: model.ball.sigma } : null,
        recent: model.recent.slice(0, 5).map((e) => ({ kind: e.kind, d: e.distance, src: e.sourceId })),
      },
    };
  },
};

(window as unknown as Record<string, unknown>).hb = hb;
