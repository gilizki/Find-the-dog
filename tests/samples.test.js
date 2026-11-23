import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import {
  barkVariation, downmixToMono, maxWindowRms, normalizeLoudness, peakOf, pickIndex, prepareBark, resolveManifest,
  trimSilence,
} from '../src/samples.js';
import { synthBark } from '../src/sounds.js';
import { seededRng } from './helpers.js';

const SR = 48000;
const P = CONFIG.audio.barkProcessing;

/** A fake recording: `silenceMs` of near-silence, then a decaying 450 Hz burst at `level`. */
function fakeBark({ silenceMs = 200, level = 0.5, ms = 250, noise = 0.0005 } = {}, rng = seededRng(1)) {
  const lead = Math.round((SR * silenceMs) / 1000);
  const n = lead + Math.round((SR * ms) / 1000) + SR * 0.1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (rng() * 2 - 1) * noise;
    if (i >= lead) {
      const t = (i - lead) / SR;
      x[i] += level * Math.sin(2 * Math.PI * 450 * t) * Math.exp(-t / 0.05) * Math.min(1, t / 0.004);
    }
  }
  return { x, lead };
}

test('stereo is downmixed to mono (average of channels)', () => {
  const L = Float32Array.from([1, 0.5, -1]);
  const R = Float32Array.from([0, 0.5, 1]);
  assert.deepEqual([...downmixToMono([L, R])], [0.5, 0.5, 0]);
  const mono = Float32Array.from([0.1, 0.2]);
  const out = downmixToMono([mono]);
  assert.deepEqual([...out], [...mono]);
  assert.notEqual(out, mono, 'returns a copy');
});

test('leading silence is trimmed so the bark starts (almost) instantly', () => {
  const { x, lead } = fakeBark({ silenceMs: 300 });
  const out = trimSilence(x, SR, P);
  // The first sample above the threshold is within the configured pre-roll (+1 ms slack).
  const thr = peakOf(out) * Math.pow(10, P.leadingDb / 20);
  const firstLoud = out.findIndex((v) => Math.abs(v) >= thr);
  assert.ok(firstLoud <= (SR * (P.preRollMs + 1)) / 1000, `starts after ${(firstLoud / SR * 1000).toFixed(1)} ms`);
  assert.ok(out.length < x.length - lead * 0.9, 'most of the silence is gone');
  assert.ok(Math.abs(out[0]) < 1e-3, 'faded in, no click');
  assert.ok(Math.abs(out[out.length - 1]) < 1e-3, 'faded out, no click');
});

test('loudness normalization makes quiet and loud recordings match', () => {
  const quiet = prepareBark([fakeBark({ level: 0.05 }).x], SR, P);
  const loud = prepareBark([fakeBark({ level: 0.9, silenceMs: 50 }).x], SR, P);
  const a = maxWindowRms(quiet, SR, P.rmsWindowMs);
  const b = maxWindowRms(loud, SR, P.rmsWindowMs);
  assert.ok(Math.abs(20 * Math.log10(a / b)) < 0.5, `rms ${a} vs ${b}`);
  assert.ok(Math.abs(a - P.targetRms) / P.targetRms < 0.05);
});

test('normalization never pushes the peak above maxPeak', () => {
  const spiky = new Float32Array(SR * 0.3);
  spiky[1000] = 0.2; // a single click: tiny RMS, would need huge gain
  const out = normalizeLoudness(spiky, SR, P);
  assert.ok(peakOf(out) <= P.maxPeak + 1e-6);
});

test('stereo recording end-to-end: mono, trimmed, normalized', () => {
  const { x } = fakeBark({ silenceMs: 150, level: 0.3 });
  const out = prepareBark([x, x.map((v) => v * 0.5)], SR, P);
  assert.ok(out instanceof Float32Array);
  assert.ok(out.length < x.length);
  assert.ok(peakOf(out) <= P.maxPeak + 1e-6);
});

test('sample pick never repeats back-to-back and uses every sample', () => {
  const rng = seededRng(77);
  for (const count of [2, 3, 7]) {
    let last = -1;
    const used = new Set();
    for (let i = 0; i < 2000; i++) {
      const k = pickIndex(count, last, rng);
      assert.ok(k >= 0 && k < count);
      assert.notEqual(k, last);
      used.add(k);
      last = k;
    }
    assert.equal(used.size, count);
  }
  assert.equal(pickIndex(1, 0, rng), 0, 'single sample: just play it');
});

test('per-bark variation stays within rate 0.92-1.08 and ±1.5 dB', () => {
  const rng = seededRng(5);
  const V = CONFIG.audio.barkVariation;
  let minR = Infinity, maxR = -Infinity, minDb = Infinity, maxDb = -Infinity;
  for (let i = 0; i < 5000; i++) {
    const v = barkVariation(V, rng);
    minR = Math.min(minR, v.rate); maxR = Math.max(maxR, v.rate);
    minDb = Math.min(minDb, v.gainDb); maxDb = Math.max(maxDb, v.gainDb);
    assert.ok(Math.abs(v.gain - Math.pow(10, v.gainDb / 20)) < 1e-12);
  }
  assert.ok(minR >= 0.92 && maxR <= 1.08 && maxR - minR > 0.14, `rate ${minR}..${maxR}`);
  assert.ok(minDb >= -1.5 && maxDb <= 1.5 && maxDb - minDb > 2.8, `dB ${minDb}..${maxDb}`);
});

test('manifest entries resolve relative to the manifest', () => {
  const urls = resolveManifest({ files: ['a.wav', 'b c.mp3', '', 3] }, 'assets/barks/manifest.json', 'http://localhost:8000/index.html');
  assert.deepEqual(urls, ['http://localhost:8000/assets/barks/a.wav', 'http://localhost:8000/assets/barks/b%20c.mp3']);
  assert.deepEqual(resolveManifest(['x.ogg'], 'assets/barks/manifest.json', 'http://h/'), ['http://h/assets/barks/x.ogg']);
  assert.deepEqual(resolveManifest(null, 'm.json'), []);
});

// ---- synthesized fallback -------------------------------------------------

/** Fundamental via normalized autocorrelation over [startMs, startMs + lenMs). */
function pitchAt(x, startMs, lenMs = 15) {
  const s = Math.round((SR * startMs) / 1000);
  const n = Math.round((SR * lenMs) / 1000);
  let best = 0, bestLag = 0;
  for (let lag = Math.floor(SR / 800); lag <= Math.ceil(SR / 180); lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = s; i < s + n; i++) { num += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
    const r = num / Math.sqrt(e1 * e2 + 1e-12);
    if (r > best) { best = r; bestLag = lag; }
  }
  return SR / bestLag;
}

const synth = (seed, extra = {}) => synthBark(SR, { ...CONFIG.audio.synthBark, doublePulseChance: 0, noiseLevel: 0, ...extra, rng: seededRng(seed) });

test('synth bark: starting pitch in 380-560 Hz and a ~30-40 % downward glide', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const x = synth(seed);
    const early = pitchAt(x, 2);
    const late = pitchAt(x, 140);
    assert.ok(early > 330 && early < 600, `early pitch ${early.toFixed(0)} Hz (seed ${seed})`);
    const drop = 1 - late / early;
    assert.ok(drop > 0.2 && drop < 0.45, `drop ${(drop * 100).toFixed(0)} % (seed ${seed})`);
  }
});

test('synth bark: fast attack, 150-250 ms woof, optional quieter second pulse', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const x = synthBark(SR, { ...CONFIG.audio.synthBark, doublePulseChance: 0, rng: seededRng(seed) });
    const pk = peakOf(x);
    const firstHalf = x.findIndex((v) => Math.abs(v) >= pk * 0.5);
    assert.ok(firstHalf / SR < 0.01, `reaches half level after ${(firstHalf / SR * 1000).toFixed(1)} ms`);
    const ms = (x.length / SR) * 1000;
    assert.ok(ms >= 170 && ms <= 270, `single woof length ${ms.toFixed(0)} ms`);
  }
  const dbl = synthBark(SR, { ...CONFIG.audio.synthBark, doublePulseChance: 1, rng: seededRng(3) });
  assert.ok(dbl.length / SR > 0.24, 'double bark is longer');
  const at = Math.round(SR * 0.13);
  const second = peakOf(dbl.subarray(at, at + Math.round(SR * 0.03)));
  assert.ok(second > 0.1 && second < peakOf(dbl.subarray(0, Math.round(SR * 0.03))), 'second pulse present and quieter');
});

test('synth bark: randomized per bark, and most energy in the 0.4-3.2 kHz formant region', () => {
  const a = synth(1), b = synth(2);
  assert.ok(a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > 1e-3), 'barks differ');
  // Energy share via a coarse DFT (Parseval).
  const x = synthBark(SR, { ...CONFIG.audio.synthBark, doublePulseChance: 0, rng: seededRng(9) });
  const n = x.length;
  let total = 0;
  for (const v of x) total += v * v;
  let band = 0;
  for (let k = Math.ceil((400 * n) / SR); k <= Math.floor((3200 * n) / SR); k++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    band += (2 * (re * re + im * im)) / n;
  }
  assert.ok(band / total > 0.7, `band energy share ${(band / total * 100).toFixed(0)} %`);
});
