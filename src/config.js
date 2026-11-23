// All tunable values live here. Units: metres, seconds, degrees, Hz.

export const GAME_TITLE = 'Audio Detector: Find the Dog';

export const CONFIG = {
  map: {
    width: 70,          // m
    height: 70,         // m
    spawnMargin: 2,     // min distance from walls for player & dog at round start
  },

  // rain: 'none' | 'light' | 'heavy' (see `rain` below). Rain is part of the difficulty.
  difficulties: {
    easy:   { label: 'Easy',   distance: 10, rain: 'none' },
    medium: { label: 'Medium', distance: 25, rain: 'light' },
    hard:   { label: 'Hard',   distance: 50, rain: 'heavy' },
  },
  defaultDifficulty: 'medium',

  // ---- Dogs (chosen on the start screen: how many, and how they move) ----
  dogs: {
    maxCount: 4,
    defaultCount: 1,
    defaultMovement: 'off',   // 'off' | 'calm' | 'restless' | 'shy'
    minSeparation: 8,         // m between dogs at the start (relaxed if the map is too small)
    radius: 0.25,             // m, collision with trunks and walls when moving
    wallMargin: 1,            // m: dogs stay this far from the walls
    barkStaggerSec: [0.12, 0.35], // s between the barks of different dogs on one SPACE
    // Each dog has its own voice: `sample` = which recording (null = random each bark, used with one dog),
    // `rate` = playback rate (pitch), `pitchScale` for the synthesized fallback. Names show on the end screen.
    voices: [
      { name: 'Rex',    emoji: '🐕', sample: null, rate: 1.0,  pitchScale: 1.0 },
      { name: 'Pip',    emoji: '🐩', sample: 1,    rate: 1.3,  pitchScale: 1.4 },
      { name: 'Bruno',  emoji: '🐕', sample: 2,    rate: 0.8,  pitchScale: 0.75 },
      { name: 'Luna',   emoji: '🐶', sample: 0,    rate: 1.12, pitchScale: 1.15 },
    ],
    movement: {
      calm:     { speed: [0.25, 0.4], legM: [1, 3], pauseSec: [4, 9] },
      restless: { speed: [0.5, 0.8],  legM: [3, 8], pauseSec: [1, 3] },
      // Shy: wanders like calm; runs away (slower than the player) when you come within noticeRadius,
      // then rests and ignores you for restAfterFleeSec, so you can catch up.
      shy:      { speed: [0.25, 0.4], legM: [1, 3], pauseSec: [4, 9], noticeRadius: 3.5, fleeSpeed: 1.0, fleeM: [4, 7], restAfterFleeSec: [4, 7] },
    },
  },

  // ---- Rain (per difficulty). Non-spatial hiss + drops; heavy rain has louder bursts that can cover a bark. ----
  // Levels use the same loudness reference as the bark (see `ambient`).
  rain: {
    light: { bedDb: -47, burstDb: null, burstEverySec: [0, 0], burstDurationSec: [0, 0], drops: 160, darken: 0.12 },
    heavy: { bedDb: -42, burstDb: -37, burstEverySec: [10, 20], burstDurationSec: [3, 6], drops: 520, darken: 0.25 },
  },

  placement: {
    tolerance: 0.5,     // |actual - target| distance must stay within this
    maxAttempts: 500,   // random direction attempts before using a guaranteed fallback
  },

  player: {
    radius: 0.35,             // collision radius against walls
    moveSpeed: 1.4,           // m/s walking forward (normal human pace)
    backwardSpeedFactor: 0.6, // backward speed = moveSpeed * this
    turnSpeedDeg: 120,        // deg/s
    strideLength: 0.7,        // m per footstep sound
    pathSampleDistance: 0.25, // m between recorded path points
  },

  rules: {
    winRadius: 1.5,     // m
    barkCooldown: 0.5,  // s
    bumpCooldown: 0.4,  // s between bump sounds (walls and trees share it)
    bumpBlockedFraction: 0.6, // a move counts as a bump if less than this fraction of it got through
  },

  // Audio-only accessibility cues (toggleable on the start screen).
  cues: {
    startCue: true,
    endCue: true,
  },

  audio: {
    masterGain: 0.9,    // overall output level
    dogGain: 1.0,       // bark bus level (before distance attenuation)
    sfxGain: 0.3,       // footsteps + wall bump (non-spatial)
    cueGain: 0.35,      // start/end cues + win jingle (non-spatial)

    // ---- Bark sounds ----
    // Real recordings are used if any load; otherwise the synthesized bark below is the fallback.
    // barkUrls: explicit list (relative to index.html). If empty, the manifest is read instead;
    // run.bat regenerates it from the files in assets/barks/ (tools/make_manifests.py).
    barkUrls: [],
    barkManifestUrl: 'assets/barks/manifest.json',

    // Per-bark variation so repeats don't sound identical (samples never repeat back-to-back).
    barkVariation: {
      rateRange: [0.92, 1.08],
      gainJitterDb: 1.5,
    },

    // Load-time processing applied to every bark (recorded or synthesized), so distance cues stay consistent:
    // downmix to mono -> trim silence -> normalize the loudest 50 ms window to targetRms (peak capped).
    barkProcessing: {
      leadingDb: -40,   // leading-silence threshold relative to the sample's peak
      trailingDb: -50,  // trailing-silence threshold
      preRollMs: 3,     // kept before the first loud sample (faded in)
      fadeOutMs: 15,
      targetRms: 0.18,
      rmsWindowMs: 50,
      maxPeak: 0.95,
    },

    // Synthesized fallback bark (see sounds.js SYNTH_BARK_DEFAULTS for every parameter).
    synthBark: {
      pitchHz: [380, 560],
      glide: [0.3, 0.4],
      durationMs: [170, 240],
      formantsHz: [700, 1200, 2600],
      doublePulseChance: 0.35,
    },

    // PannerNode settings. Gain(d) = ref / (ref + rolloff * (max(d, ref) - ref))
    //   ref 2, rolloff 0.5 -> 10 m: -9.5 dB, 25 m: -17 dB, 50 m: -22 dB.
    // Audible at 50 m, but ~13 dB quieter than at 10 m.
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    refDistance: 2,
    rolloffFactor: 0.5,
    maxDistance: 10000,

    // Air absorption: low-pass cutoff falls (log-scale) from nearHz to farHz over this distance range.
    lowpass: {
      nearHz: 18000,
      farHz: 3000,
      nearDistance: 2,
      farDistance: 60,
      Q: 0.7,
    },

    // Front/back cue: when the dog is behind the listener the sound gets darker and a bit quieter.
    // Blend amount = max(0, -cos(azimuth)): 0 at the sides/front, 1 directly behind.
    rear: {
      cutoffFactor: 0.45,
      gainFactor: 0.75,
    },

    smoothing: 0.03,      // s, time constant for listener/filter parameter changes
    footstepVariants: 4,
    footstepJitter: { rate: 0.08, gain: 0.2 },
    bumpGain: 1.6,        // wall bump level on the sfx bus
    treeBumpGain: 1.3,    // tree thud level on the sfx bus (centred, fixed)

    // ---- Ambient recordings (optional; procedural synthesis is the fallback) ----
    // ambientUrls: loopable forest/wind recordings. Used as the quiet non-spatial base bed and,
    //   converted to mono, as the source for the spatial wind gusts.
    // birdUrls: bird one-shots (converted to mono, played through HRTF panners).
    ambientUrls: [],
    ambientManifestUrl: 'assets/ambient/manifest.json',
    birdUrls: [],
    birdManifestUrl: 'assets/birds/manifest.json',
  },

  // ---- Forest ambience: distractions from random directions. Never depends on the dog. ----
  // All *Db levels are relative to a loudness-normalized source, the same reference as the bark
  // (loudest 50 ms window at barkProcessing.targetRms), so they compare directly with the bark level.
  ambient: {
    masterGain: 1.0,          // master ambient gain (linear), on top of the per-difficulty levels
    fadeInSec: 2.5,           // at round start
    fadeOutSec: 2.5,          // on the win screen / back to menu
    muteRampSec: 0.15,        // B toggle

    // 0 = calm, 1 = busy. Interpolates every value between the `low` and `high` profiles below.
    distraction: { easy: 0, medium: 0.55, hard: 1.0 },
    low: {
      bedDb: -50,             // quiet continuous non-spatial wind bed
      gustDb: -44,            // spatial wind gust + leaf rustle (peak of the gust)
      gustEverySec: [14, 24], // random interval between gust starts
      gustDurationSec: [2, 4],// length of one gust (swell in/out)
      birdDb: -30,            // bird chirp at the source (then distance attenuation, like the dog)
      birdEverySec: [9, 18],
      birdFlock: [1, 1],      // chirps per bird event (a flock calls several times from one area)
    },
    high: {
      bedDb: -37,
      gustDb: -30,
      gustEverySec: [2, 5],
      gustDurationSec: [4, 8],
      birdDb: -16,
      birdEverySec: [1, 3],
      birdFlock: [2, 5],
    },
    levelJitterDb: 2,         // ± random level per event

    gusts: {
      durationSec: [2, 8],    // range of the procedural gust buffers (each level picks from its own gustDurationSec)
      distance: [3, 9],       // m from the player, random direction (no distance attenuation)
      driftDeg: [20, 70],     // a gust drifts this far around the player over its lifetime
      variants: 6,            // procedural gust buffers generated at start
    },
    birds: {
      distance: [5, 40],      // m from the player, random direction (all around)
      heightM: [3, 8],        // up in the trees
      flyChance: 0.3,         // some birds fly a short path while chirping
      flySpeed: [3, 8],       // m/s
      flightSec: [0.8, 2],
      variants: 10,           // procedural chirp buffers generated at start
      referenceDistance: 15,  // m, used for the "busy" bark-vs-ambient estimate
      flockSpreadM: 4,        // m: flock members call from around the first bird
      flockGapSec: [0.15, 0.7], // s between calls within a flock
    },
    crickets: {
      enabled: false,         // optional continuous non-spatial crickets
      db: -44,
    },
    // Required bark-vs-ambient margins at the hardest distance (worst case: dog behind, max occlusion,
    // quietest bark variation). Checked by tests and shown in the H overlay.
    minQuietMarginDb: 6,      // vs the base bed (between gusts and birds): bark must stand out
    minBusyMarginDb: -6,      // vs bed + gust peak + bird at referenceDistance: may be masked, not buried
  },

  // ---- Limited vision ----
  vision: {
    shape: 'rect',            // 'rect' | 'cone'
    range: 2.0,               // m visible in front of the player's body (> winRadius, so you see the dog just before reaching it)
    width: 1.6,               // m (rect)
    coneAngleDeg: 80,         // full angle (cone)
    softEdge: 0.12,           // m feather of the window edge
    dogRevealRadius: 2.8,     // m: the dog fades into view when this close, from any direction (> winRadius)
    dogRevealFade: 0.6,       // m over which it fades in
    rememberSeen: false,      // keep trees you've seen as dim silhouettes
    pixelsPerMeter: 110,      // follow-camera zoom
    headingUp: true,          // follow camera rotates the world so the player always faces up (false = north-up)
  },

  // ---- Trees ----
  trees: {
    density: { easy: 1.5, medium: 2.5, hard: 3.5 }, // trees per 100 m²
    radius: [0.3, 0.6],       // m trunk radius
    minGap: 1.2,              // m free space between trunk surfaces and to walls (> player diameter)
    clearRadius: 3,           // m: no trees this close to the player start or the dog
    gridCell: 0.25,           // m, BFS grid resolution for the walkable-path check
    maxAttempts: 20,          // regenerations before lowering the density
    densityFallbackFactor: 0.8,
    // Sound occlusion: trunks on the straight line dog -> player make the bark slightly quieter and duller.
    occlusion: {
      enabled: true,
      perTreeDb: -0.8,
      perTreeCutoff: 0.85,    // cutoff multiplier per tree
      maxDb: -3,              // cap
      minCutoffFactor: 0.6,   // cap
      edgeSoftness: 0.15,     // m: weight ramps 0..1 as the line moves from (r + soft) to (r - soft) off the trunk centre
    },
  },

  fixedStep: 1 / 60,      // s, simulation step
};

/** Returns a list of human-readable problems with the config (empty = OK). */
export function validateConfig(cfg = CONFIG) {
  const problems = [];
  const innerW = cfg.map.width - 2 * cfg.map.spawnMargin;
  const innerH = cfg.map.height - 2 * cfg.map.spawnMargin;
  const diag = Math.hypot(innerW, innerH);
  for (const [key, d] of Object.entries(cfg.difficulties)) {
    if (!(d.distance > 0)) problems.push(`difficulty "${key}": distance must be > 0`);
    if (d.distance > diag) problems.push(`difficulty "${key}": distance ${d.distance} m does not fit in the map (max ${diag.toFixed(1)} m)`);
    if (d.distance <= cfg.rules.winRadius) problems.push(`difficulty "${key}": distance must exceed winRadius`);
  }
  if (!cfg.difficulties[cfg.defaultDifficulty]) problems.push(`defaultDifficulty "${cfg.defaultDifficulty}" is not defined`);
  if (!(cfg.placement.tolerance > 0)) problems.push('placement.tolerance must be > 0');
  if (!(cfg.audio.refDistance > 0)) problems.push('audio.refDistance must be > 0');
  if (!(cfg.audio.rolloffFactor >= 0)) problems.push('audio.rolloffFactor must be >= 0');
  for (const key of Object.keys(cfg.difficulties)) {
    if (!(cfg.trees.density[key] >= 0)) problems.push(`trees.density.${key} missing`);
    if (!(cfg.ambient.distraction[key] >= 0)) problems.push(`ambient.distraction.${key} missing`);
  }
  if (cfg.trees.minGap <= 2 * cfg.player.radius) problems.push('trees.minGap must exceed the player diameter');
  for (const [key, d] of Object.entries(cfg.difficulties)) {
    if (d.rain && d.rain !== 'none' && !cfg.rain[d.rain]) problems.push(`difficulty "${key}": rain "${d.rain}" is not defined`);
  }
  if (cfg.dogs.voices.length < cfg.dogs.maxCount) problems.push('dogs.voices needs one voice per dog (maxCount)');
  for (const [mode, m] of Object.entries(cfg.dogs.movement)) {
    if (Math.max(m.speed[1], m.fleeSpeed ?? 0) >= cfg.player.moveSpeed) problems.push(`dogs.movement.${mode}: must be slower than the player`);
  }
  return problems;
}
