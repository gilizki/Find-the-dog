// Entry point: wires DOM, input, audio, game and renderer together.

import { CONFIG, GAME_TITLE, validateConfig } from './config.js';
import { AudioEngine } from './audio.js';
import { Game, GameState, runLoop } from './game.js';
import { Input } from './input.js';
import { createRenderer } from './render.js';

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('view'),
  menu: $('menu'),
  results: $('results'),
  resultList: $('resultList'),
  difficulty: $('difficulty'),
  cueStart: $('cueStart'),
  cueEnd: $('cueEnd'),
  startBtn: $('startBtn'),
  testBtn: $('testBtn'),
  testHint: $('testHint'),
  barkBtn: $('barkBtn'),
  barkStatus: $('barkStatus'),
  againBtn: $('againBtn'),
  menuBtn: $('menuBtn'),
  error: $('error'),
};

document.title = GAME_TITLE;

function showError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
}

const problems = validateConfig(CONFIG);
if (problems.length) {
  console.error('Config problems:', problems);
  showError(`Config problems: ${problems.join('; ')}`);
}

// Difficulty radio buttons come from config.js
for (const [key, d] of Object.entries(CONFIG.difficulties)) {
  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'difficulty';
  radio.value = key;
  radio.checked = key === CONFIG.defaultDifficulty;
  label.append(radio, ` ${d.label} (${d.distance} m)`);
  el.difficulty.append(label);
}
el.cueStart.checked = CONFIG.cues.startCue;
el.cueEnd.checked = CONFIG.cues.endCue;

const audio = new AudioEngine(CONFIG.audio, CONFIG.ambient);

const SETS = [['barks', 'Bark'], ['ambient', 'Wind/forest loops'], ['birds', 'Birds']];

function describeAudio(status) {
  el.barkStatus.textContent = SETS.map(([key, label]) => {
    const s = status[key];
    const failed = s.failed.length ? `, ${s.failed.length} failed (see console)` : '';
    return `${label}: ${s.loaded ? `${s.loaded} recording(s)` : 'synthesized'}${failed}`;
  }).join(' · ');
}

// Start downloading recordings right away; decoding happens on the first click (needs the AudioContext).
audio.preload().then((counts) => {
  if (!audio.ctx) {
    el.barkStatus.textContent = SETS.map(([key, label]) => `${label}: ${counts[key] ? `${counts[key]} file(s) found` : 'synthesized'}`).join(' · ');
  }
});

const input = new Input();
input.attach(window);
const renderer = createRenderer(el.canvas, CONFIG, { getAudioLevels: () => (audio.ctx ? audio.levels() : null) });

const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${(s % 60).toFixed(1)} s`);

function showResults(r) {
  const rows = [
    ['Difficulty', `${r.difficulty} (${r.targetDistance} m)`],
    ['Time', fmtTime(r.time)],
    ['Barks used', r.barks],
    ['Steps', r.steps],
    ['Distance walked', `${r.walked.toFixed(1)} m`],
    ['Optimal (straight line)', `${r.optimal.toFixed(1)} m`],
    ['Path efficiency', `${Math.round(r.efficiency * 100)} %`],
    ['Wall bumps', r.wallBumps],
    ['Tree bumps', r.treeBumps],
    ['Reveal (H) used', r.revealUsed ? 'Yes' : 'No', r.revealUsed],
    ['Ambient muted (B) used', r.ambientMutedUsed ? 'Yes' : 'No', r.ambientMutedUsed],
  ];
  el.resultList.replaceChildren(
    ...rows.flatMap(([k, v, flag]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      if (flag) dd.className = 'flag';
      return [dt, dd];
    }),
  );
  el.results.title = `Efficiency = (optimal - ${CONFIG.rules.winRadius} m win radius) / distance walked`;
  el.results.hidden = false;
}

const game = new Game({
  config: CONFIG,
  audio,
  onEvent(type, payload) {
    if (type === 'roundStart') {
      el.menu.hidden = true;
      el.results.hidden = true;
    } else if (type === 'won') {
      showResults(payload);
    } else if (type === 'menu') {
      el.results.hidden = true;
      el.menu.hidden = false;
      el.startBtn.focus();
    }
  },
});

async function ensureAudio() {
  try {
    describeAudio(await audio.init()); // called inside a click handler -> satisfies autoplay policy
    return true;
  } catch (err) {
    console.error(err);
    showError(`Audio could not start: ${err.message}`);
    return false;
  }
}

el.startBtn.addEventListener('click', async () => {
  if (!(await ensureAudio())) return;
  game.cues.startCue = el.cueStart.checked;
  game.cues.endCue = el.cueEnd.checked;
  const key = el.difficulty.querySelector('input[name="difficulty"]:checked')?.value ?? CONFIG.defaultDifficulty;
  el.startBtn.blur(); // so SPACE doesn't re-click the button
  input.clear();
  game.startRound(key);
});

el.testBtn.addEventListener('click', async () => {
  if (!(await ensureAudio())) return;
  audio.stereoTest();
  el.testHint.textContent = 'You should hear a bark in your LEFT ear, then in your RIGHT ear. If reversed, swap your headphones.';
});

el.barkBtn.addEventListener('click', async () => {
  if (!(await ensureAudio())) return;
  audio.testBark();
});

el.againBtn.addEventListener('click', (e) => {
  e.currentTarget.blur();
  game.startRound();
});
el.menuBtn.addEventListener('click', () => game.toMenu());

// Enter starts from the menu.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && game.state === GameState.MENU && !el.menu.hidden && document.activeElement?.tagName !== 'BUTTON') {
    el.startBtn.click();
  }
});

runLoop({ game, input, render: () => renderer.render(game) });

// Handy for tuning from the dev console.
Object.assign(window, { game, audio, CONFIG });
