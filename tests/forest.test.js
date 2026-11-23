import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { placeAtDistance, relativeAzimuth } from '../src/geometry.js';
import { generateForest, hasWalkablePath, occlusion, resolveCollisions, scatterTrees } from '../src/forest.js';
import { computeDogParams } from '../src/audioMapping.js';
import { seededRng } from './helpers.js';

const { map, trees: T, player: PC } = CONFIG;
const OCC = T.occlusion;

function roundSetup(key, seed) {
  const rng = seededRng(seed);
  const { player, dog } = placeAtDistance(map, CONFIG.difficulties[key].distance, { margin: map.spawnMargin, rng });
  const forest = generateForest({ map, player, dog, density: T.density[key], treesCfg: T, playerRadius: PC.radius, rng });
  return { player, dog, ...forest };
}

for (const key of Object.keys(CONFIG.difficulties)) {
  test(`forest (${key}): clear zones, spacing, density and a walkable path, over 500 seeds`, () => {
    let total = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const { player, dog, trees } = roundSetup(key, seed * 7919);
      total += trees.length;
      for (const t of trees) {
        assert.ok(t.r >= T.radius[0] && t.r <= T.radius[1]);
        assert.ok(Math.hypot(t.x - player.x, t.y - player.y) >= T.clearRadius + t.r - 1e-9, 'tree in the player clear zone');
        assert.ok(Math.hypot(t.x - dog.x, t.y - dog.y) >= T.clearRadius + t.r - 1e-9, 'tree in the dog clear zone');
        assert.ok(t.x - t.r >= T.minGap - 1e-9 && t.x + t.r <= map.width - T.minGap + 1e-9, 'gap to the wall');
        assert.ok(t.y - t.r >= T.minGap - 1e-9 && t.y + t.r <= map.height - T.minGap + 1e-9, 'gap to the wall');
      }
      for (let i = 0; i < trees.length; i++) {
        for (let j = i + 1; j < trees.length; j++) {
          const a = trees[i], b = trees[j];
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r >= T.minGap - 1e-9, 'walkable gap between trunks');
        }
      }
      assert.ok(hasWalkablePath(map, trees, player, dog, PC.radius, T.gridCell), `no path (seed ${seed})`);
    }
    const expected = (T.density[key] * map.width * map.height) / 100;
    assert.ok(total / 500 > expected * 0.9, `avg ${(total / 500).toFixed(0)} trees, expected ≈ ${expected.toFixed(0)}`);
  });
}

test('BFS detects a player fully enclosed by trees', () => {
  const player = { x: 20, y: 20 };
  const ring = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ring.push({ x: 20 + Math.cos(a) * 3, y: 20 + Math.sin(a) * 3, r: 0.6 });
  }
  assert.equal(hasWalkablePath(map, ring, player, { x: 50, y: 50 }, PC.radius, T.gridCell), false);
  assert.equal(hasWalkablePath(map, ring.slice(0, 20), player, { x: 50, y: 50 }, PC.radius, T.gridCell), true, 'a gap opens the ring');
  assert.equal(hasWalkablePath(map, [], player, { x: 50, y: 50 }, PC.radius, T.gridCell), true);
});

test('generateForest regenerates (and finally thins out) when trees block the way', () => {
  // A config that blocks often: no spacing rule, huge trunks, small map.
  const small = { width: 14, height: 14 };
  const cfg = { ...T, minGap: 0, radius: [0.9, 1.4], clearRadius: 1.5, maxAttempts: 5 };
  let regenerated = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = seededRng(seed);
    const player = { x: 2.5, y: 2.5 }, dog = { x: 11.5, y: 11.5 };
    const f = generateForest({ map: small, player, dog, density: 30, treesCfg: cfg, playerRadius: PC.radius, rng });
    assert.ok(hasWalkablePath(small, f.trees, player, dog, PC.radius, cfg.gridCell), `seed ${seed}`);
    if (f.attempts > 1) regenerated++;
  }
  assert.ok(regenerated > 0, 'the blocked case was actually exercised');
});

test('scatterTrees respects keep-clear points', () => {
  const keep = [{ x: 35, y: 35 }];
  const trees = scatterTrees(map, keep, 10, T, seededRng(4));
  assert.ok(trees.length > 100);
  for (const t of trees) assert.ok(Math.hypot(t.x - 35, t.y - 35) >= T.clearRadius + t.r);
});

// ---- collision ------------------------------------------------------------

test('collision: no penetration, and the player slides around a trunk instead of sticking', () => {
  const tree = { x: 10, y: 10, r: 0.5 };
  const R = PC.radius;
  // Walk east, slightly off-centre, straight at the trunk.
  let p = { x: 8, y: 9.9 };
  let tangential = 0;
  for (let i = 0; i < 400; i++) {
    const res = resolveCollisions({ x: p.x + 0.02, y: p.y }, R, [tree], map);
    assert.ok(Math.hypot(res.x - tree.x, res.y - tree.y) >= tree.r + R - 1e-6, 'inside the trunk');
    tangential += Math.abs(res.y - p.y);
    p = res;
  }
  assert.ok(p.x > tree.x + tree.r, `should have slid past the trunk, x = ${p.x.toFixed(2)}`);
  assert.ok(tangential > 0.3, 'moved sideways along the surface');
});

test('collision: walls still clamp, trees and walls reported separately', () => {
  const w = resolveCollisions({ x: -1, y: 5 }, PC.radius, [], map);
  assert.deepEqual([w.x, w.hitWall, w.hitTree], [PC.radius, true, false]);
  const t = resolveCollisions({ x: 10.2, y: 10 }, PC.radius, [{ x: 10, y: 10, r: 0.5 }], map);
  assert.deepEqual([t.hitWall, t.hitTree], [false, true]);
  assert.ok(Math.abs(Math.hypot(t.x - 10, t.y - 10) - (0.5 + PC.radius)) < 1e-6);
});

// ---- occlusion --------------------------------------------------------------

test('occlusion: none on a clear line, mild per tree, capped, smooth at the trunk edge', () => {
  const player = { x: 10, y: 10, heading: 0 };
  const dog = { x: 40, y: 10 };
  assert.equal(occlusion(player, dog, [], OCC).gainDb, 0);
  assert.equal(occlusion(player, dog, [{ x: 20, y: 15, r: 0.5 }], OCC).weight, 0, 'tree well off the line');

  const one = occlusion(player, dog, [{ x: 20, y: 10, r: 0.5 }], OCC);
  assert.equal(one.trees, 1);
  assert.ok(Math.abs(one.gainDb - OCC.perTreeDb) < 1e-9);
  assert.ok(Math.abs(one.cutoffFactor - OCC.perTreeCutoff) < 1e-9);

  const many = Array.from({ length: 12 }, (_, i) => ({ x: 13 + i * 2, y: 10, r: 0.5 }));
  const capped = occlusion(player, dog, many, OCC);
  assert.equal(capped.gainDb, OCC.maxDb);
  assert.equal(capped.cutoffFactor, OCC.minCutoffFactor);
  assert.ok(OCC.maxDb >= -4, 'default occlusion stays mild');

  // Moving the line across a trunk edge changes the weight gradually (no jump).
  let prev = 0;
  for (let off = 0.8; off >= 0.2; off -= 0.02) {
    const w = occlusion(player, dog, [{ x: 20, y: 10 + off, r: 0.5 }], OCC).weight;
    assert.ok(w >= prev - 1e-12 && w - prev < 0.2, `weight jumped at offset ${off.toFixed(2)}`);
    prev = w;
  }
  assert.ok(prev > 0.99);

  // Disabled -> nothing.
  assert.equal(occlusion(player, dog, many, { ...OCC, enabled: false }).gainDb, 0);
});

test('occlusion lowers level and brightness but never changes the direction', () => {
  const player = { x: 10, y: 10, heading: 0.4 };
  const dog = { x: 30, y: 25 };
  const trees = [{ x: 18, y: 16, r: 0.5 }, { x: 22, y: 19, r: 0.5 }];
  const clear = computeDogParams(player, dog, CONFIG.audio);
  const occl = computeDogParams(player, dog, CONFIG.audio, { trees, occlusion: OCC });
  assert.equal(occl.azimuth, clear.azimuth);
  assert.equal(occl.azimuth, relativeAzimuth(player, dog));
  assert.ok(occl.occlusion.trees === 2);
  assert.ok(occl.totalGain < clear.totalGain && occl.cutoffHz < clear.cutoffHz);
  assert.ok(20 * Math.log10(occl.totalGain / clear.totalGain) >= OCC.maxDb - 1e-9);
});
