import { Carry, defaultCarryTunables } from '../../src/carry/carry';
import { StaticWorld } from '../../src/core/collision';
import { SoundBus, type SoundEvent } from '../../src/events/bus';
import { PropWorld, defaultPropTunables, loadRapier, type PropTunables } from '../../src/props/props';
import { archetypeByName } from '../../src/props/shapes';

const NAMES = [
  'bottle', 'flask', 'jar', 'can', 'paint-tin', 'canister', 'bucket', 'barrel', 'keg',
  'gas-cylinder', 'pipe', 'spool', 'pallet', 'crate', 'toolbox',
] as const;

export interface ThrowResult {
  name: string;
  mass: number;
  span: number;
  carryable: boolean;
  dynamic: boolean;
  awake: boolean;
  events: SoundEvent[];
  stats: ReturnType<PropWorld['getStats']>;
}

export async function runThrowMatrix(quietForce?: number): Promise<ThrowResult[]> {
  const R = await loadRapier();
  const out: ThrowResult[] = [];
  for (const name of NAMES) {
    const arch = archetypeByName(name);
    const bus = new SoundBus();
    const events: SoundEvent[] = [];
    bus.subscribe((e) => { if (e.source === 'prop-impact') events.push(e); });
    const tunables: PropTunables = { ...defaultPropTunables(), cap: 1 };
    if (quietForce !== undefined) tunables.quietForce = quietForce;
    const world = new PropWorld(R, new StaticWorld(), bus, 77, tunables, [
      { arch, x: 0, y: 0.005, z: 0 },
    ]);
    world.settle(1);

    const carry = new Carry(world, defaultCarryTunables());
    const basis = [0, 1.62, 0, 1, 0, 0, 0, 0, 1] as const;
    const carryable = carry.candidate(basis[0], basis[1], basis[2]) === 0;
    if (!carryable) {
      out.push({
        name, mass: world.massOf(0), span: world.spanOf(0), carryable: false,
        dynamic: true, awake: false, events: [], stats: { ...world.getStats() },
      });
      world.dispose();
      continue;
    }
    if (carry.toggle(...basis) !== 'picked') throw new Error(`${name}: eligible controlled body was not picked`);
    carry.update(...basis);
    let now = 0;
    for (let i = 0; i < 2; i++) { now += 1 / 60; world.step(1 / 60, now); }
    if (carry.toggle(...basis) !== 'thrown') throw new Error(`${name}: controlled body was not thrown`);
    const dynamic = !world.isCarried(0);
    let awake = world.getStats().awake > 0;
    for (let i = 0; i < 150 && events.length === 0; i++) {
      now += 1 / 60;
      world.step(1 / 60, now);
      awake ||= world.getStats().awake > 0;
    }
    out.push({
      name,
      mass: world.massOf(0),
      span: world.spanOf(0),
      carryable,
      dynamic,
      awake,
      events: [...events],
      stats: { ...world.getStats() },
    });
    world.dispose();
  }
  return out;
}

/** Negative keyframe: an eligible body released at rest 5 mm above the floor is not a throw. */
export async function runPowerlessRelease(): Promise<{
  events: number;
  stats: ReturnType<PropWorld['getStats']>;
}> {
  const R = await loadRapier();
  const arch = archetypeByName('can');
  const bus = new SoundBus();
  let events = 0;
  bus.subscribe((e) => { if (e.source === 'prop-impact') events++; });
  const world = new PropWorld(R, new StaticWorld(), bus, 91, { ...defaultPropTunables(), cap: 1 }, [
    { arch, x: 0, y: 0.005, z: 0 },
  ]);
  world.settle(1);
  const carry = new Carry(world, defaultCarryTunables());
  if (carry.toggle(0, 1.62, 0, 1, 0, 0, 0, 0, 1) !== 'picked') {
    throw new Error('powerless control: can was not picked');
  }
  carry.dropInPlace();
  let now = 0;
  for (let i = 0; i < 30; i++) { now += 1 / 60; world.step(1 / 60, now); }
  const result = { events, stats: { ...world.getStats() } };
  world.dispose();
  return result;
}
