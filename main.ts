// PNG Squeezer — Squeeze screenshots into the smallest PNG, 27 November 2026.
//
// A lossless PNG re-encoder: it reads each 1280x720 RGBA screenshot, picks the
// smallest exact form for it (palette / grey / grey+alpha / RGB / RGBA, with a
// tRNS key where one transparent value fits), chooses each row's filter by the
// kit's screen (fixed filters, minimum-sum, fewest-pairs, and brute force
// weighed by zlib), then writes the filtered bytes with an optimal-parsing
// deflate (hash-chain LZ77 + dynamic-programming optimal parse, iterated
// Huffman lengths), all in plain Node with no dependencies.
//
// Runs as `node /bot/main.ts`: reads /input/<id>/image.png, writes
// /output/<id>/image.png. One wall budget covers all 8 instances, so the work
// is budgeted by size, never by the clock: no Date, no randomness, no network,
// no reads outside /bot, /input, /output, /tmp. Two runs write the same bytes.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---- PNG codec (reader + writer) ----
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Decode a PNG (bit depth 8, colour types 0/2/3/4/6) to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null, palette = null, trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`unexpected chunk ${type}`);
  }
  if (!ended || idat.length === 0) throw new Error('truncated PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error(`filter ${ft}`);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---- Image analysis and forms ----
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS
// instead of an alpha channel: every pixel opaque or that exact value at
// alpha 0, and no opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---- Filter screen ----
const SCREEN = { level: 6, memLevel: 8 };
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// The raw data of an image of `samples` (height rows of width x bpp samples),
// each row behind its filter byte, by `choice`: a filter type (0 to 4) for
// every row, or 'minsum', 'pairs' or 'brute' (per-row choice, the lower type
// on a tie). Brute force weighs each filter by zlib level 4 over the row
// after the 32 KiB written before it.
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const FILTERS = {
  palette: [0],
  paletteByLuminance: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
};

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The screen's winner for an image: its form, filter choice and filtered data,
// weighed by zlib level 6 plus the PLTE/tRNS chunk bytes; the first on a tie.
function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else spare = data;
    }
  }
  return best;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---- Optimal-parsing deflate (zopfli-style, simplified) ----
// Hash-chain LZ77 matcher + greedy lazy parse for seed frequencies +
// dynamic-programming optimal parse with iterated Huffman code lengths.
// One dynamic Huffman block per image (or a fixed-Huffman block when that is
// smaller). Deterministic: no clock, no randomness.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Int16Array(259);
const LEN_EBITS = new Int16Array(259);
const LEN_EVAL = new Int16Array(259);
for (let s = 0; s < 29; s++) {
  const base = LEN_BASE[s];
  const top = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
  for (let l = base; l <= top; l++) {
    LEN_SYM[l] = 257 + s;
    LEN_EBITS[l] = LEN_EXTRA[s];
    LEN_EVAL[l] = l - base;
  }
}
const DIST_SYM = new Int16Array(32769);
const DIST_EBITS = new Int16Array(32769);
const DIST_EVAL = new Int16Array(32769);
for (let s = 0; s < 30; s++) {
  const base = DIST_BASE[s];
  const top = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
  for (let d = base; d <= top; d++) {
    DIST_SYM[d] = s;
    DIST_EBITS[d] = DIST_EXTRA[s];
    DIST_EVAL[d] = d - base;
  }
}

const FIXED_LITLEN = new Int16Array(288);
for (let i = 0; i < 288; i++) FIXED_LITLEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST = new Int16Array(30).fill(5);

class BitWriter {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  ensure(n) {
    if (this.pos + n > this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  writeBits(value, count) {
    this.bitbuf |= value << this.bitcnt;
    this.bitcnt += count;
    while (this.bitcnt >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(code, len) {
    this.writeBits(reverseBits(code, len), len);
  }
  align() {
    if (this.bitcnt > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  result() {
    return this.buf.subarray(0, this.pos);
  }
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// Huffman lengths from frequencies, length-limited to maxBits by frequency
// scaling: if the tree is deeper than maxBits, halve the frequencies (floored
// at 1) and rebuild. Uniform frequencies give depth <= ceil(log2(n)) <= 9,
// so this always terminates with a valid, near-optimal code.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  let scale = 0;
  for (;;) {
    let f = freq;
    if (scale > 0) {
      f = new Int32Array(n);
      for (let i = 0; i < n; i++) f[i] = freq[i] > 0 ? Math.max(1, freq[i] >> scale) : 0;
    }
    const lenOf = treeLengths(f, n);
    let mx = 0;
    for (let i = 0; i < n; i++) if (lenOf[i] > mx) mx = lenOf[i];
    if (mx <= maxBits || scale > 30) return lenOf;
    scale++;
  }
}

function treeLengths(freq, n) {
  const lengths = new Int16Array(n);
  let nz = 0;
  for (let i = 0; i < n; i++) if (freq[i] > 0) nz++;
  if (nz === 0) return lengths;
  if (nz === 1) {
    for (let i = 0; i < n; i++) if (freq[i] > 0) lengths[i] = 1;
    return lengths;
  }
  const heap = new Int32Array(2 * n);
  const heapFreq = new Float64Array(2 * n);
  const left = new Int32Array(2 * n).fill(-1);
  const right = new Int32Array(2 * n).fill(-1);
  const nodeFreq = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) nodeFreq[i] = freq[i];
  let hn = 0;
  const siftDown = (i0) => {
    let i = i0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < hn && heapFreq[l] < heapFreq[m]) m = l;
      if (r < hn && heapFreq[r] < heapFreq[m]) m = r;
      if (m === i) break;
      const th = heap[m]; heap[m] = heap[i]; heap[i] = th;
      const tf = heapFreq[m]; heapFreq[m] = heapFreq[i]; heapFreq[i] = tf;
      i = m;
    }
  };
  const push = (id, f) => {
    let i = hn++;
    heap[i] = id; heapFreq[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapFreq[p] <= heapFreq[i]) break;
      const th = heap[p]; heap[p] = heap[i]; heap[i] = th;
      const tf = heapFreq[p]; heapFreq[p] = heapFreq[i]; heapFreq[i] = tf;
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    hn--;
    heap[0] = heap[hn]; heapFreq[0] = heapFreq[hn];
    siftDown(0);
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) push(i, freq[i]);
  let next = n;
  while (hn > 1) {
    const a = pop(), b = pop();
    left[next] = a; right[next] = b;
    nodeFreq[next] = nodeFreq[a] + nodeFreq[b];
    push(next, nodeFreq[next]);
    next++;
  }
  const root = heap[0];
  const stack = [[root, 0]];
  const lenOf = new Int16Array(n);
  while (stack.length) {
    const [node, d] = stack.pop();
    if (node < n) { if (freq[node] > 0) lenOf[node] = d; }
    else {
      stack.push([left[node], d + 1]);
      stack.push([right[node], d + 1]);
    }
  }
  return lenOf;
}

function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Int32Array(n);
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return codes;
}

const hash3of = (data, i) => (Math.imul((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2], 2654435761) >>> 16) & 0xffff;

// Longest match at position i (smallest distance on ties) via the hash chains.
function bestMatchAt(data, i, head, prev, maxChain) {
  const n = data.length;
  if (i + 2 >= n) return { len: 0, dist: 0 };
  const h = hash3of(data, i);
  let cur = head[h];
  let depth = 0;
  let bestLen = 0, bestDist = 0;
  const maxDist = i < 32768 ? i : 32768;
  while (cur >= 0 && depth < maxChain) {
    const dist = i - cur;
    if (dist < 1) { cur = prev[cur]; depth++; continue; }
    if (dist > maxDist) break;
    let len = 0;
    if (data[cur] === data[i] && data[cur + 1] === data[i + 1] && data[cur + 2] === data[i + 2]) {
      len = 3;
      const cap = Math.min(258, n - i);
      while (len < cap && data[cur + len] === data[i + len]) len++;
    }
    if (len > bestLen) {
      bestLen = len; bestDist = dist;
      if (bestLen >= 258) break;
    }
    cur = prev[cur];
    depth++;
  }
  return { len: bestLen, dist: bestDist };
}

// Greedy lazy parse: fast initial parse whose frequencies seed the optimal
// parse. Much cheaper than a full DP pass: positions inside a match are skipped.
function greedyParse(data, maxChain) {
  const n = data.length;
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash3of(data, i);
    prev[i] = head[h];
    head[h] = i;
  };
  const lit = [], len = [], dist = [];
  let i = 0;
  while (i < n) {
    // Find the match at i first (chains hold positions < i only), then insert
    // i so the look-ahead match at i+1 can see it. Inserting i first would
    // let it match itself at distance 0, which deflate cannot express.
    const m0 = bestMatchAt(data, i, head, prev, maxChain);
    insert(i);
    let m1 = { len: 0, dist: 0 };
    if (m0.len >= 3 && i + 1 < n) m1 = bestMatchAt(data, i + 1, head, prev, maxChain);
    if (m0.len >= 3 && m0.len >= m1.len) {
      lit.push(0); len.push(m0.len); dist.push(m0.dist);
      for (let k = 1; k < m0.len; k++) insert(i + k);
      i += m0.len;
    } else {
      lit.push(data[i]); len.push(0); dist.push(0);
      i++;
    }
  }
  return { lit, len, dist };
}

// Dynamic-programming optimal parse under the given code lengths.
// At each position the chain is walked newest-first, so the first candidate to
// reach a length has the smallest distance for it; only newly reached lengths
// are recorded.
function optimalParse(data, litLen, distLen, maxChain) {
  const n = data.length;
  const dp = new Float64Array(n + 1);
  const choiceLen = new Int16Array(n + 1); // 0 = literal, else match length
  const choiceDist = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = Infinity;
  dp[0] = 0;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litLen[LEN_SYM[l]] + LEN_EBITS[l];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distCost[d] = distLen[DIST_SYM[d]] + DIST_EBITS[d];
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const base = dp[i];
    if (base === Infinity) {
      if (i + 2 < n) { const h = hash3of(data, i); prev[i] = head[h]; head[h] = i; }
      continue;
    }
    const lc = base + litLen[data[i]];
    if (lc < dp[i + 1]) { dp[i + 1] = lc; choiceLen[i + 1] = 0; }
    if (i + 2 < n) {
      const h = hash3of(data, i);
      let cur = head[h];
      let depth = 0;
      let bestLen = 2;
      const maxDist = i < 32768 ? i : 32768;
      while (cur >= 0 && depth < maxChain) {
        const dist = i - cur;
        if (dist > maxDist) break;
        // Only a length beyond bestLen can improve anything. Quick check: the
        // byte at offset bestLen must match, else this candidate cannot beat
        // bestLen. If it matches, scan the true length from offset 0: the
        // chain only shares a hash, so a collision may differ in the first
        // three bytes too.
        let len = 0;
        if (bestLen < 258 && i + bestLen < n && data[cur + bestLen] === data[i + bestLen]) {
          while (len < 258 && i + len < n && data[cur + len] === data[i + len]) len++;
        }
        if (len > bestLen) {
          const dc = distCost[dist];
          for (let l = bestLen + 1; l <= len; l++) {
            const c = base + lenCost[l] + dc;
            if (c < dp[i + l]) { dp[i + l] = c; choiceLen[i + l] = l; choiceDist[i + l] = dist; }
          }
          bestLen = len;
          if (bestLen >= 258) break;
        }
        cur = prev[cur];
        depth++;
      }
      prev[i] = head[h];
      head[h] = i;
    }
  }
  const opsLit = [];
  const opsLen = [];
  const opsDist = [];
  let i = n;
  while (i > 0) {
    const l = choiceLen[i];
    if (l === 0) {
      opsLit.push(data[i - 1]); opsLen.push(0); opsDist.push(0);
      i--;
    } else {
      opsLit.push(0); opsLen.push(l); opsDist.push(choiceDist[i]);
      i -= l;
    }
  }
  opsLit.reverse(); opsLen.reverse(); opsDist.reverse();
  return { lit: opsLit, len: opsLen, dist: opsDist };
}

function frequenciesOf(ops) {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  for (let k = 0; k < ops.len.length; k++) {
    if (ops.len[k] === 0) litFreq[ops.lit[k]]++;
    else {
      litFreq[LEN_SYM[ops.len[k]]]++;
      distFreq[DIST_SYM[ops.dist[k]]]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// A frequency table floored at 1: the DP cost model must never price a symbol
// at 0 bits, or the parse abuses symbols the seed parse never used.
function floored(freq) {
  const f = new Int32Array(freq.length);
  for (let i = 0; i < freq.length; i++) f[i] = freq[i] > 0 ? freq[i] : 1;
  return f;
}

// Emit one block (dynamic or fixed Huffman, whichever is smaller) for the parse.
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function emitBlock(w, ops, litLen, distLen, isLast) {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clFreq = new Int32Array(19);
  const seq = [];
  let hlit = 288;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = [];
  for (let i = 0; i < hlit; i++) all.push(litLen[i]);
  for (let i = 0; i < hdist; i++) all.push(distLen[i]);
  for (let i = 0; i < all.length;) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const t = Math.min(r, 138); seq.push([18, t]); clFreq[18]++; r -= t; }
      if (r >= 3) { seq.push([17, r]); clFreq[17]++; r = 0; }
      while (r > 0) { seq.push([0, 0]); clFreq[0]++; r--; }
    } else {
      seq.push([v, 0]); clFreq[v]++;
      let r = run - 1;
      while (r >= 3) { const t = Math.min(r, 6); seq.push([16, t]); clFreq[16]++; r -= t; }
      while (r > 0) { seq.push([v, 0]); clFreq[v]++; r--; }
    }
    i += run;
  }
  const clLen = huffmanLengths(clFreq, 7);
  // A code-length code with a single symbol would be incomplete (inflate
  // rejects it for CODES): add a dummy second symbol if needed.
  {
    let nzCl = 0, dummy = -1;
    for (let s = 0; s < 19; s++) { if (clFreq[s] > 0) nzCl++; else if (dummy < 0) dummy = s; }
    if (nzCl === 1 && dummy >= 0) {
      clFreq[dummy] = 1;
      const fixed = huffmanLengths(clFreq, 7);
      for (let s = 0; s < 19; s++) clLen[s] = fixed[s];
    }
  }
  const clCode = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let dynBits = 3 + 5 + 5 + 4 + hclen * 3;
  for (let k = 0; k < hclen; k++) dynBits += clLen[CL_ORDER[k]];
  for (const [s, extra] of seq) {
    dynBits += clLen[s];
    if (s === 16) dynBits += 2; else if (s === 17) dynBits += 3; else if (s === 18) dynBits += 7;
  }
  let bodyBits = 0;
  for (let k = 0; k < ops.len.length; k++) {
    if (ops.len[k] === 0) bodyBits += litLen[ops.lit[k]];
    else {
      bodyBits += litLen[LEN_SYM[ops.len[k]]] + LEN_EBITS[ops.len[k]];
      bodyBits += distLen[DIST_SYM[ops.dist[k]]] + DIST_EBITS[ops.dist[k]];
    }
  }
  bodyBits += litLen[256];
  dynBits += bodyBits;
  let fixBits = 3;
  for (let k = 0; k < ops.len.length; k++) {
    if (ops.len[k] === 0) fixBits += FIXED_LITLEN[ops.lit[k]];
    else {
      fixBits += FIXED_LITLEN[LEN_SYM[ops.len[k]]] + LEN_EBITS[ops.len[k]];
      fixBits += 5 + DIST_EBITS[ops.dist[k]];
    }
  }
  fixBits += FIXED_LITLEN[256];

  if (fixBits <= dynBits) {
    w.writeBits(isLast ? 1 : 0, 1);
    w.writeBits(1, 2); // BTYPE=01 fixed Huffman
    const fc = canonicalCodes(FIXED_LITLEN);
    const dc = canonicalCodes(FIXED_DIST);
    for (let k = 0; k < ops.len.length; k++) {
      if (ops.len[k] === 0) w.writeCode(fc[ops.lit[k]], FIXED_LITLEN[ops.lit[k]]);
      else {
        const l = ops.len[k];
        w.writeCode(fc[LEN_SYM[l]], FIXED_LITLEN[LEN_SYM[l]]);
        if (LEN_EBITS[l] > 0) w.writeBits(LEN_EVAL[l], LEN_EBITS[l]);
        const d = ops.dist[k];
        w.writeCode(dc[DIST_SYM[d]], 5);
        if (DIST_EBITS[d] > 0) w.writeBits(DIST_EVAL[d], DIST_EBITS[d]);
      }
    }
    w.writeCode(fc[256], FIXED_LITLEN[256]);
    return;
  }
  w.writeBits(isLast ? 1 : 0, 1);
  w.writeBits(2, 2); // BTYPE=10 dynamic Huffman
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.writeBits(clLen[CL_ORDER[k]], 3);
  for (const [s, extra] of seq) {
    w.writeCode(clCode[s], clLen[s]);
    if (s === 16) w.writeBits(extra - 3, 2);
    else if (s === 17) w.writeBits(extra - 3, 3);
    else if (s === 18) w.writeBits(extra - 11, 7);
  }
  for (let k = 0; k < ops.len.length; k++) {
    if (ops.len[k] === 0) w.writeCode(litCode[ops.lit[k]], litLen[ops.lit[k]]);
    else {
      const l = ops.len[k];
      w.writeCode(litCode[LEN_SYM[l]], litLen[LEN_SYM[l]]);
      if (LEN_EBITS[l] > 0) w.writeBits(LEN_EVAL[l], LEN_EBITS[l]);
      const d = ops.dist[k];
      w.writeCode(distCode[DIST_SYM[d]], distLen[DIST_SYM[d]]);
      if (DIST_EBITS[d] > 0) w.writeBits(DIST_EVAL[d], DIST_EBITS[d]);
    }
  }
  w.writeCode(litCode[256], litLen[256]);
}

// Compress filtered bytes as one deflate stream: a greedy lazy parse seeds the
// frequencies, one optimal-parse pass under the iterated Huffman lengths
// follows, and the block is emitted with dynamic or fixed Huffman, whichever
// is smaller. Chain depth 192: measured the best size within the wall budget
// on the practice set (chain 128: smaller but worse; chain 256: no better).
function deflateOptimal(data) {
  const MAX_CHAIN = 192;
  let ops = greedyParse(data, MAX_CHAIN);
  const { litFreq, distFreq } = frequenciesOf(ops);
  const litLen = huffmanLengths(floored(litFreq), 15);
  const distLen = huffmanLengths(floored(distFreq), 15);
  ops = optimalParse(data, litLen, distLen, MAX_CHAIN);
  const f2 = frequenciesOf(ops);
  const litLen2 = huffmanLengths(f2.litFreq, 15);
  const distLen2 = huffmanLengths(f2.distFreq, 15);
  if (f2.distFreq.every((f) => f === 0)) distLen2[0] = 1;
  const w = new BitWriter();
  emitBlock(w, ops, litLen2, distLen2, true);
  w.align();
  return w.result();
}

function zlibWrap(raw, original) {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(2 + raw.length, adler32(original));
  return out;
}

// ---- Entry point ----
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function squeezeOne(id) {
  const inPath = join(I, id, 'image.png');
  const raw = readFileSync(inPath);
  let image;
  try {
    image = decodePng(new Uint8Array(raw));
  } catch {
    // Not a PNG the decoder reads: pass it through unchanged rather than
    // failing the whole set (the grader scores it 0, the other instances
    // still count).
    mkdirSync(join(O, id), { recursive: true });
    writeFileSync(join(O, id, 'image.png'), raw);
    return;
  }
  const { form, data } = screen(image.rgba, image.width, image.height);
  const idat = zlibWrap(deflateOptimal(data), data);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, form, idat));
}

for (const id of readdirSync(I).sort()) {
  try {
    squeezeOne(id);
  } catch {
    // Any failure on one instance must not lose the set: fall back to the
    // stored input (a valid PNG of the same pixels, 0 points for that
    // instance, but answered and in format).
    try {
      mkdirSync(join(O, id), { recursive: true });
      copyFileSync(join(I, id, 'image.png'), join(O, id, 'image.png'));
    } catch {
      // Nothing more can be done for this instance.
    }
  }
}
