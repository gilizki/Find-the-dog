// Canvas rendering. World coordinates map directly to screen (x right, y down, north-up), scaled
// uniformly, so the heading arrow uses the same forwardVector() as movement and audio.
//
// Two camera modes:
//  - follow (normal play): centred on the player, zoomed in, heading-up (the player always faces up
//    the screen and the world rotates around them when they turn); everything is dark except the tiny
//    vision window in front of the player (soft edge), plus the player and heading arrow.
//  - overview (H reveal, win screen): the whole map with trees, path, dog, and the audio debug readout.

import { forwardVector, rightVector, radToDeg } from './geometry.js';
import { barkVsAmbient, computeDogParams } from './audioMapping.js';
import { visionOutline } from './vision.js';
import { GameState } from './game.js';

const COLORS = {
  bg: '#07090c',
  field: '#141a16',
  grid: '#1b241d',
  wall: '#6b7c93',
  beyondWall: '#2a2f36',
  ground: '#2c3a24',
  speckle: '#3b4a30',
  tree: '#5b3f2b',
  treeEdge: '#8d6b4f',
  bark: '#3e2a1c',
  root: '#4a3322',
  leafDark: '#1f4a24',
  leaf: '#2f6b32',
  leafLight: '#4f8f45',
  treeSeen: 'rgba(170, 140, 110, 0.22)',
  player: '#e8eef7',
  heading: '#7cc4ff',
  path: '#4aa3ff',
  dog: '#ffb347',
  line: '#ffb34799',
  vision: '#7cc4ff55',
  text: '#c9d4e3',
  dim: '#7d8a9c',
  warn: '#ff6b6b',
};

/** Triangle (screen space) for the heading indicator: tip points along forwardVector(heading). */
export function headingTriangle(cx, cy, heading, radiusPx) {
  const f = forwardVector(heading);
  const r = rightVector(heading);
  const tipD = radiusPx * 2.1;
  const baseD = radiusPx * 0.6;
  const halfW = radiusPx * 0.75;
  return [
    { x: cx + f.x * tipD, y: cy + f.y * tipD },
    { x: cx + f.x * baseD + r.x * halfW, y: cy + f.y * baseD + r.y * halfW },
    { x: cx + f.x * baseD - r.x * halfW, y: cy + f.y * baseD - r.y * halfW },
  ];
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

const fmtDb = (db) => (Number.isFinite(db) ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '—');

/** Cheap deterministic hash for ground speckles (so the texture is stable while you move). */
function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createRenderer(canvas, config, { getAudioLevels = null } = {}) {
  const ctx = canvas.getContext('2d');
  const fov = document.createElement('canvas');
  const fctx = fov.getContext('2d');
  const supportsFilter = 'filter' in fctx;
  let dpr = 1;
  const HUD = 44;
  const PAD = 20;

  // Hardest difficulty (largest distance) for the bark-vs-ambient readout.
  const maxKey = Object.entries(config.difficulties).sort((a, b) => b[1].distance - a[1].distance)[0][0];

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = fov.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = fov.height = Math.round(canvas.clientHeight * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function render(game) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (Math.round(w * dpr) !== canvas.width || Math.round(h * dpr) !== canvas.height) resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    if (game.player && game.state !== GameState.MENU) {
      if (game.showSolution) drawOverview(game, w, h);
      else drawFollow(game, w, h);
    }
    drawHud(game, w, h);
  }

  /**
   * Top-down tree: roots, a bark-textured trunk (the collision circle) and a lobed leafy canopy.
   * Per-tree shape variation comes from a hash of its position, so it is stable frame to frame.
   * `canopyAlpha` < 1 lets the trunk show through (the canopy is overhead, not an obstacle).
   */
  function drawTree(c, t, sx, sy, scale, { canopyAlpha = 0.85 } = {}) {
    const r = t.r * scale;
    const x = sx(t.x), y = sy(t.y);
    const seed = (k) => hash2(Math.round(t.x * 97) + k * 131, Math.round(t.y * 89) - k * 17);
    const detailed = r > 6;

    // Roots: tapering spokes radiating from the trunk.
    if (detailed) {
      const n = 5 + Math.floor(seed(1) * 3);
      c.strokeStyle = COLORS.root;
      c.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + seed(i + 2) * 0.8;
        const len = r * (1.35 + seed(i + 9) * 0.6);
        c.lineWidth = r * 0.28;
        c.beginPath();
        c.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6);
        c.quadraticCurveTo(x + Math.cos(a + 0.2) * r * 1.1, y + Math.sin(a + 0.2) * r * 1.1, x + Math.cos(a + 0.1) * len, y + Math.sin(a + 0.1) * len);
        c.stroke();
      }
    }

    // Trunk with bark rings.
    c.fillStyle = COLORS.tree;
    c.strokeStyle = COLORS.bark;
    c.lineWidth = Math.max(1, r * 0.14);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    if (detailed) {
      c.strokeStyle = COLORS.treeEdge;
      c.lineWidth = 1;
      for (const f of [0.7, 0.45, 0.2]) {
        c.beginPath();
        c.arc(x + (seed(20) - 0.5) * r * 0.15, y + (seed(21) - 0.5) * r * 0.15, r * f, 0, Math.PI * 2);
        c.stroke();
      }
    }

    // Canopy: a ring of overlapping leaf clumps, darker underneath, lighter highlights on top.
    const cr = r * (2.6 + seed(30) * 0.8);
    const lobes = 7 + Math.floor(seed(31) * 4);
    const rot = seed(32) * Math.PI * 2;
    const clumps = [];
    for (let i = 0; i < lobes; i++) {
      const a = rot + (i / lobes) * Math.PI * 2;
      const d = cr * (0.55 + seed(40 + i) * 0.15);
      clumps.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, r: cr * (0.42 + seed(60 + i) * 0.14) });
    }
    c.save();
    c.globalAlpha *= canopyAlpha;
    c.fillStyle = COLORS.leafDark;
    c.beginPath();
    for (const k of clumps) { c.moveTo(k.x + k.r, k.y); c.arc(k.x, k.y, k.r, 0, Math.PI * 2); }
    c.moveTo(x + cr * 0.6, y);
    c.arc(x, y, cr * 0.6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = COLORS.leaf;
    c.beginPath();
    for (const k of clumps) {
      const kx = k.x - k.r * 0.18, ky = k.y - k.r * 0.18;
      c.moveTo(kx + k.r * 0.72, ky);
      c.arc(kx, ky, k.r * 0.72, 0, Math.PI * 2);
    }
    c.fill();
    if (detailed) {
      c.fillStyle = COLORS.leafLight;
      c.beginPath();
      for (const k of clumps) {
        const kx = k.x - k.r * 0.35, ky = k.y - k.r * 0.35;
        c.moveTo(kx + k.r * 0.3, ky);
        c.arc(kx, ky, k.r * 0.3, 0, Math.PI * 2);
      }
      c.fill();
    }
    c.restore();

    // Trunk outline stays readable through the canopy (it is what you collide with).
    if (canopyAlpha < 1) {
      c.strokeStyle = COLORS.treeEdge;
      c.globalAlpha = 0.6;
      c.lineWidth = Math.max(1, r * 0.08);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = 1;
    }
  }

  /** The dog as seen in the play view: a 🐕 on a small patch of ground (the patch only outside the window). */
  function drawDog(c, x, y, r, withGround = false) {
    if (withGround) {
      const g = c.createRadialGradient(x, y, r * 0.5, x, y, r * 2);
      g.addColorStop(0, COLORS.ground);
      g.addColorStop(1, 'rgba(44, 58, 36, 0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r * 2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    c.beginPath();
    c.ellipse(x, y + r * 0.55, r * 1.1, r * 0.45, 0, 0, Math.PI * 2);
    c.fill();
    c.font = `${Math.round(r * 2)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.fillText('🐕', x, y);
    c.textBaseline = 'alphabetic';
  }

  function drawPlayer(p, sx, sy, rPx, arrowScale) {
    const [tip, b1, b2] = headingTriangle(sx(p.x), sy(p.y), p.heading, rPx * arrowScale);
    ctx.fillStyle = COLORS.heading;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.arc(sx(p.x), sy(p.y), rPx, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- follow camera: only the vision window ------------------------------

  function drawFollow(game, w, h) {
    const p = game.player;
    const v = config.vision;
    const { map } = config;
    const ppm = v.pixelsPerMeter;
    const cx = w / 2, cy = HUD + (h - HUD) / 2;
    // First-person style camera: the player stays fixed at the centre facing UP the screen, and the
    // world rotates around them as they turn (heading h maps to screen-up when rotated by -h - 90°).
    // With headingUp off, the camera is north-up and only translates.
    const rot = v.headingUp === false ? 0 : -p.heading - Math.PI / 2;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    // World coords relative to the player (the rotation is applied by the canvas transform).
    const sx = (x) => (x - p.x) * ppm;
    const sy = (y) => (y - p.y) * ppm;
    // World point -> unrotated screen point (for things that must stay upright, like the dog emoji).
    const toScreen = (x, y) => {
      const dx = sx(x), dy = sy(y);
      return { x: cx + dx * cosR - dy * sinR, y: cy + dx * sinR + dy * cosR };
    };
    const enterWorld = (c) => {
      c.save();
      c.translate(cx, cy);
      c.rotate(rot);
    };

    // Optional memory: trees seen before, as dim silhouettes.
    if (v.rememberSeen) {
      enterWorld(ctx);
      ctx.fillStyle = COLORS.treeSeen;
      for (const i of game.seenTrees) {
        const t = game.trees[i];
        ctx.beginPath();
        ctx.arc(sx(t.x), sy(t.y), t.r * ppm, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Everything that could be visible, drawn off-screen, then masked to the vision window.
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    if (supportsFilter) fctx.filter = 'none';
    fctx.clearRect(0, 0, w, h);
    fctx.fillStyle = COLORS.beyondWall;
    fctx.fillRect(0, 0, w, h);
    enterWorld(fctx);
    fctx.fillStyle = COLORS.ground;
    fctx.fillRect(sx(0), sy(0), map.width * ppm, map.height * ppm);
    // Ground speckles near the player (so you can see yourself move through the window).
    const cell = 0.2;
    fctx.fillStyle = COLORS.speckle;
    const sp = v.range + config.player.radius + v.width + 0.5;
    for (let i = Math.floor((p.x - sp) / cell); i <= Math.ceil((p.x + sp) / cell); i++) {
      for (let j = Math.floor((p.y - sp) / cell); j <= Math.ceil((p.y + sp) / cell); j++) {
        const rnd = hash2(i, j);
        if (rnd < 0.35) fctx.fillRect(sx((i + hash2(j, i)) * cell), sy((j + rnd) * cell), 2 + rnd * 4, 2 + rnd * 4);
      }
    }
    fctx.strokeStyle = COLORS.wall;
    fctx.lineWidth = 6;
    fctx.strokeRect(sx(0), sy(0), map.width * ppm, map.height * ppm);
    const viewR = v.range + config.player.radius + 3;
    // The dog, when it is inside the window (drawn upright in screen space).
    const d = game.dog;
    const dogDist = d ? Math.hypot(d.x - p.x, d.y - p.y) : Infinity;
    if (dogDist < viewR) {
      const ds = toScreen(d.x, d.y);
      fctx.save();
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawDog(fctx, ds.x, ds.y, 0.35 * ppm);
      fctx.restore();
    }
    for (const t of game.trees) {
      if (Math.hypot(t.x - p.x, t.y - p.y) < viewR + 2) drawTree(fctx, t, sx, sy, ppm, { canopyAlpha: 0.55 });
    }
    // Mask: keep only the (soft-edged) vision window.
    fctx.globalCompositeOperation = 'destination-in';
    if (supportsFilter) fctx.filter = `blur(${Math.max(1, (v.softEdge * ppm) / 2).toFixed(1)}px)`;
    fctx.fillStyle = '#fff';
    fctx.beginPath();
    visionOutline(p, config.player.radius, v).forEach((pt, i) => (i ? fctx.lineTo(sx(pt.x), sy(pt.y)) : fctx.moveTo(sx(pt.x), sy(pt.y))));
    fctx.closePath();
    fctx.fill();
    fctx.restore();
    if (supportsFilter) fctx.filter = 'none';
    fctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(fov, 0, 0, w, h);

    // Close by, the dog fades in from any direction, so you always see it just before you reach it.
    const reveal = v.dogRevealRadius ?? 0;
    if (dogDist < reveal) {
      const ds = toScreen(d.x, d.y);
      ctx.save();
      ctx.globalAlpha = Math.min(1, (reveal - dogDist) / Math.max(1e-6, v.dogRevealFade ?? 0.5));
      drawDog(ctx, ds.x, ds.y, 0.35 * ppm, true);
      ctx.restore();
    }

    enterWorld(ctx);
    drawPlayer(p, sx, sy, config.player.radius * ppm, 0.7);
    ctx.restore();
  }

  // ---- overview: whole map --------------------------------------------------

  function drawOverview(game, w, h) {
    const { map } = config;
    const scale = Math.max(1, Math.min((w - 2 * PAD) / map.width, (h - HUD - 2 * PAD - 24) / map.height));
    const ox = (w - map.width * scale) / 2;
    const oy = HUD + PAD + (h - HUD - 2 * PAD - 24 - map.height * scale) / 2;
    const sx = (x) => ox + x * scale;
    const sy = (y) => oy + y * scale;
    const p = game.player;
    const d = game.dog;

    ctx.fillStyle = COLORS.field;
    ctx.fillRect(sx(0), sy(0), map.width * scale, map.height * scale);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 5; x < map.width; x += 5) { ctx.moveTo(sx(x), sy(0)); ctx.lineTo(sx(x), sy(map.height)); }
    for (let y = 5; y < map.height; y += 5) { ctx.moveTo(sx(0), sy(y)); ctx.lineTo(sx(map.width), sy(y)); }
    ctx.stroke();
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = 3;
    ctx.strokeRect(sx(0), sy(0), map.width * scale, map.height * scale);

    for (const t of game.trees) drawTree(ctx, t, sx, sy, scale, { canopyAlpha: 0.8 });

    // Path walked so far
    if (game.path.length > 1) {
      ctx.strokeStyle = COLORS.path;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sx(game.path[0].x), sy(game.path[0].y));
      for (const pt of game.path) ctx.lineTo(sx(pt.x), sy(pt.y));
      ctx.lineTo(sx(p.x), sy(p.y));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.path;
      ctx.beginPath();
      ctx.arc(sx(game.path[0].x), sy(game.path[0].y), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Line to the dog + win radius + dog
    ctx.strokeStyle = COLORS.line;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx(p.x), sy(p.y));
    ctx.lineTo(sx(d.x), sy(d.y));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx(d.x), sy(d.y), config.rules.winRadius * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.dog;
    ctx.beginPath();
    ctx.arc(sx(d.x), sy(d.y), Math.max(5, 0.4 * scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🐕', sx(d.x), sy(d.y) - Math.max(10, 0.6 * scale));

    // Vision window (for reference) and player
    ctx.fillStyle = COLORS.vision;
    ctx.beginPath();
    visionOutline(p, config.player.radius, config.vision).forEach((pt, i) => (i ? ctx.lineTo(sx(pt.x), sy(pt.y)) : ctx.moveTo(sx(pt.x), sy(pt.y))));
    ctx.closePath();
    ctx.fill();
    drawPlayer(p, sx, sy, Math.max(5, config.player.radius * scale * 1.3), 1);

    if (game.state === GameState.PLAYING) drawDebug(game);
  }

  /** H overlay: live spatial mapping, occlusion, and bark-vs-ambient levels (estimated + measured). */
  function drawDebug(game) {
    const a = computeDogParams(game.player, game.dog, config.audio, { trees: game.trees, occlusion: config.trees.occlusion });
    const az = radToDeg(a.azimuth);
    const side = Math.abs(az) < 1 ? 'ahead' : az > 0 ? 'right' : 'left';
    const est = barkVsAmbient(config, game.difficultyKey);
    const estMax = barkVsAmbient(config, maxKey);
    const maxD = config.difficulties[maxKey].distance;
    const lines = [
      `Dog ${a.distance.toFixed(1)} m · ${Math.abs(az).toFixed(0)}° ${side}${a.rear > 0 ? ' (behind)' : ''} · bark ${fmtDb(20 * Math.log10(a.totalGain))} · LPF ${(a.cutoffHz / 1000).toFixed(1)} kHz`,
      `Occlusion: ${a.occlusion.trees} tree(s) on the line · ${fmtDb(a.occlusion.gainDb)} · cutoff ×${a.occlusion.cutoffFactor.toFixed(2)}`,
      `Ambient ${game.difficulty.label} (distraction ${est.profile.distraction.toFixed(2)}): bed ${est.profile.bedDb.toFixed(0)} · gust ${est.profile.gustDb.toFixed(0)} · bird ${est.profile.birdDb.toFixed(0)} dB${game.ambientMuted ? ' · MUTED (B)' : ''}`,
      `Bark − ambient, worst case @ ${game.difficulty.distance} m: quiet ${fmtDb(est.quietMarginDb)} · busy ${fmtDb(est.busyMarginDb)}`,
      `Bark − ambient, worst case @ ${maxD} m (max): quiet ${fmtDb(estMax.quietMarginDb)} · busy ${fmtDb(estMax.busyMarginDb)}`,
    ];
    const lv = getAudioLevels?.();
    if (lv) lines.push(`Measured: last bark ${fmtDb(lv.barkPeakDb)}FS · ambient ${fmtDb(lv.ambientDb)}FS → bark − ambient ${fmtDb(lv.marginDb)}`);
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    ctx.fillStyle = '#000c';
    ctx.fillRect(PAD - 8, HUD + 6, tw + 16, lines.length * 17 + 10);
    ctx.fillStyle = COLORS.dog;
    lines.forEach((l, i) => ctx.fillText(l, PAD, HUD + 12 + i * 17));
    ctx.textBaseline = 'alphabetic';
  }

  function drawHud(game, w, h) {
    ctx.textBaseline = 'middle';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    const diff = game.difficulty;
    ctx.fillText(`Audio Detector: Find the Dog${diff ? ` — ${diff.label} (${diff.distance} m)` : ''}`, PAD, HUD / 2 + 4);

    if (game.stats && game.state !== GameState.MENU) {
      ctx.textAlign = 'right';
      ctx.font = '14px ui-monospace, monospace';
      let x = w - PAD;
      const flag = (text) => {
        ctx.fillStyle = COLORS.warn;
        ctx.fillText(text, x, HUD / 2 + 4);
        x -= ctx.measureText(text).width + 18;
      };
      if (game.reveal && game.state === GameState.PLAYING) flag('REVEAL ON');
      if (game.ambientMuted) flag('AMBIENT MUTED');
      ctx.fillStyle = game.barkReady ? COLORS.text : COLORS.dim;
      ctx.fillText(`time ${formatTime(game.stats.elapsed)}   barks ${game.stats.barks}`, x, HUD / 2 + 4);
    }

    ctx.textAlign = 'center';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('←/→ or A/D turn · ↑/↓ or W/S walk · SPACE bark · H reveal · B ambient · R restart · Esc/M menu', w / 2, h - 14);
    ctx.textBaseline = 'alphabetic';
  }

  return { render, resize };
}
