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
import type { SoundKind, Vec2 } from '../sim/types';
import type { PlayerState, WorldState } from '../sim/sim';
import type { FieldInfo } from '../sim/types';
import type { PerceivedModel } from './perceived';

export interface Camera {
  ox: number;
  oy: number;
  scale: number;
  w: number;
  h: number;
}

export const TEAM_COLOR = ['#4dd8ff', '#ff9a52'] as const;
export const BALL_COLOR = '#ffd166';

/** Warm for sound, per the inherited language. The sonar is white because it is the loud one. */
export const SOUND_COLOR: Record<SoundKind, string> = {
  'step-walk': '#5c7fa3',
  'step-run': '#7fb2ff',
  brake: '#ff7a5c',
  dive: '#ff9d5c',
  catch: '#7dffa8',
  fumble: '#ff4d6d',
  throw: '#ffb703',
  'ball-hum': '#ffd166',
  'ball-wall': '#ffe8a3',
  sonar: '#ffffff',
  whistle: '#ff7ae0',
};

export function makeCamera(width: number, height: number, field: FieldInfo, pad = 24): Camera {
  const scale = Math.min((width - pad * 2) / field.width, (height - pad * 2) / field.height);
  return { ox: width / 2, oy: height / 2, scale, w: width, h: height };
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
    const color = SOUND_COLOR[m.kind];
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
  label(ctx, `P${p.id}${p.hasBall ? '●' : ''}`, sx(cam, p.pos) + 8, sy(cam, p.pos) - 8, color, 11);
  if (p.charging) circle(ctx, cam, p.pos, 0.8 + p.chargeT, '#ffb703', 0.8);
  if (p.diveT > 0) circle(ctx, cam, p.pos, 0.9, '#ff9d5c', 0.9);
}

export interface PerceivedOptions {
  model: PerceivedModel;
  now: number;
  showRadii: boolean;
  showVectors: boolean;
  playerRadius: number;
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
  for (const mark of m.marks) {
    const a = m.markAlpha(mark, o.now);
    if (a <= 0) continue;
    const color = SOUND_COLOR[mark.kind];
    if (o.showRadii && mark.sigma > 0) {
      ellipse(ctx, cam, mark.pos, mark.sigma, mark.sigmaBearing, mark.bearing, color, a * 0.5);
    }
    blob(ctx, cam, mark.pos, Math.min(2.4, 0.45 + mark.intensity * 0.06), color, a * (mark.self ? 0.35 : 0.75));
    if (mark.relayed) circle(ctx, cam, mark.pos, 0.5, '#7dffa8', a * 0.6);
  }

  // --- the ball: never silent, never exact --------------------------------
  if (m.ball) {
    trail(ctx, cam, m.ballTrail, BALL_COLOR);
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
  for (const cloud of debug.beliefs ?? []) {
    const alpha = Math.max(0.05, Math.min(1, cloud.confidence));
    for (const pt of cloud.points) {
      ctx.globalAlpha = alpha * Math.max(0.05, Math.min(1, pt.weight));
      ctx.fillStyle = '#ff5c8a';
      ctx.fillRect(sx(cam, pt.pos) - 1.5, sy(cam, pt.pos) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
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
