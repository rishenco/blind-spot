/** Tiny procedural sound kit (Web Audio). Everything is synthesized: no assets. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private wind: GainNode | null = null;
  private musicGain!: GainNode;
  private nextBeat = 0;
  private beat = 0;
  musicOn = false;
  /** Beats per minute; the game raises it as the ram escalates. */
  bpm = 120;

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.32;
    this.musicGain.connect(this.master);

    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Mountain wind bed.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.08;
    src.connect(lp).connect(this.wind).connect(this.master);
    src.start();
  }

  private get now(): number {
    return this.ctx!.currentTime;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noise(opts: {
    t?: number;
    dur: number;
    peak: number;
    type?: BiquadFilterType;
    f0: number;
    f1?: number;
    q?: number;
    attack?: number;
    out?: AudioNode;
  }): void {
    if (!this.ctx) return;
    const t = opts.t ?? this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.Q.value = opts.q ?? 1;
    f.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1) f.frequency.exponentialRampToValueAtTime(opts.f1, t + opts.dur);
    const g = this.ctx.createGain();
    this.env(g, t, opts.peak, opts.attack ?? 0.005, opts.dur);
    src.connect(f).connect(g).connect(opts.out ?? this.master);
    src.start(t, Math.random() * Math.max(0, 1.9 - opts.dur));
    src.stop(t + opts.dur + 0.1);
  }

  private tone(opts: {
    t?: number;
    dur: number;
    peak: number;
    f0: number;
    f1?: number;
    type?: OscillatorType;
    attack?: number;
    vibrato?: number;
    out?: AudioNode;
  }): void {
    if (!this.ctx) return;
    const t = opts.t ?? this.now;
    const o = this.ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, t + opts.dur);
    if (opts.vibrato) {
      const lfo = this.ctx.createOscillator();
      const lg = this.ctx.createGain();
      lfo.frequency.value = opts.vibrato;
      lg.gain.value = opts.f0 * 0.08;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + opts.dur + 0.1);
    }
    const g = this.ctx.createGain();
    this.env(g, t, opts.peak, opts.attack ?? 0.005, opts.dur);
    o.connect(g).connect(opts.out ?? this.master);
    o.start(t);
    o.stop(t + opts.dur + 0.1);
  }

  hoof(loud = 0.5): void {
    this.tone({ dur: 0.08, peak: loud, f0: 140, f1: 60 });
    this.noise({ dur: 0.05, peak: loud * 0.4, f0: 900, q: 2 });
  }

  scrape(): void {
    this.noise({ dur: 0.18, peak: 0.25, f0: 2500, f1: 1200, q: 1.5, attack: 0.02 });
  }

  snort(): void {
    this.noise({ dur: 0.35, peak: 0.5, f0: 700, f1: 300, q: 0.8, attack: 0.03 });
  }

  bleat(pitch = 1): void {
    if (!this.ctx) return;
    const t = this.now;
    // Two shaky "BAAA" formants.
    this.tone({ t, dur: 0.6, peak: 0.25, f0: 380 * pitch, f1: 300 * pitch, type: 'sawtooth', attack: 0.04, vibrato: 18 });
    this.tone({ t, dur: 0.6, peak: 0.12, f0: 760 * pitch, f1: 640 * pitch, type: 'square', attack: 0.04, vibrato: 18 });
  }

  whoosh(): void {
    this.noise({ dur: 0.25, peak: 0.35, f0: 400, f1: 2400, q: 1.2, attack: 0.04 });
  }

  kick(): void {
    this.tone({ dur: 0.15, peak: 0.9, f0: 180, f1: 50 });
    this.noise({ dur: 0.08, peak: 0.5, f0: 1500, q: 0.7 });
  }

  bonk(): void {
    this.tone({ dur: 0.25, peak: 0.6, f0: 520, f1: 260, type: 'triangle' });
  }

  grunt(): void {
    this.tone({ dur: 0.25, peak: 0.35, f0: 160, f1: 90, type: 'sawtooth', attack: 0.01 });
    this.noise({ dur: 0.15, peak: 0.3, f0: 600, q: 1 });
  }

  /** Big hit: ram into player. */
  smack(): void {
    this.tone({ dur: 0.3, peak: 1.0, f0: 120, f1: 40 });
    this.noise({ dur: 0.2, peak: 0.8, f0: 2000, f1: 500, q: 0.6 });
  }

  scream(): void {
    this.tone({ dur: 1.6, peak: 0.3, f0: 700, f1: 250, type: 'sawtooth', attack: 0.05, vibrato: 9 });
  }

  boom(): void {
    this.tone({ dur: 1.8, peak: 1.0, f0: 70, f1: 25 });
    this.noise({ dur: 2.2, peak: 1.0, type: 'lowpass', f0: 1200, f1: 80, q: 0.5, attack: 0.01 });
  }

  setWind(level: number): void {
    if (this.wind && this.ctx) this.wind.gain.setTargetAtTime(level, this.now, 0.3);
  }

  /** Call every frame: schedules the drum loop slightly ahead of time. */
  update(): void {
    if (!this.ctx || !this.musicOn) return;
    const spb = 60 / this.bpm / 2; // eighth notes
    if (this.nextBeat < this.now) this.nextBeat = this.now + 0.05;
    while (this.nextBeat < this.now + 0.15) {
      const t = this.nextBeat;
      const step = this.beat % 16;
      const out = this.musicGain;
      if (step % 4 === 0 || step === 10) this.tone({ t, dur: 0.18, peak: 0.9, f0: 110, f1: 40, out });
      if (step === 4 || step === 12) this.noise({ t, dur: 0.14, peak: 0.5, f0: 1800, q: 0.7, out });
      if (step % 2 === 1) this.noise({ t, dur: 0.03, peak: 0.15, type: 'highpass', f0: 7000, out });
      // Low "tribal" bass pulse.
      const bass = [55, 0, 55, 0, 65, 0, 55, 0, 49, 0, 49, 0, 41, 0, 49, 0][step];
      if (bass) this.tone({ t, dur: 0.16, peak: 0.25, f0: bass, type: 'triangle', out });
      this.beat++;
      this.nextBeat += spb;
    }
  }
}
