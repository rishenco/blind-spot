/**
 * Which dogs and which props are live this run (engine-plan §7, §8).
 *
 * A patrolling dog is a walking lantern: it emits `dogGait` every 0.8 m for as long as it exists,
 * and a beacon hums every 4 s whether or not anyone is listening. Both are correct behaviour and
 * both are a problem for a REPRODUCIBLE capture — a route that was recorded in a world with no
 * other emitters cannot be replayed in one that has them, because paint is a shared buffer and the
 * dot count is the sum of everything that ever sounded.
 *
 * So membership is explicit rather than implied, and the rule is stated once here instead of being
 * re-derived by the boot layer, the scripted harness and the specs:
 *
 *   parameter absent   -> a scripted run gets what the SCRIPT declares (nothing, by default);
 *                         a human run gets the map's own defaults.
 *   `none` (or empty)  -> nothing runs.
 *   `all`              -> everything the map authors runs.
 *   a comma list       -> exactly those ids, in map order, unknown ids dropped.
 *
 * Ids are dropped silently rather than warned about: this is parsed from a URL a person typed, and
 * a console this milestone's captures assert is clean is worth more than a typo report.
 *
 * The map's order is always the output order, never the parameter's — two URLs naming the same set
 * must produce the same spawn order, or the run is only deterministic by coincidence.
 */

export interface RosterRequest {
  /** Raw URL parameter, or null when it was not given at all. */
  readonly param: string | null;
  /** True when a script is driving the run (`?sim=…`). */
  readonly scripted: boolean;
  /** What the script declares, if it declares anything. */
  readonly scriptRoster?: readonly string[] | undefined;
  /** Every id the map authors, in map order. */
  readonly known: readonly string[];
  /** What runs when nobody says otherwise (dogs: `defaultOn` routes; props: all of them). */
  readonly defaults: readonly string[];
}

export function resolveRoster(req: RosterRequest): string[] {
  const known = new Set(req.known);
  const order = (ids: Iterable<string>): string[] => {
    const want = new Set<string>();
    for (const id of ids) if (known.has(id)) want.add(id);
    return req.known.filter((id) => want.has(id));
  };

  if (req.param === null) {
    if (req.scripted) return order(req.scriptRoster ?? []);
    return order(req.defaults);
  }

  const raw = req.param.trim().toLowerCase();
  if (raw === '' || raw === 'none') return [];
  if (raw === 'all') return [...req.known];
  return order(
    req.param
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
