// Pure dog logic: placing several dogs, their voices, and how they move. No DOM or Web Audio.
//
// Movement modes (config.dogs.movement):
//   off       the dog stays where it is
//   calm      walks short legs slowly, with long sniffing pauses
//   restless  longer, faster legs with short pauses
//   shy       wanders like calm, but trots away when the player gets close, then rests (catchable)
// Every mode is slower than the player, so a dog can always be caught.

import { TAU, distance, isInsideMap } from './geometry.js';
import { resolveCollisions } from './forest.js';

export const MOVEMENT_MODES = ['off', 'calm', 'restless', 'shy'];

const rand = (rng, [a, b]) => a + rng() * (b - a);

/**
 * Positions for `count` dogs, each about `dist` metres from the player (random directions), inside the
 * map with `margin`, and at least `minSeparation` metres apart. The separation is relaxed if needed.
 * `first` (optional) is an already placed dog to keep as dog 0.
 */
export function placeDogs(map, player, dist, count, { margin = 0, minSeparation = 0, first = null, maxAttempts = 400, rng = Math.random } = {}) {
  const dogs = first ? [{ x: first.x, y: first.y }] : [];
  let sep = minSeparation;
  while (dogs.length < count) {
    let placed = null;
    for (let i = 0; i < maxAttempts && !placed; i++) {
      const a = rng() * TAU;
      const p = { x: player.x + Math.cos(a) * dist, y: player.y + Math.sin(a) * dist };
      if (isInsideMap(p, map, margin) && dogs.every((d) => distance(d, p) >= sep)) placed = p;
    }
    if (placed) dogs.push(placed);
    else if (sep > 0.5) sep *= 0.7;
    else {
      // Distance cannot fit in any direction (should not happen: the first dog proves one fits).
      dogs.push({ x: Math.min(Math.max(player.x + dist, margin), map.width - margin), y: player.y });
    }
  }
  return dogs;
}

/** Voice for dog `i`: a fixed recording slot and pitch, so every dog is recognisable. */
export function dogVoice(i, voices) {
  return voices[i % voices.length];
}

/** A dog ready for the game: position, voice and movement state. */
export function createDog(pos, i, cfg, rng = Math.random) {
  return {
    id: i,
    x: pos.x,
    y: pos.y,
    found: false,
    voice: dogVoice(i, cfg.voices),
    // Movement state
    state: 'rest',
    timer: rand(rng, [0.5, 3]),
    target: null,
    speed: 0,
    facing: rng() < 0.5 ? -1 : 1, // screen-independent: -1 = moving towards -x, for drawing
    fled: 0,
  };
}

function pickWanderTarget(dog, map, margin, legM, rng) {
  for (let i = 0; i < 12; i++) {
    const a = rng() * TAU;
    const len = rand(rng, legM);
    const t = { x: dog.x + Math.cos(a) * len, y: dog.y + Math.sin(a) * len };
    if (isInsideMap(t, map, margin)) return t;
  }
  return { x: map.width / 2, y: map.height / 2 };
}

function pickFleeTarget(dog, player, map, margin, len, rng) {
  const away = Math.atan2(dog.y - player.y, dog.x - player.x);
  // Try straight away first, then fan out (a cornered dog runs along the wall).
  for (const spread of [0.4, 0.9, 1.4, 1.9]) {
    for (let i = 0; i < 4; i++) {
      const a = away + (rng() * 2 - 1) * spread;
      const t = { x: dog.x + Math.cos(a) * len, y: dog.y + Math.sin(a) * len };
      if (isInsideMap(t, map, margin)) return t;
    }
  }
  return null; // cornered: stays put and can be caught
}

/**
 * Advance one dog by dt. Returns the event that happened ('flee' when a shy dog starts running), or null.
 * world = { player, trees, map, cfg (config.dogs), mode, rng }
 */
export function updateDog(dog, dt, { player, trees, map, cfg, mode, rng = Math.random }) {
  if (dog.found || mode === 'off' || !cfg.movement[mode]) return null;
  const m = cfg.movement[mode];
  const margin = cfg.wallMargin;
  let event = null;

  // Shy: notices the player inside noticeRadius (unless tired from the last run).
  if (m.noticeRadius && dog.state !== 'flee' && dog.fled <= 0 && distance(dog, player) < m.noticeRadius) {
    const t = pickFleeTarget(dog, player, map, margin, rand(rng, m.fleeM), rng);
    if (t) {
      dog.state = 'flee';
      dog.target = t;
      dog.speed = m.fleeSpeed;
      event = 'flee';
    }
  }
  dog.fled = Math.max(0, dog.fled - dt);

  if (dog.state === 'rest') {
    dog.timer -= dt;
    if (dog.timer <= 0) {
      dog.state = 'walk';
      dog.target = pickWanderTarget(dog, map, margin, m.legM, rng);
      dog.speed = rand(rng, m.speed);
    }
    return event;
  }

  // walk / flee towards the target
  const dx = dog.target.x - dog.x, dy = dog.target.y - dog.y;
  const d = Math.hypot(dx, dy);
  const step = Math.min(d, dog.speed * dt);
  let stuck = false;
  if (step > 1e-9) {
    const res = resolveCollisions({ x: dog.x + (dx / d) * step, y: dog.y + (dy / d) * step }, cfg.radius, trees, map);
    const moved = Math.hypot(res.x - dog.x, res.y - dog.y);
    if (Math.abs(res.x - dog.x) > 1e-6) dog.facing = res.x > dog.x ? 1 : -1;
    dog.x = res.x;
    dog.y = res.y;
    // Stuck on a trunk: give up on this target (sliding usually gets around, this is the fallback).
    stuck = moved < step * 0.2;
  }
  if (d - step < 0.05 || stuck) {
    if (dog.state === 'flee') {
      // Tired after running: rests and ignores the player for a while, so it can be caught.
      dog.fled = rand(rng, m.restAfterFleeSec);
      dog.timer = dog.fled;
    } else {
      dog.timer = rand(rng, m.pauseSec);
    }
    dog.state = 'rest';
    dog.target = null;
  }
  return event;
}
