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

  /** Soft-clip curve for grit (shared). */
  private shaperCurve: Float32Array<ArrayBuffer> | null = null;
  private grit(): WaveShaperNode {
    const ws = this.ctx!.createWaveShaper();
    if (!this.shaperCurve) {
      const n = 1024;
      this.shaperCurve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        this.shaperCurve[i] = Math.tanh(x * 3);
      }
    }
    ws.curve = this.shaperCurve;
    ws.oversample = '2x';
    return ws;
  }

  private rand(a: number, b: number): number {
    return a + Math.random() * (b - a);
  }

  /** Heavy hoof: low sine thump + dirt click. Called per step while running/charging. */
  hoof(loud = 0.5): void {
    if (!this.ctx) return;
    const t = this.now;
    const p = this.rand(0.85, 1.15);
    this.tone({ t, dur: 0.16, peak: loud * 1.6, f0: 110 * p, f1: 36 * p, attack: 0.002 });
    this.noise({ t, dur: 0.08, peak: loud * 0.9, type: 'lowpass', f0: 420 * p, q: 0.7, attack: 0.002 });
    this.noise({ t, dur: 0.025, peak: loud * 0.35, type: 'highpass', f0: 2600, q: 0.7, attack: 0.001 });
    // a few pebbles skittering
    if (loud > 0.4) this.noise({ t: t + 0.03, dur: 0.06, peak: loud * 0.12, f0: 4200, q: 4, attack: 0.002 });
  }

  /** Hoof pawing the dirt: two gritty scrapes with a little thump. */
  scrape(): void {
    if (!this.ctx) return;
    const t = this.now;
    for (let i = 0; i < 2; i++) {
      const ti = t + i * 0.17;
      this.noise({ t: ti, dur: 0.16, peak: 0.42, f0: 1900, f1: 650, q: 2.2, attack: 0.01 });
      this.noise({ t: ti, dur: 0.12, peak: 0.2, type: 'lowpass', f0: 500, q: 0.8, attack: 0.005 });
      this.tone({ t: ti, dur: 0.07, peak: 0.35, f0: 90, f1: 45, attack: 0.002 });
    }
  }

  /** Angry snort: a sharp nasal inhale, then a big wet fluttering exhale through the nostrils. */
  snort(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    // inhale "hnk"
    this.noise({ t, dur: 0.09, peak: 0.28, f0: 1400, f1: 2600, q: 5, attack: 0.01 });
    // exhale "PFFRRR": noise through a nasal band, amplitude-fluttered like flapping nostrils
    const t1 = t + 0.13;
    const dur = 0.42;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(900, t1);
    bp.frequency.exponentialRampToValueAtTime(380, t1 + dur);
    const flap = ctx.createGain();
    flap.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(34, t1);
    lfo.frequency.linearRampToValueAtTime(22, t1 + dur);
    const lg = ctx.createGain();
    lg.gain.value = 0.45;
    lfo.connect(lg).connect(flap.gain);
    const g = ctx.createGain();
    this.env(g, t1, 0.75, 0.02, dur);
    src.connect(bp).connect(flap).connect(g).connect(this.master);
    src.start(t1, Math.random());
    src.stop(t1 + dur + 0.1);
    lfo.start(t1);
    lfo.stop(t1 + dur + 0.1);
    // chesty rumble under it
    this.tone({ t: t1, dur: 0.3, peak: 0.3, f0: 85, f1: 55, type: 'triangle', attack: 0.02 });
  }

  /**
   * "BAAAAH!" — two detuned sawtooths with the bleat's characteristic fast warble (pitch + amplitude),
   * pushed through "AA" vowel formants and a little grit. pitch > 1 = more panicked.
   */
  bleat(pitch = 1): void {
    if (this.ctx) this.bleatAt(this.now, pitch);
  }

  private bleatAt(t: number, pitch: number): void {
    const ctx = this.ctx!;
    const dur = 0.75 / Math.sqrt(pitch);
    const f = 230 * pitch * this.rand(0.95, 1.05);
    const voice = ctx.createGain();
    voice.gain.value = 1;
    // pitch warble
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(7.5 * Math.min(1.4, pitch), t);
    lfo.frequency.linearRampToValueAtTime(9.5 * Math.min(1.4, pitch), t + dur);
    const vib = ctx.createGain();
    vib.gain.value = f * 0.06;
    lfo.connect(vib);
    // amplitude warble ("ba-a-a-a")
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const tg = ctx.createGain();
    tg.gain.value = 0.4;
    lfo.connect(tg).connect(trem.gain);
    const oscs: OscillatorNode[] = [];
    for (const det of [-9, 11]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      // "B" onset scoops up, holds, then sags at the end
      o.frequency.setValueAtTime(f * 0.72, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.04, t + 0.07);
      o.frequency.setValueAtTime(f * 1.04, t + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(f * 0.78, t + dur);
      vib.connect(o.frequency);
      o.connect(voice);
      oscs.push(o);
    }
    // breathy rasp
    const ns = ctx.createBufferSource();
    ns.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1800;
    nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0.35;
    ns.connect(nf).connect(ng).connect(voice);
    // lips: lowpass opens for the "B"
    const lips = ctx.createBiquadFilter();
    lips.type = 'lowpass';
    lips.Q.value = 0.7;
    lips.frequency.setValueAtTime(350, t);
    lips.frequency.exponentialRampToValueAtTime(4200, t + 0.06);
    lips.frequency.setValueAtTime(4200, t + dur * 0.7);
    lips.frequency.exponentialRampToValueAtTime(1200, t + dur);
    const shaped = this.grit();
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    voice.connect(pre).connect(shaped).connect(lips).connect(trem);
    // "AA" formants in parallel
    // Sustained envelope: "BAAAA" holds, then trails off into "...h".
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 0.035);
    out.gain.linearRampToValueAtTime(0.38, t + dur * 0.75);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [ff, q, gain] of [
      [760, 6, 1.0],
      [1250, 7, 0.75],
      [2600, 9, 0.35],
      [300, 2, 0.4],
    ] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(ff * Math.min(1.25, Math.sqrt(pitch)), t);
      bp.frequency.exponentialRampToValueAtTime(ff * 0.85 * Math.min(1.25, Math.sqrt(pitch)), t + dur);
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain * 2.2;
      trem.connect(bp).connect(g).connect(out);
    }
    out.connect(this.master);
    for (const o of oscs) {
      o.start(t);
      o.stop(t + dur + 0.15);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.15);
    ns.start(t, Math.random());
    ns.stop(t + dur + 0.15);
  }

  /** Charge start: furious snort + a big bleat + a rising rumble of hooves/dust. */
  chargeStart(): void {
    if (!this.ctx) return;
    const t = this.now;
    this.snort();
    this.bleatAt(t + 0.3, 0.85);
    // rising rumble: low noise swelling + a sub that climbs
    this.noise({ t, dur: 1.0, peak: 0.45, type: 'lowpass', f0: 160, f1: 600, q: 1.2, attack: 0.35 });
    this.tone({ t, dur: 0.9, peak: 0.35, f0: 42, f1: 75, type: 'triangle', attack: 0.3 });
  }

  /** Hooves locking up on rock: gritty slide with a comic squeal on top. */
  skid(): void {
    if (!this.ctx) return;
    const t = this.now;
    this.noise({ t, dur: 0.5, peak: 0.45, f0: 2200, f1: 700, q: 1.6, attack: 0.02 });
    this.noise({ t, dur: 0.4, peak: 0.3, type: 'lowpass', f0: 600, f1: 200, q: 0.8, attack: 0.01 });
    this.tone({ t, dur: 0.38, peak: 0.12, f0: 1500, f1: 950, type: 'triangle', attack: 0.02, vibrato: 30 });
  }

  /** Body slamming into rock during the fall. strength 0..1. */
  thud(strength = 1): void {
    if (!this.ctx) return;
    const t = this.now;
    const s = Math.max(0.2, Math.min(1, strength));
    this.tone({ t, dur: 0.28, peak: 0.9 * s + 0.2, f0: 95 * this.rand(0.9, 1.1), f1: 32, attack: 0.002 });
    this.noise({ t, dur: 0.18, peak: 0.7 * s, type: 'lowpass', f0: 900, f1: 150, q: 0.9, attack: 0.002 });
    this.noise({ t, dur: 0.05, peak: 0.4 * s, type: 'highpass', f0: 2500, q: 0.7, attack: 0.001 });
    // rocks clattering after
    for (let i = 0; i < 3; i++) {
      this.noise({ t: t + 0.08 + i * this.rand(0.05, 0.12), dur: 0.05, peak: 0.12 * s, f0: this.rand(1800, 4000), q: 5, attack: 0.002 });
    }
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
