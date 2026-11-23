// Spatial audio engine (Web Audio API). The ONLY module that touches AudioContext.
// Game -> audio parameter mapping lives in audioMapping.js; sound synthesis in sounds.js.
//
// Graph:
//   bark source -> lowpass (distance + rear muffle) -> rearGain -> PannerNode(HRTF, inverse) -> dogBus ┐
//   footsteps / bump (non-spatial)                                                     -> sfxBus ──┤-> master -> limiter -> out
//   start/end cues, win jingle (non-spatial)                                           -> cueBus ──┤
//   forest ambience (ambient.js: bed + spatial gusts/birds, fades, mute)            -> ambient ──┘
//   bark = random recorded sample (never repeated back-to-back) or freshly synthesized fallback
//   Analysers on the dog bus and the ambient output feed the bark-vs-ambient readout (H overlay).

import { CONFIG } from './config.js';
import { computeDogParams, gainToDb, listenerOrientation, toAudioPosition } from './audioMapping.js';
import * as synth from './sounds.js';
import { barkVariation, downmixToMono, normalizeChannelsRms, normalizeLoudness, pickIndex, prepareBark } from './samples.js';
import { decodeAssetSet, fetchAssetSet } from './assetLoader.js';
import { AmbientAudio } from './ambient.js';

function setParam(param, value, ctx, tau, snap) {
  const t = ctx.currentTime;
  if (snap) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(value, t);
  } else {
    param.setTargetAtTime(value, t, tau);
  }
}

export class AudioEngine {
  constructor(cfg = CONFIG.audio, ambientCfg = CONFIG.ambient) {
    this.cfg = cfg;
    this.ambientCfg = ambientCfg;
    this.ctx = null;
    this.player = null;
    this.dog = null;
    this.trees = [];
    this.occlusionCfg = null;
    this.lastDogParams = null;
    this.barkSamples = [];      // decoded + processed mono AudioBuffers
    this.lastBarkIndex = -1;
    const none = { source: 'synth', loaded: 0, failed: [] };
    this.status = { barks: { ...none }, ambient: { ...none }, birds: { ...none } };
    this._fetched = null;
    this._levels = { barkPeakDb: -Infinity, ambientDb: -Infinity, barkAt: -1 };
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Back-compat: bark status only. */
  get barkStatus() {
    return this.status.barks;
  }

  /**
   * Downloads bark, ambient and bird files at page load (no AudioContext needed, so no autoplay warnings).
   * Resolves to the number of files fetched per set.
   */
  preload() {
    const c = this.cfg;
    this._fetched ??= {
      barks: fetchAssetSet({ urls: c.barkUrls ?? [], manifestUrl: c.barkManifestUrl, label: 'bark' }),
      ambient: fetchAssetSet({ urls: c.ambientUrls ?? [], manifestUrl: c.ambientManifestUrl, label: 'ambient loop' }),
      birds: fetchAssetSet({ urls: c.birdUrls ?? [], manifestUrl: c.birdManifestUrl, label: 'bird' }),
    };
    const f = this._fetched;
    return Promise.all([f.barks, f.ambient, f.birds]).then(([b, a, r]) => ({ barks: b.files.length, ambient: a.files.length, birds: r.files.length }));
  }

  /** Must be called from a user gesture (click/keypress) to satisfy browser autoplay policies. */
  async init() {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('This browser does not support the Web Audio API.');
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this._buildGraph();
      this._buildBuffers();
      this.ambient.buildProcedural();
      await this._decodeAll();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.status;
  }

  async _decodeAll() {
    this.preload();
    const proc = this.cfg.barkProcessing;
    const whole = { ...proc, rmsWindowMs: 1e9 };
    const [barks, loops, birds] = await Promise.all([
      this._fetched.barks.then((f) => decodeAssetSet(this.ctx, f, (ch, sr) => [prepareBark(ch, sr, proc)], 'bark')),
      // Loops: keep stereo for the non-spatial bed (whole-file RMS), plus a mono copy for spatial gusts.
      this._fetched.ambient.then((f) => decodeAssetSet(this.ctx, f, (ch) => normalizeChannelsRms(ch.slice(0, 2), whole), 'ambient loop')),
      this._fetched.birds.then((f) => decodeAssetSet(this.ctx, f, (ch, sr) => [prepareBark(ch, sr, proc)], 'bird')),
    ]);
    this.barkSamples = barks.items.map((it) => this._toBuffer(it.channels[0], it.sampleRate));
    this.ambient.setRecordings({
      loops: loops.items.map((it) => ({ ...it, mono: normalizeLoudness(downmixToMono(it.channels), it.sampleRate, whole) })),
      birds: birds.items,
    });
    const st = (set, n) => ({ source: n ? 'samples' : 'synth', loaded: n, failed: set.failed });
    this.status = { barks: st(barks, barks.items.length), ambient: st(loops, loops.items.length), birds: st(birds, birds.items.length) };
  }

  _buildGraph() {
    const c = this.ctx;
    const cfg = this.cfg;
    this.master = new GainNode(c, { gain: cfg.masterGain });
    this.limiter = new DynamicsCompressorNode(c, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.master.connect(this.limiter).connect(c.destination);

    this.dogFilter = new BiquadFilterNode(c, { type: 'lowpass', frequency: cfg.lowpass.nearHz, Q: cfg.lowpass.Q });
    this.dogRearGain = new GainNode(c, { gain: 1 });
    this.panner = new PannerNode(c, {
      panningModel: cfg.panningModel,
      distanceModel: cfg.distanceModel,
      refDistance: cfg.refDistance,
      rolloffFactor: cfg.rolloffFactor,
      maxDistance: cfg.maxDistance,
      coneInnerAngle: 360,
      coneOuterAngle: 360,
      // Safety net: force a mono input even if a stereo buffer ever slips through.
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.dogBus = new GainNode(c, { gain: cfg.dogGain });
    this.dogFilter.connect(this.dogRearGain).connect(this.panner).connect(this.dogBus).connect(this.master);

    this.sfxBus = new GainNode(c, { gain: cfg.sfxGain });
    this.sfxBus.connect(this.master);
    this.cueBus = new GainNode(c, { gain: cfg.cueGain });
    this.cueBus.connect(this.master);

    this.ambient = new AmbientAudio(c, this.master, { ambientCfg: this.ambientCfg, audioCfg: cfg });

    // Meters for the bark-vs-ambient readout (both measured before the common master gain).
    this.dogMeter = new AnalyserNode(c, { fftSize: 2048 });
    this.ambientMeter = new AnalyserNode(c, { fftSize: 2048 });
    this.dogBus.connect(this.dogMeter);
    this.ambient.output.connect(this.ambientMeter);
    this._meterBuf = new Float32Array(2048);
  }

  _rmsDb(analyser) {
    analyser.getFloatTimeDomainData(this._meterBuf);
    let s = 0;
    for (const v of this._meterBuf) s += v * v;
    return gainToDb(Math.sqrt(s / this._meterBuf.length));
  }

  /** Sampled every simulation step: peak short-term level of the last bark, smoothed ambient level. */
  _meter() {
    const L = this._levels;
    const bark = this._rmsDb(this.dogMeter);
    if (this.ctx.currentTime - L.barkAt < 1.5) L.barkPeakDb = Math.max(L.barkPeakDb, bark);
    const amb = this._rmsDb(this.ambientMeter);
    L.ambientDb = Number.isFinite(L.ambientDb) ? 10 * Math.log10(0.95 * 10 ** (L.ambientDb / 10) + 0.05 * 10 ** (amb / 10)) : amb;
    L.ambientNowDb = amb;
  }

  /** Live levels (dBFS before master) for the debug overlay. */
  levels() {
    const L = this._levels;
    return { barkPeakDb: L.barkPeakDb, ambientDb: L.ambientDb, ambientNowDb: L.ambientNowDb ?? -Infinity, marginDb: L.barkPeakDb - L.ambientDb };
  }

  _toBuffer(samples, sampleRate = this.ctx.sampleRate) {
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    return buf;
  }

  _buildBuffers() {
    const sr = this.ctx.sampleRate;
    this.buffers = {
      footsteps: Array.from({ length: this.cfg.footstepVariants }, () => this._toBuffer(synth.synthFootstep(sr))),
      bump: this._toBuffer(synth.synthBump(sr)),
      treeThuds: Array.from({ length: 3 }, () => this._toBuffer(synth.synthTreeThud(sr))),
      startCue: this._toBuffer(synth.synthStartCue(sr)),
      endCue: this._toBuffer(synth.synthEndCue(sr)),
      win: this._toBuffer(synth.synthWinJingle(sr)),
    };
  }

  /**
   * The next bark to play: a random recorded sample (never the same one twice in a row), or, if
   * no recordings loaded, a freshly synthesized bark (randomized each time). Both are mono and
   * loudness-normalized the same way, so distance cues stay consistent.
   */
  _nextBarkBuffer(synthOverrides = {}) {
    if (this.barkSamples.length) {
      this.lastBarkIndex = pickIndex(this.barkSamples.length, this.lastBarkIndex);
      return this.barkSamples[this.lastBarkIndex];
    }
    const sr = this.ctx.sampleRate;
    const raw = synth.synthBark(sr, { ...this.cfg.synthBark, ...synthOverrides });
    return this._toBuffer(prepareBark([raw], sr, this.cfg.barkProcessing));
  }

  _play(buffer, destination, { gain = 1, rate = 1, delay = 0 } = {}) {
    if (!this.ctx || !buffer) return;
    const src = new AudioBufferSourceNode(this.ctx, { buffer, playbackRate: rate });
    const g = new GainNode(this.ctx, { gain });
    src.connect(g).connect(destination);
    src.start(this.ctx.currentTime + delay);
    src.onended = () => g.disconnect();
  }

  // ---- spatial state -------------------------------------------------------

  setDog(dog) {
    this.dog = { x: dog.x, y: dog.y };
    if (!this.ctx) return;
    const p = toAudioPosition(dog.x, dog.y);
    const P = this.panner;
    if (P.positionX) {
      setParam(P.positionX, p.x, this.ctx, 0, true);
      setParam(P.positionY, p.y, this.ctx, 0, true);
      setParam(P.positionZ, p.z, this.ctx, 0, true);
    } else {
      P.setPosition(p.x, p.y, p.z);
    }
    this._updateDogTone(true);
  }

  /** Call every frame with the player's position + heading. */
  setListener(player, { snap = false } = {}) {
    this.player = { x: player.x, y: player.y, heading: player.heading };
    if (!this.ctx) return;
    const p = toAudioPosition(player.x, player.y);
    const { forward: f, up: u } = listenerOrientation(player.heading);
    const L = this.ctx.listener;
    const tau = this.cfg.smoothing;
    if (L.positionX) {
      setParam(L.positionX, p.x, this.ctx, tau, snap);
      setParam(L.positionY, p.y, this.ctx, tau, snap);
      setParam(L.positionZ, p.z, this.ctx, tau, snap);
      setParam(L.forwardX, f.x, this.ctx, tau, snap);
      setParam(L.forwardY, f.y, this.ctx, tau, snap);
      setParam(L.forwardZ, f.z, this.ctx, tau, snap);
      setParam(L.upX, u.x, this.ctx, tau, snap);
      setParam(L.upY, u.y, this.ctx, tau, snap);
      setParam(L.upZ, u.z, this.ctx, tau, snap);
    } else {
      // Older Firefox/Safari: no AudioParams on the listener.
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    this._updateDogTone(snap);
    this._meter();
  }

  /** Trees for occlusion of the bark. */
  setForest(trees, occlusionCfg) {
    this.trees = trees ?? [];
    this.occlusionCfg = occlusionCfg ?? null;
    this._updateDogTone(true);
  }

  _updateDogTone(snap) {
    if (!this.dog || !this.player) return;
    const params = computeDogParams(this.player, this.dog, this.cfg, { trees: this.trees, occlusion: this.occlusionCfg });
    this.lastDogParams = params;
    if (!this.ctx) return;
    setParam(this.dogFilter.frequency, params.cutoffHz, this.ctx, this.cfg.smoothing, snap);
    setParam(this.dogRearGain.gain, params.toneGain, this.ctx, this.cfg.smoothing, snap);
  }

  // ---- ambience (facade over ambient.js) ----------------------------------

  ambientStart(profile) {
    this.ambient?.start(profile);
  }

  ambientStop() {
    this.ambient?.stop();
  }

  ambientEvent(ev) {
    this.ambient?.play(ev);
  }

  setAmbientMuted(muted) {
    this.ambient?.setMuted(muted);
  }

  // ---- one-shot sounds -----------------------------------------------------

  /** The dog's bark: goes through the distance/rear filter and the HRTF panner. */
  bark() {
    if (!this.ctx) return;
    const { rate, gain } = barkVariation(this.cfg.barkVariation);
    this._play(this._nextBarkBuffer(), this.dogFilter, { rate, gain });
    this._levels.barkAt = this.ctx.currentTime;
    this._levels.barkPeakDb = -Infinity;
  }

  /** One bark, centred and non-spatial, for judging the sound from the start screen. */
  testBark() {
    if (!this.ctx) return;
    const { rate, gain } = barkVariation(this.cfg.barkVariation);
    this._play(this._nextBarkBuffer(), this.master, { rate, gain: gain * this.cfg.dogGain * 0.7 });
  }

  footstep() {
    if (!this.ctx) return;
    const { rate, gain } = this.cfg.footstepJitter;
    const list = this.buffers.footsteps;
    this._play(list[Math.floor(Math.random() * list.length)], this.sfxBus, {
      rate: 1 + (Math.random() * 2 - 1) * rate,
      gain: 1 - Math.random() * gain,
    });
  }

  bump() {
    this._play(this.buffers?.bump, this.sfxBus, { gain: this.cfg.bumpGain });
  }

  /** Soft woody thud for a tree: centred, fixed level (carries no information about the dog). */
  treeBump() {
    if (!this.ctx) return;
    const list = this.buffers.treeThuds;
    this._play(list[Math.floor(Math.random() * list.length)], this.sfxBus, { gain: this.cfg.treeBumpGain, rate: 0.95 + Math.random() * 0.1 });
  }

  startCue() {
    this._play(this.buffers?.startCue, this.cueBus);
  }

  endCue() {
    this._play(this.buffers?.endCue, this.cueBus);
  }

  winJingle({ delay = 0 } = {}) {
    if (!this.ctx) return;
    this._play(this.buffers.win, this.cueBus, { gain: 1.4, delay });
    // Two happy barks on top: recordings pitched up a little, or a high synthesized "yip".
    for (const [i, at] of [0.5, 0.72].entries()) {
      const buffer = this._nextBarkBuffer({ pitchScale: 1.7, durationMs: [90, 120], doublePulseChance: 0 });
      this._play(buffer, this.cueBus, { gain: 1.2 - i * 0.2, rate: this.barkSamples.length ? 1.2 : 1, delay: delay + at });
    }
  }

  /** Plays a bark hard-left, then hard-right, to check headphones are on the right way round. */
  stereoTest() {
    if (!this.ctx) return;
    [-1, 1].forEach((pan, i) => {
      const src = new AudioBufferSourceNode(this.ctx, { buffer: this._nextBarkBuffer() });
      const panner = new StereoPannerNode(this.ctx, { pan });
      const g = new GainNode(this.ctx, { gain: 0.6 });
      src.connect(panner).connect(g).connect(this.master);
      src.start(this.ctx.currentTime + i * 0.8);
    });
  }
}
