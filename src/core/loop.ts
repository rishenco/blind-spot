/**
 * Main loop: a fixed-timestep simulation driven by an accumulator, rendered every frame.
 *
 * Simulation determinism (and therefore movement feel) must not depend on display refresh
 * rate, so `fixedUpdate` always receives exactly `stepSeconds`. Rendering gets the leftover
 * fraction as `alpha` for interpolation.
 *
 * The loop has a second, test-only gear. Wall-clock pacing means the amount of *simulated* time
 * behind a given wall-clock duration depends on how busy the machine was — a frame longer than
 * `maxFrameSeconds` is dropped rather than banked, so a slow host silently simulates less. That
 * is correct for a player (a stall must not teleport the world) and useless for a test: a
 * screenshot taken "800 ms after the ping" is a picture of an unknown instant. `suspend` stops
 * the accumulator, `step` advances the simulation by an exact number of ticks, and frames keep
 * being drawn throughout — the renderer, the GPU path and the event loop are all still the real
 * ones, and only the pacing is the caller's. Nothing enters this gear unless something calls
 * `suspend` or `step`.
 */

export interface LoopHandlers {
  fixedUpdate(dt: number): void;
  /** Poses the frame: cameras, view-dependent uniforms. Cheap, and safe to call off-frame. */
  render(alpha: number): void;
  /**
   * Draws the posed frame. Split from `render` so a stepped tick can pose the world — and be
   * read back — without paying for a GPU frame that the display clock is about to draw anyway.
   */
  draw?(): void;
  /**
   * Finishes work the loop would otherwise let amortise across several frames.
   *
   * Called after every *stepped* tick and never during wall-clock pacing. Amortised work is
   * budgeted in milliseconds, which is exactly the wall-clock dependence stepping exists to
   * remove: without this, "how much of the room is known after N ticks" would still be a
   * question about the host. With it, a stepped tick is a settled tick.
   */
  settleTick?(): void;
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
  private stepping = false;

  /** Smoothed frames per second, for the debug HUD. */
  fps = 0;
  /** Sim ticks executed in the most recent frame. */
  ticksLastFrame = 0;
  /** Sim ticks executed since boot. The simulation's own clock, in its own unit. */
  ticks = 0;

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

  /** True while wall-clock pacing is suspended and the simulation only moves under `step`. */
  get suspended(): boolean {
    return this.stepping;
  }

  /**
   * Suspends wall-clock pacing. Frames keep being drawn; no simulated time passes until `step`.
   */
  suspend(): void {
    this.stepping = true;
    this.accumulator = 0;
  }

  /** Hands the simulation back to the display clock, without banking the time it was suspended. */
  resume(): void {
    if (!this.stepping) return;
    this.stepping = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  /**
   * Advances the simulation by exactly `ticks` fixed steps, then poses the frame.
   *
   * Suspends the loop if it was still running on the display clock, so a caller that steps never
   * has to remember to stop the accumulator first. The pose is taken at `alpha = 1`: a state
   * read straight after a step describes the tick that just ran, not a blend of it with the one
   * before. Returns the total tick count since boot.
   */
  step(ticks: number): number {
    if (!this.stepping) this.suspend();
    const n = Math.max(0, Math.trunc(ticks));
    for (let i = 0; i < n; i++) {
      this.handlers.fixedUpdate(this.stepSeconds);
      this.handlers.settleTick?.();
    }
    this.ticks += n;
    this.ticksLastFrame = n;
    this.handlers.render(1);
    return this.ticks;
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

    // Suspended, the frame is still a real frame — it just has no time in it.
    if (!this.stepping) {
      this.accumulator += frameSeconds;
      let ticks = 0;
      while (this.accumulator >= this.stepSeconds) {
        this.handlers.fixedUpdate(this.stepSeconds);
        this.accumulator -= this.stepSeconds;
        ticks++;
      }
      this.ticksLastFrame = ticks;
      this.ticks += ticks;
    }

    this.handlers.render(this.stepping ? 1 : this.accumulator / this.stepSeconds);
    this.handlers.draw?.();
  };
}
