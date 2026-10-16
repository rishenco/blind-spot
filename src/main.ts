import { Game } from './game/game';

const game = new Game();
// Debug/test handle (used by scripts/play.mjs).
(window as unknown as { __game: Game }).__game = game;
