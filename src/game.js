// Game state, rules and the main loop. No DOM or Web Audio here: audio is injected,
// which keeps this module testable in Node.

import { CONFIG } from './config.js';
import {
  degToRad, distance, forwardVector, hasReachedDog, normalizeAngle, placeAtDistance, randomHeading,
} from './geometry.js';
import { generateForest, resolveCollisions } from './forest.js';
import { circleInVision } from './vision.js';
import { AmbientDirector, ambientProfile } from './ambientDirector.js';
import { MOVEMENT_MODES, createDog, placeDogs, updateDog } from './dogs.js';

export const GameState = Object.freeze({ MENU: 'menu', PLAYING: 'playing', WON: 'won' });

/** Audio interface the game expects. Used when no audio engine is supplied (tests, no Web Audio). */
export const silentAudio = Object.freeze({
  setDog() {}, setDogs() {}, moveDog() {}, dogFound() {}, setListener() {}, setForest() {}, bark() {}, footstep() {}, bump() {}, treeBump() {},
  startCue() {}, endCue() {}, winJingle() {},
  ambientStart() {}, ambientStop() {}, ambientEvent() {}, setAmbientMuted() {},
});

const clampUnit = (v) => Math.max(-1, Math.min(1, v || 0));

export class Game {
  /**
   * @param rng         randomness for placement, heading and trees
   * @param ambientRng  separate randomness for ambient distractions, so they are independent of the dog
   */
  constructor({ config = CONFIG, audio = silentAudio, rng = Math.random, ambientRng = Math.random, onEvent = () => {} } = {}) {
    this.config = config;
    this.audio = audio;
    this.rng = rng;
    this.onEvent = onEvent;
    this.state = GameState.MENU;
    this.difficultyKey = config.defaultDifficulty;
    this.cues = { ...config.cues };
    this.player = null;
    this.dogs = [];
    this.options = { dogCount: config.dogs.defaultCount, movement: config.dogs.defaultMovement };
    this.trees = [];
    this.seenTrees = new Set();
    this.path = [];
    this.reveal = false;
    this.ambientMuted = false;
    this.ambientDirector = new AmbientDirector(config.ambient, ambientRng);
    this.stats = null;
  }

  /** The first dog still being searched for (or the first dog). Setting it replaces all dogs with one. */
  get dog() {
    return this.dogs.find((d) => !d.found) ?? this.dogs[0] ?? null;
  }

  set dog(pos) {
    this.dogs = pos ? [createDog(pos, 0, this.config.dogs, this.rng)] : [];
    this._sendDogs();
  }

  get dogsFound() {
    return this.dogs.filter((d) => d.found).length;
  }

  /** Rain level of the current difficulty: 'none' | 'light' | 'heavy'. */
  get rain() {
    return this.difficulty?.rain ?? 'none';
  }

  get difficulty() {
    return this.config.difficulties[this.difficultyKey];
  }

  /** Whether the renderer may show the whole map (dog, trees, path). Otherwise only the vision window. */
  get showSolution() {
    return this.state === GameState.WON || (this.state === GameState.PLAYING && this.reveal);
  }

  get barkReady() {
    return this.state === GameState.PLAYING && this.barkCooldown <= 0;
  }

  /**
   * @param difficultyKey  key of config.difficulties
   * @param options        { dogCount: 1..config.dogs.maxCount, movement: 'off'|'calm'|'restless'|'shy' }
   *                       (kept for restarts)
   */
  startRound(difficultyKey = this.difficultyKey, options = {}) {
    if (!this.config.difficulties[difficultyKey]) throw new Error(`Unknown difficulty "${difficultyKey}"`);
    this.difficultyKey = difficultyKey;
    const dc = this.config.dogs;
    const opt = { ...this.options, ...options };
    opt.dogCount = Math.max(1, Math.min(dc.maxCount, Math.round(opt.dogCount) || 1));
    if (!MOVEMENT_MODES.includes(opt.movement)) opt.movement = 'off';
    this.options = opt;
    const { map, placement, trees: treesCfg, player: pc } = this.config;
    const { player, dog } = placeAtDistance(map, this.difficulty.distance, {
      margin: map.spawnMargin,
      maxAttempts: placement.maxAttempts,
      rng: this.rng,
    });
    const dogPositions = placeDogs(map, player, this.difficulty.distance, opt.dogCount, {
      margin: Math.max(map.spawnMargin, dc.wallMargin), minSeparation: dc.minSeparation, first: dog, rng: this.rng,
    });
    const forest = generateForest({
      map, player, dogs: dogPositions, density: treesCfg.density[difficultyKey] ?? 0, treesCfg, playerRadius: pc.radius, rng: this.rng,
    });
    this.trees = forest.trees;
    this.forestInfo = { attempts: forest.attempts, density: forest.density };
    this.seenTrees = new Set();
    this.player = { x: player.x, y: player.y, heading: randomHeading(this.rng) };
    this.dogs = dogPositions.map((d, i) => createDog(d, i, dc, this.rng));
    this.path = [{ x: player.x, y: player.y }];
    this.reveal = false;
    this.barkCooldown = 0;
    this.bumpCooldown = 0;
    this.strideProgress = 0;
    this.stats = {
      elapsed: 0,
      barks: 0,
      steps: 0,
      walked: 0,
      wallBumps: 0,
      treeBumps: 0,
      optimal: distance(player, dog), // to the first dog (with several dogs: the nearest one is at the same distance)
      revealUsed: false,
      ambientMutedUsed: this.ambientMuted,
      found: [],
    };
    this.state = GameState.PLAYING;
    this.audio.setForest(this.trees, treesCfg.occlusion);
    this._sendDogs();
    this.audio.setListener(this.player, { snap: true });
    this.ambientProfile = ambientProfile(this.config, difficultyKey, this.rain);
    this.ambientDirector.reset(this.ambientProfile);
    this.audio.setAmbientMuted(this.ambientMuted);
    this.audio.ambientStart(this.ambientProfile);
    if (this.cues.startCue) this.audio.startCue();
    this._updateSeen();
    this.onEvent('roundStart', this);
  }

  toMenu() {
    this.state = GameState.MENU;
    this.reveal = false;
    this.ambientDirector.stop();
    this.audio.ambientStop();
    this.onEvent('menu', this);
  }

  /** Discrete actions: 'bark' | 'reveal' | 'ambient' | 'restart' | 'menu'. Returns true if handled. */
  handleAction(action) {
    switch (action) {
      case 'bark':
        return this.bark();
      case 'reveal':
        return this.toggleReveal();
      case 'ambient':
        return this.toggleAmbient();
      case 'restart':
        if (this.state === GameState.MENU) return false;
        this.startRound();
        return true;
      case 'menu':
        if (this.state === GameState.MENU) return false;
        this.toMenu();
        return true;
      default:
        return false;
    }
  }

  /** The lost (not yet found) dog closest to the player, or null. */
  get nearestLostDog() {
    let best = null, bestD = Infinity;
    for (const d of this.dogs) {
      if (d.found) continue;
      const dd = distance(this.player, d);
      if (dd < bestD) { best = d; bestD = dd; }
    }
    return best;
  }

  /** SPACE: only the closest dog that has not been found barks once. */
  bark() {
    if (!this.barkReady) return false;
    const dog = this.nearestLostDog;
    this.audio.bark(dog ? [dog.id] : []);
    this.stats.barks++;
    this.barkCooldown = this.config.rules.barkCooldown;
    return true;
  }

  toggleReveal() {
    if (this.state !== GameState.PLAYING) return false;
    this.reveal = !this.reveal;
    if (this.reveal) this.stats.revealUsed = true;
    this.onEvent('reveal', this);
    return true;
  }

  /** B: mute/unmute the forest ambience (testing aid). Stays muted across rounds; recorded per round. */
  toggleAmbient() {
    if (this.state === GameState.MENU) return false;
    this.ambientMuted = !this.ambientMuted;
    if (this.ambientMuted && this.state === GameState.PLAYING) this.stats.ambientMutedUsed = true;
    this.audio.setAmbientMuted(this.ambientMuted);
    this.onEvent('ambientMuted', this);
    return true;
  }

  /**
   * Advance the simulation by dt seconds.
   * controls.turn: -1 (left) .. +1 (right). controls.move: -1 (back) .. +1 (forward).
   */
  update(dt, controls = { turn: 0, move: 0 }) {
    if (this.state !== GameState.PLAYING) return;
    const { player: pc, rules, map } = this.config;
    const p = this.player;

    this.stats.elapsed += dt;
    this.barkCooldown = Math.max(0, this.barkCooldown - dt);
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);

    const turn = clampUnit(controls.turn);
    const move = clampUnit(controls.move);

    // Positive turn = clockwise on screen = turning right (see geometry.js).
    if (turn) p.heading = normalizeAngle(p.heading + turn * degToRad(pc.turnSpeedDeg) * dt);

    if (move) {
      const speed = move > 0 ? pc.moveSpeed : pc.moveSpeed * pc.backwardSpeedFactor;
      const f = forwardVector(p.heading);
      const len = move * speed * dt;
      const res = resolveCollisions({ x: p.x + f.x * len, y: p.y + f.y * len }, pc.radius, this.trees, map);
      const moved = Math.hypot(res.x - p.x, res.y - p.y);
      p.x = res.x;
      p.y = res.y;
      // A "bump" is walking INTO something. Sliding along a trunk or wall at a shallow angle keeps
      // most of the motion and stays quiet.
      const blocked = moved < Math.abs(len) * rules.bumpBlockedFraction;
      if ((res.hitTree || res.hitWall) && blocked && this.bumpCooldown <= 0) {
        if (res.hitTree) {
          this.audio.treeBump();
          this.stats.treeBumps++;
        } else {
          this.audio.bump();
          this.stats.wallBumps++;
        }
        this.bumpCooldown = rules.bumpCooldown;
      }
      this._accumulateWalk(moved);
      this._updateSeen();
    } else if (turn) {
      this._updateSeen();
    }

    this._updateDogs(dt);
    this.audio.setListener(p);
    for (const ev of this.ambientDirector.update(dt, p)) this.audio.ambientEvent(ev);

    for (const d of this.dogs) {
      if (!d.found && hasReachedDog(p, d, rules.winRadius)) this._found(d);
    }
    if (this.dogs.length && this.dogs.every((d) => d.found)) this._win();
  }

  _sendDogs() {
    if (this.audio.setDogs) this.audio.setDogs(this.dogs);
    else if (this.dogs[0]) this.audio.setDog(this.dogs[0]);
  }

  _updateDogs(dt) {
    const mode = this.options.movement;
    if (mode === 'off') return;
    const world = { player: this.player, trees: this.trees, map: this.config.map, cfg: this.config.dogs, mode, rng: this.rng };
    for (const d of this.dogs) {
      if (d.found) continue;
      const bx = d.x, by = d.y;
      updateDog(d, dt, world);
      if (d.x !== bx || d.y !== by) this.audio.moveDog?.(d);
    }
  }

  _found(dog) {
    dog.found = true;
    dog.state = 'rest';
    dog.foundAt = this.stats.elapsed;
    this.stats.found.push({ id: dog.id, time: this.stats.elapsed });
    const remaining = this.dogs.filter((d) => !d.found).length;
    if (remaining > 0) this.audio.dogFound?.(dog);
    this.onEvent('dogFound', { dog, found: this.dogs.length - remaining, total: this.dogs.length });
  }

  /** Optional memory of trees that have been inside the vision window. */
  _updateSeen() {
    const v = this.config.vision;
    if (!v.rememberSeen) return;
    this.trees.forEach((t, i) => {
      if (!this.seenTrees.has(i) && circleInVision(this.player, t, this.config.player.radius, v)) this.seenTrees.add(i);
    });
  }

  _accumulateWalk(moved) {
    if (moved <= 0) return;
    const pc = this.config.player;
    this.stats.walked += moved;
    this.strideProgress += moved;
    while (this.strideProgress >= pc.strideLength) {
      this.strideProgress -= pc.strideLength;
      this.stats.steps++;
      this.audio.footstep();
    }
    const last = this.path[this.path.length - 1];
    if (distance(last, this.player) >= pc.pathSampleDistance) this.path.push({ x: this.player.x, y: this.player.y });
  }

  _win() {
    this.state = GameState.WON;
    this.path.push({ x: this.player.x, y: this.player.y });
    this.ambientDirector.stop();
    this.audio.ambientStop();
    if (this.cues.endCue) this.audio.endCue();
    this.audio.winJingle({ delay: this.cues.endCue ? 0.55 : 0 });
    this.onEvent('won', this.results());
  }

  results() {
    const s = this.stats;
    const minimumWalk = Math.max(0, s.optimal - this.config.rules.winRadius);
    return {
      difficulty: this.difficulty.label,
      rain: this.rain,
      dogs: this.dogs.length,
      movement: this.options.movement,
      foundTimes: s.found.map((f) => f.time),
      targetDistance: this.difficulty.distance,
      time: s.elapsed,
      barks: s.barks,
      steps: s.steps,
      walked: s.walked,
      optimal: s.optimal,
      minimumWalk,
      efficiency: s.walked > 0 ? Math.min(1, minimumWalk / s.walked) : 0,
      wallBumps: s.wallBumps,
      treeBumps: s.treeBumps,
      trees: this.trees.length,
      revealUsed: s.revealUsed,
      ambientMutedUsed: s.ambientMutedUsed,
    };
  }
}

/** Fixed-timestep loop driven by requestAnimationFrame (browser only). */
export function runLoop({ game, input, render, step = game.config.fixedStep }) {
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000); // cap so a hidden tab doesn't fast-forward
    last = now;
    for (const action of input.consumeActions()) game.handleAction(action);
    while (acc >= step) {
      game.update(step, input.controls());
      acc -= step;
    }
    render(game);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
