/**
 * M7 — the radio. Concept §"Одно предложение" gave the game a cost for every sense; this gives
 * it the one thing it never had: a reason to go somewhere. See `doc/proto/m7-radio.md`.
 *
 * Two bodies, one class:
 *  - On the floor, at a fixed point inside the hall's always-clear middle rect (see
 *    `world/hall.ts`'s `MIDDLE`), it pings *unconditionally* — that unfading, far-off mark is
 *    the whole tutorial. `RADIO_GROUND_POS` is deliberately not the player spawn or the gate, so
 *    all three (start / radio / gate) sit in different places, per the M7 "round" spec.
 *  - Once picked up (simple proximity, no key — carrying it costs nothing, per the human's
 *    2026-08-25 decision that it must NOT occupy `E`'s left hand), it goes silent until the
 *    player switches it on with its own key. Switching on is not instant: a fixed capture delay
 *    (a slider, NOT distance-dependent — distance is already encoded in clarity, encoding it
 *    twice would double-count it) has to pass before the noise:melody ratio means anything. That
 *    delay is what stops the player from tapping the switch every step for a free, instant
 *    bearing: every reading costs several seconds of the loudest sound in the hall.
 *
 * Direction is never available. `clarity()` is a pure function of distance to `GATE_TARGET` —
 * nothing else feeds it, not yaw, not which way the player is looking, not time. That is the
 * one law in this file that must never be relaxed: the moment clarity depends on anything but
 * distance, the radio becomes a compass and the mechanic in `concept.md` §"один шум" is gone.
 *
 * Floor-drop ("оставить рацию как приманку") is explicitly NOT implemented here — the human
 * proposed it (line 24 of the spec) and later rejected it in the same document's "Раунд целиком"
 * section (line 88): a dropped radio turns the loudest point in a black hall into a mandatory
 * return trip through whatever it has since attracted. See the task report's deviations section.
 */

import * as THREE from 'three';
import type { SoundBus } from '../events/bus';
import { GATE_TARGET } from '../world/hall';

export interface RadioTunables {
  /** Proximity, metres, at which the ground unit is auto-picked-up. */
  pickupRadius: number;
  /** Seconds of "still settling" after switching on, before the signal can be trusted. */
  captureSeconds: number;
  /** Seconds between bus pings while active — must stay well under the marker layer's life. */
  pingInterval: number;
  /** Loudness (metres of audibility) of the ground unit's unconditional ping. */
  groundLoudness: number;
  /** Loudness of the carried unit while switched on — the loudest thing in the hall. */
  carryLoudness: number;
  /** Distance to the gate, metres, at which the signal reads fully clear. */
  clarityNear: number;
  /** Distance to the gate, metres, at which the signal is pure noise. */
  clarityFar: number;
  /** Indicator blink rate while "settling", Hz. Never used to encode anything but that state. */
  blinkHz: number;
  /** Peak gain of the continuous hiss the player hears. */
  noiseGain: number;
  /** Peak gain of the continuous, interrupted melody the player hears. */
  melodyGain: number;
}

export function defaultRadioTunables(): RadioTunables {
  return {
    pickupRadius: 0.9,
    captureSeconds: 2.2,
    pingInterval: 0.6,
    groundLoudness: 42,
    carryLoudness: 70,
    clarityNear: 6,
    clarityFar: 58,
    blinkHz: 2.2,
    noiseGain: 0.05,
    melodyGain: 0.045,
  };
}

/**
 * The indicator's only three legal states (spec, "что здесь надо сделать правильно"). It answers
 * exactly one question — "is the reading trustworthy yet" — and must never be extended to leak
 * clarity through brightness, rate or colour.
 */
export type RadioIndicator = 'off' | 'settling' | 'ready';

/** Fixed pickup point: the middle of the hall, guaranteed clear floor in every seed. */
export const RADIO_GROUND_POS = new THREE.Vector3(0, 0, 0);

export class Radio {
  readonly tunables: RadioTunables;

  private _carried = false;
  private _powered = false;
  private poweredSince = -Infinity;
  private lastPing = -Infinity;
  private lastClarity = 0;

  private ctx: AudioContext | null = null;
  private noiseGainNode: GainNode | null = null;
  private melodyOsc: OscillatorNode | null = null;
  private melodyGainNode: GainNode | null = null;

  constructor(tunables: RadioTunables = defaultRadioTunables()) {
    this.tunables = tunables;
  }

  get carried(): boolean {
    return this._carried;
  }

  get powered(): boolean {
    return this._powered;
  }

  /** For scenario/pose resets and `main.ts`'s round restart — not a gameplay action. */
  reset(): void {
    this._carried = false;
    this._powered = false;
    this.poweredSince = -Infinity;
    this.lastPing = -Infinity;
    this.lastClarity = 0;
  }

  /** Force carry state (keyframe scenarios, `pose()`). Turning it off when un-carrying it. */
  setCarried(carried: boolean): void {
    this._carried = carried;
    if (!carried) this._powered = false;
  }

  /** The radio's own key. No effect on the ground unit — nothing to switch there. */
  toggle(now: number): void {
    if (!this._carried) return;
    this._powered = !this._powered;
    if (this._powered) this.poweredSince = now;
  }

  indicator(now: number): RadioIndicator {
    if (!this._carried || !this._powered) return 'off';
    return now - this.poweredSince < this.tunables.captureSeconds ? 'settling' : 'ready';
  }

  /** Blink phase for the "settling" state — sim-time only, never wall-clock. */
  blinkOn(now: number): boolean {
    return Math.floor(now * this.tunables.blinkHz) % 2 === 0;
  }

  /**
   * Signal clarity, 0..1. Pure function of horizontal distance to `GATE_TARGET`. No yaw, no
   * player facing, no time — see the file header. 0 = pure noise, 1 = fully legible melody.
   */
  clarity(position: THREE.Vector3): number {
    const t = this.tunables;
    const d = Math.hypot(position.x - GATE_TARGET.x, position.z - GATE_TARGET.z);
    const span = Math.max(0.001, t.clarityFar - t.clarityNear);
    const c = 1 - (d - t.clarityNear) / span;
    return Math.max(0, Math.min(1, c));
  }

  /** Where the radio *is*, right now — the ground point, or wherever the player is. */
  position(playerPos: THREE.Vector3): THREE.Vector3 {
    return this._carried ? playerPos : RADIO_GROUND_POS;
  }

  /** Last clarity computed by `update()` — what the indicator/audio actually used this tick. */
  get lastComputedClarity(): number {
    return this.lastClarity;
  }

  update(_dt: number, now: number, bus: SoundBus, playerPos: THREE.Vector3): void {
    const t = this.tunables;
    if (!this._carried) {
      const d = Math.hypot(playerPos.x - RADIO_GROUND_POS.x, playerPos.z - RADIO_GROUND_POS.z);
      if (d < t.pickupRadius) this.setCarried(true);
    }

    const pos = this.position(playerPos);
    const active = !this._carried || this._powered;
    if (active && now - this.lastPing >= t.pingInterval) {
      this.lastPing = now;
      bus.emit({
        source: 'radio',
        x: pos.x,
        y: 0.9,
        z: pos.z,
        loudness: this._carried ? t.carryLoudness : t.groundLoudness,
      });
    }

    this.lastClarity = this.clarity(pos);
    this.syncSynth(active);
  }

  // --- continuous, player-only drone. Playback, not simulation: it rides the AudioContext's
  // own real-time clock the same way `AudioStage` does, and is exempt from the sim's
  // determinism rule for exactly that reason (see concept.md's law on performance/determinism
  // and `process.md`'s note on continuous audio synthesis). It never touches game state. ---

  /** Must only be called from a real user gesture — browsers refuse otherwise, and headless
   *  keyframe runs never press a real key, so this stays inert there. */
  resume(): void {
    if (this.ctx) {
      void this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const noiseBuf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 2)), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    // A fixed hiss texture, not `Math.random()` — this is a sound-card buffer, never read back
    // into game state, so it does not need to be seeded per-round the way simulation RNG does.
    let seed = 0x9e3779b9;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noiseSrc.connect(noiseGain).connect(ctx.destination);
    noiseSrc.start();

    const melodyOsc = ctx.createOscillator();
    melodyOsc.type = 'sine';
    melodyOsc.frequency.value = 440;
    const melodyGain = ctx.createGain();
    melodyGain.gain.value = 0;
    melodyOsc.connect(melodyGain).connect(ctx.destination);
    melodyOsc.start();

    this.noiseGainNode = noiseGain;
    this.melodyOsc = melodyOsc;
    this.melodyGainNode = melodyGain;
  }

  private syncSynth(active: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseGainNode || !this.melodyGainNode || !this.melodyOsc) return;
    const t = this.tunables;
    if (!active) {
      this.noiseGainNode.gain.value = 0;
      this.melodyGainNode.gain.value = 0;
      return;
    }
    const c = this.lastClarity;
    // "перебои": the melody drops in and out on a fixed playback-clock beat, never on sim time.
    const beat = Math.floor(ctx.currentTime * 2.4) % 4;
    const notch = beat === 1 || beat === 3 ? 0.12 : 1;
    this.melodyOsc.frequency.value = beat < 2 ? 392 : 494;
    this.noiseGainNode.gain.value = t.noiseGain * (1 - 0.75 * c);
    this.melodyGainNode.gain.value = t.melodyGain * c * notch;
  }

  dispose(): void {
    try {
      this.melodyOsc?.stop();
    } catch {
      /* already stopped */
    }
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}
