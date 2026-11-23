// Pure processing for bark samples (recorded or synthesized). No Web Audio here, so it's testable.
// Pipeline at load time: downmix to mono -> trim silence -> loudness-normalize.
// Per bark: pick a sample (never the same twice in a row) + small rate/gain variation.

const dbToGain = (db) => Math.pow(10, db / 20);

/** Averages any number of channels into one. A stereo source would break the HRTF panner's spatial image. */
export function downmixToMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

export function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** RMS of the loudest `windowMs` stretch: a loudness measure that ignores length and silent tails. */
export function maxWindowRms(x, sr, windowMs = 50) {
  const w = Math.max(1, Math.min(x.length, Math.round((sr * windowMs) / 1000)));
  let sum = 0;
  for (let i = 0; i < w; i++) sum += x[i] * x[i];
  let best = sum;
  for (let i = w; i < x.length; i++) {
    sum += x[i] * x[i] - x[i - w] * x[i - w];
    if (sum > best) best = sum;
  }
  return Math.sqrt(Math.max(0, best) / w);
}

/**
 * Removes leading silence (so the bark starts the instant SPACE is pressed) and trailing silence.
 * Thresholds are relative to the sample's own peak. Short fades avoid clicks at the new edges.
 */
export function trimSilence(x, sr, { leadingDb = -40, trailingDb = -50, preRollMs = 3, fadeOutMs = 15 } = {}) {
  const peak = peakOf(x);
  if (peak === 0) return new Float32Array(0);
  const lead = peak * dbToGain(leadingDb);
  const trail = peak * dbToGain(trailingDb);
  let first = 0;
  while (first < x.length && Math.abs(x[first]) < lead) first++;
  let last = x.length - 1;
  while (last > first && Math.abs(x[last]) < trail) last--;
  const preRoll = Math.round((sr * preRollMs) / 1000);
  const start = Math.max(0, first - preRoll);
  const end = Math.min(x.length, last + 1 + Math.round((sr * fadeOutMs) / 1000));
  const out = x.slice(start, end);
  const fadeIn = first - start;
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.min(out.length, Math.round((sr * fadeOutMs) / 1000));
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;
  return out;
}

/** Scales so the loudest window hits targetRms, without letting the peak exceed maxPeak. */
export function normalizeLoudness(x, sr, { targetRms = 0.18, maxPeak = 0.95, rmsWindowMs = 50 } = {}) {
  const rms = maxWindowRms(x, sr, rmsWindowMs);
  const peak = peakOf(x);
  if (rms === 0 || peak === 0) return x;
  const gain = Math.min(targetRms / rms, maxPeak / peak);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * gain;
  return out;
}

/** Full load-time pipeline: channels (array of Float32Array) -> mono, trimmed, normalized. */
export function prepareBark(channels, sr, opts = {}) {
  const mono = downmixToMono(channels);
  const trimmed = trimSilence(mono, sr, opts);
  return normalizeLoudness(trimmed, sr, opts);
}

/** Random index in [0, count), never equal to `last` (when there is more than one choice). */
export function pickIndex(count, last, rng = Math.random) {
  if (count <= 1) return 0;
  if (last < 0 || last >= count) return Math.floor(rng() * count) % count;
  const i = Math.floor(rng() * (count - 1)) % (count - 1);
  return i >= last ? i + 1 : i;
}

/** Per-bark variation so repeats don't sound identical. */
export function barkVariation({ rateRange = [0.92, 1.08], gainJitterDb = 1.5 } = {}, rng = Math.random) {
  const [lo, hi] = rateRange;
  const gainDb = (rng() * 2 - 1) * gainJitterDb;
  return { rate: lo + rng() * (hi - lo), gainDb, gain: dbToGain(gainDb) };
}

/** Resolves manifest entries relative to the manifest's own URL. */
export function resolveManifest(manifest, manifestUrl, base = 'http://localhost/') {
  const files = Array.isArray(manifest) ? manifest : manifest?.files;
  if (!Array.isArray(files)) return [];
  const root = new URL(manifestUrl, base);
  return files.filter((f) => typeof f === 'string' && f.trim()).map((f) => new URL(f, root).href);
}

/** Whole-file RMS normalization for continuous sounds (loops); one common gain for all channels. */
export function normalizeChannelsRms(channels, { targetRms = 0.18, maxPeak = 0.95 } = {}) {
  let sum = 0, count = 0, peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    count += ch.length;
    peak = Math.max(peak, peakOf(ch));
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  if (rms === 0) return channels.map((c) => Float32Array.from(c));
  const gain = Math.min(targetRms / rms, maxPeak / peak);
  return channels.map((c) => c.map((v) => v * gain));
}
