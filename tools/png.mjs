/**
 * Minimal PNG reader for the screenshot driver.
 *
 * The sonar lab's assertions are photometric — "this frame is black", "this region dimmed but
 * did not vanish" — so the driver has to look at pixels, not just at state. Playwright hands
 * back a PNG buffer and node ships zlib, so the only missing piece is ~60 lines of unfiltering.
 * That is cheaper than taking on an image dependency for it.
 *
 * Supports what headless chromium actually produces: 8-bit, non-interlaced, colour type 2
 * (RGB) or 6 (RGBA). Anything else throws rather than guessing.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decodes a PNG buffer to `{ width, height, channels, data }` with 8 bits per channel. */
export function decodePng(buffer) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  let offset = 8;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      const depth = buffer[start + 8];
      const colorType = buffer[start + 9];
      const interlace = buffer[start + 12];
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4; // + CRC
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = y * stride;
    const prev = line - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x];
      const a = x >= channels ? data[line + x - channels] : 0;
      const b = y > 0 ? data[prev + x] : 0;
      const c = x >= channels && y > 0 ? data[prev + x - channels] : 0;
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      data[line + x] = out & 0xff;
    }
    pos += stride;
  }

  return { width, height, channels, data };
}

/**
 * Mean Rec.709 luminance (0-255) over a rectangle, optionally with rectangular holes punched
 * out of it — the HUD, the reticle and the lil-gui panel are DOM, not renderer output, and
 * would otherwise dominate every "is this frame black" measurement.
 */
export function meanLuminance(image, rect, holes = []) {
  const { width, height, channels, data } = image;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let masked = false;
      for (const h of holes) {
        if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) {
          masked = true;
          break;
        }
      }
      if (masked) continue;
      const i = (y * width + x) * channels;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      count++;
    }
  }
  return { mean: count === 0 ? 0 : sum / count, samples: count };
}

/** Fraction of pixels in a rectangle brighter than `threshold` (0-255 luminance). */
export function litFraction(image, rect, threshold = 8) {
  const { width, height, channels, data } = image;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  let lit = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (l > threshold) lit++;
      count++;
    }
  }
  return { fraction: count === 0 ? 0 : lit / count, lit, samples: count };
}
