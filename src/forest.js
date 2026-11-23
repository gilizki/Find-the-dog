// Pure forest logic: tree scattering, walkable-path check, collision with sliding, sound occlusion.

import { clampToMap } from './geometry.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Scatters trees by dart throwing with a spatial hash.
 * - radius in cfg.radius, at least cfg.minGap of free space between trunk surfaces and to the walls
 * - nothing within cfg.clearRadius of any `keepClear` point (player start, dog)
 */
export function scatterTrees(map, keepClear, density, cfg, rng = Math.random) {
  const target = Math.round((density * map.width * map.height) / 100);
  const [rMin, rMax] = cfg.radius;
  const cell = 2 * rMax + cfg.minGap; // any conflicting tree is within one neighbouring cell
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const grid = Array.from({ length: cols * rows }, () => []);
  const trees = [];
  const maxTries = target * 30;
  for (let t = 0; t < maxTries && trees.length < target; t++) {
    const r = rMin + rng() * (rMax - rMin);
    const lo = r + cfg.minGap;
    if (map.width <= 2 * lo || map.height <= 2 * lo) break;
    const x = lo + rng() * (map.width - 2 * lo);
    const y = lo + rng() * (map.height - 2 * lo);
    if (keepClear.some((p) => Math.hypot(p.x - x, p.y - y) < cfg.clearRadius + r)) continue;
    const cx = Math.min(cols - 1, Math.floor(x / cell));
    const cy = Math.min(rows - 1, Math.floor(y / cell));
    let ok = true;
    for (let gy = Math.max(0, cy - 1); ok && gy <= Math.min(rows - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); ok && gx <= Math.min(cols - 1, cx + 1); gx++) {
        for (const o of grid[gy * cols + gx]) {
          if (Math.hypot(o.x - x, o.y - y) < r + o.r + cfg.minGap) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    const tree = { x, y, r };
    trees.push(tree);
    grid[cy * cols + cx].push(tree);
  }
  return trees;
}

/**
 * Grid BFS: can a circle of `radius` get from `from` to `to` without touching trees or walls?
 * A cell is blocked if its centre is within (tree.r + radius) of a trunk or within `radius` of a wall.
 */
export function hasWalkablePath(map, trees, from, to, radius, cell = 0.25) {
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const blocked = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = (gx + 0.5) * cell, y = (gy + 0.5) * cell;
      if (x < radius || y < radius || x > map.width - radius || y > map.height - radius) blocked[gy * cols + gx] = 1;
    }
  }
  for (const t of trees) {
    const R = t.r + radius;
    const x0 = Math.max(0, Math.floor((t.x - R) / cell)), x1 = Math.min(cols - 1, Math.floor((t.x + R) / cell));
    const y0 = Math.max(0, Math.floor((t.y - R) / cell)), y1 = Math.min(rows - 1, Math.floor((t.y + R) / cell));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (Math.hypot((gx + 0.5) * cell - t.x, (gy + 0.5) * cell - t.y) < R) blocked[gy * cols + gx] = 1;
      }
    }
  }
  const idx = (p) => Math.min(rows - 1, Math.max(0, Math.floor(p.y / cell))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(p.x / cell)));
  const start = idx(from), goal = idx(to);
  if (blocked[start] || blocked[goal]) return false;
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0, tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const c = queue[head++];
    if (c === goal) return true;
    const gx = c % cols, gy = (c - gx) / cols;
    if (gx > 0) visit(c - 1);
    if (gx < cols - 1) visit(c + 1);
    if (gy > 0) visit(c - cols);
    if (gy < rows - 1) visit(c + cols);
  }
  return false;
  function visit(n) {
    if (!seen[n] && !blocked[n]) { seen[n] = 1; queue[tail++] = n; }
  }
}

/**
 * Trees for a round, with a guaranteed walkable path from the player to every dog (`dog`, or `dogs` for
 * several). Regenerates on failure; after cfg.maxAttempts failures the density is lowered (and eventually
 * 0 trees, which always works).
 */
export function generateForest({ map, player, dog, dogs = dog ? [dog] : [], density, treesCfg, playerRadius, rng = Math.random }) {
  let d = density;
  let attempts = 0;
  while (d > 0.01) {
    for (let i = 0; i < treesCfg.maxAttempts; i++) {
      attempts++;
      const trees = scatterTrees(map, [player, ...dogs], d, treesCfg, rng);
      if (dogs.every((g) => hasWalkablePath(map, trees, player, g, playerRadius, treesCfg.gridCell))) return { trees, attempts, density: d };
    }
    d *= treesCfg.densityFallbackFactor;
  }
  return { trees: [], attempts, density: 0 };
}

/**
 * Moves a circle out of any trunks it overlaps (along the contact normal) and inside the walls.
 * Removing only the penetrating component of the motion is what produces sliding along the surface.
 */
export function resolveCollisions(pos, radius, trees, map, iterations = 4) {
  let x = pos.x, y = pos.y;
  let hitTree = false, hitWall = false;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (const t of trees) {
      const dx = x - t.x, dy = y - t.y;
      const minD = t.r + radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-9 ? dx / d : 1, ny = d > 1e-9 ? dy / d : 0;
      x = t.x + nx * (minD + 1e-7);
      y = t.y + ny * (minD + 1e-7);
      hitTree = moved = true;
    }
    const c = clampToMap({ x, y }, map, radius);
    if (c.hitWall) { hitWall = true; moved = moved || c.x !== x || c.y !== y; }
    x = c.x; y = c.y;
    if (!moved) break;
  }
  return { x, y, hitTree, hitWall };
}

/**
 * Sound occlusion by trunks on the straight line player -> dog.
 * Each tree contributes a weight 0..1 that ramps smoothly as the line passes from (r + soft) to
 * (r - soft) off the trunk centre, so walking past a tree never causes a jump.
 * Only level and brightness change; direction is untouched.
 */
export function occlusion(player, dog, trees, occ) {
  const none = { weight: 0, trees: 0, gainDb: 0, cutoffFactor: 1 };
  if (!occ?.enabled || !trees?.length) return none;
  const dx = dog.x - player.x, dy = dog.y - player.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return none;
  const soft = Math.max(1e-6, occ.edgeSoftness);
  let weight = 0, count = 0;
  for (const t of trees) {
    const u = clamp01(((t.x - player.x) * dx + (t.y - player.y) * dy) / L2);
    const dist = Math.hypot(player.x + dx * u - t.x, player.y + dy * u - t.y);
    const w = clamp01((t.r + soft - dist) / (2 * soft));
    if (w > 0) { weight += w; count++; }
  }
  return {
    weight,
    trees: count,
    gainDb: Math.max(occ.maxDb, occ.perTreeDb * weight),
    cutoffFactor: Math.max(occ.minCutoffFactor, Math.pow(occ.perTreeCutoff, weight)),
  };
}
