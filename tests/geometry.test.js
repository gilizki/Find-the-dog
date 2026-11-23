import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, validateConfig } from '../src/config.js';
import {
  clampToMap, distance, forwardVector, hasReachedDog, isInsideMap, normalizeAngle, placeAtDistance,
  relativeAzimuth, rightVector,
} from '../src/geometry.js';
import { seededRng } from './helpers.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('default config is valid', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
});

test('validateConfig catches a distance that cannot fit', () => {
  const cfg = structuredClone(CONFIG);
  cfg.difficulties.insane = { label: 'Insane', distance: 500 };
  assert.ok(validateConfig(cfg).some((p) => p.includes('insane')));
});

for (const [key, { distance: target }] of Object.entries(CONFIG.difficulties)) {
  test(`placement (${key}, ${target} m): exact distance within tolerance, both inside the map`, () => {
    const rng = seededRng(42 + target);
    const { map, placement } = CONFIG;
    for (let i = 0; i < 5000; i++) {
      const { player, dog } = placeAtDistance(map, target, { margin: map.spawnMargin, maxAttempts: placement.maxAttempts, rng });
      assert.ok(Math.abs(distance(player, dog) - target) <= placement.tolerance, `distance off: ${distance(player, dog)}`);
      assert.ok(isInsideMap(player, map, map.spawnMargin - 1e-9), `player outside: ${JSON.stringify(player)}`);
      assert.ok(isInsideMap(dog, map, map.spawnMargin - 1e-9), `dog outside: ${JSON.stringify(dog)}`);
    }
  });
}

test('placement covers all directions (not biased to one side)', () => {
  const rng = seededRng(7);
  const quadrants = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) {
    const { player, dog } = placeAtDistance(CONFIG.map, 25, { margin: 2, rng });
    quadrants[(dog.x >= player.x ? 0 : 1) + (dog.y >= player.y ? 0 : 2)]++;
  }
  for (const q of quadrants) assert.ok(q > 700, `quadrant counts ${quadrants}`);
});

test('placement still works near the maximum possible distance (fallback path)', () => {
  const map = { width: 20, height: 10 };
  const maxD = Math.hypot(16, 6); // margin 2
  const rng = seededRng(3);
  for (let i = 0; i < 200; i++) {
    const { player, dog } = placeAtDistance(map, maxD - 1e-6, { margin: 2, maxAttempts: 5, rng });
    assert.ok(near(distance(player, dog), maxD - 1e-6, 1e-6));
    assert.ok(isInsideMap(player, map, 2 - 1e-6) && isInsideMap(dog, map, 2 - 1e-6));
  }
});

test('placement throws when the distance cannot fit', () => {
  assert.throws(() => placeAtDistance({ width: 10, height: 10 }, 50, { margin: 1 }), RangeError);
});

test('win condition: inside or exactly on the radius wins, just outside does not', () => {
  const dog = { x: 10, y: 10 };
  const r = CONFIG.rules.winRadius;
  assert.equal(hasReachedDog({ x: 10, y: 10 }, dog, r), true);
  assert.equal(hasReachedDog({ x: 10 + r, y: 10 }, dog, r), true);
  assert.equal(hasReachedDog({ x: 10, y: 10 - r + 0.01 }, dog, r), true);
  assert.equal(hasReachedDog({ x: 10 + r + 0.01, y: 10 }, dog, r), false);
  assert.equal(hasReachedDog({ x: 10 + r, y: 10 + r }, dog, r), false); // diagonal ≈ 2.12 m
});

test('rightVector is forward rotated 90° clockwise on screen (y down)', () => {
  // Facing east (heading 0) -> right hand points south = screen down (+y).
  const r0 = rightVector(0);
  assert.ok(near(r0.x, 0) && near(r0.y, 1));
  // Facing north (screen up, heading -90°) -> right hand points east (+x).
  const rn = rightVector(-Math.PI / 2);
  assert.ok(near(rn.x, 1) && near(rn.y, 0));
  // Always perpendicular to forward
  for (let h = -3; h < 3; h += 0.37) {
    const f = forwardVector(h), r = rightVector(h);
    assert.ok(near(f.x * r.x + f.y * r.y, 0));
  }
});

test('relativeAzimuth: ahead 0, right +90°, left -90°, behind ±180°', () => {
  const rng = seededRng(11);
  for (let i = 0; i < 100; i++) {
    const player = { x: rng() * 50, y: rng() * 50, heading: normalizeAngle(rng() * 10) };
    const f = forwardVector(player.heading), r = rightVector(player.heading);
    const at = (v, d) => ({ x: player.x + v.x * d, y: player.y + v.y * d });
    assert.ok(near(relativeAzimuth(player, at(f, 5)), 0, 1e-9));
    assert.ok(near(relativeAzimuth(player, at(r, 5)), Math.PI / 2, 1e-9));
    assert.ok(near(relativeAzimuth(player, at(r, -5)), -Math.PI / 2, 1e-9));
    assert.ok(near(Math.abs(relativeAzimuth(player, at(f, -5))), Math.PI, 1e-9));
  }
});

test('clampToMap keeps points inside and reports wall hits', () => {
  const map = { width: 10, height: 10 };
  assert.deepEqual(clampToMap({ x: 5, y: 5 }, map, 0.5), { x: 5, y: 5, hitWall: false });
  assert.deepEqual(clampToMap({ x: -1, y: 5 }, map, 0.5), { x: 0.5, y: 5, hitWall: true });
  assert.deepEqual(clampToMap({ x: 11, y: 12 }, map, 0.5), { x: 9.5, y: 9.5, hitWall: true });
});

test('normalizeAngle wraps into (-π, π]', () => {
  assert.ok(near(normalizeAngle(3 * Math.PI), Math.PI));
  assert.ok(near(normalizeAngle(-Math.PI), Math.PI));
  assert.ok(near(normalizeAngle(Math.PI / 2 + 4 * Math.PI), Math.PI / 2, 1e-9));
});
