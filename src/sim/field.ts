/**
 * The pitch: a rectangle with a goal mouth in each short wall and a forbidden arc in front of
 * each goal. There are no obstacles — that is a decision, not an omission (concept, "Поле").
 *
 * Geometry lives here so both the simulation and the ping sampler read the same shape, and so
 * the truth renderer and the perceived renderer cannot drift apart about where a wall is.
 */
import type { FieldConfig } from './config';
import type { FieldInfo, TeamId, Vec2 } from './types';

export function makeField(cfg: FieldConfig): FieldInfo {
  const halfWidth = cfg.width / 2;
  const halfHeight = cfg.height / 2;
  return {
    width: cfg.width,
    height: cfg.height,
    halfWidth,
    halfHeight,
    goalWidth: cfg.goalWidth,
    creaseRadius: cfg.creaseRadius,
    goalCentre: [
      { x: -halfWidth, y: 0 },
      { x: halfWidth, y: 0 },
    ],
  };
}

/** Which goal a team attacks (the one it does NOT defend). */
export const attackingGoal = (field: FieldInfo, team: TeamId): Vec2 =>
  field.goalCentre[team === 0 ? 1 : 0];

export const defendingGoal = (field: FieldInfo, team: TeamId): Vec2 => field.goalCentre[team];

/** True when a point is inside either crease (the arc nobody may enter). */
export function insideCrease(field: FieldInfo, p: Vec2, margin = 0): boolean {
  for (const g of field.goalCentre) {
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    if (dx * dx + dy * dy < (field.creaseRadius + margin) * (field.creaseRadius + margin)) {
      return true;
    }
  }
  return false;
}

/** True when a point is inside the crease of goal `index` (the goal that team defends). */
export function insideCreaseOf(field: FieldInfo, index: number, p: Vec2, margin = 0): boolean {
  const g = field.goalCentre[index];
  if (!g) return false;
  const dx = p.x - g.x;
  const dy = p.y - g.y;
  const r = field.creaseRadius + margin;
  return dx * dx + dy * dy < r * r;
}

/**
 * Keeps a body inside the playable area: the rectangle inset by its radius, minus the two
 * creases. Mutates `pos`/`vel` and reports whether it had to push (so the caller can decide
 * whether that counts as an audible scrape — currently it does not).
 *
 * `creaseAccess` is the one exception in the rulebook: the goalkeeper of team N may stand inside
 * the crease of goal N and nobody else may stand in either. Pass -1 for an ordinary body.
 */
export function confineBody(
  field: FieldInfo,
  pos: Vec2,
  vel: Vec2,
  radius: number,
  creaseAccess = -1,
): boolean {
  let touched = false;
  const maxX = field.halfWidth - radius;
  const maxY = field.halfHeight - radius;
  if (pos.x < -maxX) {
    pos.x = -maxX;
    if (vel.x < 0) vel.x = 0;
    touched = true;
  } else if (pos.x > maxX) {
    pos.x = maxX;
    if (vel.x > 0) vel.x = 0;
    touched = true;
  }
  if (pos.y < -maxY) {
    pos.y = -maxY;
    if (vel.y < 0) vel.y = 0;
    touched = true;
  } else if (pos.y > maxY) {
    pos.y = maxY;
    if (vel.y > 0) vel.y = 0;
    touched = true;
  }
  for (let gi = 0; gi < field.goalCentre.length; gi++) {
    if (gi === creaseAccess) continue;
    const g = field.goalCentre[gi]!;
    const dx = pos.x - g.x;
    const dy = pos.y - g.y;
    const d2 = dx * dx + dy * dy;
    const r = field.creaseRadius + radius;
    if (d2 < r * r) {
      const d = Math.sqrt(d2);
      touched = true;
      if (d < 1e-6) {
        // Dead centre of a goal: push along the pitch's long axis, away from the wall.
        pos.x = g.x + (g.x < 0 ? r : -r);
      } else {
        pos.x = g.x + (dx / d) * r;
        pos.y = g.y + (dy / d) * r;
        const vn = (vel.x * dx + vel.y * dy) / d;
        if (vn < 0) {
          vel.x -= (vn * dx) / d;
          vel.y -= (vn * dy) / d;
        }
      }
    }
  }
  return touched;
}

export type WallAxis = 'x' | 'y';

/** True when a point on a short wall is inside the goal mouth (and so not a wall at all). */
export const inGoalMouth = (field: FieldInfo, y: number): boolean =>
  Math.abs(y) <= field.goalWidth / 2;

/**
 * Samples the wall outline as points, for a ping return. Only points within `range` of the
 * origin are produced; the goal mouths are gaps, and the creases are sampled as their own arc
 * so the rule the player must not cross is legible on screen.
 */
export function sampleGeometry(
  field: FieldInfo,
  origin: Vec2,
  range: number,
  step: number,
  out: { pos: Vec2; kind: 'wall' | 'crease' }[],
): void {
  const r2 = range * range;
  const push = (x: number, y: number, kind: 'wall' | 'crease') => {
    const dx = x - origin.x;
    const dy = y - origin.y;
    if (dx * dx + dy * dy <= r2) out.push({ pos: { x, y }, kind });
  };
  // Long walls (top and bottom), full length.
  for (let x = -field.halfWidth; x <= field.halfWidth + 1e-6; x += step) {
    push(x, -field.halfHeight, 'wall');
    push(x, field.halfHeight, 'wall');
  }
  // Short walls, skipping the goal mouths.
  for (let y = -field.halfHeight; y <= field.halfHeight + 1e-6; y += step) {
    if (inGoalMouth(field, y)) continue;
    push(-field.halfWidth, y, 'wall');
    push(field.halfWidth, y, 'wall');
  }
  // Crease arcs, sampled by walking the chord — no trigonometry, and the spacing stays even
  // enough for a dotted arc.
  for (const g of field.goalCentre) {
    const rad = field.creaseRadius;
    const n = Math.max(8, Math.round((Math.PI * rad) / step));
    for (let i = 0; i <= n; i++) {
      // Parametrise by y across the diameter and take both x branches: two half-arcs, even in y.
      const y = -rad + (2 * rad * i) / n;
      const inside = rad * rad - y * y;
      if (inside <= 0) continue;
      const dx = Math.sqrt(inside);
      const x = g.x < 0 ? g.x + dx : g.x - dx;
      if (Math.abs(y) <= field.halfHeight) push(x, y, 'crease');
    }
  }
}
