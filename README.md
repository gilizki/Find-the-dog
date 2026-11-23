# Audio Detector: Find the Dog

You are standing in a windy 70 × 70 m forest and can see only half a metre in front of you.
Somewhere among the trees a dog is waiting a set distance away. Press **Space** and it barks once.
Wind gusts and birds come from every direction to distract you. Use your ears (direction,
loudness, brightness and how they change as you move and turn) to walk to the dog without
bumping into every trunk on the way.

🎧 **Use headphones.** The game uses HRTF spatial audio; speakers can't convey left/right and
front/back properly. Use the **Headphone check** button on the start screen to confirm the left
and right channels are the right way round, and **Test bark** to hear the bark sound.

🐕 **Sounds:** put real recordings in `assets/barks/`, `assets/ambient/` and `assets/birds/`
(see [Sound files](#sound-files)). Anything missing is synthesized.

## Run it

ES modules don't load from `file://`, so serve the folder locally:

- **Windows:** double-click `run.bat`. It refreshes the sound manifests, starts `python -m http.server 8000` and opens the browser.
- **Any OS:** `npm start`, or `python tools/make_manifests.py && python -m http.server 8000`, then open <http://localhost:8000>.

No build step and no dependencies. Works in current Chrome, Edge, Firefox and Safari. In Safari the
vision window has a hard edge instead of a soft one, because Safari has no canvas `filter`.

### Tests

```
npm test        # = node --test "tests/**/*.test.js"   (Node 18+; no packages needed)
```

| Area | What is tested |
| --- | --- |
| Placement & rules | distance within tolerance, inside the map, all directions, win radius, bark cooldown, wall collisions, footsteps, results, reveal flag |
| Left/right | arrow-key turning matches the drawn heading. The exact listener/source vectors sent to Web Audio go through the spec's panner math: a dog on the right gives a positive azimuth and a louder right channel |
| Distance | 50 m audible but clearly quieter than 10 m. `masterGain`/`rolloffFactor` drive the mapping |
| Barks | stereo downmix, silence trim, equal loudness across files, no back-to-back repeats, variation ranges. Synth: pitch, 30–40 % glide, attack, length, formant energy |
| Trees | clear zones around start and dog, spacing, density, **walkable path over 500 seeds per difficulty**, BFS detects an enclosed player, regeneration when blocked |
| Collision | no penetration, sliding around a trunk, walls vs trees counted separately, rate-limited thud, glancing contact is silent |
| Occlusion | none on a clear line, per-tree loss, cap, smooth ramp at trunk edges, never changes the azimuth |
| Vision | inside/outside of the window for several headings (front, just past the range, behind, beside), circles, cone variant, outline; memory of seen trees |
| Ambient | distraction per difficulty, events from all four sectors, bird distances/heights/flights, gust drift, **independence from the dog**, procedural sounds, loop seams |
| Bark vs ambient | at the max distance (50 m, hard), worst case: ≥ +6 dB over the quiet bed, ≥ −6 dB at the busiest moment |

## Controls

| Key | Action |
| --- | --- |
| ← / → or A / D | Turn left / right |
| ↑ / ↓ or W / S | Walk forward / backward (relative to your heading) |
| Space | The closest dog not yet found barks once (0.5 s cooldown; dogs never bark on their own) |
| H | Reveal: full map, trees, dog, path and the audio debug readout. **Recorded in the results** |
| B | Mute / unmute the forest ambience (for testing). Stays muted across rounds. **Recorded in the results** |
| R | Restart with new random positions and a new forest |
| Esc / M | Back to the menu |
| Enter | Start (from the menu) |

## Game setup (start screen)

No levels and no score: you pick what kind of game you want, and the choice is remembered in the browser.

- **Difficulty**: distance to the dogs, tree density, wind/birds, and **rain**: Easy is dry, Medium has
  light rain, Hard has heavy rain with louder bursts that can cover a bark (`CONFIG.difficulties[*].rain`,
  levels in `CONFIG.rain`). Rain is visible only inside your lit vision window: falling streaks,
  splash rings on the ground, and slightly darker light.
- **Dogs (1-4)**: every dog is at the difficulty distance from you (in different directions, at least
  `dogs.minSeparation` apart) with a guaranteed walkable path. Each has its own voice (recording + pitch,
  `CONFIG.dogs.voices`). Space makes only the closest lost dog bark, so you track one dog at a time. A found
  dog goes quiet, you hear a short happy yip, and the HUD counts `dogs 1/3`. The round ends when all are found.
- **Dogs move** (`CONFIG.dogs.movement`, all slower than the player):
  - *No*: the dogs stay put.
  - *Calm*: short slow walks with long sniffing pauses.
  - *Restless*: longer, faster walks with short pauses.
  - *Shy*: wanders like calm, but runs away when you come within `noticeRadius`, then rests and ignores
    you for a few seconds, so you can catch it.

## Project structure

```
index.html          start screen, results panel, canvas
style.css
run.bat             local server launcher (Windows); refreshes the sound manifests first
assets/barks/       bark recordings + manifest.json
assets/ambient/     loopable wind/forest recordings + manifest.json
assets/birds/       bird one-shots + manifest.json
tools/
  make_manifests.py writes manifest.json in each assets folder from its contents
src/
  config.js         ALL tunable values (map, difficulties, speeds, radii, audio, ambient, vision, trees)
  geometry.js       pure 2D math: vectors, azimuth, placement at distance, win check
  dogs.js           pure: placing several dogs, their voices, wandering / shy movement
  forest.js         pure: tree scattering, BFS walkable-path check, collision + sliding, occlusion
  vision.js         pure: vision-window geometry (inside/outside, outline)
  ambientDirector.js pure: schedules gusts/birds around the listener (never sees the dog); per-difficulty profile
  audioMapping.js   pure game-state -> audio-parameter mapping incl. occlusion; bark-vs-ambient estimate
  audio.js          Web Audio engine: graph, loading/decoding, listener/panner updates, one-shots, meters
  ambient.js        Web Audio ambience: base bed, spatial gusts and birds, fades, mute
  assetLoader.js    manifest + fetch + decode for any sound folder
  samples.js        pure sample processing: downmix, trim, loudness-normalize, non-repeating pick, variation
  sounds.js         procedural synthesis: fallback bark, wind bed, gusts, birds, crickets, thuds, cues, jingle
  game.js           state machine (menu / playing / won), rules, collisions, stats, fixed-step loop
  input.js          keyboard -> held controls + one-shot action queue
  render.js         follow camera + vision window, full-map overview, debug readout, HUD
  main.js           wiring + DOM (menu, results, autoplay-safe audio start)
tests/              node:test unit tests
```

## The forest

### Trees (`CONFIG.trees`)
- **Scattering:** trunks of radius 0.3–0.6 m are placed randomly, with a density per difficulty (`density`, trees per 100 m²;
  Easy 1.5, Medium 2.5, Hard 3.5, so about 70–170 trees).
- **Spacing:** there are at least `minGap` = 1.2 m between trunk surfaces and between trunks and walls. That's wider than the
  0.7 m player, so there are always gaps to walk through.
- **Clear zones:** no trunk within `clearRadius` = 3 m of the player start or the dog.
- **Guaranteed path:** every forest is checked with a breadth-first search on a `gridCell` = 0.25 m grid, where a cell is
  blocked if it's within trunk radius + player radius. If the path is blocked, the trees are regenerated (`maxAttempts`).
  After that the density is lowered step by step, and as a last resort the game uses no trees at all.
- **Collision:** after each step the player is pushed out of overlapping trunks along the contact normal, then
  clamped to the walls. Only the motion *into* the trunk is removed, so you slide around it.
- **Bumps:** a move counts as a bump when less than `rules.bumpBlockedFraction` of it got through.
  A tree plays a soft woody thud and a wall plays the old bump. Both are centred, at a fixed level, and share
  the `rules.bumpCooldown` rate limit. Sliding along a trunk at a shallow angle stays silent.
- **Sound occlusion** (`occlusion`, mild by default): each trunk near the straight line from player to dog gets a weight
  from 0 to 1. The weight ramps smoothly over ±`edgeSoftness` around the trunk's edge, so walking past a tree never causes a jump.
  - Each unit of weight costs `perTreeDb` (−0.8 dB) and multiplies the cutoff by `perTreeCutoff` (×0.85).
  - The total is capped at `maxDb` (−3 dB) and `minCutoffFactor` (×0.6).
  - **Direction is never changed**, only level and brightness. Set `enabled: false` to turn it off.

### Limited vision (`CONFIG.vision`)
- **Follow camera:** centred on you at `pixelsPerMeter` = 110, so the window is about 220 px deep. It stays north-up and
  doesn't rotate, which keeps the heading arrow consistent with the arrow keys.
- **The window:** you see only what is inside the vision window: `range` = 2 m in front of your body,
  `width` = 1.6 m (`shape: 'rect'`), or `shape: 'cone'` with `coneAngleDeg`. It has a soft edge (`softEdge`).
  Inside it you see the ground, trees, walls and the dog, and nothing else. The window reaches past
  `winRadius` (1.5 m), so the dog comes into view a moment before you reach it.
- **Memory:** `rememberSeen: true` keeps trees you've seen as dim silhouettes.
- **H and the win screen:** both switch to the full-map overview, with all trees, the path, the dog and your vision window.

### Forest ambience (`CONFIG.ambient`): distractions from every direction
| Layer | How | Spatial? |
| --- | --- | --- |
| Base bed | quiet continuous wind, decorrelated stereo, loopable | no (always underneath) |
| Wind gusts + leaf rustle | each gust swells in and out over 2.5–6 s, starts 3–9 m away in a **random direction** and **drifts 20–70°** around you while it plays | HRTF panner, no distance loss |
| Birds | chirps (sweeps, whistles, trills) **anywhere around you, including straight ahead and behind**, 5–40 m away, 3–8 m up in the trees. 30 % fly a short path (3–8 m/s) while calling | HRTF panner, inverse distance like the dog |
| Crickets | optional (`crickets.enabled`), continuous | no |

- **Distraction:** `distraction` per difficulty (Easy 0, Medium 0.55, Hard 1.0) interpolates every level, interval, gust length
  and bird flock size between the `low` and `high` profiles. A higher value means more frequent, louder and longer gusts,
  louder birds that come in flocks of up to 5 calls from one area, and a louder bed.
  `masterGain` scales all ambience. `levelJitterDb` varies each event.
- **Independence:** the scheduler (`ambientDirector.js`) gets only the player's position and its own random generator.
  It never receives the dog, so no ambient sound carries information about where the dog is. A test runs the same round
  with three different dog positions and checks that the ambient events are identical.
- **Fades and mute:** the ambience fades in at round start (`fadeInSec`), fades out on the win screen and the menu
  (`fadeOutSec`), and **B** mutes it.

### Bark vs ambient level
All sources share one loudness reference: every bark, gust and bird is normalized so that its loudest 50 ms
reaches `barkProcessing.targetRms`, and loops are normalized by whole-file RMS. The `*Db` values in `CONFIG.ambient` can
therefore be compared directly with the bark. `barkVsAmbient()` in `audioMapping.js` estimates the worst case for the bark:
dog directly behind, occlusion at its cap, and the quietest bark variation.

| Difficulty | Bark (worst) | vs quiet bed | vs busiest moment (bed + gust peak + bird at 15 m) |
| --- | --- | --- | --- |
| Easy, 10 m | −16.5 dB | **+28.1 dB** | +15.9 dB |
| Medium, 25 m | −23.6 dB | **+17.9 dB** | +5.4 dB |
| Hard, 50 m | −29.3 dB | **+7.7 dB** | −5.3 dB |

Tests require at least `minQuietMarginDb` = +6 dB and `minBusyMarginDb` = −6 dB at the maximum distance.
On Hard a strong gust or a nearby bird can cover a far bark, but between them the bark stands out.

Press **H** during play to see both estimates (for the current difficulty and for 50 m). The overlay also shows a **live measurement**:
analysers on the dog bus and the ambient output report the last bark's peak level and the ambient level (dBFS) and
their difference. To tune, change `ambient.high/low` (`bedDb`, `gustDb`, `birdDb`), `ambient.masterGain`, or the
distraction values.

## How the bark mapping works

### Coordinates
The game plane is the horizontal audio plane: game `(x, y)` → Web Audio `(x, height, y)`, with `up = (0, 1, 0)`.
The dog is at height 0 and birds are 3–8 m up. The heading `h` gives listener forward `(cos h, 0, sin h)`.
Web Audio's "right" is `forward × up = (−sin h, 0, cos h)`, which is exactly the game's right-hand vector
(y points down the screen, so increasing heading is a clockwise turn = turning right). Every frame the listener's
**position and orientation** are updated, smoothed with `setTargetAtTime`, with a fallback for browsers without listener AudioParams.

### Signal chain

```
bark ─► low-pass (distance × rear × occlusion) ─► gain (rear × occlusion) ─► PannerNode (HRTF, inverse) ─► dog bus ─┐
footsteps, wall bump, tree thud (centred, fixed level)                                               ─► sfx bus ───┤
start/end cues, win jingle (centred)                                                                 ─► cue bus ───┼─► master ─► limiter ─► out
ambience: bed (non-spatial) + gusts/birds (own HRTF panners) ─► fade ─► mute (B)                     ─► ambient ───┘
Test bark + Headphone check (start screen) go straight to master, centred / hard-panned.
```

| Cue | What does it | Tuning (`config.js`) |
| --- | --- | --- |
| Left / right (HRTF) | `PannerNode` with `panningModel: "HRTF"` | `audio.panningModel` |
| Loudness vs distance | Panner `distanceModel: "inverse"`: `gain = ref / (ref + rolloff·(d − ref))` | `audio.refDistance`, `rolloffFactor`, `masterGain`, `dogGain` |
| Air absorption (far = duller) | Low-pass cutoff, log-interpolated from `nearHz` to `farHz` over `nearDistance…farDistance` | `audio.lowpass.*` |
| Front / back | Behind the listener the cutoff is multiplied by `rear.cutoffFactor` and the level by `rear.gainFactor`, blended by `max(0, −cos azimuth)` (0 at the sides, 1 directly behind) | `audio.rear.*` |
| Trees in the way | extra low-pass and gain loss per trunk on the line, capped | `trees.occlusion.*` |

With the defaults (`refDistance 2`, `rolloffFactor 0.5`), no trees:

| Distance | Level | Low-pass (in front) |
| --- | --- | --- |
| ≤ 2 m | 0 dB | 18 kHz |
| 10 m | −9.5 dB | ~14 kHz |
| 25 m | −17 dB | ~9 kHz |
| 50 m | −22 dB | ~4 kHz |

The filter and gain are updated continuously, so a bark that is still ringing keeps changing as you turn.
Turning in place is a useful way to find the direction: the bark is centred and brightest when the dog is
straight ahead. Footsteps, bumps and cues are not spatialised (centred, fixed level), so they never carry information
about the dog's position.

## Sound files

Browsers can't list a folder, so each sound folder has a **`manifest.json`**:

```json
{ "files": ["bark1.wav", "bark2.mp3"] }
```

`run.bat` and `npm start` regenerate all three manifests automatically (`tools/make_manifests.py`).
With any other server, run `python tools/make_manifests.py` (or `npm run manifest`) after adding or removing files.
Alternatively, list files explicitly in config (`audio.barkUrls`, `audio.ambientUrls`, `audio.birdUrls`), with paths relative to
`index.html`. A non-empty list replaces that folder's manifest. Supported formats: WAV, MP3, OGG, Opus, FLAC and M4A, or anything
the browser decodes. Files that fail to download or decode are skipped with a console warning. The start screen
shows what loaded.

| Folder | What to put there | Processing at load time | Fallback |
| --- | --- | --- | --- |
| `assets/barks/` | short single barks, dry (little room echo) | mono, trim silence, normalize loudest 50 ms | synthesized bark |
| `assets/ambient/` | **loopable** wind / forest recordings, ideally without birds or animals | stereo kept for the base bed (whole-file RMS normalized). A mono copy supplies random excerpts for the spatial gusts, shaped into a swell | synthesized wind bed + gusts |
| `assets/birds/` | single bird calls, short | mono, trim silence, normalize loudest 50 ms | synthesized chirps |

### Barks in detail
1. **Downmixed to mono** (average of channels). A stereo source would carry its own left/right image into the
   HRTF panner and break the spatial effect. As a safety net, every panner is also forced to a mono input.
2. **Silence trimmed:** leading silence below −40 dB (relative to the file's peak) is cut, keeping a 3 ms faded pre-roll,
   so the bark starts the instant you press Space. Trailing silence below −50 dB is cut with a 15 ms fade.
3. **Loudness-normalized:** the loudest 50 ms window is scaled to `targetRms` for every file, with the peak capped at `maxPeak`.
4. **Per bark:** a random recording is picked, **never the same one twice in a row**, with `playbackRate` 0.92–1.08 and
   ±1.5 dB gain (`audio.barkVariation`).

**Synthesized fallback bark:** used only if no recording loads, and generated fresh for every bark.
- **Source:** a band-limited sawtooth at 380–560 Hz. The pitch glides down 30–40 % over ~150 ms, with vibrato and jitter.
- **Attack:** a band-passed noise burst at the onset.
- **Formants:** three parallel formant band-passes at ~700, 1200 and 2600 Hz.
- **Envelope:** 5 ms attack, then a 170–240 ms decay, with an optional quieter second pulse.
- Settings: `audio.synthBark` (all parameters are listed in `SYNTH_BARK_DEFAULTS`).

The win jingle layers two happy barks on top: recordings pitched up 20 %, or high synthesized "yips".

## Results screen
- Time, barks used, steps, distance walked, the optimal straight-line distance, and path efficiency
  (`(optimal − win radius) / walked`).
- **Wall bumps** and **tree bumps**.
- Whether the **reveal (H)** was used, and whether the **ambience was muted (B)** at any point in the round.
- After a round the full map is drawn, with all trees, your path and the dog.
