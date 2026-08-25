/**
 * Canvas drawing for the two panes.
 *
 * Two functions, two sources, no overlap: `drawTruth` takes the world, `drawPerceived` takes a
 * `PerceivedModel` and nothing else. That separation is enforced by the signatures on purpose —
 * the right-hand pane cannot accidentally learn something the player has not heard, because
 * there is nothing in scope that knows it.
 *
 * The visual language is inherited from the previous prototype's sound layer: a sound mark is a
 * soft blob at the point where the event happened, it lights nothing around it, and it is warm
 * where the instrument returns (sonar, geometry) are cold. Matter is dots, sound is blobs — you
 * never have to work out which layer you are looking at.
 */
import type { BeliefCloud, SoundKind, Vec2 } from '../sim/types';
import type { PlayerState, WorldState } from '../sim/sim';
import type { FieldInfo } from '../sim/types';
import type { Mark, PerceivedModel } from './perceived';

export interface Camera {
  ox: number;
  oy: number;
  scale: number;
  w: number;
  h: number;
}

export const TEAM_COLOR = ['#4dd8ff', '#ff9a52'] as const;
export const BALL_COLOR = '#ffd166';

/**
 * Warm for sound, per the inherited language. The sonar is white because it is the loud one.
 *
 * Partial by design: the rules layer may invent a sound kind, and a missing row must be a grey
 * blob rather than a crash or a compile error in the renderer.
 */
export const SOUND_COLOR: Partial<Record<SoundKind, string>> = {
  'step-walk': '#5c7fa3',
  'step-run': '#7fb2ff',
  brake: '#ff7a5c',
  dive: '#ff9d5c',
  catch: '#7dffa8',
  fumble: '#ff4d6d',
  throw: '#ffb703',
  'ball-hum': '#ffd166',
  'ball-wall': '#ffe8a3',
  // Two rows added with the fight for the ball: a ball whistling past a body that did not react,
  // and the scuffle of the ball changing hands.
  'ball-near': '#c7b48a',
  // The carried ball's beep: the same warm yellow as the ball itself, because that is what it is.
  'ball-carry': '#ffd166',
  // A shout: the one noise a player makes on purpose, so it gets its own colour.
  call: '#6fd3e0',
  steal: '#5cffd0',
  sonar: '#ffffff',
  whistle: '#ff7ae0',
};

export const soundColor = (kind: SoundKind): string => SOUND_COLOR[kind] ?? '#8aa0b4';

export function makeCamera(width: number, height: number, field: FieldInfo, pad = 24): Camera {
  const scale = Math.min((width - pad * 2) / field.width, (height - pad * 2) / field.height);
  return { ox: width / 2, oy: height / 2, scale, w: width, h: height };
}

/**
 * The play camera: the same projection, zoomed and centred on one body.
 *
 * A whole-pitch view is the right tool for debugging and the wrong one for playing — at 24 m
 * across, a player is four pixels and their own half-metre of touch is invisible, so every
 * instrument the cockpit draws on the body lands on top of itself. Zooming in also does
 * something the concept wants: the edges of the pane stop being the edges of the world, so
 * "somewhere out there" becomes a real feeling instead of a corner of a diagram.
 *
 * It never scrolls past the pitch by more than a margin, because a blind player who has lost
 * the walls has lost the only fixed thing they have.
 */
export function makePlayCamera(
  width: number,
  height: number,
  field: FieldInfo,
  centre: Vec2,
  zoom: number,
  shake: Vec2 = { x: 0, y: 0 },
): Camera {
  const base = makeCamera(width, height, field);
  const scale = base.scale * zoom;
  const margin = 2.5;
  const halfW = width / 2 / scale;
  const halfH = height / 2 / scale;
  const maxX = Math.max(0, field.halfWidth + margin - halfW);
  const maxY = Math.max(0, field.halfHeight + margin - halfH);
  const cx = Math.max(-maxX, Math.min(maxX, centre.x));
  const cy = Math.max(-maxY, Math.min(maxY, centre.y));
  return { ox: width / 2 - cx * scale + shake.x, oy: height / 2 + cy * scale + shake.y, scale, w: width, h: height };
}

export const sx = (cam: Camera, p: Vec2): number => cam.ox + p.x * cam.scale;
export const sy = (cam: Camera, p: Vec2): number => cam.oy - p.y * cam.scale;

function arrow(ctx: CanvasRenderingContext2D, cam: Camera, from: Vec2, vec: Vec2, color: string, k = 0.35): void {
  const speed = Math.hypot(vec.x, vec.y);
  if (speed < 0.05) return;
  const to = { x: from.x + vec.x * k, y: from.y + vec.y * k };
  const x0 = sx(cam, from);
  const y0 = sy(cam, from);
  const x1 = sx(cam, to);
  const y1 = sy(cam, to);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const head = Math.min(8, len * 0.4);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
  ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function trail(ctx: CanvasRenderingContext2D, cam: Camera, points: readonly Vec2[], color: string): void {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i < points.length; i++) {
    ctx.globalAlpha = (i / points.length) * 0.5;
    ctx.beginPath();
    ctx.moveTo(sx(cam, points[i - 1]!), sy(cam, points[i - 1]!));
    ctx.lineTo(sx(cam, points[i]!), sy(cam, points[i]!));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A soft blob: hot core, bleeding to nothing. A reading, not a lamp. */
function blob(ctx: CanvasRenderingContext2D, cam: Camera, at: Vec2, radiusM: number, color: string, alpha: number): void {
  const r = Math.max(3, radiusM * cam.scale);
  const g = ctx.createRadialGradient(sx(cam, at), sy(cam, at), 0, sx(cam, at), sy(cam, at), r);
  g.addColorStop(0, color);
  g.addColorStop(0.35, color);
  g.addColorStop(1, 'transparent');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(sx(cam, at), sy(cam, at), r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function circle(ctx: CanvasRenderingContext2D, cam: Camera, at: Vec2, radiusM: number, color: string, alpha = 1, dash?: number[]): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(sx(cam, at), sy(cam, at), radiusM * cam.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * The error cigar: an ellipse long along the bearing to the source and short across it. Drawing
 * the honest shape of the uncertainty is the point — a circle would say the listener knows the
 * distance as well as the direction, which is exactly the thing that is not true.
 */
function ellipse(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  at: Vec2,
  along: number,
  across: number,
  bearing: Vec2,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.ellipse(
    sx(cam, at),
    sy(cam, at),
    Math.max(1, along * cam.scale),
    Math.max(1, across * cam.scale),
    Math.atan2(-bearing.y, bearing.x),
    0,
    Math.PI * 2,
  );
  ctx.stroke();
  ctx.restore();
}

export function clear(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, cam.w, cam.h);
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#8aa0b4', size = 12): void {
  ctx.fillStyle = color;
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(text, x, y);
}

/** One live sound event, kept by the playground so the truth pane can show it fading. */
export interface TruthMark {
  pos: Vec2;
  kind: SoundKind;
  intensity: number;
  sourceId: number;
  born: number;
}

export interface TruthOptions {
  state: WorldState;
  field: FieldInfo;
  marks: readonly TruthMark[];
  trails: readonly Vec2[][];
  now: number;
  markLife: number;
  showRadii: boolean;
  showVectors: boolean;
  playerRadius: number;
  highlight: number | null;
}

export function drawTruth(ctx: CanvasRenderingContext2D, cam: Camera, o: TruthOptions): void {
  clear(ctx, cam);
  const f = o.field;

  // --- the pitch ---------------------------------------------------------
  ctx.strokeStyle = '#1d2a36';
  ctx.lineWidth = 2;
  ctx.strokeRect(
    sx(cam, { x: -f.halfWidth, y: 0 }),
    sy(cam, { x: 0, y: f.halfHeight }),
    f.width * cam.scale,
    f.height * cam.scale,
  );
  // Goal mouths.
  ctx.strokeStyle = '#3f5a75';
  ctx.lineWidth = 4;
  for (const g of f.goalCentre) {
    ctx.beginPath();
    const lo = { x: g.x, y: -f.goalWidth / 2 };
    const hi = { x: g.x, y: f.goalWidth / 2 };
    ctx.moveTo(sx(cam, lo), sy(cam, lo));
    ctx.lineTo(sx(cam, hi), sy(cam, hi));
    ctx.stroke();
  }
  // Creases.
  for (const g of f.goalCentre) circle(ctx, cam, g, f.creaseRadius, '#25384a', 1, [4, 4]);
  ctx.beginPath();
  ctx.setLineDash([2, 6]);
  ctx.strokeStyle = '#152130';
  ctx.moveTo(sx(cam, { x: 0, y: f.halfHeight }), sy(cam, { x: 0, y: f.halfHeight }));
  ctx.lineTo(sx(cam, { x: 0, y: -f.halfHeight }), sy(cam, { x: 0, y: -f.halfHeight }));
  ctx.stroke();
  ctx.setLineDash([]);

  // --- sound events, with the radius at which they can be heard -----------
  for (const m of o.marks) {
    const age = o.now - m.born;
    const a = Math.max(0, 1 - age / o.markLife);
    if (a <= 0) continue;
    const color = soundColor(m.kind);
    if (o.showRadii) circle(ctx, cam, m.pos, m.intensity * (1 - a * 0.15), color, a * 0.18);
    blob(ctx, cam, m.pos, Math.min(2.2, 0.5 + m.intensity * 0.06), color, a * 0.5);
  }

  // --- a ping's front, while it travels ------------------------------------
  for (const ping of o.state.pings) {
    circle(ctx, cam, ping.origin, ping.radius, '#ffffff', 0.5);
  }

  // --- trails, bodies, vectors ---------------------------------------------
  for (const p of o.state.players) {
    trail(ctx, cam, o.trails[p.id] ?? [], TEAM_COLOR[p.team]);
  }
  for (const p of o.state.players) drawBody(ctx, cam, p, o);

  const b = o.state.ball;
  circle(ctx, cam, b.pos, 0.6, BALL_COLOR, 0.35);
  ctx.fillStyle = BALL_COLOR;
  ctx.beginPath();
  ctx.arc(sx(cam, b.pos), sy(cam, b.pos), 4, 0, Math.PI * 2);
  ctx.fill();
  if (o.showVectors) arrow(ctx, cam, b.pos, b.vel, BALL_COLOR, 0.12);
}

/**
 * One belief grid, drawn as the grid it is.
 *
 * Squares of the real cell size, not dots: a coarse belief has to *look* coarse, or the reader
 * mistakes "he could be anywhere in this block" for "he is at these points". Age is written on
 * the heaviest cell in seconds, because "where does it think he is" and "how old is that
 * thought" are two different questions and the second one is the one that explains the bot's
 * mistakes.
 */
function drawBeliefGrid(ctx: CanvasRenderingContext2D, cam: Camera, cloud: BeliefCloud, mirror: boolean): void {
  const cell = (cloud.cell ?? 0.5) * cam.scale;
  const color = cloud.color ?? (mirror ? '#9d7bff' : '#ff5c8a');
  ctx.save();
  for (const pt of cloud.points) {
    const a = Math.max(0, Math.min(1, pt.weight));
    // Alpha rises as sqrt of the weight, not linearly: a normalised belief spread over a hundred
    // cells has a peak weight of one and a tail of hundredths, and a linear ramp draws the tail
    // as nothing at all — which is exactly the part a reader needs to see.
    ctx.globalAlpha = (mirror ? 0.4 : 0.6) * Math.sqrt(a);
    ctx.fillStyle = color;
    ctx.fillRect(sx(cam, pt.pos) - cell / 2, sy(cam, pt.pos) - cell / 2, cell, cell);
  }
  ctx.globalAlpha = 1;
  const peak = cloud.points[0];
  if (peak) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(mirror ? [2, 3] : []);
    ctx.strokeRect(sx(cam, peak.pos) - cell / 2, sy(cam, peak.pos) - cell / 2, cell, cell);
    ctx.setLineDash([]);
    label(
      ctx,
      `${cloud.about} ${cloud.age.toFixed(1)}s`,
      sx(cam, peak.pos) + cell,
      sy(cam, peak.pos) - 4,
      color,
      9,
    );
  }
  ctx.restore();
}

function drawBody(ctx: CanvasRenderingContext2D, cam: Camera, p: PlayerState, o: TruthOptions): void {
  const color = TEAM_COLOR[p.team];
  // The halo: how far this body can be heard right now — the concept's non-negotiable readout.
  // Only for the player being listened to: four overlapping 30 m rings say nothing to anyone.
  if (o.showRadii && p.loudness > 0 && p.id === o.highlight) {
    circle(ctx, cam, p.pos, p.loudness, color, 0.14);
  }
  ctx.fillStyle = p.id === o.highlight ? '#ffffff' : color;
  ctx.beginPath();
  ctx.arc(sx(cam, p.pos), sy(cam, p.pos), Math.max(4, o.playerRadius * cam.scale), 0, Math.PI * 2);
  ctx.fill();
  // Aim tick.
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx(cam, p.pos), sy(cam, p.pos));
  const tip = { x: p.pos.x + p.aim.x * 0.9, y: p.pos.y + p.aim.y * 0.9 };
  ctx.lineTo(sx(cam, tip), sy(cam, tip));
  ctx.stroke();
  if (o.showVectors) arrow(ctx, cam, p.pos, p.vel, '#ffffff');
  // The gloves. One body per team may stand inside its own arc, and which body it is changes
  // during play — so in the truth view it has to be visible at a glance, or half of what the
  // defence is doing is unreadable.
  if (p.keeper) {
    circle(ctx, cam, p.pos, o.playerRadius * 2.1, '#ffffff', 0.5);
  }
  label(
    ctx,
    `P${p.id}${p.hasBall ? '●' : ''}${p.keeper ? ' GK' : ''}`,
    sx(cam, p.pos) + 8,
    sy(cam, p.pos) - 8,
    color,
    11,
  );
  if (p.charging) circle(ctx, cam, p.pos, 0.8 + p.chargeT, '#ffb703', 0.8);
  if (p.diveT > 0) circle(ctx, cam, p.pos, 0.9, '#ff9d5c', 0.9);
}

export interface PerceivedOptions {
  model: PerceivedModel;
  now: number;
  showRadii: boolean;
  showVectors: boolean;
  playerRadius: number;
  /**
   * Which belief clouds to draw. Four grids on one pane is soup, so this is a filter and not a
   * checkbox: 'opponents' is where the bot thinks they are, 'mirror' is where it thinks they
   * think it is, and reading one against the other is the whole point of the tool. Any other
   * string is matched against the cloud's name, which is how a keyframe isolates the one belief
   * its caption is making a claim about.
   */
  beliefFilter?: string;
}


/**
 * One sound mark, and everything a player has to read off it in a quarter of a second.
 *
 * Four separate readings are packed into one shape, and they are the four questions the concept
 * says a blind player is always asking:
 *
 *   * **where** — the blob sits at the reported position, and the dashed cigar around it is the
 *     honest shape of the error: long along the bearing, short across it;
 *   * **how loud** — the core's size scales with the event's audible radius, so a fumble is
 *     visibly a bigger mistake than a footstep;
 *   * **how fresh** — a mark is born with a single expanding echo ring and a hot core, and once
 *     it is past half its life it stops being filled at all and becomes a hollow, dotted ghost.
 *     Information that has gone stale must *look* stale, or a player acts on a two-second-old
 *     guess believing it to be news;
 *   * **whose** — a known source (a team-mate, the ball, the player's own body) is drawn cool
 *     and labelled; an anonymous one gets the warm palette and a question mark. Telling "my
 *     partner just moved" from "somebody just moved" is the difference between a pass and a
 *     panic.
 *
 * None of it lights the pitch: no gradient reaches the walls, nothing casts, and the geometry
 * around a mark stays exactly as black as it was (concept, law 1 — and it is checked by pixel
 * measurement in the keyframe generator).
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  model: PerceivedModel,
  mark: Mark,
  o: PerceivedOptions,
): void {
  const a = model.markAlpha(mark, o.now);
  if (a <= 0) return;
  const colour = soundColor(mark.kind);
  const age = o.now - mark.born;
  const known = mark.sourceId !== null;
  const core = Math.min(2.4, 0.45 + mark.intensity * 0.06);

  // The echo: one ring leaving the point at birth. It is what makes a new mark register in
  // peripheral vision on a screen that is otherwise almost still.
  if (age < 0.45) {
    const k = age / 0.45;
    circle(ctx, cam, mark.pos, core * (0.5 + k * 2.2), colour, (1 - k) * 0.5 * (mark.self ? 0.5 : 1), [3, 4]);
  }

  if (o.showRadii && mark.sigma > 0) {
    ellipse(ctx, cam, mark.pos, mark.sigma, mark.sigmaBearing, mark.bearing, colour, a * 0.45);
  }

  if (a > 0.5) {
    // Fresh: a filled reading.
    blob(ctx, cam, mark.pos, core, colour, (a - 0.5) * 2 * (mark.self ? 0.35 : 0.8));
  }
  // Stale: the hollow ghost that outlives the reading, so old news never looks like new news.
  circle(ctx, cam, mark.pos, core * 0.5, colour, a * 0.5, a > 0.5 ? undefined : [2, 3]);

  if (mark.relayed) circle(ctx, cam, mark.pos, 0.55, '#7dffa8', a * 0.6);
  // Labels are rationed. A team-mate keeps their name for as long as the mark lives, because
  // "that was my partner" is a fact worth acting on all the way to the end. An anonymous mark
  // gets its question mark only while it is fresh: after a second it is not a person any more,
  // it is a place where somebody was, and a screen full of question marks says nothing.
  if (!mark.self && (known ? a > 0.15 : a > 0.7)) {
    label(
      ctx,
      known ? `P${mark.sourceId}` : '?',
      sx(cam, mark.pos) + 7,
      sy(cam, mark.pos) - 6,
      known ? '#7dffa8' : colour,
      known ? 9 : 11,
    );
  }
}

/**
 * The blind pane. Everything here came out of one `PerceptionFrame` stream.
 *
 * Note what is NOT drawn: walls, creases, goals, the centre line, other bodies, the true ball.
 * Unknown space is black, and it stays black until something makes a noise in it.
 */
export function drawPerceived(ctx: CanvasRenderingContext2D, cam: Camera, o: PerceivedOptions): void {
  clear(ctx, cam);
  const m = o.model;
  const frame = m.frame;
  if (!frame) {
    label(ctx, 'no perception yet', 16, 24);
    return;
  }

  // --- sonar returns: cold, sharp, dying ----------------------------------
  for (const snap of m.sonar) {
    // The volume the ping has checked so far, drawn as a barely-there disc: this is the
    // negative information — everywhere in here that is not a dot is confirmed empty.
    if (snap.checkedRadius > 0) {
      ctx.globalAlpha = 0.05 * Math.max(0, 1 - (o.now - snap.firedAt) / 1.2);
      ctx.fillStyle = '#6fd3e0';
      ctx.beginPath();
      ctx.arc(sx(cam, snap.origin), sy(cam, snap.origin), snap.checkedRadius * cam.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (snap.waveRadius > 0 && o.now - snap.firedAt < 1.2) {
      circle(ctx, cam, snap.origin, snap.waveRadius, '#ffffff', 0.25);
    }
    for (const pt of snap.points) {
      const a = m.sonarAlpha(pt, o.now);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      if (pt.kind === 'player') {
        ctx.fillStyle = pt.sourceId === null ? '#ff5c8a' : '#7dffa8';
        ctx.beginPath();
        ctx.arc(sx(cam, pt.pos), sy(cam, pt.pos), 5, 0, Math.PI * 2);
        ctx.fill();
        label(ctx, pt.sourceId === null ? '?' : `P${pt.sourceId}`, sx(cam, pt.pos) + 7, sy(cam, pt.pos) - 6, ctx.fillStyle as string, 10);
        if (o.showVectors && pt.vel) arrow(ctx, cam, pt.pos, pt.vel, '#7dffa8');
      } else if (pt.kind === 'ball') {
        ctx.fillStyle = BALL_COLOR;
        ctx.fillRect(sx(cam, pt.pos) - 2, sy(cam, pt.pos) - 2, 4, 4);
      } else {
        ctx.fillStyle = pt.kind === 'crease' ? '#2f6f8f' : '#7fd4ff';
        ctx.fillRect(sx(cam, pt.pos) - 1, sy(cam, pt.pos) - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
  }

  // --- sound marks: warm, soft, at the point where the sound happened -----
  for (const mark of m.marks) drawMark(ctx, cam, m, mark, o);

  // --- the ball: never silent, never exact --------------------------------
  // It is the player's only permanent landmark, so it is drawn as an instrument reading and not
  // as a dot: a steady core, a slow breathing halo that says "this source is still sounding",
  // the error cigar, and the tail of where it has been. The breath is what stops the ball from
  // reading as a flicker among the sound marks — the one thing on the pane that is always true
  // has to look like it.
  if (m.ball) {
    trail(ctx, cam, m.ballTrail, BALL_COLOR);
    const breath = 0.55 + 0.45 * Math.sin(o.now * 5.5);
    blob(ctx, cam, m.ball.pos, 0.35 + breath * 0.2, BALL_COLOR, 0.3 + breath * 0.2);
    ellipse(ctx, cam, m.ball.pos, Math.max(0.12, m.ball.sigma), Math.max(0.06, m.ball.sigmaBearing), m.ball.bearing, BALL_COLOR, 0.6);
    ctx.fillStyle = BALL_COLOR;
    ctx.beginPath();
    ctx.arc(sx(cam, m.ball.pos), sy(cam, m.ball.pos), 4, 0, Math.PI * 2);
    ctx.fill();
    if (o.showVectors) arrow(ctx, cam, m.ball.pos, m.ball.vel, BALL_COLOR, 0.12);
  }

  // --- self: the one thing known exactly ----------------------------------
  const self = frame.self;
  trail(ctx, cam, m.selfTrail, '#ffffff');
  if (o.showRadii && self.ownLoudness > 0) circle(ctx, cam, self.pos, self.ownLoudness, '#ffffff', 0.1);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(sx(cam, self.pos), sy(cam, self.pos), Math.max(4, o.playerRadius * cam.scale), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx(cam, self.pos), sy(cam, self.pos));
  const selfTip = { x: self.pos.x + self.aim.x, y: self.pos.y + self.aim.y };
  ctx.lineTo(sx(cam, selfTip), sy(cam, selfTip));
  ctx.stroke();
  if (o.showVectors) arrow(ctx, cam, self.pos, self.vel, '#ffd166');

  // --- the belief overlay slot (empty until a bot fills it) ---------------
  drawControllerDebug(ctx, cam, o);
}

/**
 * Draws whatever a controller chose to expose through `debugSnapshot()`.
 *
 * Nothing fills this in yet — the dummies only publish a label and a marker or two. It is here,
 * wired and drawn, so the belief layer has somewhere to land: clouds of weighted points, an age
 * and a confidence per cloud, plus free-form markers and scored action lists.
 */
export function drawControllerDebug(ctx: CanvasRenderingContext2D, cam: Camera, o: PerceivedOptions): void {
  const debug = o.model.controllerDebug;
  if (!debug) return;
  const filter = o.beliefFilter ?? 'all';
  if (filter !== 'none') {
    for (const cloud of debug.beliefs ?? []) {
      const about = String(cloud.about);
      const mirror = about.startsWith('mirror');
      if (filter === 'opponents' && mirror) continue;
      else if (filter === 'mirror' && !mirror) continue;
      else if (filter !== 'all' && filter !== 'opponents' && filter !== 'mirror' && !about.includes(filter)) continue;
      drawBeliefGrid(ctx, cam, cloud, mirror);
    }
  }
  for (const marker of debug.markers ?? []) {
    const color = marker.color ?? '#9d7bff';
    if (marker.kind === 'circle') circle(ctx, cam, marker.pos, marker.r ?? 0.5, color, 0.8, [2, 2]);
    else if (marker.kind === 'line' && marker.to) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(sx(cam, marker.pos), sy(cam, marker.pos));
      ctx.lineTo(sx(cam, marker.to), sy(cam, marker.to));
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(sx(cam, marker.pos) - 2, sy(cam, marker.pos) - 2, 4, 4);
    }
    if (marker.label) label(ctx, marker.label, sx(cam, marker.pos) + 6, sy(cam, marker.pos) + 12, color, 10);
  }
}
