// In-match roguelite draft. Every card changes what you *do*, never a damage number.

export interface Card { id: string; tier: 1 | 2 | 3; name: string; text: string }

export const CARDS: Card[] = [
  // Tier 1 — perception stance
  { id: 'longlens', tier: 1, name: 'LONG LENS', text: 'Pulse narrows to 35° but reaches 45m. Own the hallways.' },
  { id: 'widelens', tier: 1, name: 'WIDE LENS', text: 'Pulse widens to 110° but only reaches 18m. Own the rooms.' },
  { id: 'softstep', tier: 1, name: 'SOFT STEP', text: 'Walking is silent. Sprinting is not.' },
  { id: 'keenear',  tier: 1, name: 'KEEN EAR',  text: 'You hear footsteps from twice as far.' },

  // Tier 2 — counter-intelligence
  { id: 'retort',   tier: 2, name: 'RETORT',    text: 'A pulse that captures you returns their full silhouette to you.' },
  { id: 'coldblood',tier: 2, name: 'COLD BLOOD',text: 'Crouched and perfectly still, enemy pulses do not see you.' },
  { id: 'tremor',   tier: 2, name: 'TREMOR SENSE', text: 'A sprinting enemy within 12m reveals themselves every step.' },
  { id: 'phantom',  tier: 2, name: 'PHANTOM SHARD', text: 'Your decoys return full silhouettes and sprint-loud steps.' },

  // Tier 3 — power plays
  { id: 'overpulse',tier: 3, name: 'OVERPULSE', text: 'Pulse becomes 360° at 20m. Cooldown 8s.' },
  { id: 'ghostrounds', tier: 3, name: 'GHOST ROUNDS', text: 'Your tracers and impacts are invisible to the enemy.' },
  { id: 'extrapolator', tier: 3, name: 'EXTRAPOLATOR', text: 'Ghosts show a predicted path from their captured velocity.' },
  { id: 'deadsong', tier: 3, name: 'DEAD SONG', text: 'Carrying the relic, you sing every 8s, and only as a trace.' },
];

export const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

/** Pick 3 of the tier's 4 cards, excluding anything already held. */
export function draftFor(tier: 1 | 2 | 3, held: Set<string>, rnd: () => number): Card[] {
  const pool = CARDS.filter((c) => c.tier === tier && !held.has(c.id));
  const out: Card[] = [];
  const p = [...pool];
  while (out.length < 3 && p.length) out.push(...p.splice(Math.floor(rnd() * p.length), 1));
  return out;
}

/** Pulse shape after upgrades. */
export function pulseShape(up: Set<string>): { halfDeg: number; range: number; cd: number } {
  if (up.has('overpulse')) return { halfDeg: 180, range: 20, cd: 8 };
  if (up.has('longlens')) return { halfDeg: 17.5, range: 45, cd: 4 };
  if (up.has('widelens')) return { halfDeg: 55, range: 18, cd: 4 };
  return { halfDeg: 35, range: 28, cd: 4 };
}
