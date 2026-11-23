import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { forwardVector, rightVector } from '../src/geometry.js';
import { circleInVision, distanceToVision, pointInVision, visionOutline } from '../src/vision.js';

const V = CONFIG.vision;
const R = CONFIG.player.radius;

/** World point at `f` metres forward and `s` metres right of the player. */
function at(player, f, s) {
  const fw = forwardVector(player.heading), r = rightVector(player.heading);
  return { x: player.x + fw.x * f + r.x * s, y: player.y + fw.y * f + r.y * s };
}

test('default vision reaches past the win radius, so the dog is seen just before it is reached', () => {
  assert.ok(R + V.range > CONFIG.rules.winRadius + 0.3, `window ends ${R + V.range} m ahead, win at ${CONFIG.rules.winRadius} m`);
  assert.equal(V.shape, 'rect');
});

for (const heading of [0, Math.PI / 2, -2.3, 3]) {
  test(`rect vision window (heading ${heading.toFixed(2)}): what is inside and outside`, () => {
    const player = { x: 20, y: 20, heading };
    const inside = (f, s) => pointInVision(player, at(player, f, s), R, V);
    // inside
    assert.ok(inside(R + 0.01, 0), 'just in front of the body');
    assert.ok(inside(R + V.range / 2, 0), 'middle of the window');
    assert.ok(inside(R + V.range - 0.01, V.width / 2 - 0.01), 'far right corner');
    assert.ok(inside(R + V.range - 0.01, -V.width / 2 + 0.01), 'far left corner');
    // outside
    assert.ok(!inside(R + V.range + 0.01, 0), 'just beyond the range');
    assert.ok(!inside(R + V.range + 3, 0), 'far ahead');
    assert.ok(!inside(-0.5, 0), 'behind');
    assert.ok(!inside(R + 0.2, V.width / 2 + 0.05), 'beside the window (right)');
    assert.ok(!inside(R + 0.2, -V.width / 2 - 0.05), 'beside the window (left)');
    assert.ok(!inside(0, 1), 'at the side of the player');
    // distance grows with offset
    assert.ok(Math.abs(distanceToVision(player, at(player, R + V.range + 1, 0), R, V) - 1) < 1e-9);
  });
}

test('circles: a trunk partly inside the window is visible, one just outside is not', () => {
  const player = { x: 10, y: 10, heading: 0.7 };
  const c1 = { ...at(player, R + V.range + 0.3, 0), r: 0.4 }; // centre beyond the window, edge reaches in
  assert.ok(circleInVision(player, c1, R, V));
  const c2 = { ...at(player, R + V.range + 0.5, 0), r: 0.4 }; // 0.1 m short
  assert.ok(!circleInVision(player, c2, R, V));
  const c3 = { ...at(player, -1, 0), r: 0.6 }; // behind
  assert.ok(!circleInVision(player, c3, R, V));
});

test('cone vision variant', () => {
  const v = { ...V, shape: 'cone', coneAngleDeg: 80 };
  const player = { x: 10, y: 10, heading: -1 };
  const inside = (f, s) => pointInVision(player, at(player, f, s), R, v);
  assert.ok(inside(R + 0.3, 0));
  assert.ok(inside((R + 0.3) * Math.cos(0.6), (R + 0.3) * Math.sin(0.6)), '34° off-axis is inside an 80° cone');
  assert.ok(!inside((R + 0.3) * Math.cos(0.8), (R + 0.3) * Math.sin(0.8)), '46° off-axis is outside');
  assert.ok(!inside(R + V.range + 0.1, 0), 'beyond range');
  assert.ok(!inside(-0.5, 0), 'behind');
});

test('window outline matches the geometry (all corners on the window boundary)', () => {
  const player = { x: 5, y: 5, heading: 1.1 };
  const pts = visionOutline(player, R, V);
  assert.equal(pts.length, 4);
  for (const p of pts) assert.ok(distanceToVision(player, p, R, V) < 1e-9);
});

test('the dog fades into view from any direction before it can be reached', () => {
  assert.ok(V.dogRevealRadius - V.dogRevealFade > CONFIG.rules.winRadius + 0.3,
    `fully visible at ${V.dogRevealRadius - V.dogRevealFade} m, win at ${CONFIG.rules.winRadius} m`);
});
