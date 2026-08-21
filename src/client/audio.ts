// Procedural audio. No asset pipeline: everything is synthesised, which keeps the build
// trivial and lets each sound be *derived* from the event that caused it.

import type { Ev } from '../shared/proto.ts';
import type { Controller } from './controller.ts';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private stride = 0;

  resume() {
    if (!this.ctx) {
      const C = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
      this.master = this.ctx!.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx!.destination);
    }
    this.ctx?.resume();
  }

  /** Pan and attenuate by where the sound is relative to where the player is facing. */
  private place(x: number, z: number, px: number, pz: number, yaw: number, maxDist: number) {
    const dx = x - px, dz = z - pz;
    const d = Math.hypot(dx, dz);
    const rel = Math.atan2(dx, -dz) - yaw;
    return { pan: Math.max(-1, Math.min(1, Math.sin(rel))), gain: Math.max(0, 1 - d / maxDist), d };
  }

  private blip(freq: number, dur: number, gain: number, pan: number, type: OscillatorType = 'sine', sweep = 0) {
    const c = this.ctx; if (!c || !this.master || gain <= 0.001) return;
    const o = c.createOscillator(), g = c.createGain(), p = c.createStereoPanner();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), c.currentTime + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), c.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.master);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  }

  private noise(dur: number, gain: number, pan: number, lo: number, hi: number) {
    const c = this.ctx; if (!c || !this.master || gain <= 0.001) return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = lo; f.Q.value = 1.1;
    f.frequency.exponentialRampToValueAtTime(hi, c.currentTime + dur);
    const g = c.createGain(); g.gain.value = gain;
    const p = c.createStereoPanner(); p.pan.value = pan;
    src.connect(f); f.connect(g); g.connect(p); p.connect(this.master);
    src.start();
  }

  /** Your own pulse: a descending chirp that sounds like something leaving you. */
  pulse() { this.blip(1180, 0.5, 0.16, 0, 'sine', 0.32); this.noise(0.3, 0.05, 0, 2600, 500); }

  forEvent(e: Ev, pos: { x: number; z: number }, yaw: number) {
    if (e.k !== 'sound') {
      if (e.k === 'hit') { this.noise(0.16, 0.3, 0, 900, 160); this.blip(150, 0.22, 0.2, 0, 'square', 0.5); }
      return;
    }
    const p = this.place(e.x, e.z, pos.x, pos.z, yaw, 46);
    switch (e.kind) {
      case 'step':      this.noise(0.11, 0.13 * p.gain, p.pan, 340, 130); break;
      case 'shot':      this.noise(0.34, 0.42 * p.gain, p.pan, 1500, 90); this.blip(88, 0.3, 0.22 * p.gain, p.pan, 'square', 0.4); break;
      case 'hiss':      this.noise(0.09, 0.13 * p.gain, p.pan, 5200, 1600); break;
      // The enemy's pulse arriving through a wall: the single most important sound in the game.
      case 'pulse':     this.blip(760, 0.62, 0.20 * p.gain, p.pan, 'triangle', 0.42); break;
      case 'sing':      this.blip(560, 0.85, 0.20 * p.gain, p.pan, 'sine', 1.32); this.blip(842, 0.7, 0.10 * p.gain, p.pan, 'sine', 1.32); break;
      // The relic's heartbeat is audible map-wide but its direction still reads.
      case 'heartbeat': this.blip(120, 0.5, 0.20, p.pan * 0.8, 'sine', 1.9); this.blip(240, 0.34, 0.09, p.pan * 0.8, 'sine', 1.9); break;
      case 'device':    this.blip(1500, 0.2, 0.14 * p.gain, p.pan, 'square', 0.6); break;
      case 'spike':     this.blip(2100, 0.14, 0.16 * p.gain, p.pan, 'square', 1.6); break;
      default:          this.noise(0.14, 0.12 * p.gain, p.pan, 900, 300);
    }
  }

  /** Your own footsteps — quiet, but present, so the world feels physical. */
  step(ctl: Controller, dt: number, _now: number) {
    const spd = Math.hypot(ctl.vel.x, ctl.vel.z);
    if (spd < 0.4) { this.stride = 0.55; return; }
    this.stride -= spd * dt;
    if (this.stride <= 0) {
      this.stride = ctl.sprinting ? 0.62 : 0.82;
      this.noise(0.075, ctl.crouching ? 0.025 : 0.055, (Math.random() - 0.5) * 0.3, 300, 120);
    }
  }
}
