// Pure geometry of the player's tiny vision window (what the canvas may show in normal play).
// The window starts at the front of the player's body and extends `range` metres forward.

import { degToRad, forwardVector, rightVector } from './geometry.js';

/** Point in the player's frame: f = metres forward, s = metres to the right. */
export function toLocal(player, p) {
  const dx = p.x - player.x, dy = p.y - player.y;
  const f = forwardVector(player.heading), r = rightVector(player.heading);
  return { f: dx * f.x + dy * f.y, s: dx * r.x + dy * r.y };
}

function toWorld(player, f, s) {
  const fw = forwardVector(player.heading), r = rightVector(player.heading);
  return { x: player.x + fw.x * f + r.x * s, y: player.y + fw.y * f + r.y * s };
}

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - vx * u, py - ay - vy * u);
}

/** Distance (m) from a world point to the vision window; 0 if inside. */
export function distanceToVision(player, p, playerRadius, v) {
  const { f, s } = toLocal(player, p);
  const near = playerRadius;
  const far = playerRadius + v.range;
  if (v.shape === 'cone') {
    // Annular sector around the player, between radii near..far, ±half angle.
    const half = degToRad(v.coneAngleDeg) / 2;
    const rho = Math.hypot(f, s);
    const theta = Math.atan2(s, f);
    if (Math.abs(theta) <= half) return Math.max(0, near - rho, rho - far);
    const sgn = Math.sign(theta) || 1;
    const ex = Math.cos(half), ey = Math.sin(half) * sgn;
    return segDist(f, s, ex * near, ey * near, ex * far, ey * far);
  }
  const dxr = Math.max(near - f, 0, f - far);
  const dyr = Math.max(Math.abs(s) - v.width / 2, 0);
  return Math.hypot(dxr, dyr);
}

export const pointInVision = (player, p, playerRadius, v) => distanceToVision(player, p, playerRadius, v) <= 1e-9;

/** True if any part of a circle {x, y, r} is inside the window. */
export const circleInVision = (player, c, playerRadius, v) => distanceToVision(player, c, playerRadius, v) < c.r;

/** Window outline in world coordinates (for drawing / clipping). */
export function visionOutline(player, playerRadius, v, segments = 16) {
  const near = playerRadius, far = playerRadius + v.range;
  if (v.shape === 'cone') {
    const half = degToRad(v.coneAngleDeg) / 2;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = -half + (2 * half * i) / segments;
      pts.push(toWorld(player, Math.cos(a) * far, Math.sin(a) * far));
    }
    for (let i = segments; i >= 0; i--) {
      const a = -half + (2 * half * i) / segments;
      pts.push(toWorld(player, Math.cos(a) * near, Math.sin(a) * near));
    }
    return pts;
  }
  const hw = v.width / 2;
  return [toWorld(player, near, -hw), toWorld(player, far, -hw), toWorld(player, far, hw), toWorld(player, near, hw)];
}
