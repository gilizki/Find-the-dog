import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Game, GameState } from '../src/game.js';
import { distance, forwardVector } from '../src/geometry.js';
import { Input } from '../src/input.js';
import { headingTriangle } from '../src/render.js';
import { recordingAudio, seededRng } from './helpers.js';

const DT = CONFIG.fixedStep;
const IDLE = { turn: 0, move: 0 };

/** Open field (no trees) for tests that place the player by hand and walk straight lines. */
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

test('round start: player and dog at the difficulty distance, random heading, listener synced', () => {
  const { game, audio } = newGame();
  const headings = new Set();
  for (const key of Object.keys(CONFIG.difficulties)) {
    for (let i = 0; i < 20; i++) {
      game.startRound(key);
      assert.equal(game.state, GameState.PLAYING);
      assert.ok(Math.abs(distance(game.player, game.dog) - CONFIG.difficulties[key].distance) <= CONFIG.placement.tolerance);
      headings.add(game.player.heading.toFixed(3));
    }
  }
  assert.ok(headings.size > 50, 'headings should vary');
  assert.ok(audio.count('setDog') > 0 && audio.count('setListener') > 0);
});

test('arrow-key turning matches the drawn heading: RIGHT turns clockwise on screen', () => {
  const { game } = newGame();
  const input = new Input();
  game.startRound('medium');
  game.player = { x: 35, y: 35, heading: -Math.PI / 2 }; // facing screen-up (north)
  game.dog = { x: 0.1, y: 0.1 }; // far away, irrelevant

  input.keyDown('ArrowRight');
  assert.equal(input.controls().turn, 1);
  run(game, 90 / CONFIG.player.turnSpeedDeg, input.controls()); // turn ~90°
  input.keyUp('ArrowRight');

  // After turning right from north, the player must face east (screen right)...
  const f = forwardVector(game.player.heading);
  assert.ok(f.x > 0.99 && Math.abs(f.y) < 0.1, `forward after right turn: ${JSON.stringify(f)}`);
  // ...and the triangle the renderer draws must point the same way (tip to the right of the centre).
  const [tip] = headingTriangle(100, 100, game.player.heading, 10);
  assert.ok(tip.x > 115 && Math.abs(tip.y - 100) < 3, `tip ${JSON.stringify(tip)}`);

  // Walking forward now moves the player to screen-right.
  const x0 = game.player.x;
  input.keyDown('KeyW');
  run(game, 1, input.controls());
  assert.ok(game.player.x > x0 + 1);

  // LEFT (A) turns counter-clockwise: back to north = screen up (tip above the centre).
  input.keyUp('KeyW');
  input.keyDown('KeyA');
  run(game, 90 / CONFIG.player.turnSpeedDeg, input.controls());
  const [tip2] = headingTriangle(100, 100, game.player.heading, 10);
  assert.ok(tip2.y < 85 && Math.abs(tip2.x - 100) < 3, `tip ${JSON.stringify(tip2)}`);
});

test('dog only barks on request, with a cooldown', () => {
  const { game, audio } = newGame();
  game.startRound('easy');
  run(game, 10); // idle: never barks on its own
  assert.equal(audio.count('bark'), 0);

  assert.equal(game.handleAction('bark'), true);
  assert.equal(game.handleAction('bark'), false); // immediately again: blocked
  run(game, CONFIG.rules.barkCooldown * 0.8);
  assert.equal(game.handleAction('bark'), false);
  run(game, CONFIG.rules.barkCooldown * 0.3);
  assert.equal(game.handleAction('bark'), true);
  assert.equal(audio.count('bark'), 2);
  assert.equal(game.stats.barks, 2);
});

test('holding SPACE (key repeat) queues only one bark', () => {
  const input = new Input();
  input.keyDown('Space');
  input.keyDown('Space', true);
  input.keyDown('Space', true);
  assert.deepEqual(input.consumeActions(), ['bark']);
});

test('walking into a wall stops the player and plays a rate-limited bump', () => {
  const { game, audio } = newGame();
  game.startRound('easy');
  game.player = { x: 5, y: 30, heading: Math.PI }; // facing west
  game.dog = { x: 60, y: 60 };
  run(game, 6, { turn: 0, move: 1 });
  assert.ok(Math.abs(game.player.x - CONFIG.player.radius) < 1e-9);
  const bumps = audio.count('bump');
  assert.ok(bumps >= 2 && bumps <= Math.ceil(3.5 / CONFIG.rules.bumpCooldown) + 1, `bumps: ${bumps}`);
  // Only real movement counts as walked distance.
  assert.ok(Math.abs(game.stats.walked - (5 - CONFIG.player.radius)) < 1e-6);
});

test('footsteps follow stride length', () => {
  const { game, audio } = newGame();
  game.startRound('easy');
  game.player = { x: 10, y: 35, heading: 0 };
  game.dog = { x: 10, y: 5 };
  run(game, 5, { turn: 0, move: 1 }); // 7 m
  assert.equal(game.stats.steps, Math.floor(7 / CONFIG.player.strideLength + 1e-6));
  assert.equal(audio.count('footstep'), game.stats.steps);
});

test('win: reaching the dog ends the round with correct results and cues', () => {
  const { game, audio, events } = newGame();
  game.startRound('easy');
  game.player = { x: 10, y: 30, heading: 0 }; // facing east
  game.dog = { x: 20, y: 30 };
  game.stats.optimal = 10;
  game.handleAction('bark');
  run(game, 10, { turn: 0, move: 1 });

  assert.equal(game.state, GameState.WON);
  assert.ok(distance(game.player, game.dog) <= CONFIG.rules.winRadius);
  assert.ok(distance(game.player, game.dog) > CONFIG.rules.winRadius - 0.1, 'stops as soon as it is within the radius');
  const won = events.find((e) => e.t === 'won');
  assert.ok(won);
  const r = won.p;
  assert.equal(r.barks, 1);
  assert.equal(r.optimal, 10);
  assert.ok(Math.abs(r.walked - (10 - CONFIG.rules.winRadius)) < 0.05);
  assert.ok(r.efficiency > 0.99);
  assert.ok(r.time > 0 && r.time < 10);
  assert.equal(r.revealUsed, false);
  assert.equal(audio.count('endCue'), 1);
  assert.equal(audio.count('winJingle'), 1);
  assert.equal(game.showSolution, true, 'path and dog are shown after the round');

  // Nothing moves after winning.
  const pos = { ...game.player };
  run(game, 1, { turn: 1, move: 1 });
  assert.deepEqual(game.player, pos);
  assert.equal(game.handleAction('bark'), false);
});

test('reveal (H) usage is recorded in the results, even if toggled off again', () => {
  const { game, events } = newGame();
  game.startRound('easy');
  assert.equal(game.showSolution, false, 'dog hidden by default');
  game.handleAction('reveal');
  assert.equal(game.showSolution, true);
  game.handleAction('reveal');
  assert.equal(game.showSolution, false);
  game.player = { x: game.dog.x - 1.4, y: game.dog.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(game.state, GameState.WON);
  assert.equal(events.find((e) => e.t === 'won').p.revealUsed, true);

  // New round resets it.
  game.handleAction('restart');
  assert.equal(game.stats.revealUsed, false);
  assert.equal(game.reveal, false);
});

test('cue toggles: start/end cues can be disabled', () => {
  const { game, audio } = newGame();
  game.cues = { startCue: false, endCue: false };
  game.startRound('easy');
  game.player = { x: game.dog.x, y: game.dog.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(audio.count('startCue'), 0);
  assert.equal(audio.count('endCue'), 0);
  assert.equal(audio.count('winJingle'), 1);
});

test('trees: walking into a trunk plays a rate-limited tree thud, counted separately from walls', () => {
  const { game, audio } = newGame(4, CONFIG);
  game.startRound('easy');
  game.trees = [{ x: 20, y: 30, r: 0.5 }];
  game.dog = { x: 60, y: 60 };
  game.player = { x: 17, y: 30, heading: 0 }; // facing the trunk, head-on
  run(game, 6, { turn: 0, move: 1 });
  assert.ok(Math.abs(game.player.x - (20 - 0.5 - CONFIG.player.radius)) < 1e-3, 'stopped at the trunk');
  const thuds = audio.count('treeBump');
  assert.ok(thuds >= 2 && thuds <= Math.ceil(4 / CONFIG.rules.bumpCooldown) + 1, `thuds ${thuds}`);
  assert.equal(game.stats.treeBumps, thuds);
  assert.equal(game.stats.wallBumps, 0);
  assert.equal(audio.count('bump'), 0);
  assert.equal(game.results().treeBumps, thuds);
});

test('trees: walking at a trunk off-centre slides around it; glancing contact is silent', () => {
  for (const [offset, maxBumps] of [[0.6, 0], [0.25, 3]]) {
    const { game, audio } = newGame(4, CONFIG);
    game.startRound('easy');
    game.trees = [{ x: 20, y: 30, r: 0.5 }];
    game.dog = { x: 60, y: 60 };
    game.player = { x: 17, y: 30 - offset, heading: 0 };
    run(game, 6, { turn: 0, move: 1 });
    assert.ok(game.player.x > 21, `offset ${offset}: slid past, x = ${game.player.x.toFixed(2)}`);
    assert.ok(audio.count('treeBump') <= maxBumps, `offset ${offset}: ${audio.count('treeBump')} bumps`);
  }
});

test('vision memory: with rememberSeen, trees that entered the window are remembered', () => {
  const cfg = structuredClone(OPEN_FIELD);
  cfg.vision.rememberSeen = true;
  const { game } = newGame(2, cfg);
  game.startRound('easy');
  game.trees = [{ x: 20.9, y: 30, r: 0.4 }, { x: 40, y: 40, r: 0.4 }];
  game.player = { x: 20, y: 30, heading: Math.PI }; // facing away
  game.update(DT, IDLE);
  game._updateSeen();
  assert.equal(game.seenTrees.size, 0);
  run(game, 180 / CONFIG.player.turnSpeedDeg + 0.05, { turn: 1, move: 0 }); // turn around
  assert.ok(game.seenTrees.has(0) && !game.seenTrees.has(1));
});

test('ambient: starts with the round, events flow while playing, stops on win; B mute is recorded', () => {
  const { game, audio, events } = newGame(6);
  game.startRound('hard');
  assert.equal(audio.count('ambientStart'), 1);
  run(game, 20);
  assert.ok(audio.count('ambientEvent') > 3, 'gusts/birds scheduled');
  assert.equal(game.handleAction('ambient'), true);
  assert.equal(game.ambientMuted, true);
  assert.deepEqual(audio.calls.filter((c) => c.name === 'setAmbientMuted').at(-1).args, [true]);
  game.player = { x: game.dog.x - 1, y: game.dog.y, heading: 0 };
  game.update(DT, IDLE);
  assert.equal(game.state, GameState.WON);
  assert.equal(audio.count('ambientStop'), 1);
  const r = events.find((e) => e.t === 'won').p;
  assert.equal(r.ambientMutedUsed, true);
  const before = audio.count('ambientEvent');
  run(game, 20);
  assert.equal(audio.count('ambientEvent'), before, 'no new ambient events after the round');
  // Mute persists into the next round and is recorded there too.
  game.handleAction('restart');
  assert.equal(game.stats.ambientMutedUsed, true);
  game.handleAction('ambient');
  game.handleAction('restart');
  assert.equal(game.stats.ambientMutedUsed, false);
});

test('round start with trees: the forest is generated and handed to the audio for occlusion', () => {
  const { game, audio } = newGame(8, CONFIG);
  game.startRound('hard');
  assert.ok(game.trees.length > 100);
  const call = audio.calls.find((c) => c.name === 'setForest');
  assert.equal(call.args[0], game.trees);
  assert.equal(call.args[1], CONFIG.trees.occlusion);
});

test('restart gives new positions; menu returns to MENU', () => {
  const { game, events } = newGame(99);
  game.startRound('medium');
  const first = { ...game.dog };
  game.handleAction('restart');
  assert.notDeepEqual(game.dog, first);
  game.handleAction('menu');
  assert.equal(game.state, GameState.MENU);
  assert.ok(events.some((e) => e.t === 'menu'));
  assert.equal(game.handleAction('bark'), false);
});
