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
  makePlayCamera,
  type Camera,
  type TruthMark,
} from './draw';
import { HumanInput, type Poll } from './input';
import { PerceivedModel } from './perceived';
import { findScenario, SCENARIOS, type HandSlot } from './scenarios';
import { Feel } from './feel';
import { drawHud } from './hud';
import { HandballAudio } from './audio';
import { ScriptPoller } from './hands';

const TRAIL = 70;

interface Setup {
  config: SimConfig;
  seed: number;
  controllers: { name: string; make: ControllerFactory }[];
  eyes: EntityId;
  /** The slot a person at this keyboard is driving, if any. */
  humanSlot: EntityId | null;
  /** Slots driven by a scripted pair of hands (keyframe storyboards). */
  hands: HandSlot[];
  /**
   * Whose cockpit is drawn. A HUD belongs to whoever is playing — a live human or a script
   * standing in for one — and to nobody else, which is also why the AI keyframes are unchanged
   * by any of this.
   */
  playerSlot: EntityId | null;
}

interface Session {
  match: Match;
  models: PerceivedModel[];
  marks: TruthMark[];
  trails: Vec2[][];
  /** The player's own body-sense. Null when nobody is playing this session. */
  feel: Feel | null;
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
  /** 'play' is one pane, a camera on the body, and the cockpit. 'debug' is the double view. */
  mode: 'debug' as 'debug' | 'play',
  zoom: 1.7,
  sound: true,
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

/**
 * The ear. Nothing in the simulation reads back from it, so its presence or absence cannot
 * change a single tick — and it is never even constructed under the keyframe harness, which has
 * no audio device and whose frame budget is the thing being measured.
 */
const audio = new HandballAudio();
if (harness) audio.setEnabled(false);
input.onFirstGesture = () => {
  if (params.sound) audio.resume();
};

/** One poller per scripted slot, so a script's intents produce the same edges hands do. */
const pollers = new Map<EntityId, ScriptPoller>();
const pollerFor = (id: EntityId): ScriptPoller => {
  let p = pollers.get(id);
  if (!p) {
    p = new ScriptPoller();
    pollers.set(id, p);
  }
  return p;
};

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
  return {
    config,
    seed: params.seed,
    controllers,
    eyes: humanSlot ?? 0,
    humanSlot,
    hands: [],
    playerSlot: humanSlot,
  };
}

/** Everything `Feel` needs to explain the game to the person playing it, read out of the config. */
function feelConfig(config: SimConfig): ConstructorParameters<typeof Feel>[0] {
  return {
    minCharge: config.throwing.minCharge,
    maxCharge: config.throwing.maxCharge,
    catchRadius: config.catching.radius,
    catchWindow: config.catching.windowSec,
    walkLoud: config.loudness['step-walk'],
    runLoud: config.loudness['step-run'],
    pingCooldown: config.ping.cooldownSec,
    carryTimeout: config.match.carryTimeoutSec,
  };
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
    feel: s.playerSlot !== null ? new Feel(feelConfig(s.config), input.usingPad) : null,
  };
  ingest(session, { events: [], touches: [], sonar: [], goals: [], turnovers: [] }, null, false);
  return session;
}

/**
 * Feeds one tick's results into everything that renders.
 *
 * `poll` is what the hands did this tick and is only ever non-null for the slot being played;
 * `sound` is off while scrubbing, because replaying two thousand ticks of a match through the
 * audio engine at once would be a wall of noise and a stall.
 */
function ingest(session: Session, out: StepOutput, poll: Poll | null, sound: boolean): void {
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

  const slot = setup.playerSlot;
  if (session.feel && slot !== null) {
    const frame = match.frameOf(slot);
    if (frame) {
      session.feel.update(frame, models[slot]!, poll, setup.config.dt);
      if (sound && params.sound) audio.render(frame);
    }
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

function loadScenario(name: string, ticksOverride?: number): void {
  if (name === 'none') return;
  const scenario = findScenario(name);
  const s = scenario.make();
  for (const h of scenario.hands ?? []) h.script.reset();
  pollers.clear();
  restart({
    config: s.config,
    seed: s.seed,
    controllers: s.controllers,
    eyes: s.eyes,
    humanSlot: null,
    hands: scenario.hands ?? [],
    playerSlot: scenario.playerSlot ?? null,
  });
  params.teamSize = s.config.teamSize;
  // Resolve "stop at the first interception" by running the match once and reading its timeline.
  let target = ticksOverride ?? scenario.ticks ?? 60;
  if (ticksOverride === undefined && scenario.stopOn) {
    const probe = new Match({ config: s.config, seed: s.seed, controllers: s.controllers });
    const found = probe.run().timeline.find((e) => e.kind === scenario.stopOn!.kind);
    if (found) target = Math.max(1, found.tick - (scenario.stopOn.lead ?? 0));
  }
  // Sound off while fast-forwarding into a scenario: it is a wall of noise, not a match.
  for (let i = 0; i < target; i++) tick(false);
  playing = false;
  syncTransport();
  render();
}

// -- the tick -------------------------------------------------------------

function tick(sound = true): void {
  const session = live;
  const { match } = session;
  if (match.isOver) return;
  let poll: Poll | null = null;

  // Scripted hands first: a storyboard drives one or two slots through the same external-intent
  // door a person does, so the cockpit and the recording see no difference between them.
  for (const hand of setup.hands) {
    const frame = match.frameOf(hand.slot);
    if (!frame) continue;
    const intent = hand.script.act(frame, match.sim.state.t);
    const handPoll = pollerFor(hand.slot).poll(intent);
    match.setExternalIntent(hand.slot, intent);
    recordInput(rec, match.sim.state.tick + 1, hand.slot, intent);
    if (hand.slot === setup.playerSlot) poll = handPoll;
  }

  if (setup.humanSlot !== null) {
    const me = match.sim.state.players[setup.humanSlot]!;
    poll = input.poll(me.pos, me.aim);
    match.setExternalIntent(setup.humanSlot, poll.intent);
    recordInput(rec, match.sim.state.tick + 1, setup.humanSlot, poll.intent);
  }

  const out = match.step();
  rec.ticks = match.sim.state.tick;
  ingest(session, out, poll, sound);
}

/** Rebuilds the match from the recording up to `targetTick`, perception and all. */
function scrubTo(targetTick: number): void {
  const session = makeSession(setup);
  replayTo(rec, targetTick, (m, out) => {
    void m;
    ingest(session, out, null, false);
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

function fitCanvas(canvas: HTMLCanvasElement, play = false): Camera {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(64, canvas.clientWidth);
  const h = Math.max(64, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return play ? playCamera(w, h) : makeCamera(w, h, cameraField());
}

/**
 * Whether the blind pane is currently somebody's cockpit rather than a debug view.
 *
 * Everything that follows from this — the camera on the body, the HUD, the shake — is gated on
 * it, which is what keeps the tool's keyframes and the AI's keyframes pixel-identical to what
 * they were.
 */
function cockpit(): boolean {
  return params.mode === 'play' && setup.playerSlot !== null && clampEyes(setup.eyes) === setup.playerSlot;
}

/**
 * A small kick on the loud moments.
 *
 * It is two pixels and it lasts a fifth of a second, and it is the only thing on the list that a
 * person will feel rather than read: a throw leaving the hand, a fumble, a ping. Deterministic
 * (it is a function of sim time), so a keyframe of a shake is the same shake every run.
 */
function shakeOf(feel: import('./feel').Feel | null): Vec2 {
  if (!feel) return { x: 0, y: 0 };
  let k = 0;
  for (const f of feel.flashes) {
    const age = feel.t - f.t;
    if (age > 0.22) continue;
    const w = f.kind === 'ping' ? 3.5 : f.kind === 'throw' ? 2.6 : f.kind === 'fumble' ? 3 : 0;
    k = Math.max(k, w * Math.max(0, 1 - age / 0.22));
  }
  if (k <= 0) return { x: 0, y: 0 };
  const t = feel.t * 90;
  return { x: Math.sin(t) * k, y: Math.cos(t * 1.37) * k };
}

function playCamera(w: number, h: number): Camera {
  const session = current();
  const slot = setup.playerSlot ?? clampEyes(setup.eyes);
  const frame = session.match.frameOf(slot);
  const centre = frame ? frame.self.pos : { x: 0, y: 0 };
  return makePlayCamera(w, h, session.match.field, centre, params.zoom, shakeOf(session.feel));
}

function cameraField() {
  return current().match.field;
}

let fps = 0;
/** Storyboard close-ups turn the corner instruments off so the action fills the frame. */
let hudChromeOff = false;

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

  const play = cockpit();
  const eyesCam = fitCanvas(eyesCanvas, play);
  drawPerceived(eyesCtx, eyesCam, {
    model: session.models[eyes]!,
    now,
    showRadii: params.showRadii,
    showVectors: play ? false : params.showVectors,
    playerRadius: setup.config.player.radius,
    beliefFilter: play ? 'none' : params.beliefs,
  });
  if (play && session.feel) {
    const frame = session.match.frameOf(eyes);
    if (frame) drawHud(eyesCtx, eyesCam, { feel: session.feel, frame, now, chrome: !hudChromeOff });
  }

  el('eyes-title').textContent = play
    ? `you are P${eyes}`
    : `as P${eyes} hears${replay ? ' (replay)' : ''}`;
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
  const slot = setup.playerSlot;
  if (slot !== null && session.feel) {
    const f = session.feel;
    cards.push(
      `<div class="card" style="min-width:300px;border-color:#4d80b0"><b>you are P${slot}</b><br>` +
        `<span class="k">${input.helpText}</span><br>` +
        `<span class="k">heard at</span> ${f.loudness.toFixed(1)} m ` +
        `<span class="k">silent</span> ${f.silentFor.toFixed(1)}s<br>` +
        `<span class="k">charge</span> ${(f.charge * 100).toFixed(0)}%${f.committed ? ' <b>committed</b>' : ''} ` +
        `<span class="k">ball</span> ${Number.isFinite(f.ballDistance) ? `${f.ballDistance.toFixed(1)} m` : '—'}<br>` +
        `<span class="k">catch</span> ${f.catchReadout?.text ?? '—'}<br>` +
        `<span class="k">throws</span> ${f.stats.throws} <span class="k">caught</span> ${f.stats.catches} ` +
        `<span class="k">fumbled</span> ${f.stats.fumbles} <span class="k">pings</span> ${f.stats.pings}` +
        `</div>`,
    );
  }
  for (const p of state.players) {
    // Play mode is not a debugger: a person driving a body should not be reading four cards of
    // other people's positions off the bottom of their own screen.
    if (params.mode === 'play' && p.id !== slot) continue;
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
/**
 * One button that turns the debug tool into a game.
 *
 * A jam player should not have to find a dropdown, a slot number and a layout mode before they
 * can move: this puts a person in P0 against bots, hides the panel, drops the truth pane and
 * starts the audio device off the click that a browser requires anyway.
 */
function enterPlay(): void {
  params.mode = 'play';
  params.human = '0';
  params.teamB = 'bot';
  params.scenario = 'none';
  layout = 'eyes';
  document.body.classList.add('playing');
  restart();
  applyLayout();
  playing = true;
  syncTransport();
  if (params.sound) audio.resume();
  gui.hide();
}

function leavePlay(): void {
  params.mode = 'debug';
  document.body.classList.remove('playing');
  layout = 'both';
  applyLayout();
  gui.show();
}

el('play').addEventListener('click', () => {
  if (params.mode === 'play') leavePlay();
  else enterPlay();
  el('play').classList.toggle('on', params.mode === 'play');
  el('play').textContent = params.mode === 'play' ? 'exit play' : '▶ play';
});

el('start-overlay').addEventListener('click', () => {
  el('start-overlay').style.display = 'none';
  enterPlay();
  el('play').classList.add('on');
  el('play').textContent = 'exit play';
});
el('start-skip').addEventListener('click', (e) => {
  e.stopPropagation();
  el('start-overlay').style.display = 'none';
});
if (harness) el('start-overlay').style.display = 'none';

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
// The mouse aims by pointing at a place on the pitch, in either pane — which means the mapping
// has to use the SAME camera that pane was drawn with, or a zoomed cockpit aims where the
// cursor is not.
input.toWorld = (clientX, clientY, target) => {
  const rect = target.getBoundingClientRect();
  const cam =
    target === eyesCanvas && cockpit()
      ? makePlayCamera(
          rect.width,
          rect.height,
          current().match.field,
          current().match.frameOf(setup.playerSlot ?? 0)?.self.pos ?? { x: 0, y: 0 },
          params.zoom,
        )
      : makeCamera(rect.width, rect.height, current().match.field);
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

const playFolder = gui.addFolder('play (the human side)');
playFolder.add(params, 'mode', ['debug', 'play']).onChange(() => {
  document.body.classList.toggle('playing', params.mode === 'play');
  render();
});
playFolder.add(params, 'zoom', 1, 3.5, 0.05).name('camera zoom').onChange(() => render());
playFolder
  .add(params, 'sound')
  .name('audio')
  .onChange((on: boolean) => {
    audio.setEnabled(on);
    if (on) audio.resume();
  });
playFolder.add({ vol: 0.55 }, 'vol', 0, 1, 0.05).name('volume').onChange((v: number) => audio.setVolume(v));

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
  scenario(name: string, ticks?: number) {
    loadScenario(name, ticks);
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
    for (let i = 0; i < n; i++) tick(false);
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
  /**
   * Cockpit controls for the storyboards.
   *
   * `mode('play')` turns the blind pane into the pane a person plays on — camera on the body,
   * HUD on top — without changing one number in the simulation. `hud(false)` strips the corner
   * instruments so a close-up of a wind-up is a picture of a wind-up.
   */
  mode(m: 'debug' | 'play') {
    params.mode = m;
    document.body.classList.toggle('playing', m === 'play');
    render();
  },
  zoom(z: number) {
    params.zoom = z;
    render();
  },
  hud(on: boolean) {
    hudChromeOff = !on;
    render();
  },
  /**
   * The player's own experience, in numbers a caption can make a claim about: how loud they
   * have been, what they fumbled, what the catch read-out decided and why.
   *
   * This is the closest thing to a playtest that exists without a person, so it is the thing
   * the hands scenarios assert on.
   */
  feel() {
    const session = current();
    const f = session.feel;
    if (!f) return null;
    return {
      t: f.t,
      charge: f.charge,
      chargeT: f.chargeT,
      committed: f.committed,
      loudness: f.loudness,
      silentFor: f.silentFor,
      ballDistance: Number.isFinite(f.ballDistance) ? f.ballDistance : null,
      ballTca: Number.isFinite(f.ballTca) ? f.ballTca : null,
      catchWindowOpen: f.catchWindowOpen,
      lastCatch: f.lastCatch,
      readout: f.catchReadout?.text ?? null,
      hint: f.activeHint?.text ?? null,
      stats: f.stats,
      flashes: f.flashes.map((x) => x.kind),
    };
  },
  /** What the scripted hands think they are doing — the storyboard's caption, from the run. */
  handLabels() {
    return setup.hands.map((h) => ({ slot: h.slot, name: h.script.name, label: h.script.label }));
  },
  draw() {
    render();
  },
  /**
   * World metres -> page pixels, using whichever camera the blind pane is actually drawn with.
   *
   * This is what lets a keyframe make the strongest claim in the project photometrically: point
   * at where an opponent really is, and measure that the player's own pane is black there.
   */
  project(x: number, y: number) {
    const rect = eyesCanvas.getBoundingClientRect();
    const session = current();
    const cam = cockpit()
      ? makePlayCamera(
          rect.width,
          rect.height,
          session.match.field,
          session.match.frameOf(setup.playerSlot ?? 0)?.self.pos ?? { x: 0, y: 0 },
          params.zoom,
        )
      : makeCamera(rect.width, rect.height, session.match.field);
    return {
      x: Math.round(rect.x + cam.ox + x * cam.scale),
      y: Math.round(rect.y + cam.oy - y * cam.scale),
    };
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
