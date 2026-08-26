/**
 * The player's one perceptual admission contract for SoundBus events.
 *
 * Audio, world markers and the off-screen compass may render the same admitted event differently,
 * and for different lifetimes, but none may know about an event another rejects by distance.
 * Keeping this outside `audio/` avoids making HUD systems depend on timbre synthesis.
 */
import type { SoundEvent } from './bus';

/** Web Audio's inverse curve is deliberately allowed a quiet final margin before hard culling. */
export const SOUND_CULL_MARGIN = 1.2;

/**
 * Source/kind-specific physical carry. Spider chatter is the pack's long-range giveaway. The
 * fallback mirrors the legacy no-kind classification so old/debug emitters make the same choice.
 */
export function soundCarry(event: Pick<SoundEvent, 'source' | 'kind' | 'loudness'>): number {
  if (event.source !== 'spider') return 1;
  if (event.kind === 'chatter') return 2.6;
  if (event.kind !== undefined) return 1;
  return event.loudness > 5 && event.loudness < 18 ? 2.6 : 1;
}

export function soundDistance(
  event: Pick<SoundEvent, 'x' | 'y' | 'z'>,
  x: number,
  y: number,
  z: number,
): number {
  return Math.hypot(event.x - x, event.y - y, event.z - z);
}

export function soundPerceptionRange(
  event: Pick<SoundEvent, 'source' | 'kind' | 'loudness'>,
): number {
  return Math.max(0, event.loudness) * SOUND_CULL_MARGIN * soundCarry(event);
}

export function isSoundPerceivableAt(
  event: Pick<SoundEvent, 'source' | 'kind' | 'x' | 'y' | 'z' | 'loudness'>,
  x: number,
  y: number,
  z: number,
): boolean {
  return soundDistance(event, x, y, z) <= soundPerceptionRange(event);
}
