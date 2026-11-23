import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, validateConfig } from '../src/config.js';
import { Game, GameState } from '../src/game.js';
import { distance, isInsideMap } from '../src/geometry.js';
import { hasWalkablePath } from '../src/forest.js';
import { createDog, placeDogs, updateDog } from '../src/dogs.js';
import { AmbientDirector, ambientProfile } from '../src/ambientDirector.js';
import { recordingAudio, seededRng } from './helpers.js';

const DT = CONFIG.fixedStep;
const IDLE = { turn: 0, move: 0 };

const OPEN_FIELD = structuredClone(CONFIG);
for (const k of Object.keys(OPEN_FIELD.trees.density)) OPEN_FIELD.trees.density[k] = 0;

function newGame(seed = 1, config = OPEN_FIELD) {
  const audio = recordingAudio();
  const events = [];
  const game = new Game({ config, audio, rng: seededRng(seed), ambientRng: seededRng(seed + 1000), onEvent: (t, p) => events.push({ t, p }) });
  return { game, audio, events };
}

function run(game, seconds, controls = IDLE) {
  for (let t = 0; t < seconds - 1e-9; t += DT) game.update(DT, controls);
}

/** Turn towards a point, then walk (a simple chasing "player"). */
function chase(game, target) {
  const p = game.player;
  const want = Math.atan2(target.y - p.y, target.x - p.x);
  let diff = want - p.heading;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff <= -Math.PI) diff += 2 * Math.PI;
  const turn = Math.abs(diff) < 0.05 ? 0 : Math.sign(diff);
  return { turn, move: Math.abs(diff) < 0.6 ? 1 : 0 };
}

test('config is valid (rain levels, one voice per dog, dogs slower than the player)', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
});

test('placeDogs: every dog at the distance, inside the map, apart from each other', () => {
  const map = CONFIG.map;
  for (let seed = 1; seed <= 30; seed++) {
    const rng = seededRng(seed);
    const player = { x: 10 + rng() * 50, y: 10 + rng() * 50 };
    const dogs = placeDogs(map, player, 25, 4, { margin: 2, minSeparation: 8, rng });
    assert.equal(dogs.length, 4);
    for (const d of dogs) {
      assert.ok(Math.abs(distance(player, d) - 25) < 1e-6);
      assert.ok(isInsideMap(d, map, 2));
    }
  }
});

test('round with 3 dogs: all at the difficulty distance, reachable through the forest, distinct voices', () => {
  const { game } = newGame(5, CONFIG);
  game.startRound('hard', { dogCount: 3 });
  assert.equal(game.dogs.length, 3);
  for (const d of game.dogs) {
    assert.ok(Math.abs(distance(game.player, d) - CONFIG.difficulties.hard.distance) <= CONFIG.placement.tolerance);
    assert.ok(hasWalkablePath(CONFIG.map, game.trees, game.player, d, CONFIG.player.radius, CONFIG.trees.gridCell));
  }
  assert.equal(new Set(game.dogs.map((d) => d.voice.name)).size, 3);
});

test('several dogs: SPACE barks only the closest lost dog; the round ends when all are found', () => {
  const { game, audio, events } = newGame(7);
  game.startRound('easy', { dogCount: 3 });
  const [a, b, c] = game.dogs;
  const lastBark = () => audio.calls.filter((x) => x.name === 'bark').at(-1).args[0];
  // Stand next to each dog in turn (just outside the win radius): that one barks.
  for (const d of [b, c, a]) {
    game.player = { x: d.x - CONFIG.rules.winRadius - 0.3, y: d.y, heading: 0 };
    run(game, 1);
    game.bark();
    assert.deepEqual(lastBark(), [d.id]);
  }

  game.player = { x: a.x - 1, y: a.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(game.state, GameState.PLAYING);
  assert.equal(game.dogsFound, 1);
  assert.ok(events.some((e) => e.t === 'dogFound' && e.p.found === 1 && e.p.total === 3));

  // A found dog never barks again: the closest of the remaining ones does.
  run(game, 1);
  game.bark();
  const nearer = distance(game.player, b) < distance(game.player, c) ? b : c;
  assert.deepEqual(lastBark(), [nearer.id]);

  game.player = { x: b.x, y: b.y - 1, heading: 0 };
  game.update(DT, IDLE);
  game.player = { x: c.x + 0.5, y: c.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(game.state, GameState.WON);
  const r = events.find((e) => e.t === 'won').p;
  assert.equal(r.dogs, 3);
  assert.equal(r.foundTimes.length, 3);
});

test('restart keeps the chosen dogs and movement', () => {
  const { game } = newGame(8);
  game.startRound('medium', { dogCount: 2, movement: 'calm' });
  game.handleAction('restart');
  assert.equal(game.dogs.length, 2);
  assert.equal(game.options.movement, 'calm');
});

test('movement off: dogs stay put; calm/restless: they move, stay inside the map and out of trunks', () => {
  for (const movement of ['off', 'calm', 'restless']) {
    const { game } = newGame(11, CONFIG);
    game.startRound('hard', { dogCount: 2, movement });
    // Keep the player away from the dogs.
    const start = game.dogs.map((d) => ({ x: d.x, y: d.y }));
    for (let t = 0; t < 60; t += DT) {
      game.update(DT, IDLE);
      for (const d of game.dogs) {
        assert.ok(isInsideMap(d, CONFIG.map, CONFIG.dogs.radius - 1e-6));
        for (const tr of game.trees) assert.ok(distance(d, tr) >= tr.r + CONFIG.dogs.radius - 1e-3, 'dog inside a trunk');
      }
    }
    const moved = game.dogs.map((d, i) => distance(d, start[i]));
    if (movement === 'off') assert.ok(moved.every((m) => m === 0));
    else assert.ok(moved.some((m) => m > 0.5), `${movement} dogs should wander`);
  }
});

test('moving dogs tell the audio where they are; found dogs stop moving', () => {
  const { game, audio } = newGame(12);
  game.startRound('easy', { dogCount: 2, movement: 'restless' });
  run(game, 20);
  assert.ok(audio.calls.length && game.dogs.some((d) => d.state !== 'rest' || d.timer >= 0));
  const d = game.dogs[0];
  game.player = { x: d.x - 1, y: d.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(d.found, true);
  const at = { x: d.x, y: d.y };
  run(game, 20);
  assert.deepEqual({ x: d.x, y: d.y }, at);
});

test('shy dog runs away when approached, but a chasing player always catches it', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { game, events } = newGame(seed);
    game.startRound('easy', { dogCount: 1, movement: 'shy' });
    let fled = false;
    const startD = { ...game.dog };
    for (let t = 0; t < 120 && game.state === GameState.PLAYING; t += DT) {
      game.update(DT, chase(game, game.dog));
      if (distance(game.dog, startD) > 2) fled = true;
    }
    assert.equal(game.state, GameState.WON, `seed ${seed}: shy dog should be catchable`);
    assert.ok(fled, `seed ${seed}: shy dog should have run at least once`);
    assert.ok(events.some((e) => e.t === 'won'));
  }
});

test('updateDog: a shy dog flees from the player and then ignores them while it rests', () => {
  const cfg = CONFIG.dogs;
  const rng = seededRng(3);
  const dog = createDog({ x: 35, y: 35 }, 0, cfg, rng);
  const world = { player: { x: 33, y: 35 }, trees: [], map: CONFIG.map, cfg, mode: 'shy', rng };
  assert.equal(updateDog(dog, DT, world), 'flee');
  for (let i = 0; i < 60 * 10 && dog.state === 'flee'; i++) updateDog(dog, DT, world);
  assert.equal(dog.state, 'rest');
  assert.ok(dog.fled > 0);
  assert.ok(distance(dog, world.player) > 4);
  world.player = { x: dog.x - 1, y: dog.y };
  assert.equal(updateDog(dog, DT, world), null, 'tired: does not run again right away');
});

test('rain follows the difficulty: dry easy, light medium, heavy hard with bursts', () => {
  assert.equal(ambientProfile(CONFIG, 'easy').rain, null);
  assert.equal(ambientProfile(CONFIG, 'medium').rain.level, 'light');
  assert.equal(ambientProfile(CONFIG, 'hard').rain.level, 'heavy');
  const count = (key) => {
    const dir = new AmbientDirector(CONFIG.ambient, seededRng(4));
    dir.reset(ambientProfile(CONFIG, key));
    let n = 0;
    for (let t = 0; t < 120; t += DT) n += dir.update(DT, { x: 35, y: 35 }).filter((e) => e.type === 'rainBurst').length;
    return n;
  };
  assert.equal(count('easy'), 0);
  assert.equal(count('medium'), 0);
  assert.ok(count('hard') >= 4);
  const { game } = newGame(2);
  game.startRound('hard');
  assert.equal(game.rain, 'heavy');
});
