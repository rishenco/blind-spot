import { edgeDistance } from './game/arena';
import { Game } from './game/game';

const game = new Game();
// Debug/test handle (used by scripts/play.mjs).
(window as unknown as { __game: Game }).__game = game;
// Test hook: plateau rim check for headless bots.
(game as unknown as { __edge: (x: number, z: number) => boolean }).__edge = (x, z) => edgeDistance(x, z) > 0;
