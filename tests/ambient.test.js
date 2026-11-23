import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { AmbientDirector, ambientProfile } from '../src/ambientDirector.js';
import { barkVsAmbient } from '../src/audioMapping.js';
import { relativeAzimuth } from '../src/geometry.js';
import { Game } from '../src/game.js';
import { synthBirdChirp, synthCrickets, synthGust, synthTreeThud, synthWindBed } from '../src/sounds.js';
import { recordingAudio, seededRng } from './helpers.js';

const AM = CONFIG.ambient;
const hardestKey = Object.entries(CONFIG.difficulties).sort((a, b) => b[1].distance - a[1].distance)[0][0];

test('distraction per difficulty: harder = more frequent and louder gusts and birds', () => {
  const e = ambientProfile(CONFIG, 'easy'), m = ambientProfile(CONFIG, 'medium'), h = ambientProfile(CONFIG, 'hard');
  assert.ok(e.distraction < m.distraction && m.distraction < h.distraction);
  for (const k of ['bedDb', 'gustDb', 'birdDb']) assert.ok(e[k] < m[k] && m[k] < h[k], k);
  for (const k of ['gustEverySec', 'birdEverySec']) {
    assert.ok(e[k][0] > h[k][0] && e[k][1] > h[k][1], `${k}: hard should be more frequent`);
  }
});

test(`bark vs ambient at the max distance (${CONFIG.difficulties[hardestKey].distance} m, ${hardestKey}): audible when quiet, masked but not buried when busy`, () => {
  const r = barkVsAmbient(CONFIG, hardestKey);
  assert.ok(r.quietMarginDb >= AM.minQuietMarginDb, `quiet margin ${r.quietMarginDb.toFixed(1)} dB < ${AM.minQuietMarginDb}`);
  assert.ok(AM.minQuietMarginDb >= 6, 'requirement: at least +6 dB');
  assert.ok(r.busyMarginDb >= AM.minBusyMarginDb, `busy margin ${r.busyMarginDb.toFixed(1)} dB < ${AM.minBusyMarginDb}`);
  assert.ok(r.busyMarginDb < 3, 'the ambient should really interfere at its busiest');
  // Easier difficulties are more comfortable.
  for (const key of Object.keys(CONFIG.difficulties)) {
    assert.ok(barkVsAmbient(CONFIG, key).quietMarginDb >= r.quietMarginDb - 1e-9, key);
  }
});

test('ambient master gain shifts the margins dB for dB', () => {
  const louder = structuredClone(CONFIG);
  louder.ambient.masterGain = 2; // +6.02 dB
  const a = barkVsAmbient(CONFIG, 'hard'), b = barkVsAmbient(louder, 'hard');
  assert.ok(Math.abs(a.quietMarginDb - b.quietMarginDb - 6.0206) < 1e-3);
});

function collectEvents(seed, seconds, listener) {
  const dir = new AmbientDirector(AM, seededRng(seed));
  dir.reset(ambientProfile(CONFIG, 'hard'));
  const events = [];
  for (let t = 0; t < seconds; t += 1 / 60) events.push(...dir.update(1 / 60, listener));
  return events;
}

test('gusts and birds come from all directions around the player (front, back, left, right)', () => {
  const listener = { x: 35, y: 35, heading: 0.9 };
  const events = collectEvents(3, 1200, listener);
  for (const type of ['gust', 'bird']) {
    const evs = events.filter((e) => e.type === type);
    assert.ok(evs.length > 100, `${type}: ${evs.length} events`);
    const sectors = { front: 0, right: 0, back: 0, left: 0 };
    for (const e of evs) {
      const az = relativeAzimuth(listener, e.from);
      const deg = (az * 180) / Math.PI;
      if (Math.abs(deg) <= 45) sectors.front++;
      else if (Math.abs(deg) >= 135) sectors.back++;
      else if (deg > 0) sectors.right++;
      else sectors.left++;
    }
    for (const [s, n] of Object.entries(sectors)) assert.ok(n / evs.length > 0.15, `${type} ${s}: ${n}/${evs.length}`);
  }
});

test('birds: 5-40 m away, up in the trees, some fly a short path; gusts drift', () => {
  const listener = { x: 35, y: 35 };
  const events = collectEvents(5, 900, listener);
  const birds = events.filter((e) => e.type === 'bird');
  const dists = birds.map((b) => Math.hypot(b.from.x - listener.x, b.from.y - listener.y));
  assert.ok(Math.min(...dists) >= 5 - 1e-9 && Math.max(...dists) <= 40 + 1e-9);
  assert.ok(Math.min(...dists) < 10 && Math.max(...dists) > 30, 'varied distances');
  assert.ok(birds.every((b) => b.from.h >= AM.birds.heightM[0] && b.from.h <= AM.birds.heightM[1]));
  const flying = birds.filter((b) => b.flies);
  assert.ok(flying.length / birds.length > 0.15 && flying.length / birds.length < 0.45);
  for (const b of flying) {
    const len = Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y);
    assert.ok(len > 0 && len <= AM.birds.flySpeed[1] * AM.birds.flightSec[1] + 1e-9);
  }
  for (const g of events.filter((e) => e.type === 'gust')) {
    const a0 = Math.atan2(g.from.y - listener.y, g.from.x - listener.x);
    const a1 = Math.atan2(g.to.y - listener.y, g.to.x - listener.x);
    const drift = Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))) * 180 / Math.PI;
    assert.ok(drift >= AM.gusts.driftDeg[0] - 1e-6 && drift <= AM.gusts.driftDeg[1] + 1e-6, `drift ${drift}`);
  }
});

test('independence: ambient events never depend on the dog position', () => {
  const run = (dogOverride) => {
    const audio = recordingAudio();
    const game = new Game({ config: CONFIG, audio, rng: seededRng(11), ambientRng: seededRng(99) });
    game.startRound('hard');
    if (dogOverride) game.dog = dogOverride; // a completely different dog
    game.player = { x: 35, y: 35, heading: 0 };
    game.trees = [];
    for (let i = 0; i < 60 * 30; i++) game.update(1 / 60, { turn: i % 200 < 100 ? 1 : 0, move: 0 });
    return audio.calls.filter((c) => c.name === 'ambientEvent').map((c) => JSON.stringify(c.args[0]));
  };
  const a = run(null);
  const b = run({ x: 5, y: 65 });
  const c = run({ x: 65, y: 5 });
  assert.ok(a.length > 10);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  // And the director's API has no way to receive the dog.
  assert.equal(AmbientDirector.prototype.update.length, 2);
});

test('procedural ambient sounds: finite, non-silent, loops wrap without a click', () => {
  const sr = 24000;
  const rng = seededRng(8);
  const check = (x, name) => {
    let peak = 0;
    for (const v of x) { assert.ok(Number.isFinite(v), name); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(peak > 0.3 && peak <= 1, `${name} peak ${peak}`);
  };
  const bed = synthWindBed(sr, { seconds: 4, rng });
  bed.forEach((c, i) => {
    check(c, `bed ${i}`);
    assert.ok(Math.abs(c[c.length - 1] - c[0]) < 0.05, 'bed loop seam');
  });
  assert.ok(bed[0].some((v, i) => Math.abs(v - bed[1][i]) > 0.05), 'bed channels are decorrelated');
  const gust = synthGust(sr, { duration: 3, rng });
  check(gust, 'gust');
  const edge = (x, from, to) => Math.max(...Array.from(x.subarray(from, to), Math.abs));
  assert.ok(edge(gust, 0, sr * 0.05) < 0.2 && edge(gust, gust.length - sr * 0.05, gust.length) < 0.2, 'gust swells in and out');
  for (let i = 0; i < 10; i++) check(synthBirdChirp(sr, { rng }), 'bird');
  synthCrickets(sr, { seconds: 2, rng }).forEach((c) => check(c, 'crickets'));
  check(synthTreeThud(sr, { rng }), 'tree thud');
});

test('levels differ clearly: hard has many more birds (flocks) and longer gusts than easy', () => {
  const count = (key) => {
    const dir = new AmbientDirector(AM, seededRng(11));
    const p = ambientProfile(CONFIG, key);
    dir.reset(p);
    const evs = [];
    for (let t = 0; t < 600; t += 1 / 60) evs.push(...dir.update(1 / 60, { x: 35, y: 35 }));
    const gusts = evs.filter((e) => e.type === 'gust');
    return { birds: evs.filter((e) => e.type === 'bird').length, gusts: gusts.length, gustLen: gusts.reduce((s, g) => s + g.duration, 0) / gusts.length };
  };
  const e = count('easy'), m = count('medium'), h = count('hard');
  assert.ok(m.birds > e.birds * 2 && h.birds > m.birds * 2, `birds per 10 min: ${e.birds} / ${m.birds} / ${h.birds}`);
  assert.ok(m.gusts > e.gusts * 1.5 && h.gusts > m.gusts * 2, `gusts per 10 min: ${e.gusts} / ${m.gusts} / ${h.gusts}`);
  assert.ok(e.gustLen < m.gustLen && m.gustLen < h.gustLen);
});
