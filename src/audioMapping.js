// Pure mapping from game state -> spatial-audio parameters. No Web Audio calls here,
// so everything is unit-testable and easy to tune. audio.js applies these values.

import { distance, forwardVector, relativeAzimuth } from './geometry.js';
import { occlusion as treeOcclusion } from './forest.js';
import { ambientProfile } from './ambientDirector.js';

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
/** Power sum of levels in dB (uncorrelated sources). */
export const sumDb = (levels) => 10 * Math.log10(levels.reduce((s, db) => s + Math.pow(10, db / 10), 0));

/**
 * Game (x, y) -> Web Audio (x, y, z).
 * The game plane is the horizontal audio plane (audio Y = up). Game y maps to audio +Z.
 * With forward = (cos h, 0, sin h) and up = (0, 1, 0), Web Audio's right = forward x up
 * = (-sin h, 0, cos h), which equals the game's rightVector(h). So left/right are NOT mirrored
 * (verified in tests/audio.test.js against the spec's panning math).
 */
export function toAudioPosition(x, y, height = 0) {
  return { x, y: height, z: y };
}

export function listenerOrientation(heading) {
  const f = forwardVector(heading);
  return { forward: { x: f.x, y: 0, z: f.y }, up: { x: 0, y: 1, z: 0 } };
}

/** Same formula the PannerNode uses for distanceModel "inverse" (Web Audio spec). */
export function inverseDistanceGain(d, { refDistance, rolloffFactor, maxDistance = Infinity }) {
  const dd = Math.max(Math.min(d, maxDistance), refDistance);
  return refDistance / (refDistance + rolloffFactor * (dd - refDistance));
}

/** Low-pass cutoff simulating air absorption: log-interpolated between nearHz and farHz. */
export function distanceCutoff(d, lp) {
  const t = Math.min(1, Math.max(0, (d - lp.nearDistance) / (lp.farDistance - lp.nearDistance)));
  return lp.nearHz * Math.pow(lp.farHz / lp.nearHz, t);
}

/** 0 when the source is in front or at the sides, rising smoothly to 1 directly behind. */
export function rearAmount(azimuth) {
  return Math.max(0, -Math.cos(azimuth));
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Everything the audio engine needs about the dog relative to the player.
 * `distanceGain` is what the PannerNode applies itself; `toneGain` (rear muffle x tree occlusion)
 * and `cutoffHz` (air absorption x rear x occlusion) are applied by our own nodes before the panner.
 * Occlusion changes only level and brightness, never the direction.
 */
export function computeDogParams(player, dog, audioCfg, { trees = [], occlusion: occCfg = null } = {}) {
  const d = distance(player, dog);
  const azimuth = relativeAzimuth(player, dog);
  const rear = rearAmount(azimuth);
  const occ = treeOcclusion(player, dog, trees, occCfg);
  const cutoffHz = distanceCutoff(d, audioCfg.lowpass) * lerp(1, audioCfg.rear.cutoffFactor, rear) * occ.cutoffFactor;
  const rearGain = lerp(1, audioCfg.rear.gainFactor, rear);
  const occlusionGain = dbToGain(occ.gainDb);
  const distanceGain = inverseDistanceGain(d, audioCfg);
  return {
    distance: d,
    azimuth,
    rear,
    cutoffHz,
    rearGain,
    occlusion: occ,
    occlusionGain,
    toneGain: rearGain * occlusionGain,
    distanceGain,
    totalGain: audioCfg.masterGain * audioCfg.dogGain * rearGain * occlusionGain * distanceGain,
  };
}

/**
 * Bark vs ambient level estimate (dB, same loudness reference for all sources) at a difficulty's distance.
 * Worst case for the bark: dog directly behind, maximum tree occlusion, quietest bark variation.
 *  - quietDb: base bed (+ crickets, + steady rain), i.e. the moments between gusts and birds
 *  - busyDb:  bed + the loudest gust + a bird at birds.referenceDistance (+ a rain burst), all at their loudest jitter
 * Master gain is common to everything and cancels out; ambient.masterGain does not.
 */
export function barkVsAmbient(config, difficultyKey) {
  const A = config.audio, AM = config.ambient;
  const dist = config.difficulties[difficultyKey].distance;
  const occ = config.trees?.occlusion;
  const barkDb = gainToDb(A.dogGain) + gainToDb(inverseDistanceGain(dist, A)) + gainToDb(A.rear.gainFactor)
    + (occ?.enabled ? occ.maxDb : 0) - A.barkVariation.gainJitterDb;
  const p = ambientProfile(config, difficultyKey);
  const amb = gainToDb(AM.masterGain);
  const quietParts = [p.bedDb];
  if (AM.crickets?.enabled) quietParts.push(AM.crickets.db);
  if (p.rain) quietParts.push(p.rain.bedDb);
  const quietDb = amb + sumDb(quietParts);
  const birdAtRef = p.birdDb + AM.levelJitterDb + gainToDb(inverseDistanceGain(AM.birds.referenceDistance, A));
  const busyParts = [...quietParts, p.gustDb + AM.levelJitterDb, birdAtRef];
  if (p.rain?.burstDb != null) busyParts.push(p.rain.burstDb + AM.levelJitterDb);
  const busyDb = amb + sumDb(busyParts);
  return { barkDb, quietDb, busyDb, quietMarginDb: barkDb - quietDb, busyMarginDb: barkDb - busyDb, profile: p };
}
