/**
 * The per-frame projection state every Blueprint layer reads.
 *
 * One object, built once and mutated in place: the matter layer, the event layer and the dog all
 * have to agree about where the camera is, how big a metre is on screen and which slice of the
 * world is allowed to exist this frame. Two layers computing that separately is how a mark ends up
 * drawn at a scale or a range the geometry it annotates is not.
 *
 * `camPos` is a plain array that is written in place and handed to the uniforms by REFERENCE — no
 * per-frame allocation anywhere in the draw path (engine-plan §10).
 */
export interface BlueprintFrame {
  now: number;
  /** Mutated in place; the same array instance is the value of every `uCamPos` uniform. */
  readonly camPos: number[];
  /** Pixels per metre at one metre of depth: `(viewH/2) / tan(fov/2)`, in CSS px. */
  projScale: number;
  pixelRatio: number;
  /** The near-field dot cap in CSS px — nothing in the event layer may outgrow a splat. */
  capPx: number;
  floorCentre: number;
  floorSpan: number;
  /** True when the comfort setting is on: no strobes, no flashes, pulses become fades. */
  calm: boolean;
}

export const makeFrame = (): BlueprintFrame => ({
  now: 0,
  camPos: [0, 0, 0],
  projScale: 500,
  pixelRatio: 1,
  capPx: 9,
  floorCentre: 0,
  floorSpan: 0,
  calm: false,
});
