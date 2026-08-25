/**
 * The ear's keyframe generator.
 *
 * A sound cannot be screenshotted, so this is the substitute the milestone spec asks for: fixed
 * scenes of bus events are rendered offline through the *same* synthesis the player hears
 * (`src/audio/offline.ts` → `src/audio/voices.ts`), written out as WAVs you can listen to, and
 * drawn as spectrograms you can look at. Every scene is rendered twice — through the mixer as it
 * is now, and through a reconstruction of the pre-M4b mixer — because the complaint being fixed
 * ("no spider clicks at all", "the rifle sounds like knocking on a wall") is not a volume
 * problem and a picture of the difference is the only honest way to show that.
 *
 *   node tools/audio.mjs [dist/index.html]
 *
 * Writes out/audio/<n>-<scene>.wav, out/audio/<n>-<scene>-before.wav and
 * out/audio/<n>-<scene>.png (now on top, before underneath). Prints a table and a set of pass/
 * fail checks; exits non-zero if any of them fail.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const htmlPath = resolve(process.argv[2] ?? 'dist/index.html');
if (!existsSync(htmlPath)) {
  console.error(`[audio] build not found: ${htmlPath} (run \`npm run build\` first)`);
  process.exit(2);
}
const outDir = resolve('out/audio');
mkdirSync(outDir, { recursive: true });

// ---- tiny PNG writer -------------------------------------------------------

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
/** RGB, 8-bit, no interlace — the same subset tools/png.mjs can read back. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- a 3x5 font, because the PM only ever sees the picture ------------------

const FONT = {
  A: '111101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110',
  E: '111100111100111', F: '111100111100100', G: '111100101101111', H: '101101111101101',
  I: '111010010010111', J: '001001001101111', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '111101101101111', P: '111101111100100',
  Q: '111101101111001', R: '111101110101101', S: '111100111001111', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111',
  ' ': '000000000000000', '-': '000000111000000', '.': '000000000000010', ':': '000010000010000',
  '/': '001001010100100', ',': '000000000010100', '(': '011100100100011', ')': '110001001001110',
  '+': '000010111010000', '@': '111101111100011', '?': '111001010000010', '=': '000111000111000',
};
function drawText(px, w, h, x0, y0, text, scale, rgb) {
  let x = x0;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT[raw] ?? FONT['?'];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px_ = x + gx * scale + sx;
            const py_ = y0 + gy * scale + sy;
            if (px_ < 0 || py_ < 0 || px_ >= w || py_ >= h) continue;
            const o = (py_ * w + px_) * 3;
            px[o] = rgb[0];
            px[o + 1] = rgb[1];
            px[o + 2] = rgb[2];
          }
        }
      }
    }
    x += scale * 4;
  }
  return x;
}

// ---- signal maths ----------------------------------------------------------

/** Decodes the 16-bit PCM stereo WAV the page hands back into a mono Float32Array. */
function wavToMono(buf) {
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bytes = buf.readUInt32LE(40);
  const frames = bytes / (2 * channels);
  const mono = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const v = buf.readInt16LE(44 + (i * channels + c) * 2) / 32768;
      s += v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    mono[i] = s / channels;
  }
  return { mono, rate, peak };
}

const rmsOf = (x, a = 0, b = x.length) => {
  let s = 0;
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
};
const peakOf = (x, a = 0, b = x.length) => {
  let p = 0;
  for (let i = a; i < b; i++) if (Math.abs(x[i]) > p) p = Math.abs(x[i]);
  return p;
};
const db = (v) => (v <= 1e-9 ? -180 : 20 * Math.log10(v));

/** Iterative radix-2 FFT, in place, on separate re/im arrays. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const FFT_N = 1024;
/** Columns of magnitude spectra, one per `hop` samples. */
function spectrogram(mono, hop) {
  const cols = Math.max(1, Math.floor((mono.length - FFT_N) / hop));
  const out = [];
  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
  for (let c = 0; c < cols; c++) {
    const re = new Float32Array(FFT_N);
    const im = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) re[i] = (mono[c * hop + i] ?? 0) * win[i];
    fft(re, im);
    const mag = new Float32Array(FFT_N / 2);
    for (let i = 0; i < FFT_N / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (FFT_N / 4);
    out.push(mag);
  }
  return out;
}

/** RMS of the part of a window that sits above `hz` — how much *bright* sound is in there. */
function highRms(mono, rate, a, b, hz) {
  const n = 1 << Math.ceil(Math.log2(Math.max(64, Math.min(b - a, 8192))));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = mono[a + i] ?? 0;
  fft(re, im);
  let hi = 0;
  for (let i = 1; i < n / 2; i++) {
    if ((i * rate) / n > hz) hi += 2 * (re[i] * re[i] + im[i] * im[i]);
  }
  return Math.sqrt(hi) / n;
}

/** Fraction of the energy of a window that sits above `hz` — "is this thing bright?". */
function highFraction(mono, rate, a, b, hz) {
  const n = 1 << Math.ceil(Math.log2(Math.max(64, Math.min(b - a, 8192))));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = mono[a + i] ?? 0;
  fft(re, im);
  let hi = 0;
  let all = 0;
  for (let i = 1; i < n / 2; i++) {
    const e = re[i] * re[i] + im[i] * im[i];
    all += e;
    if ((i * rate) / n > hz) hi += e;
  }
  return all <= 0 ? 0 : hi / all;
}

// ---- the picture -----------------------------------------------------------

const W = 960;
const PANEL_H = 200;
const WAVE_H = 54;
const HEAD = 22;
const F_MIN = 60;
const F_MAX = 16000;

/** Blue→white heat: quiet is near-black, loud is white. Matches nothing in the game on purpose. */
function heat(v) {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.max(0, Math.min(1, t * 2.2 - 0.5));
  const g = Math.max(0, Math.min(1, t * 1.9 - 0.15));
  const b = Math.max(0, Math.min(1, t * 2.6));
  return [(r * 255) | 0, (g * 255) | 0, (b * 255) | 0];
}

function drawPanel(px, w, h, y0, mono, rate, seconds, label) {
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 3;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
  };
  drawText(px, w, h, 6, y0 + 6, label, 2, [150, 190, 255]);
  const specTop = y0 + HEAD;
  const hop = Math.max(1, Math.floor((seconds * rate) / w));
  const cols = spectrogram(mono, hop);
  for (let x = 0; x < w; x++) {
    const col = cols[Math.min(cols.length - 1, Math.floor((x / w) * cols.length))];
    for (let y = 0; y < PANEL_H; y++) {
      // Log frequency axis: low at the bottom, 16 kHz at the top.
      const f = F_MIN * Math.pow(F_MAX / F_MIN, 1 - y / PANEL_H);
      const bin = Math.min(FFT_N / 2 - 1, Math.max(1, Math.round((f * FFT_N) / rate)));
      const v = col ? col[bin] : 0;
      // -78 dB floor: below that is silence, and silence must look like silence.
      const d = (db(v) + 78) / 78;
      put(x, specTop + y, heat(d));
    }
  }
  const waveTop = specTop + PANEL_H + 2;
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * mono.length);
    const b = Math.floor(((x + 1) / w) * mono.length);
    const p = peakOf(mono, a, Math.max(a + 1, b));
    const half = WAVE_H / 2;
    const amp = Math.min(half, p * half);
    for (let y = -amp; y <= amp; y++) put(x, (waveTop + half + y) | 0, [90, 220, 190]);
    put(x, (waveTop + half) | 0, [60, 130, 120]);
  }
  // Second ticks along the waveform, so "the shot lands at 1.0 s" is checkable by eye.
  for (let s = 1; s < Math.ceil(seconds); s++) {
    const x = Math.round((s / seconds) * w);
    for (let y = waveTop; y < waveTop + WAVE_H; y += 3) put(x, y, [70, 80, 100]);
  }
  return waveTop + WAVE_H + 8;
}

// ---- drive the page --------------------------------------------------------

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PREINSTALLED = process.env.BLINDSPOT_CHROMIUM ?? '/opt/pw-browsers/chromium';
if (existsSync(PREINSTALLED)) launchOptions.executablePath = PREINSTALLED;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(htmlPath).href);
await page.waitForFunction(() => window.bs !== undefined, null, { timeout: 180000 });
// No device is opened: the offline renderer needs neither an AudioContext nor a gesture.
await page.evaluate(() => window.bs.audio(false));

const t0 = Date.now();
const now = await page.evaluate(() => window.bs.audioRender({}));
const before = await page.evaluate(() => window.bs.audioRender({ legacy: true }));
// Two more passes that exist only to measure the deafening: the ring left in your ears is
// switched off in both, and the ducking in one of them. Nothing else differs, so the gap between
// them *is* the deafening — measured, not asserted.
const ducked = await page.evaluate(() => window.bs.audioRender({ tinnitus: 0 }));
const noduck = await page.evaluate(() =>
  window.bs.audioRender({ deafDepth: 1, deafCutoff: 20000, tinnitus: 0 }));
const renderMs = Date.now() - t0;


const failures = [];
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(`[audio] ${line}`);
  if (!ok) failures.push(line);
};

const scenes = new Map();
now.forEach((r, i) => {
  const idx = String(i + 1).padStart(2, '0');
  const a = wavToMono(Buffer.from(r.wav, 'base64'));
  const b = wavToMono(Buffer.from(before[i].wav, 'base64'));
  writeFileSync(resolve(outDir, `${idx}-${r.name}.wav`), Buffer.from(r.wav, 'base64'));
  writeFileSync(resolve(outDir, `${idx}-${r.name}-before.wav`), Buffer.from(before[i].wav, 'base64'));

  const h = (HEAD + PANEL_H + 2 + WAVE_H + 8) * 2 + 26;
  const px = Buffer.alloc(W * h * 3, 8);
  drawText(px, W, h, 6, 6, `${idx} ${r.name} - ${r.what}`.slice(0, 74), 2, [235, 235, 235]);
  let y = 26;
  y = drawPanel(px, W, h, y, a.mono, a.rate, r.seconds, `NOW  PEAK ${db(a.peak).toFixed(1)} DBFS  RMS ${db(rmsOf(a.mono)).toFixed(1)}`);
  drawPanel(px, W, h, y, b.mono, b.rate, r.seconds, `BEFORE (M4A)  PEAK ${db(b.peak).toFixed(1)} DBFS  RMS ${db(rmsOf(b.mono)).toFixed(1)}`);
  writeFileSync(resolve(outDir, `${idx}-${r.name}.png`), encodePng(W, h, px));

  scenes.set(r.name, {
    r, a, b,
    d: wavToMono(Buffer.from(ducked[i].wav, 'base64')),
    n: wavToMono(Buffer.from(noduck[i].wav, 'base64')),
  });
  console.log(
    `[audio] ${idx} ${r.name.padEnd(9)} now peak ${db(a.peak).toFixed(1).padStart(6)} dB  rms ${db(rmsOf(a.mono)).toFixed(1).padStart(6)} dB` +
      `   before peak ${db(b.peak).toFixed(1).padStart(6)} dB  rms ${db(rmsOf(b.mono)).toFixed(1).padStart(6)} dB` +
      `   voiced ${Object.entries(r.voiced).map(([k, v]) => `${k}x${v}`).join(' ')}${r.culled ? ` culled ${r.culled}` : ''}`,
  );
});

const win = (s, from, to) => [Math.floor(from * s.rate), Math.floor(to * s.rate)];

// 1. The clicks exist at all — the thing the player never heard once.
{
  const { a, b, r } = scenes.get('clicks');
  const near = win(a, 0.1, 0.85);
  const nowPeak = peakOf(a.mono, ...near);
  const oldPeak = peakOf(b.mono, ...near);
  check('a spider click at 3 m is audible', db(nowPeak) > -26, `${db(nowPeak).toFixed(1)} dBFS (was ${db(oldPeak).toFixed(1)})`);
  const hiNow = highFraction(a.mono, a.rate, near[0], near[1] - 1, 2000);
  const hiOld = highFraction(b.mono, b.rate, near[0], near[1] - 1, 2000);
  check('the click sits above everything else in the game', hiNow > 0.5,
    `${(hiNow * 100).toFixed(0)}% of its energy is over 2 kHz (was ${(hiOld * 100).toFixed(0)}%)`);
  const mid = win(a, 1.9, 2.65);
  check('at 14 m it is quieter but still there', db(peakOf(a.mono, ...mid)) > -52,
    `${db(peakOf(a.mono, ...mid)).toFixed(1)} dBFS, against ${db(nowPeak).toFixed(1)} at 3 m`);
  const far = win(a, 2.85, 4.35);
  check('past its loudness radius it is gone', db(peakOf(a.mono, ...far)) < -70,
    `${db(peakOf(a.mono, ...far)).toFixed(1)} dBFS, ${r.culled} events culled by range`);
}

// 2. The shot is an event, not a knock.
{
  const shot = scenes.get('shot');
  const clicks = scenes.get('clicks');
  const shotPeak = peakOf(shot.a.mono);
  const clickPeak = peakOf(clicks.a.mono, ...win(clicks.a, 0.1, 0.85));
  check('the shot towers over the pack', db(shotPeak) - db(clickPeak) > 18,
    `${(db(shotPeak) - db(clickPeak)).toFixed(1)} dB above a 3 m click`);
  check('the shot does not clip', shotPeak < 0.999, `peak ${db(shotPeak).toFixed(2)} dBFS`);
  // A real muzzle blast is low-heavy, so the absolute share of high frequency is never large.
  // What matters is that there is a crack there at all, which is precisely what the old
  // footstep-shaped shot did not have.
  const [ta, tb] = win(shot.a, 0.1, 0.115);
  const hiNow = highFraction(shot.a.mono, shot.a.rate, ta, tb, 1500);
  const hiOld = highFraction(shot.b.mono, shot.b.rate, ta, tb, 1500);
  check('it opens with a crack, not a thud', hiNow > hiOld * 2.5,
    `${(hiNow * 100).toFixed(1)}% of the first 15 ms is over 1.5 kHz, against ${(hiOld * 100).toFixed(1)}% before`);
  const [sa, sb] = win(shot.a, 0.35, 0.75);
  check('and leaves a tail', db(rmsOf(shot.a.mono, sa, sb)) > -46, `${db(rmsOf(shot.a.mono, sa, sb)).toFixed(1)} dB 250-650 ms later`);
}

// 3. The shot deafens. Measured against the identical scene with the ducking switched off, so
//    the shot's own tail is present in both and cancels out of the comparison.
{
  const { a, d, n } = scenes.get('deafened');
  // The two clicks that land while the shot is still in your ears, at 1.25 s and 1.47 s. The
  // blast's own tail bypasses the duck by design, so the comparison is made in the band the
  // clicks own rather than over the whole spectrum.
  const hurt = win(a, 1.24, 1.53);
  const later = win(a, 2.6, 3.55);
  // Measured over 2 kHz, where the clicks live and the blast's low tail does not.
  const duckedHi = highRms(d.mono, d.rate, hurt[0], hurt[1] - 1, 2000);
  const openHi = highRms(n.mono, n.rate, hurt[0], hurt[1] - 1, 2000);
  check('the clicks that land while you are deaf are pushed down', db(openHi) - db(duckedHi) > 5,
    `${(db(openHi) - db(duckedHi)).toFixed(1)} dB below the same scene without ducking`);
  const hiDucked = highFraction(d.mono, d.rate, hurt[0], hurt[1] - 1, 2000);
  const hiOpen = highFraction(n.mono, n.rate, hurt[0], hurt[1] - 1, 2000);
  check('and goes muffled, not just quiet', hiDucked < hiOpen * 0.7,
    `${(hiDucked * 100).toFixed(1)}% over 2 kHz against ${(hiOpen * 100).toFixed(1)}% open`);
  const lateDucked = db(rmsOf(d.mono, ...later));
  const lateOpen = db(rmsOf(n.mono, ...later));
  check('and comes back', Math.abs(lateOpen - lateDucked) < 2.5,
    `${(lateOpen - lateDucked).toFixed(1)} dB apart a second and a half later`);
}

// 4. Concept: "по железному стеллажу громче, чем по бетону".
{
  const { a } = scenes.get('steps');
  const concrete = peakOf(a.mono, ...win(a, 0.1, 1.5));
  const steel = peakOf(a.mono, ...win(a, 1.55, 2.85));
  check('a spider on steel is louder than on concrete', db(steel) - db(concrete) > 3 && db(concrete) > -60,
    `${db(steel).toFixed(1)} against ${db(concrete).toFixed(1)} dBFS, ${(db(steel) - db(concrete)).toFixed(1)} dB apart`);
  const boot = peakOf(a.mono, ...win(a, 2.87, 3.19));
  check('the player’s own boot is there but quiet', db(boot) > -40 && db(boot) < -10, `${db(boot).toFixed(1)} dBFS`);
}

// 5. Nothing anywhere is allowed to clip.
{
  let worst = 0;
  let worstName = '';
  for (const [name, s] of scenes) {
    if (s.a.peak > worst) {
      worst = s.a.peak;
      worstName = name;
    }
  }
  check('no scene clips', worst < 0.999, `loudest is ${worstName} at ${db(worst).toFixed(2)} dBFS`);
}

check('no page errors', errors.length === 0, errors.join('; '));
console.log(`[audio] rendered ${now.length} scenes twice in ${renderMs} ms → ${outDir}`);

await browser.close();
if (failures.length > 0) {
  console.error(`[audio] ${failures.length} check(s) failed`);
  process.exit(1);
}
