// Pure 2D math shared by game logic, rendering and the audio mapping.
//
// Coordinate convention (identical to the canvas): x grows to the right (east),
// y grows DOWN the screen (south). Heading is in radians; heading 0 faces +x.
// Because y points down, INCREASING heading rotates CLOCKWISE on screen, i.e. turning RIGHT.

export const TAU = Math.PI * 2;

export const degToRad = (d) => (d * Math.PI) / 180;
export const radToDeg = (r) => (r * 180) / Math.PI;

/** Unit vector the player faces. */
export function forwardVector(heading) {
  return { x: Math.cos(heading), y: Math.sin(heading) };
}

/** Unit vector pointing to the player's right-hand side (forward rotated 90° clockwise on screen). */
export function rightVector(heading) {
  return { x: -Math.sin(heading), y: Math.cos(heading) };
}

/** Wraps an angle to (-π, π]. */
export function normalizeAngle(a) {
  a %= TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function isInsideMap(p, map, margin = 0) {
  return p.x >= margin && p.x <= map.width - margin && p.y >= margin && p.y <= map.height - margin;
}

/** Clamps a point into the map (keeping `margin` from walls). Reports whether a wall stopped it. */
export function clampToMap(p, map, margin = 0) {
  const x = Math.min(Math.max(p.x, margin), map.width - margin);
  const y = Math.min(Math.max(p.y, margin), map.height - margin);
  return { x, y, hitWall: x !== p.x || y !== p.y };
}

/**
 * Angle of `target` relative to where `listener` faces, in radians, in (-π, π].
 * 0 = straight ahead, +π/2 = directly to the RIGHT, -π/2 = directly to the LEFT, ±π = behind.
 */
export function relativeAzimuth(listener, target) {
  const dx = target.x - listener.x;
  const dy = target.y - listener.y;
  const f = forwardVector(listener.heading);
  const r = rightVector(listener.heading);
  return Math.atan2(dx * r.x + dy * r.y, dx * f.x + dy * f.y);
}

export function randomHeading(rng = Math.random) {
  return normalizeAngle(rng() * TAU);
}

/**
 * Places two points exactly `dist` apart, both inside the map with `margin` from the walls.
 * Picks a random direction, then a uniformly random player position among those that keep
 * the dog inside the map. Throws if the distance cannot fit at all.
 */
export function placeAtDistance(map, dist, { margin = 0, maxAttempts = 500, rng = Math.random } = {}) {
  const minX = margin, minY = margin;
  const innerW = map.width - 2 * margin;
  const innerH = map.height - 2 * margin;
  if (innerW <= 0 || innerH <= 0) throw new RangeError('Map is smaller than the spawn margin');
  if (dist > Math.hypot(innerW, innerH)) {
    throw new RangeError(`Distance ${dist} m cannot fit inside a ${map.width}x${map.height} m map with margin ${margin}`);
  }

  const tryAngle = (angle) => {
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spanX = innerW - Math.abs(dx);
    const spanY = innerH - Math.abs(dy);
    if (spanX < 0 || spanY < 0) return null;
    const player = {
      x: minX + Math.max(0, -dx) + rng() * spanX,
      y: minY + Math.max(0, -dy) + rng() * spanY,
    };
    return { player, dog: { x: player.x + dx, y: player.y + dy } };
  };

  for (let i = 0; i < maxAttempts; i++) {
    const placed = tryAngle(rng() * TAU);
    if (placed) return placed;
  }
  // Fallback: the map diagonal always fits (checked above). Pick one of its 4 orientations.
  const diagAngle = Math.atan2(innerH, innerW);
  const options = [diagAngle, Math.PI - diagAngle, Math.PI + diagAngle, -diagAngle];
  return tryAngle(options[Math.floor(rng() * 4) % 4]);
}

export function hasReachedDog(player, dog, winRadius) {
  return distance(player, dog) <= winRadius;
}
