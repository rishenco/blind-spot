/**
 * The player's cockpit: everything drawn for a human that is not the world.
 *
 * The screen is black and stays black (concept, law 1). Nothing in here lights the pitch,
 * casts a shadow or reveals a body — it is drawn *on the player*, in the half-metre the concept
 * grants to touch, or clamped to the edges of the pane as instrument text. The test for whether
 * a HUD element is legal is simple: could a blindfolded person know this about themselves?
 * Their own effort, their own noise, their own cooldown — yes. Anything about anybody else —
 * no, and it is not here.
 *
 * It is only ever drawn over the pane of the player a human is actually driving, which is also
 * why the keyframe generator's "the blind pane is overwhelmingly unknown" measurement is
 * unaffected: those scenarios have no human in them.
 */
import type { Feel } from './feel';
import { loudnessBand } from './feel';
import type { Camera } from './draw';
import { sx, sy } from './draw';
import type { PerceptionFrame } from '../sim/types';

const CHARGE_COLD = '#ffb703';
const CHARGE_HOT = '#ff5c3a';
const QUIET = '#5c7fa3';
const LOUD = '#ff7a5c';

export interface HudOptions {
  feel: Feel;
  frame: PerceptionFrame;
  now: number;
  /** Draw the corner instruments and the tutor line. Off for the storyboard close-ups. */
  chrome?: boolean;
  /** Draw the faint remembered court. On by default; see `drawCourt` for why it is allowed. */
  court?: boolean;
}


/**
 * The remembered court: walls, goals and creases, at the edge of visibility.
 *
 * This is the one part of the cockpit that could look like a violation of law 1, so it is worth
 * being explicit. It is not the world being revealed — it is the player's memory of a pitch they
 * are standing on, and the perception contract already says so in as many words: `FieldInfo`
 * ships inside every `PerceptionFrame` with the comment "the pitch is not a secret — players
 * know the field they are standing on". A blindfolded handball player knows which way they are
 * attacking. Withholding that does not create tension, it creates nausea: without it a person
 * has no frame of reference at all, cannot tell a wall bounce from a pass, and cannot answer the
 * only question that makes the ball worth having — which end do I shoot at.
 *
 * It is drawn below the content threshold the keyframe generator measures (a hair above black),
 * it never brightens near a sound mark, and it can be switched off — so the law's actual
 * subject, "what is happening right now", stays entirely a matter of what made a noise.
 */
function drawCourt(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const f = o.frame.field;
  const attacking = f.goalCentre[o.frame.self.team === 0 ? 1 : 0];
  const defending = f.goalCentre[o.frame.self.team];
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = '#111c26';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 8]);
  ctx.strokeRect(
    sx(cam, { x: -f.halfWidth, y: 0 }),
    sy(cam, { x: 0, y: f.halfHeight }),
    f.width * cam.scale,
    f.height * cam.scale,
  );
  ctx.setLineDash([3, 9]);
  for (const g of [attacking, defending]) {
    ctx.beginPath();
    ctx.arc(sx(cam, g), sy(cam, g), f.creaseRadius * cam.scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // The two goal mouths are the only things a player really has to keep straight, so they get
  // a colour: gold is the one to shoot at, cold is the one to defend.
  const mouth = (g: { x: number; y: number }, colour: string, alpha: number): void => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx(cam, { x: g.x, y: -f.goalWidth / 2 }), sy(cam, { x: g.x, y: -f.goalWidth / 2 }));
    ctx.lineTo(sx(cam, { x: g.x, y: f.goalWidth / 2 }), sy(cam, { x: g.x, y: f.goalWidth / 2 }));
    ctx.stroke();
    ctx.restore();
  };
  mouth(attacking, '#4a3a16', 0.9);
  mouth(defending, '#1b2735', 0.9);

  drawBoards(ctx, cam, o);
}

/**
 * The boards, the way blind football uses them.
 *
 * In the real sport the side lines are physical barriers precisely so that a player can find out
 * where he is by touching one. The pitch outline above is memory and stays at the edge of
 * visibility; THIS is the touch channel the concept already grants ("контур в ~0.5 м вокруг
 * тела"), extended along the one surface that is always exactly where it was: a wall within
 * reach lights up along its length, brighter the closer it is.
 */
function drawBoards(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const f = o.frame.field;
  const p = o.frame.self.pos;
  const FEEL = 2.2;
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }, gap: number): void => {
    if (gap > FEEL) return;
    const k = 1 - gap / FEEL;
    ctx.save();
    ctx.globalAlpha = 0.15 + 0.55 * k * k;
    ctx.strokeStyle = '#4dd8ff';
    ctx.lineWidth = 1 + 2 * k;
    ctx.beginPath();
    ctx.moveTo(sx(cam, a), sy(cam, a));
    ctx.lineTo(sx(cam, b), sy(cam, b));
    ctx.stroke();
    ctx.restore();
  };
  // Only the stretch of wall within arm's reach along the pitch, not the whole side: what is
  // being drawn is a hand on a board, not a floodlight.
  const span = 3.5;
  seg({ x: p.x - span, y: f.halfHeight }, { x: p.x + span, y: f.halfHeight }, f.halfHeight - p.y);
  seg({ x: p.x - span, y: -f.halfHeight }, { x: p.x + span, y: -f.halfHeight }, f.halfHeight + p.y);
  seg({ x: f.halfWidth, y: p.y - span }, { x: f.halfWidth, y: p.y + span }, f.halfWidth - p.x);
  seg({ x: -f.halfWidth, y: p.y - span }, { x: -f.halfWidth, y: p.y + span }, f.halfWidth + p.x);
}

function ring(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  at: { x: number; y: number },
  rM: number,
  colour: string,
  alpha: number,
  width = 1,
  dash?: number[],
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(sx(cam, at), sy(cam, at), Math.max(1, rM * cam.scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  colour: string,
  size = 12,
  align: CanvasTextAlign = 'left',
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(s, x, y);
  ctx.restore();
}

/**
 * The whole cockpit, in one pass.
 *
 * Order matters: the world-space parts sit under the player's own body marker (drawn by
 * `drawPerceived` before this), the screen-space parts sit on top of everything.
 */
export function drawHud(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const self = frame.self;
  const pos = self.pos;
  const chrome = o.chrome ?? true;
  if (o.court ?? true) drawCourt(ctx, cam, o);

  // --- the half-metre of touch the concept grants ------------------------
  // A faint contour around the body. It is the only thing on screen that is always there, and
  // it is the reason a player never feels they have lost their own body in the dark.
  ring(ctx, cam, pos, 0.5, '#ffffff', 0.12, 1);

  // --- own loudness: the ring that says "this is how far away I am audible" ---
  const band = loudnessBand(self.ownLoudness, feel.cfg);
  if (self.ownLoudness > 0.01) {
    const colour = band === 'loud' ? LOUD : QUIET;
    // Two rings: the eased one is the needle, the peak one snaps and decays — so a footfall
    // reads as an event and a sprint reads as a state.
    ring(ctx, cam, pos, feel.loudness, colour, band === 'loud' ? 0.3 : 0.18, 1, [4, 6]);
    if (feel.loudnessPeak > feel.loudness + 0.2) {
      ring(ctx, cam, pos, feel.loudnessPeak, colour, 0.12, 1);
    }
  } else if (feel.silentFor > 0.25) {
    // Silence is a state worth showing, because it is a move: a tight, cold, breathing ring.
    const pulse = 0.55 + 0.45 * Math.sin(o.now * 2.2);
    ring(ctx, cam, pos, 0.85 + pulse * 0.12, '#4dd8ff', 0.22, 1);
  }

  // --- the aim line, and the wind-up on it -------------------------------
  const aimLen = 1.1 + feel.charge * 1.6;
  const tip = { x: pos.x + self.aim.x * aimLen, y: pos.y + self.aim.y * aimLen };
  // A loaded swing counts as "armed" whether or not the ball is in the hand: in `touch` nobody
  // ever holds it, and the whole skill is standing there already wound up.
  const armed = self.hasBall || self.charging;
  ctx.save();
  ctx.globalAlpha = armed ? 0.75 : 0.3;
  ctx.strokeStyle = armed ? mixHex(CHARGE_COLD, CHARGE_HOT, feel.charge) : '#ffffff';
  ctx.lineWidth = armed ? 1 + feel.charge * 2.5 : 1;
  ctx.setLineDash(armed ? [] : [2, 4]);
  ctx.beginPath();
  ctx.moveTo(sx(cam, pos), sy(cam, pos));
  ctx.lineTo(sx(cam, tip), sy(cam, tip));
  ctx.stroke();
  ctx.restore();

  if (self.charging) drawWindup(ctx, cam, o);
  if (feel.releaseFlash > 0) drawRelease(ctx, cam, o);

  // --- the ball leash: bearing and range to the one thing always audible ---
  drawBallLeash(ctx, cam, o);

  // --- the ping's own cost, drawn on the player ---------------------------
  drawPing(ctx, cam, o);

  // --- the body's own state: airborne, recovering, or flat on the floor ----
  drawBodyState(ctx, cam, o);

  if (!chrome) return;

  drawChrome(ctx, cam, o);
}

/**
 * The wind-up.
 *
 * Two readings in one shape, because "how hard" and "am I past the point of a real throw" are
 * different questions: an arc that fills clockwise is the power, and a hard notch on it is
 * `minCharge` — below the notch the release is a lob, above it the throw scales to full speed.
 * The arc lives on the body, at arm's length, so the eye never leaves the player.
 */
function drawWindup(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const pos = frame.self.pos;
  const cx = sx(cam, pos);
  const cy = sy(cam, pos);
  const r = Math.max(14, 1.0 * cam.scale);
  const a0 = -Math.PI / 2;
  const span = Math.PI * 2 * feel.charge;

  ctx.save();
  ctx.lineCap = 'butt';
  // Track.
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = '#2c3a4a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // Fill.
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = mixHex(CHARGE_COLD, CHARGE_HOT, feel.charge);
  ctx.lineWidth = 3 + feel.charge * 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a0 + span);
  ctx.stroke();
  // The commit notch.
  const notch = a0 + Math.PI * 2 * (feel.cfg.minCharge / feel.cfg.maxCharge);
  ctx.globalAlpha = feel.committed ? 1 : 0.5;
  ctx.strokeStyle = feel.committed ? '#ffffff' : '#7e93a7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(notch) * (r - 6), cy + Math.sin(notch) * (r - 6));
  ctx.lineTo(cx + Math.cos(notch) * (r + 6), cy + Math.sin(notch) * (r + 6));
  ctx.stroke();
  // The body leans back into the wind-up: a short tail opposite the aim, growing with power.
  ctx.globalAlpha = 0.5 * feel.charge;
  ctx.strokeStyle = mixHex(CHARGE_COLD, CHARGE_HOT, feel.charge);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const back = { x: pos.x - frame.self.aim.x * (0.4 + feel.charge), y: pos.y - frame.self.aim.y * (0.4 + feel.charge) };
  ctx.lineTo(sx(cam, back), sy(cam, back));
  ctx.stroke();
  ctx.restore();

  text(
    ctx,
    `${Math.round(feel.charge * 100)}%${feel.committed ? '' : ' · lob'}`,
    cx,
    cy + r + 16,
    feel.committed ? '#ffd166' : '#7e93a7',
    11,
    'center',
    0.9,
  );
}

/** The release: a wedge thrown along the aim, and a kick-ring on the body. Lives ~0.45 s. */
function drawRelease(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const k = feel.releaseFlash;
  const pos = frame.self.pos;
  const aim = feel.releaseAim;
  const reach = (1.2 + feel.releasePower * 3.5) * (1 - k * 0.5);
  ctx.save();
  ctx.globalAlpha = k * 0.8;
  ctx.strokeStyle = CHARGE_HOT;
  ctx.lineWidth = 1 + feel.releasePower * 3;
  const spread = 0.35 - feel.releasePower * 0.2;
  for (const s of [-spread, 0, spread]) {
    const dx = aim.x * Math.cos(s) - aim.y * Math.sin(s);
    const dy = aim.x * Math.sin(s) + aim.y * Math.cos(s);
    ctx.beginPath();
    ctx.moveTo(sx(cam, { x: pos.x + dx * 0.5, y: pos.y + dy * 0.5 }), sy(cam, { x: pos.x + dx * 0.5, y: pos.y + dy * 0.5 }));
    ctx.lineTo(sx(cam, { x: pos.x + dx * reach, y: pos.y + dy * reach }), sy(cam, { x: pos.x + dx * reach, y: pos.y + dy * reach }));
    ctx.stroke();
  }
  ctx.restore();
  ring(ctx, cam, pos, 0.6 + (1 - k) * 2.2, CHARGE_HOT, k * 0.5, 2);
}

/**
 * The ball leash.
 *
 * The ball is the one thing a player always has, so it should behave like an instrument and not
 * like a mote of dust: a thin line from the body to the estimate, the range in metres, and —
 * when the ball is close and closing — the catch telegraph.
 *
 * The telegraph is the fairness fix for automatic catching. It draws the AREA the ball can be
 * taken in, live: the ring shrinks as the ball speeds up and goes green when the ball is inside
 * it. A player who misses can see that the ring was smaller than his mistake.
 */
function drawBallLeash(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const self = frame.self;
  const ball = frame.emitters.find((e) => e.kind === 'ball');
  if (!ball) return;
  const pos = self.pos;
  if (!self.hasBall) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 8]);
    ctx.beginPath();
    ctx.moveTo(sx(cam, pos), sy(cam, pos));
    ctx.lineTo(sx(cam, ball.pos), sy(cam, ball.pos));
    ctx.stroke();
    ctx.restore();
  }

  if (!self.hasBall && feel.ballDistance < 4.5) {
    // The reach, drawn live. It shrinks as the ball speeds up, which is the whole rule of
    // catching now that there is no button: a lob can be taken from a metre away, a shot has to
    // hit your hands.
    const reach = feel.reachNow;
    ring(ctx, cam, pos, reach, feel.ballInReach ? '#7dffa8' : '#3f5a75', feel.ballInReach ? 0.8 : 0.25, feel.ballInReach ? 2 : 1, feel.ballInReach ? undefined : [3, 5]);
    if (Number.isFinite(feel.ballTca) && feel.ballTca > 0 && feel.ballTca < 1.2) {
      // A countdown arc: full circle at 1.2 s out, empty at the moment of arrival.
      const cx = sx(cam, pos);
      const cy = sy(cam, pos);
      const rr = Math.max(6, reach * cam.scale);
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#7dffa8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - feel.ballTca / 1.2));
      ctx.stroke();
      ctx.restore();
    }
    if (feel.ballInReach) ring(ctx, cam, pos, reach * 0.62, '#7dffa8', 0.45, 1);
  }

  const readout = feel.catchReadout;
  if (readout) {
    // Below the reach ring, never on top of the body: the verdict has to be readable at the
    // exact moment the body is the brightest thing on the screen.
    const below = sy(cam, pos) + Math.max(28, feel.reachNow * cam.scale + 20);
    text(ctx, readout.text, sx(cam, pos), below, readout.colour, 12, 'center', readout.alpha);
  }
}

/** The ping, from the payer's side: a cooldown arc, and the price, drawn once, loudly. */
function drawPing(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const pos = frame.self.pos;
  const cd = frame.self.pingCooldown;
  const cx = sx(cam, pos);
  const cy = sy(cam, pos);
  const r = Math.max(9, 0.62 * cam.scale);
  if (cd > 0) {
    const u = 1 - cd / feel.cfg.pingCooldown;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#4dd8ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u);
    ctx.stroke();
    ctx.restore();
  } else {
    ring(ctx, cam, pos, 0.62, '#4dd8ff', 0.22, 1, [1, 3]);
  }

  // The scream: an outward red ring, fast and short, saying the whole pitch just got your
  // position for free. It is the only HUD element that is allowed to be alarming.
  const flash = feel.flashes.find((f) => f.kind === 'ping');
  if (flash) {
    const age = feel.t - flash.t;
    const k = Math.max(0, 1 - age / 0.6);
    ring(ctx, cam, pos, 0.8 + (1 - k) * 9, '#ff4d6d', k * 0.6, 2);
    ring(ctx, cam, pos, 0.8 + (1 - k) * 5, '#ffffff', k * 0.35, 1);
  }
}


/**
 * The three states a body can be in that are not "standing there".
 *
 * A dive is 0.4 s of commitment followed by 0.6 s of being useless, and being tackled is
 * seconds of lying on the floor while the game happens without you. Both are things a person
 * feels in their hands as "why is nothing responding", so both get a shape: a streak forward
 * while the dive is live, a draining bar while recovering, and an unmistakable read-out while
 * down. The rules layer is still growing these mechanics; the cockpit has the room reserved and
 * reads them straight off `SelfState`, so a new one shows up here the day it is published.
 */
function drawBodyState(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const self = o.frame.self;
  const pos = self.pos;
  const down = (self as { down?: boolean }).down === true;
  if (self.diving) {
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = '#ff9d5c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx(cam, pos), sy(cam, pos));
    const tip = { x: pos.x + self.vel.x * 0.14, y: pos.y + self.vel.y * 0.14 };
    ctx.lineTo(sx(cam, tip), sy(cam, tip));
    ctx.stroke();
    ctx.restore();
    text(ctx, 'DIVE', sx(cam, pos), sy(cam, pos) - 26, '#ff9d5c', 11, 'center', 0.9);
  } else if (self.recovering) {
    ring(ctx, cam, pos, 0.7, '#ff9d5c', 0.35, 2, [2, 4]);
    text(ctx, 'up…', sx(cam, pos), sy(cam, pos) - 26, '#ff9d5c', 10, 'center', 0.7);
  }
  if (down) {
    ring(ctx, cam, pos, 1.0, '#ff4d6d', 0.5, 2);
    text(ctx, 'DOWN', sx(cam, pos), sy(cam, pos) - 30, '#ff4d6d', 13, 'center', 0.95);
  }
}

/** Corner instruments: score, clock, loudness meter, carry timer, tutor line, flashes. */
function drawChrome(ctx: CanvasRenderingContext2D, cam: Camera, o: HudOptions): void {
  const { feel, frame } = o;
  const self = frame.self;
  const w = cam.w;
  const h = cam.h;

  // Screen flashes: a vignette in the pane, never a wash over the pitch. Black stays black.
  for (const f of feel.flashes) {
    const age = feel.t - f.t;
    const k = Math.max(0, 1 - age / 0.7) * Math.min(1, f.strength);
    if (k <= 0) continue;
    const colour =
      f.kind === 'ping' ? '255,77,109' :
      f.kind === 'fumble' ? '255,77,109' :
      f.kind === 'goal' ? '125,255,168' :
      f.kind === 'conceded' ? '255,154,82' :
      f.kind === 'throw' ? '255,183,3' : null;
    if (!colour) continue;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.66);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(${colour},${(k * 0.3).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // --- loudness meter, bottom left ---------------------------------------
  const band = loudnessBand(self.ownLoudness, feel.cfg);
  const mx = 16;
  const my = h - 26;
  const mw = 132;
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#1b2735';
  ctx.strokeRect(mx, my, mw, 8);
  ctx.restore();
  const fill = Math.min(1, feel.loudness / feel.cfg.runLoud);
  ctx.fillStyle = band === 'loud' ? LOUD : band === 'quiet' ? QUIET : '#4dd8ff';
  ctx.globalAlpha = 0.85;
  ctx.fillRect(mx + 1, my + 1, Math.max(0, (mw - 2) * fill), 6);
  ctx.globalAlpha = 1;
  // The walk notch: the line between "audible at three metres" and "audible at nine".
  const notch = mx + 1 + (mw - 2) * (feel.cfg.walkLoud / feel.cfg.runLoud);
  ctx.strokeStyle = '#7e93a7';
  ctx.beginPath();
  ctx.moveTo(notch, my - 2);
  ctx.lineTo(notch, my + 10);
  ctx.stroke();
  // A carrier is a special case worth its own words: their loudness reading is the ball's, not
  // their own, and it covers the whole pitch. "HEARD AT 30 M" is technically right and reads as
  // a broken meter; the truth is simpler and much more alarming.
  text(
    ctx,
    self.hasBall
      ? 'THE BALL SINGS — THEY ALL KNOW WHERE YOU ARE'
      : band === 'silent'
        ? `SILENT · ${feel.silentFor.toFixed(1)}s`
        : `HEARD AT ${self.ownLoudness.toFixed(0)} m`,
    mx,
    my - 6,
    self.hasBall ? '#ffd166' : band === 'loud' ? LOUD : band === 'silent' ? '#4dd8ff' : QUIET,
    11,
  );

  // --- carry timer: the five seconds the rules give a carrier ------------
  // Drawn as a bar that empties, not as a number that counts: a person with a ball in their
  // hands and two defenders somewhere in the dark has no attention left for arithmetic.
  if (self.hasBall && feel.cfg.carryTimeout > 0) {
    const left = Math.max(0, feel.cfg.carryTimeout - feel.carryFor);
    const u = left / feel.cfg.carryTimeout;
    const bw = 132;
    const bx = w - 16 - bw;
    const by = h - 26;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#1b2735';
    ctx.strokeRect(bx, by, bw, 8);
    ctx.restore();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = u < 0.3 ? '#ff4d6d' : '#ffd166';
    ctx.fillRect(bx + 1 + (bw - 2) * (1 - u), by + 1, Math.max(0, (bw - 2) * u), 6);
    ctx.globalAlpha = 1;
    text(
      ctx,
      u < 0.35 ? `LET GO — ${left.toFixed(1)}s` : 'BALL — pass it or shoot it',
      w - 16,
      by - 6,
      u < 0.35 ? '#ff4d6d' : '#ffd166',
      11,
      'right',
    );
  }

  // --- the named job, top centre -----------------------------------------
  // The one thing on screen that answers "what am I supposed to be doing". It sits above
  // everything else, it changes rarely (see `Feel.updateTask`) and it is two or three words:
  // a person with a black screen and no idea where anybody is has no attention to spare for a
  // sentence. Nothing in it is intel — see `Task`.
  const task = feel.task;
  if (task) {
    const age = feel.t - task.since;
    const alpha = Math.min(1, age * 4);
    text(ctx, task.text, w / 2, 34, task.colour, 20, 'center', alpha * 0.95);
    if (task.why) text(ctx, task.why, w / 2, 50, '#7e93a7', 11, 'center', alpha * 0.7);
  }

  // --- the tutor line, centred, one at a time ----------------------------
  const hint = feel.activeHint;
  if (hint) {
    const age = feel.t - hint.shownAt;
    const alpha = Math.min(1, age * 3) * Math.max(0, Math.min(1, (5 - age) * 1.5));
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = '#0b1017';
    ctx.strokeStyle = '#1b2735';
    const pad = 10;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(hint.text).width;
    ctx.fillRect(w / 2 - tw / 2 - pad, h - 74, tw + pad * 2, 24);
    ctx.strokeRect(w / 2 - tw / 2 - pad, h - 74, tw + pad * 2, 24);
    ctx.restore();
    text(ctx, hint.text, w / 2, h - 58, '#cfe2f2', 12, 'center', alpha);
  }
}

/** Linear blend of two `#rrggbb` strings. Cheap, and it keeps the palette in one place. */
function mixHex(a: string, b: string, k: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const out = pa.map((v, i) => Math.round(v + (pb[i]! - v) * Math.max(0, Math.min(1, k))));
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}
