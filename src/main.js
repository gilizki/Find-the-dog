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
  dogCount: $('dogCount'),
  movement: $('movement'),
  movementHint: $('movementHint'),
  resultsTitle: $('resultsTitle'),
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

// ---- Start-screen choices (built from config.js, remembered in this browser) ----
const SETTINGS_KEY = 'findTheDog.settings';
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* private mode etc.: just not remembered */ }
}
const saved = loadSettings();

function addRadios(fieldset, name, options, selected) {
  for (const [value, text] of options) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = value;
    radio.checked = String(value) === String(selected);
    label.append(radio, ` ${text}`);
    fieldset.append(label);
  }
  if (!fieldset.querySelector('input:checked')) fieldset.querySelector('input').checked = true;
}
const picked = (fieldset) => fieldset.querySelector('input:checked')?.value;

const RAIN_TEXT = { none: 'dry', light: 'light rain', heavy: 'heavy rain' };
addRadios(el.difficulty, 'difficulty',
  Object.entries(CONFIG.difficulties).map(([key, d]) => [key, `${d.label} (${d.distance} m, ${RAIN_TEXT[d.rain ?? 'none']})`]),
  saved.difficulty in CONFIG.difficulties ? saved.difficulty : CONFIG.defaultDifficulty);
addRadios(el.dogCount, 'dogCount',
  Array.from({ length: CONFIG.dogs.maxCount }, (_, i) => [i + 1, String(i + 1)]),
  saved.dogCount ?? CONFIG.dogs.defaultCount);
const MOVEMENT = [
  ['off', 'No', 'The dogs stay where they are.'],
  ['calm', 'Calm', 'The dogs wander slowly and stop to sniff around.'],
  ['restless', 'Restless', 'The dogs move often and further. Bark again to keep track of them.'],
  ['shy', 'Shy', 'The dogs run away when you get close, then rest. Catch them while they rest.'],
];
addRadios(el.movement, 'movement', MOVEMENT.map(([k, t]) => [k, t]), saved.movement ?? CONFIG.dogs.defaultMovement);
const updateMovementHint = () => { el.movementHint.textContent = MOVEMENT.find(([k]) => k === picked(el.movement))?.[2] ?? ''; };
el.movement.addEventListener('change', updateMovementHint);
updateMovementHint();
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
  el.resultsTitle.textContent = r.dogs > 1 ? `🐕 You found all ${r.dogs} dogs!` : '🐕 You found the dog!';
  const rows = [
    ['Difficulty', `${r.difficulty} (${r.targetDistance} m, ${RAIN_TEXT[r.rain] ?? 'dry'})`],
    ['Dogs', `${r.dogs} · ${MOVEMENT.find(([k]) => k === r.movement)?.[1] ?? r.movement} movement`],
    ...(r.dogs > 1 ? r.foundTimes.map((t, i) => [`Dog ${i + 1} found at`, fmtTime(t)]) : []),
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
  const settings = {
    difficulty: picked(el.difficulty) ?? CONFIG.defaultDifficulty,
    dogCount: Number(picked(el.dogCount) ?? CONFIG.dogs.defaultCount),
    movement: picked(el.movement) ?? CONFIG.dogs.defaultMovement,
  };
  saveSettings(settings);
  el.startBtn.blur(); // so SPACE doesn't re-click the button
  input.clear();
  game.startRound(settings.difficulty, { dogCount: settings.dogCount, movement: settings.movement });
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
