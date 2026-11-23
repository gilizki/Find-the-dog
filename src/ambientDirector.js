// Pure scheduler for ambient distractions (wind gusts, birds). Decides WHEN and WHERE; audio.js/ambient.js
// only render the events. It is given the listener's position and its own RNG and nothing else.
// In particular it never sees the dog, so ambient sound carries no information about the dog.

import { TAU } from './geometry.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Per-difficulty ambient settings: CONFIG.ambient.distraction[key] interpolates low -> high. */
export function ambientProfile(config, difficultyKey) {
  const a = config.ambient;
  const t = clamp01(a.distraction[difficultyKey] ?? 0.5);
  const L = a.low, H = a.high;
  const range = (k) => [lerp(L[k][0], H[k][0], t), lerp(L[k][1], H[k][1], t)];
  const intRange = (k) => range(k).map(Math.round);
  return {
    distraction: t,
    bedDb: lerp(L.bedDb, H.bedDb, t),
    gustDb: lerp(L.gustDb, H.gustDb, t),
    birdDb: lerp(L.birdDb, H.birdDb, t),
    gustEverySec: range('gustEverySec'),
    birdEverySec: range('birdEverySec'),
    gustDurationSec: range('gustDurationSec'),
    birdFlock: intRange('birdFlock'),
  };
}

export class AmbientDirector {
  constructor(ambientCfg, rng = Math.random) {
    this.cfg = ambientCfg;
    this.rng = rng;
    this.profile = null;
  }

  _rand([a, b]) {
    return a + this.rng() * (b - a);
  }

  reset(profile) {
    this.profile = profile;
    this.time = 0;
    this.nextGust = this._rand([0.3, 0.5]) * profile.gustEverySec[0];
    this.nextBird = this._rand([0.3, 0.8]) * profile.birdEverySec[0];
    this.pendingBirds = []; // flock members waiting for their call time: {at, ev}
  }

  stop() {
    this.profile = null;
  }

  /** Advance time; returns the events that start now. `listener` = {x, y} of the player. */
  update(dt, listener) {
    if (!this.profile) return [];
    this.time += dt;
    const events = [];
    while (this.time >= this.nextGust) {
      events.push(this._gust(listener));
      this.nextGust += this._rand(this.profile.gustEverySec);
    }
    while (this.time >= this.nextBird) {
      this._flock(listener, this.nextBird);
      this.nextBird += this._rand(this.profile.birdEverySec);
    }
    this.pendingBirds.sort((a, b) => a.at - b.at);
    while (this.pendingBirds.length && this.pendingBirds[0].at <= this.time) events.push(this.pendingBirds.shift().ev);
    return events;
  }

  _jitterDb() {
    return (this.rng() * 2 - 1) * this.cfg.levelJitterDb;
  }

  /** A gust (wind + leaf rustle) from a random direction, drifting around the listener. */
  _gust(l) {
    const g = this.cfg.gusts;
    const a0 = this.rng() * TAU;
    const d0 = this._rand(g.distance);
    const drift = ((this._rand(g.driftDeg) * Math.PI) / 180) * (this.rng() < 0.5 ? -1 : 1);
    const d1 = this._rand(g.distance);
    return {
      type: 'gust',
      from: { x: l.x + Math.cos(a0) * d0, y: l.y + Math.sin(a0) * d0, h: 1.5 },
      to: { x: l.x + Math.cos(a0 + drift) * d1, y: l.y + Math.sin(a0 + drift) * d1, h: 1.5 },
      duration: this._rand(this.profile.gustDurationSec ?? g.durationSec),
      levelDb: this.profile.gustDb + this._jitterDb(),
      pick: this.rng(),
    };
  }

  /** One bird event, or on busier levels a small flock calling in quick succession from one area. */
  _flock(l, at) {
    const b = this.cfg.birds;
    const [lo, hi] = this.profile.birdFlock ?? [1, 1];
    const n = lo + Math.floor(this.rng() * (hi - lo + 1));
    const first = this._bird(l);
    this.pendingBirds.push({ at, ev: first });
    let t = at;
    for (let i = 1; i < n; i++) {
      t += this._rand(b.flockGapSec);
      const a = this.rng() * TAU;
      const r = this.rng() * b.flockSpreadM;
      this.pendingBirds.push({ at: t, ev: this._bird(l, { x: first.from.x + Math.cos(a) * r, y: first.from.y + Math.sin(a) * r }) });
    }
  }

  /** A bird anywhere around the listener (front, back, sides), up in the trees; sometimes flying. */
  _bird(l, near = null) {
    const b = this.cfg.birds;
    let a = this.rng() * TAU;
    let d = this._rand(b.distance);
    if (near) {
      a = Math.atan2(near.y - l.y, near.x - l.x);
      d = Math.max(b.distance[0], Math.min(b.distance[1], Math.hypot(near.x - l.x, near.y - l.y)));
    }
    const from = { x: l.x + Math.cos(a) * d, y: l.y + Math.sin(a) * d, h: this._rand(b.heightM) };
    const flies = this.rng() < b.flyChance;
    let to = { ...from };
    let flightSec = 0;
    if (flies) {
      flightSec = this._rand(b.flightSec);
      const dir = this.rng() * TAU;
      const len = this._rand(b.flySpeed) * flightSec;
      to = { x: from.x + Math.cos(dir) * len, y: from.y + Math.sin(dir) * len, h: Math.max(1, from.h + (this.rng() * 2 - 1) * 2) };
    }
    return { type: 'bird', from, to, flies, flightSec, levelDb: this.profile.birdDb + this._jitterDb(), pick: this.rng() };
  }
}
