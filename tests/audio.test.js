import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { forwardVector, rightVector } from '../src/geometry.js';
import {
  computeDogParams, distanceCutoff, inverseDistanceGain, listenerOrientation, rearAmount, toAudioPosition,
} from '../src/audioMapping.js';
import { synthBark, synthBump, synthEndCue, synthFootstep, synthStartCue, synthWinJingle } from '../src/sounds.js';
import { equalPowerGains, seededRng, webAudioAzimuth } from './helpers.js';

const A = CONFIG.audio;
const dB = (g) => 20 * Math.log10(g);

/** Runs the exact vectors audio.js sends to Web Audio through the spec's panner math. */
function browserView(player, dog) {
  const { forward, up } = listenerOrientation(player.heading);
  const az = webAudioAzimuth(toAudioPosition(player.x, player.y), forward, up, toAudioPosition(dog.x, dog.y));
  return { az, ...equalPowerGains(az) };
}

test('left/right is NOT mirrored: dog on the right -> positive azimuth and louder right channel', () => {
  const rng = seededRng(2024);
  for (let i = 0; i < 500; i++) {
    const player = { x: 5 + rng() * 60, y: 5 + rng() * 60, heading: rng() * Math.PI * 2 - Math.PI };
    const r = rightVector(player.heading);
    const f = forwardVector(player.heading);
    const side = 1 + rng() * 20; // how far to the right
    const fwd = (rng() * 2 - 1) * 15; // anywhere from behind to ahead
    const dog = { x: player.x + r.x * side + f.x * fwd, y: player.y + r.y * side + f.y * fwd };

    const game = computeDogParams(player, dog, A);
    assert.ok(game.azimuth > 0, `game azimuth should be positive, got ${game.azimuth}`);

    const browser = browserView(player, dog);
    assert.ok(browser.az > 0, `Web Audio azimuth should be positive, got ${browser.az}`);
    assert.ok(browser.right > browser.left, `right ${browser.right} should exceed left ${browser.left}`);

    // Mirror case: dog on the left -> left louder.
    const dogL = { x: player.x - r.x * side + f.x * fwd, y: player.y - r.y * side + f.y * fwd };
    const left = browserView(player, dogL);
    assert.ok(computeDogParams(player, dogL, A).azimuth < 0);
    assert.ok(left.az < 0 && left.left > left.right);
  }
});

test('game azimuth and Web Audio azimuth agree in degrees (for sources in front)', () => {
  const rng = seededRng(9);
  for (let i = 0; i < 200; i++) {
    const player = { x: 30, y: 30, heading: rng() * 6 - 3 };
    const ang = (rng() * 2 - 1) * (Math.PI / 2 - 0.01); // front half
    const f = forwardVector(player.heading), r = rightVector(player.heading);
    const dog = { x: player.x + (f.x * Math.cos(ang) + r.x * Math.sin(ang)) * 10, y: player.y + (f.y * Math.cos(ang) + r.y * Math.sin(ang)) * 10 };
    const gameDeg = (computeDogParams(player, dog, A).azimuth * 180) / Math.PI;
    assert.ok(Math.abs(gameDeg - browserView(player, dog).az) < 1e-6);
  }
});

test('distance falloff: audible at 50 m, clearly quieter than at 10 m', () => {
  const g10 = inverseDistanceGain(10, A);
  const g25 = inverseDistanceGain(25, A);
  const g50 = inverseDistanceGain(50, A);
  // Audible: no more than 26 dB below the reference level.
  assert.ok(dB(g50) > -26, `50 m is ${dB(g50).toFixed(1)} dB`);
  // Clearly quieter: at least 9 dB below 10 m.
  assert.ok(dB(g10) - dB(g50) >= 9, `10 m vs 50 m difference only ${(dB(g10) - dB(g50)).toFixed(1)} dB`);
  assert.ok(g10 > g25 && g25 > g50);
  // Within the reference distance (i.e. right next to the dog) the gain is full.
  assert.equal(inverseDistanceGain(1, A), 1);
});

test('master gain and rolloff are exposed in config and drive the mapping', () => {
  assert.equal(typeof A.masterGain, 'number');
  assert.equal(typeof A.rolloffFactor, 'number');
  const steeper = { ...A, rolloffFactor: A.rolloffFactor * 2 };
  assert.ok(inverseDistanceGain(30, steeper) < inverseDistanceGain(30, A));
  const player = { x: 10, y: 10, heading: 0 };
  const dog = { x: 30, y: 10 };
  const loud = computeDogParams(player, dog, { ...A, masterGain: 1 });
  const quiet = computeDogParams(player, dog, { ...A, masterGain: 0.5 });
  assert.ok(Math.abs(quiet.totalGain - loud.totalGain / 2) < 1e-12);
});

test('low-pass cutoff falls with distance', () => {
  let prev = Infinity;
  for (let d = 0; d <= 70; d += 5) {
    const c = distanceCutoff(d, A.lowpass);
    assert.ok(c <= prev);
    prev = c;
  }
  assert.ok(distanceCutoff(1, A.lowpass) === A.lowpass.nearHz);
  assert.ok(distanceCutoff(100, A.lowpass) === A.lowpass.farHz);
});

test('front/back: a dog behind is darker and quieter than the same dog in front', () => {
  const player = { x: 30, y: 30, heading: 0.7 };
  const f = forwardVector(player.heading);
  const ahead = computeDogParams(player, { x: 30 + f.x * 15, y: 30 + f.y * 15 }, A);
  const behind = computeDogParams(player, { x: 30 - f.x * 15, y: 30 - f.y * 15 }, A);
  assert.ok(Math.abs(ahead.distance - behind.distance) < 1e-9);
  assert.ok(behind.cutoffHz < ahead.cutoffHz * 0.6);
  assert.ok(behind.totalGain < ahead.totalGain);
  // Sides untouched, smooth blend
  assert.ok(Math.abs(rearAmount(Math.PI / 2)) < 1e-12 && rearAmount(0) === 0 && rearAmount(Math.PI) === 1);
});

test('procedural sounds are non-empty, finite and never clip', () => {
  const sr = 48000;
  const rng = seededRng(5);
  const sounds = {
    bark: synthBark(sr, { rng }), footstep: synthFootstep(sr, { rng }), bump: synthBump(sr, { rng }),
    start: synthStartCue(sr), end: synthEndCue(sr), win: synthWinJingle(sr, { rng }),
  };
  for (const [name, s] of Object.entries(sounds)) {
    assert.ok(s.length > sr * 0.05, `${name} too short`);
    let peak = 0;
    for (const v of s) {
      assert.ok(Number.isFinite(v), `${name} has non-finite sample`);
      peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(peak > 0.5 && peak <= 1, `${name} peak ${peak}`);
  }
});
