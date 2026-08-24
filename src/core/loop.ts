/**
 * Main loop: a fixed-timestep simulation driven by an accumulator, rendered every frame.
 *
 * Simulation determinism (and therefore movement feel) must not depend on display refresh
 * rate, so `fixedUpdate` always receives exactly `stepSeconds`. Rendering gets the leftover
 * fraction as `alpha` for interpolation.
 */

export interface LoopHandlers {
  fixedUpdate(dt: number): void;
  render(alpha: number): void;
}

export interface LoopOptions {
  /** Simulation rate in Hz. */
  hz?: number;
  /** Upper bound on real time consumed by one frame, in seconds (spiral-of-death guard). */
  maxFrameSeconds?: number;
}

export class Loop {
  readonly stepSeconds: number;
  private readonly maxFrameSeconds: number;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Smoothed frames per second, for the debug HUD. */
  fps = 0;
  /** Sim ticks executed in the most recent frame. */
  ticksLastFrame = 0;

  constructor(
    private readonly handlers: LoopHandlers,
    options: LoopOptions = {},
  ) {
    this.stepSeconds = 1 / (options.hz ?? 120);
    this.maxFrameSeconds = options.maxFrameSeconds ?? 0.25;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    let frameSeconds = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0) frameSeconds = 0;
    // A long stall (tab hidden, breakpoint) is dropped rather than simulated in bulk.
    if (frameSeconds > this.maxFrameSeconds) frameSeconds = this.maxFrameSeconds;

    if (frameSeconds > 0) {
      const instantFps = 1 / frameSeconds;
      this.fps = this.fps === 0 ? instantFps : this.fps + (instantFps - this.fps) * 0.1;
    }

    this.accumulator += frameSeconds;
    let ticks = 0;
    while (this.accumulator >= this.stepSeconds) {
      this.handlers.fixedUpdate(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      ticks++;
    }
    this.ticksLastFrame = ticks;

    this.handlers.render(this.accumulator / this.stepSeconds);
  };
}
