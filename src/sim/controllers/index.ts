/**
 * The controller registry.
 *
 * A match is reproducible from `{ seed, config, controller names }`, so controllers have to be
 * addressable by name — the batch runner takes names on the command line and a replay stores
 * names, not closures. Anything new (the real bot, when it arrives) registers here and is
 * immediately available to the playground, the batch runner and the keyframe scenarios.
 */
import type { ControllerFactory } from '../match';
import { idleIntent, type Controller, type ControllerContext } from '../types';
import { BallChaser, Goalie, RandomWalker, Statue, Striker } from './dummies';

export { BallChaser, Goalie, RandomWalker, Statue, Striker } from './dummies';
export { Scripted, scripted, type ScriptAction } from './scripted';

export const CONTROLLERS: Record<string, ControllerFactory> = {
  statue: (ctx: ControllerContext): Controller => new Statue(ctx),
  ballchaser: (ctx: ControllerContext): Controller => new BallChaser(ctx),
  goalie: (ctx: ControllerContext): Controller => new Goalie(ctx),
  randomwalker: (ctx: ControllerContext): Controller => new RandomWalker(ctx),
  striker: (ctx: ControllerContext): Controller => new Striker(ctx),
  /**
   * The slot a human drives. It stands still until something calls `Match.setExternalIntent`
   * for it, which is exactly what the playground does — and what a replay does when it plays
   * the recorded keystrokes back.
   */
  human: (): Controller => ({
    name: 'human',
    decide: () => idleIntent(),
    debugSnapshot: () => ({ label: 'driven from outside' }),
  }),
};

export function makeController(name: string): { name: string; make: ControllerFactory } {
  const make = CONTROLLERS[name];
  if (!make) throw new Error(`unknown controller: ${name} (have: ${Object.keys(CONTROLLERS).join(', ')})`);
  return { name, make };
}

/** Builds a full roster from two strategy names: team 0 all `a`, team 1 all `b`. */
export function roster(a: string, b: string, teamSize: number): { name: string; make: ControllerFactory }[] {
  const out: { name: string; make: ControllerFactory }[] = [];
  for (let i = 0; i < teamSize; i++) out.push(makeController(a));
  for (let i = 0; i < teamSize; i++) out.push(makeController(b));
  return out;
}
