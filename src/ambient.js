// Ambient audio renderer (Web Audio). Plays what AmbientDirector schedules; knows nothing about the dog.
//
//   base bed (stereo loop, non-spatial) ─► bedGain ─┐
//   gust  (mono) ─► envelope gain ─► PannerNode (HRTF, no distance loss, drifting) ─┤
//   bird  (mono) ─► gain ─► PannerNode (HRTF, inverse distance, maybe flying)      ─┼─► fadeBus ─► muteGain ─► (out)
//   crickets (optional stereo loop, non-spatial) ─► cricketGain ────────────────────┘

import { toAudioPosition } from './audioMapping.js';
import * as synth from './sounds.js';
import { normalizeLoudness } from './samples.js';

const dbToGain = (db) => Math.pow(10, db / 20);

export class AmbientAudio {
  constructor(ctx, destination, { ambientCfg, audioCfg }) {
    this.ctx = ctx;
    this.cfg = ambientCfg;
    this.audioCfg = audioCfg;
    this.fadeBus = new GainNode(ctx, { gain: 0 });
    this.muteGain = new GainNode(ctx, { gain: 1 });
    this.fadeBus.connect(this.muteGain).connect(destination);
    this.output = this.muteGain;
    this.bedGain = new GainNode(ctx, { gain: 0 });
    this.bedGain.connect(this.fadeBus);
    this.cricketGain = new GainNode(ctx, { gain: 0 });
    this.cricketGain.connect(this.fadeBus);
    this.loops = [];      // recorded beds: stereo AudioBuffers
    this.gustSources = []; // recorded loops as mono AudioBuffers (gust material)
    this.birds = [];      // recorded birds: mono AudioBuffers
    this.profile = null;
    this.active = new Set();
  }

  _buffer(channels, sampleRate = this.ctx.sampleRate) {
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(c, i));
    return buf;
  }

  buildProcedural() {
    const sr = this.ctx.sampleRate;
    const proc = this.audioCfg.barkProcessing;
    const rand = ([a, b]) => a + Math.random() * (b - a);
    const whole = { ...proc, rmsWindowMs: 1e9 }; // whole-file RMS for continuous material
    this.synthBed = this._buffer(synth.synthWindBed(sr).map((c) => normalizeLoudness(c, sr, whole)));
    this.synthGusts = Array.from({ length: this.cfg.gusts.variants }, () =>
      this._buffer([normalizeLoudness(synth.synthGust(sr, { duration: rand(this.cfg.gusts.durationSec) }), sr, proc)]));
    this.synthBirds = Array.from({ length: this.cfg.birds.variants }, () =>
      this._buffer([normalizeLoudness(synth.synthBirdChirp(sr), sr, proc)]));
    if (this.cfg.crickets?.enabled) {
      this.synthCricketBed = this._buffer(synth.synthCrickets(sr).map((c) => normalizeLoudness(c, sr, whole)));
    }
  }

  /** loops: [{channels (stereo-or-mono, RMS-normalized), mono, sampleRate}], birds: [{channels:[mono], sampleRate}] */
  setRecordings({ loops = [], birds = [] }) {
    this.loops = loops.map((l) => this._buffer(l.channels.length === 1 ? [l.channels[0], l.channels[0]] : l.channels.slice(0, 2), l.sampleRate));
    this.gustSources = loops.map((l) => this._buffer([l.mono], l.sampleRate));
    this.birds = birds.map((b) => this._buffer(b.channels, b.sampleRate));
  }

  _startLoop(buffer, gainNode, db) {
    const src = new AudioBufferSourceNode(this.ctx, { buffer, loop: true });
    src.connect(gainNode);
    src.start(this.ctx.currentTime, Math.random() * buffer.duration);
    gainNode.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.1);
    return src;
  }

  /** Round start: (re)start the bed at this difficulty's level and fade everything in. */
  start(profile) {
    this.profile = profile;
    const t = this.ctx.currentTime;
    if (!this.bedSource) {
      const loop = this.loops.length ? this.loops[Math.floor(Math.random() * this.loops.length)] : this.synthBed;
      this.bedSource = this._startLoop(loop, this.bedGain, profile.bedDb);
    } else {
      this.bedGain.gain.setTargetAtTime(dbToGain(profile.bedDb), t, 0.1);
    }
    if (this.synthCricketBed && !this.cricketSource) this.cricketSource = this._startLoop(this.synthCricketBed, this.cricketGain, this.cfg.crickets.db);
    const g = this.fadeBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.cfg.masterGain, t + this.cfg.fadeInSec);
  }

  /** Win screen / menu: fade out; running one-shots are cut when the fade is done. */
  stop() {
    this.profile = null;
    const t = this.ctx.currentTime;
    const g = this.fadeBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + this.cfg.fadeOutSec);
    for (const src of this.active) {
      try { src.stop(t + this.cfg.fadeOutSec + 0.05); } catch { /* already stopped */ }
    }
  }

  setMuted(muted) {
    this.muteGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, this.cfg.muteRampSec / 3);
  }

  _panner({ distanceLoss }) {
    const a = this.audioCfg;
    return new PannerNode(this.ctx, {
      panningModel: a.panningModel,
      distanceModel: 'inverse',
      refDistance: a.refDistance,
      rolloffFactor: distanceLoss ? a.rolloffFactor : 0,
      maxDistance: a.maxDistance,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
  }

  _move(panner, from, to, t0, dur) {
    const a = toAudioPosition(from.x, from.y, from.h ?? 0);
    const b = toAudioPosition(to.x, to.y, to.h ?? 0);
    if (panner.positionX) {
      for (const k of ['x', 'y', 'z']) {
        const p = panner[`position${k.toUpperCase()}`];
        p.setValueAtTime(a[k], t0);
        if (dur > 0) p.linearRampToValueAtTime(b[k], t0 + dur);
      }
    } else {
      panner.setPosition(a.x, a.y, a.z);
    }
  }

  _launch(src, nodes, t0, offset, dur) {
    this.active.add(src);
    src.onended = () => {
      this.active.delete(src);
      nodes.forEach((n) => n.disconnect());
    };
    if (dur === undefined) src.start(t0, offset);
    else src.start(t0, offset, dur);
  }

  /** Render one AmbientDirector event. */
  play(ev) {
    if (!this.profile) return;
    const t0 = this.ctx.currentTime + 0.02;
    const gain = dbToGain(ev.levelDb);
    if (ev.type === 'gust') {
      const panner = this._panner({ distanceLoss: false });
      const env = new GainNode(this.ctx, { gain: 0 });
      let src, dur, offset = 0;
      if (this.gustSources.length) {
        // A random excerpt of a recorded loop, shaped into a swell.
        const buffer = this.gustSources[Math.floor(ev.pick * this.gustSources.length) % this.gustSources.length];
        dur = Math.min(ev.duration, buffer.duration);
        offset = Math.random() * Math.max(0, buffer.duration - dur);
        src = new AudioBufferSourceNode(this.ctx, { buffer });
        const curve = Float32Array.from({ length: 64 }, (_, i) => gain * Math.pow(Math.sin((Math.PI * i) / 63), 1.5));
        env.gain.setValueCurveAtTime(curve, t0, dur);
      } else {
        // Procedural gusts already contain their swell: pick one of the variants closest to the wanted length.
        const ranked = [...this.synthGusts].sort((a, b) => Math.abs(a.duration - ev.duration) - Math.abs(b.duration - ev.duration));
        const near = ranked.slice(0, 2);
        const buffer = near[Math.floor(ev.pick * near.length) % near.length];
        dur = buffer.duration;
        src = new AudioBufferSourceNode(this.ctx, { buffer });
        env.gain.setValueAtTime(gain, t0);
      }
      src.connect(env).connect(panner).connect(this.fadeBus);
      this._move(panner, ev.from, ev.to, t0, dur);
      this._launch(src, [env, panner], t0, offset, dur);
    } else if (ev.type === 'bird') {
      const list = this.birds.length ? this.birds : this.synthBirds;
      const buffer = list[Math.floor(ev.pick * list.length) % list.length];
      const panner = this._panner({ distanceLoss: true });
      const g = new GainNode(this.ctx, { gain });
      const src = new AudioBufferSourceNode(this.ctx, { buffer, playbackRate: 0.95 + Math.random() * 0.1 });
      src.connect(g).connect(panner).connect(this.fadeBus);
      this._move(panner, ev.from, ev.to, t0, ev.flies ? Math.max(ev.flightSec, buffer.duration) : 0);
      this._launch(src, [g, panner], t0, 0, undefined);
    }
  }
}
