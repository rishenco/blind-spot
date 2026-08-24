/**
 * What a lidar return actually is, as far as the renderer is concerned.
 *
 * A ping is a wavefront: an origin, a shape (cone about `dir`, or omni when `coneAngleDeg`
 * reaches 360), a reach, and a speed. Nothing a ping reveals exists before the front has
 * physically got there — a dot's birth stamp is `time + distance / waveSpeed`. That is what
 * makes a scan read as an answer arriving rather than a light switch.
 *
 * The lidar is deliberately *not* on the sound bus: spiders do not hear it (concept, perception
 * table). The bus and this type are separate on purpose, and that separation is the design.
 */
export interface LidarPing {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit aim vector; ignored when the ping is omnidirectional. */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  /** Full apex angle in degrees; >= 360 means omnidirectional. */
  readonly coneAngleDeg: number;
  /** How far the front reaches, metres. */
  readonly paintRadius: number;
  /** Front expansion speed, m/s. Readable, not physical: ~25-45 so the sweep can be watched. */
  readonly waveSpeed: number;
  /** Scene clock at emission, seconds. */
  readonly time: number;
  /** Monotonic counter — a stable identity for tooling. */
  readonly seq: number;
}
