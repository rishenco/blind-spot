/**
 * Spectrograms, in a module, because two generators need them.
 *
 * `tools/audio.mjs` renders the full seven-scene ear pass with a "how it was" panel underneath
 * every scene; `tools/shoot.mjs` renders two of the same scenes into the main keyframe gallery,
 * so an ear regression is caught by the run everybody already does. Both draw the same picture
 * with the code below: a log-frequency spectrogram, 60 Hz at the bottom and 16 kHz at the top,
 * over a waveform strip with a tick every second.
 *
 * Nothing here talks to a browser or to the game — it takes a WAV buffer and gives back a PNG.
 */
import { deflateSync } from 'node:zlib';

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
/**
 * One scene, one panel: the picture the main keyframe run puts in the gallery. Takes a
 * `RenderResult` straight from `window.bs.audioRender` and gives back the PNG plus the two
 * numbers a caption wants.
 */
function scenePanelPng(result, caption) {
  const a = wavToMono(Buffer.from(result.wav, 'base64'));
  const h = HEAD + PANEL_H + 2 + WAVE_H + 8 + 26;
  const px = Buffer.alloc(W * h * 3, 8);
  drawText(px, W, h, 6, 6, (caption ?? `${result.name} - ${result.what}`).slice(0, 74), 2, [235, 235, 235]);
  const label = `PEAK ${db(a.peak).toFixed(1)} DBFS  RMS ${db(rmsOf(a.mono)).toFixed(1)}  ${result.seconds.toFixed(1)} S`;
  drawPanel(px, W, h, 26, a.mono, a.rate, result.seconds, label.toUpperCase());
  return { png: encodePng(W, h, px), mono: a.mono, rate: a.rate, peak: a.peak, rms: rmsOf(a.mono) };
}

export {
  scenePanelPng,
  encodePng,
  drawText,
  wavToMono,
  rmsOf,
  peakOf,
  db,
  spectrogram,
  highRms,
  highFraction,
  drawPanel,
  heat,
  W,
  PANEL_H,
  WAVE_H,
  HEAD,
  FFT_N,
};
