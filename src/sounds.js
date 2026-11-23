// Procedural sound synthesis. Each generator returns a mono Float32Array at the given sample
// rate, so they are pure and testable without a browser. audio.js wraps them in AudioBuffers.
// Real recordings (assets/barks, assets/ambient, assets/birds) take precedence; see README "Sound files".

const TAU = Math.PI * 2;

function normalize(buf, peak = 0.9) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < buf.length; i++) buf[i] *= k;
  }
  return buf;
}

/** One-pole low-pass coefficient for a cutoff frequency. */
const onePole = (hz, sr) => 1 - Math.exp((-TAU * hz) / sr);

/** Adds `src` into `out` starting at `offset` samples, scaled by `gain`. */
export function mixInto(out, src, offset = 0, gain = 1) {
  for (let i = 0; i < src.length && offset + i < out.length; i++) out[offset + i] += src[i] * gain;
  return out;
}

/** RBJ band-pass biquad (constant 0 dB peak gain) with state, processing one sample at a time. */
function bandpass(hz, q, sr) {
  const w0 = (TAU * hz) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** PolyBLEP correction: removes most of the aliasing of a naive sawtooth. */
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Default synthesized-bark parameters; CONFIG.audio.synthBark overrides these. */
export const SYNTH_BARK_DEFAULTS = {
  pitchHz: [380, 560],        // starting fundamental, random per bark
  glide: [0.3, 0.4],          // downward pitch glide as a fraction of the start pitch
  glideMs: 150,               // time to complete the glide
  vibratoHz: [5, 8],
  vibratoDepth: 0.015,        // ±1.5 %
  jitter: 0.01,               // random pitch wobble (fraction)
  attackMs: 5,
  durationMs: [170, 240],     // length of the main "woof" (decay included)
  formantsHz: [700, 1200, 2600],
  formantQ: [5, 6, 8],
  formantGains: [1, 0.7, 0.35],
  formantJitter: 0.08,        // ±8 % per bark
  noiseHz: 1800,              // centre of the band-passed attack noise
  noiseMs: 22,                // decay time of the attack noise
  noiseLevel: 0.6,
  doublePulseChance: 0.35,    // chance of a quieter second pulse ("wuf-wuf")
  secondPulseDelayMs: 120,
  secondPulseGain: 0.5,
  pitchScale: 1,              // >1 for a small-dog yip
};

/**
 * Dog-like "woof": a sawtooth with a fast ~30-40 % downward pitch glide, vibrato and jitter, plus a
 * band-passed noise burst at the onset, shaped by three parallel formant band-passes ("wuf" vowel),
 * a ~5 ms attack and a 150-250 ms decay. Every call is randomized slightly (pitch, formants, length).
 */
export function synthBark(sr, opts = {}) {
  const o = { ...SYNTH_BARK_DEFAULTS, ...opts };
  const rng = opts.rng ?? Math.random;
  const rand = ([a, b]) => a + rng() * (b - a);
  const jit = (v, amount) => v * (1 + (rng() * 2 - 1) * amount);

  const f0 = rand(o.pitchHz) * o.pitchScale;
  const glide = rand(o.glide);
  const dur = rand(o.durationMs) / 1000;
  const pulses = [{ at: 0, f0, glide, dur, gain: 1 }];
  if (rng() < o.doublePulseChance) {
    pulses.push({
      at: jit(o.secondPulseDelayMs / 1000, 0.1),
      f0: f0 * (0.9 + rng() * 0.07),
      glide: glide * 0.9,
      dur: dur * (0.55 + rng() * 0.15),
      gain: o.secondPulseGain,
    });
  }
  const total = Math.max(...pulses.map((p) => p.at + p.dur)) + 0.02;
  const n = Math.floor(sr * total);

  // 1) Source: sawtooth + band-passed noise burst, per pulse
  const src = new Float32Array(n);
  const glideT = o.glideMs / 1000;
  const attack = o.attackMs / 1000;
  const aJit = onePole(30, sr);
  for (const p of pulses) {
    const off = Math.floor(p.at * sr);
    const len = Math.floor(p.dur * sr);
    const vibHz = rand(o.vibratoHz);
    const vibPhase = rng() * TAU;
    const noiseBp = bandpass(o.noiseHz, 1.2, sr);
    const tau = (p.dur - attack) / 4.5; // ~-40 dB by the end of the pulse
    const fadeLen = Math.floor(0.01 * sr);
    let phase = rng();
    let j = 0;
    for (let i = 0; i < len && off + i < n; i++) {
      const t = i / sr;
      const g = Math.min(1, t / glideT);
      const glideFrac = (1 - Math.exp(-3 * g)) / (1 - Math.exp(-3)); // fast at first, eases out
      j += aJit * (rng() * 2 - 1 - j);
      const f = p.f0 * (1 - p.glide * glideFrac) * (1 + o.vibratoDepth * Math.sin(TAU * vibHz * t + vibPhase) + o.jitter * 8 * j);
      const dt = f / sr;
      phase += dt;
      if (phase >= 1) phase -= 1;
      const saw = 2 * phase - 1 - polyBlep(phase, dt);
      let env = t < attack ? t / attack : Math.exp(-(t - attack) / tau);
      if (len - i < fadeLen) env *= (len - i) / fadeLen;
      const noise = noiseBp(rng() * 2 - 1) * Math.exp(-t / (o.noiseMs / 1000)) * o.noiseLevel * 3;
      src[off + i] += p.gain * (saw * env + noise * Math.min(1, t / 0.001));
    }
  }

  // 2) Parallel formant filters (randomized slightly) + a little low-passed body
  const banks = o.formantsHz.map((hz, k) => ({
    filter: bandpass(jit(hz, o.formantJitter) * Math.sqrt(o.pitchScale), o.formantQ[k], sr),
    gain: o.formantGains[k],
  }));
  const aBody = onePole(900, sr);
  let body = 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let y = 0;
    for (const b of banks) y += b.filter(src[i]) * b.gain;
    body += aBody * (src[i] - body);
    out[i] = y + 0.15 * body;
  }
  // 3) Gentle saturation for a bit of throat grit
  const pk = peakOf(out) || 1;
  for (let i = 0; i < n; i++) out[i] = Math.tanh((1.6 * out[i]) / pk);
  return normalize(out, 0.9);
}

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** Soft footstep: low thud plus a little filtered scuff. */
export function synthFootstep(sr, { rng = Math.random } = {}) {
  const duration = 0.11;
  const n = Math.floor(sr * duration);
  const out = new Float32Array(n);
  const a = onePole(700 + rng() * 300, sr);
  const thudHz = 65 + rng() * 20;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    lp += a * (rng() * 2 - 1 - lp);
    out[i] = lp * Math.exp(-t / 0.02) * 1.5 + Math.sin(TAU * thudHz * t) * Math.exp(-t / 0.03) * 0.6;
    out[i] *= Math.min(1, t / 0.002);
  }
  return normalize(out, 0.8);
}

/** Dull thump for walking into a wall. */
export function synthBump(sr, { rng = Math.random } = {}) {
  const duration = 0.3;
  const n = Math.floor(sr * duration);
  const out = new Float32Array(n);
  const a = onePole(1200, sr);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 55 + 45 * Math.exp(-t / 0.04);
    phase += (TAU * f) / sr;
    lp += a * (rng() * 2 - 1 - lp);
    out[i] = Math.tanh(2 * (Math.sin(phase) * Math.exp(-t / 0.07) + lp * Math.exp(-t / 0.012) * 0.8));
    out[i] *= Math.min(1, t / 0.002);
  }
  return normalize(out, 0.9);
}

/** Bell-like notes: [{ hz, start, dur, gain }]. */
export function synthTones(sr, notes, { tail = 0.1 } = {}) {
  const total = Math.max(...notes.map((nt) => nt.start + nt.dur)) + tail;
  const out = new Float32Array(Math.floor(sr * total));
  for (const { hz, start, dur, gain = 1 } of notes) {
    const off = Math.floor(start * sr);
    const len = Math.floor(dur * sr);
    for (let i = 0; i < len && off + i < out.length; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.01) * Math.exp(-t / (dur * 0.35));
      const s = Math.sin(TAU * hz * t) + 0.3 * Math.sin(TAU * 2 * hz * t) + 0.08 * Math.sin(TAU * 3 * hz * t);
      out[off + i] += s * env * gain;
    }
  }
  return normalize(out, 0.8);
}

/** Round-start cue: soft rising fifth. */
export const synthStartCue = (sr) =>
  synthTones(sr, [
    { hz: 523.25, start: 0, dur: 0.35, gain: 0.8 },
    { hz: 783.99, start: 0.13, dur: 0.45 },
  ]);

/** Round-end cue: descending three-note figure (clearly different from the start cue). */
export const synthEndCue = (sr) =>
  synthTones(sr, [
    { hz: 783.99, start: 0, dur: 0.3 },
    { hz: 659.25, start: 0.12, dur: 0.3 },
    { hz: 523.25, start: 0.24, dur: 0.5 },
  ]);

/** Win: bright ascending arpeggio. The engine layers two happy barks on top (real samples if loaded). */
export const synthWinJingle = (sr) =>
  synthTones(
    sr,
    [523.25, 659.25, 783.99, 1046.5].map((hz, i) => ({ hz, start: i * 0.11, dur: i === 3 ? 0.7 : 0.25 })),
    { tail: 0.3 },
  );

// ---- Forest ambience + tree thud --------------------------------------------------------------

/** Smooth random control signal in [0, 1]: cosine-interpolated random points every ~periodSec. */
function smoothRandom(n, sr, periodSec, rng) {
  const out = new Float32Array(n);
  const step = Math.max(1, Math.round(periodSec * sr));
  let a = rng(), b = rng();
  for (let i = 0; i < n; i++) {
    const k = i % step;
    if (k === 0 && i > 0) { a = b; b = rng(); }
    const u = k / step;
    out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  }
  return out;
}

/** Makes a buffer loop seamlessly by crossfading its extra tail into its head. */
function loopify(x, n, xf) {
  const out = x.slice(0, n);
  for (let i = 0; i < xf; i++) {
    const u = i / xf;
    out[i] = x[i] * Math.sqrt(u) + x[n + i] * Math.sqrt(1 - u);
  }
  return out;
}

/** Low, continuous, slowly breathing wind. Returns [left, right] (decorrelated), loopable. */
export function synthWindBed(sr, { seconds = 10, rng = Math.random } = {}) {
  const xf = Math.floor(sr * 1.5);
  const n = Math.floor(sr * seconds);
  return [0, 1].map(() => {
    const total = n + xf;
    const cut = smoothRandom(total, sr, 2.5, rng);
    const amp = smoothRandom(total, sr, 3.5, rng);
    const x = new Float32Array(total);
    let l1 = 0, l2 = 0;
    for (let i = 0; i < total; i++) {
      const a = onePole(220 + 380 * cut[i], sr);
      l1 += a * (rng() * 2 - 1 - l1);
      l2 += a * (l1 - l2);
      x[i] = l2 * (0.65 + 0.35 * amp[i]);
    }
    return normalize(loopify(x, n, xf), 0.9);
  });
}

/**
 * One gust: wind noise whose level and brightness swell in and out, plus leaf rustle
 * (high-passed, crackly noise) that follows the gust's strength.
 */
export function synthGust(sr, { duration = 4, rng = Math.random } = {}) {
  const n = Math.floor(sr * duration);
  const out = new Float32Array(n);
  const wobble = smoothRandom(n, sr, 0.6, rng);
  const crackle = smoothRandom(n, sr, 0.035, rng);
  const peakAt = 0.35 + rng() * 0.3;
  const aHp = onePole(1500, sr);
  let l1 = 0, l2 = 0, hpLp = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // asymmetric swell: rise to peakAt, then fall
    const s = u < peakAt ? u / peakAt : (1 - u) / (1 - peakAt);
    const env = Math.pow(Math.sin((Math.PI / 2) * s), 2) * (0.75 + 0.25 * wobble[i]);
    const a = onePole(250 + 1100 * env, sr);
    const w = rng() * 2 - 1;
    l1 += a * (w - l1);
    l2 += a * (l1 - l2);
    hpLp += aHp * (w - hpLp);
    const rustle = (w - hpLp) * Math.pow(crackle[i], 3) * env * env;
    out[i] = l2 * env * 2.2 + rustle * 0.5;
  }
  return normalize(out, 0.9);
}

/** A bird call: 2-5 syllables of sweeps, rising whistles or trills in the 2-6 kHz range. */
export function synthBirdChirp(sr, { rng = Math.random } = {}) {
  const syllables = 2 + Math.floor(rng() * 4);
  const style = ['sweep', 'up', 'trill'][Math.floor(rng() * 3)];
  const base = 2500 + rng() * 2000;
  const parts = [];
  let t = 0.01;
  for (let k = 0; k < syllables; k++) {
    const dur = 0.04 + rng() * 0.1;
    parts.push({ start: t, dur, f0: base * (0.9 + rng() * 0.2) });
    t += dur + 0.03 + rng() * 0.06;
  }
  const out = new Float32Array(Math.floor(sr * (t + 0.02)));
  for (const p of parts) {
    const off = Math.floor(p.start * sr), len = Math.floor(p.dur * sr);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const u = i / len;
      let f;
      if (style === 'sweep') f = p.f0 * (1.4 - 0.7 * u);
      else if (style === 'up') f = p.f0 * (0.75 + 0.6 * u * u);
      else f = p.f0 * (1 + 0.12 * Math.sin(TAU * 45 * (i / sr)));
      phase += (TAU * f) / sr;
      const env = Math.pow(Math.sin(Math.PI * u), 2);
      out[off + i] += (Math.sin(phase) + 0.12 * Math.sin(2 * phase)) * env;
    }
  }
  return normalize(out, 0.9);
}

/** Optional crickets: pulsed ~4.5 kHz chirps. Returns [left, right], loopable. */
export function synthCrickets(sr, { seconds = 6, rng = Math.random } = {}) {
  const xf = Math.floor(sr * 0.5);
  const n = Math.floor(sr * seconds);
  return [0, 1].map(() => {
    const total = n + xf;
    const x = new Float32Array(total);
    const hz = 4300 + rng() * 500;
    const pulseHz = 14 + rng() * 6;
    const groupSec = 0.4 + rng() * 0.4;
    const gapSec = 0.3 + rng() * 0.5;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      const inGroup = (t % (groupSec + gapSec)) < groupSec;
      const pulse = Math.max(0, Math.sin(TAU * pulseHz * t)) ** 6;
      x[i] = inGroup ? Math.sin(TAU * hz * t) * pulse : 0;
    }
    return normalize(loopify(x, n, xf), 0.9);
  });
}

/** Soft woody thud for walking into a tree (distinct from the wall bump). */
export function synthTreeThud(sr, { rng = Math.random } = {}) {
  const n = Math.floor(sr * 0.2);
  const out = new Float32Array(n);
  const a = onePole(900, sr);
  const res = 380 + rng() * 80;
  let phase = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (TAU * (80 + 45 * Math.exp(-t / 0.03))) / sr;
    lp += a * (rng() * 2 - 1 - lp);
    out[i] = Math.sin(phase) * Math.exp(-t / 0.045)
      + Math.sin(TAU * res * t) * Math.exp(-t / 0.02) * 0.45
      + lp * Math.exp(-t / 0.004) * 0.8;
    out[i] *= Math.min(1, t / 0.003);
  }
  return normalize(out, 0.85);
}
