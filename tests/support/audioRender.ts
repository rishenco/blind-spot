/**
 * The offline renderer the audio tests measure — one place that knows what an audio backend is.
 *
 * `node-web-audio-api` is a Rust implementation of the Web Audio API with a real
 * `OfflineAudioContext`, so a graph built here is the *same graph* the browser would build and
 * renders faster than real time with no browser, no device and no clock. That is what makes
 * audio testable at all in vitest: the alternative is Playwright plus a virtual sound card plus a
 * recording, which is three moving parts to make one assertion.
 *
 * It is a devDependency and nothing under `src/` imports it — `vite-plugin-singlefile` bundles
 * the browser build and must never see it. The game's own audio, when it exists, will use the
 * *browser's* WebAudio; this module exists so a test can render that same code headlessly.
 *
 * CI caveats, recorded here because they will bite someone at 2 a.m.: the package ships prebuilt
 * native binaries for linux/darwin/win x64+arm64 and **glibc only** — there is no musl build, so
 * an Alpine runner cannot load it. It also requires Node ≥ 22.
 */

import { OfflineAudioContext } from 'node-web-audio-api';
import type { AudioBufferLike } from './audioMetrics';

/**
 * The rate every audio test renders at.
 *
 * 48 kHz rather than 44.1: it is what browsers pick on every platform we target, and matching it
 * means a pinned spectral number measured here is the number the shipped game produces. A metric
 * measured at one rate and asserted against a render at another is a bug waiting to be blamed on
 * the synthesis.
 */
export const TEST_SAMPLE_RATE = 48000;

/**
 * Master gain every render passes through, mirroring the prototype's output stage.
 *
 * Pinned rather than 1 because every absolute dBFS number in `audioSpec.ts` is measured through
 * it: change this and the whole table moves together, which is exactly the visible one-line diff
 * the spec file exists to produce.
 */
export const TEST_MASTER_GAIN = 0.85;

/**
 * Render a graph to a buffer.
 *
 * `build` receives the context and a master `GainNode` already wired to the destination; connect
 * sources to the master, not to `ctx.destination`, so every render shares one output stage.
 *
 * The render is *fully deterministic* — same graph in, bit-identical buffer out — which is the
 * property the whole phonometric approach stands on. Any randomness a voice needs must come from
 * a seeded generator baked into an `AudioBuffer` (see `probeVoices.noiseBurst`), never from
 * `Math.random`: a test that pins a spectral centroid against an unseeded noise burst pins a
 * number that was true once.
 */
export async function renderOffline(
  seconds: number,
  build: (ctx: OfflineAudioContext, master: GainNode) => void,
  channels = 2,
): Promise<AudioBufferLike> {
  const ctx = new OfflineAudioContext(
    channels,
    Math.ceil(seconds * TEST_SAMPLE_RATE),
    TEST_SAMPLE_RATE,
  );
  const master = ctx.createGain();
  master.gain.value = TEST_MASTER_GAIN;
  master.connect(ctx.destination);
  build(ctx, master);
  return await ctx.startRendering();
}

/**
 * A buffer built from raw channel data — the analytic probe signals of `metrics.test.ts`.
 *
 * Deliberately *not* an `AudioBuffer`: a metric proved against a hand-built plain object is
 * proved against arithmetic, with no audio backend anywhere in the claim. The day a metric is
 * wrong, this tells you whether the fault is in the metric or in the renderer.
 */
export function bufferOf(channels: Float32Array[], sampleRate = TEST_SAMPLE_RATE): AudioBufferLike {
  if (channels.length === 0) throw new Error('bufferOf: needs at least one channel');
  const length = channels[0]!.length;
  for (const c of channels) {
    if (c.length !== length) throw new Error('bufferOf: channels must be the same length');
  }
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (data === undefined) throw new RangeError(`bufferOf: no channel ${channel}`);
      return data;
    },
  };
}
