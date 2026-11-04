/**
 * RHYME TOGETHER — аудиодвижок.
 *
 * 1) StemRenderer: синтезирует из JSON-партитуры три стема —
 *      instrumental, guide-A, guide-B — как Float32-буферы (без файлов и сети).
 * 2) MusicClock: единственный источник истины для позиции воспроизведения.
 *      Стартует стемы в момент, назначенный СЕРВЕРОМ, компенсирует сетевую
 *      задержку через оценку смещения часов и автоматически подтягивает
 *      рассинхронизацию (playbackRate + жёсткий seek при большом дрейфе).
 */

export const A4 = 440;
export const mtof = (m) => A4 * Math.pow(2, (m - 69) / 12);
export const ftom = (f) => 69 + 12 * Math.log2(f / A4);

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const QUALITY = { M: [0, 4, 7, 12], m: [0, 3, 7, 12], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10] };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// ─────────────────────────────────────────────────────────────────────────────
// Синтез
// ─────────────────────────────────────────────────────────────────────────────
export class StemRenderer {
  constructor(song, sampleRate = 44100) {
    this.song = song;
    this.sr = sampleRate;
    this.bpm = song.bpm;
    this.bpb = song.beatsPerBar;
    this.beat = 60 / song.bpm;
    this.scale = song.key === 'minor' ? MINOR : MAJOR;
    this.len = Math.ceil(song.durationSec * sampleRate) + sampleRate * 2; // хвост
  }

  degToMidi(deg, octave = 0) {
    const oct = Math.floor(deg / 7) + octave;
    return this.song.tonic + oct * 12 + this.scale[((deg % 7) + 7) % 7];
  }

  /** Время (сек) начала такта/доли */
  t(bar, beat = 0) { return (bar * this.bpb + beat) * this.beat; }

  allocate() {
    return [new Float32Array(this.len), new Float32Array(this.len)];
  }

  // ── элементарные генераторы (пишут прямо в буфер) ───────────────────────────
  _addTone(L, R, startSec, durSec, freq, gain, opts = {}) {
    const {
      harmonics = [1], decay = 0, attack = 0.008, release = 0.06,
      pan = 0, detune = 0, vibrato = 0, vibRate = 5.2, glideFrom = null, lp = 0,
    } = opts;
    const sr = this.sr;
    const i0 = Math.floor(startSec * sr);
    const n = Math.floor(durSec * sr);
    if (i0 < 0) return;
    const tail = Math.floor(release * sr);
    const gL = Math.cos((pan + 1) * Math.PI / 4), gR = Math.sin((pan + 1) * Math.PI / 4);
    let phase = 0, lpState = 0;
    const lpCoef = lp ? 1 - Math.exp(-2 * Math.PI * lp / sr) : 0;
    for (let i = 0; i < n + tail; i++) {
      const idx = i0 + i;
      if (idx >= this.len) break;
      const tt = i / sr;
      // огибающая
      let env;
      if (i < n) {
        const atk = Math.min(1, tt / Math.max(attack, 1e-4));
        env = atk * (decay ? Math.exp(-decay * tt) : 1);
      } else {
        env = Math.exp(-(i - n) / Math.max(tail / 3, 1));
      }
      // частота: глиссандо + вибрато
      let f = freq;
      if (glideFrom !== null && tt < 0.14) {
        const k = tt / 0.14;
        f = glideFrom * Math.pow(freq / glideFrom, k);
      }
      if (vibrato && tt > 0.12) {
        const vd = Math.min(1, (tt - 0.12) / 0.25) * vibrato;
        f *= Math.pow(2, (vd * Math.sin(2 * Math.PI * vibRate * tt)) / 12);
      }
      phase += (2 * Math.PI * f * (1 + detune)) / sr;
      let s = 0;
      for (let h = 0; h < harmonics.length; h++) s += harmonics[h] * Math.sin(phase * (h + 1));
      if (lp) { lpState += lpCoef * (s - lpState); s = lpState; }
      const v = s * env * gain;
      L[idx] += v * gL;
      R[idx] += v * gR;
    }
  }

  _addNoise(L, R, startSec, durSec, gain, opts = {}) {
    const { decay = 40, hp = 0, pan = 0, lp = 0 } = opts;
    const sr = this.sr, i0 = Math.floor(startSec * sr), n = Math.floor(durSec * sr);
    const gL = Math.cos((pan + 1) * Math.PI / 4), gR = Math.sin((pan + 1) * Math.PI / 4);
    let prev = 0, lpState = 0;
    const lpCoef = lp ? 1 - Math.exp(-2 * Math.PI * lp / sr) : 0;
    for (let i = 0; i < n; i++) {
      const idx = i0 + i;
      if (idx >= this.len || idx < 0) continue;
      const env = Math.exp(-decay * (i / sr));
      let s = Math.random() * 2 - 1;
      if (hp) { const d = s - prev; prev = s; s = d; }          // грубый ФВЧ
      if (lp) { lpState += lpCoef * (s - lpState); s = lpState; } // грубый ФНЧ
      const v = s * env * gain;
      L[idx] += v * gL; R[idx] += v * gR;
    }
  }

  _addKick(L, R, startSec, gain = 0.9) {
    const sr = this.sr, i0 = Math.floor(startSec * sr), n = Math.floor(0.34 * sr);
    for (let i = 0; i < n; i++) {
      const idx = i0 + i;
      if (idx >= this.len) break;
      const tt = i / sr;
      const f = 46 + 92 * Math.exp(-tt * 26);
      const env = Math.exp(-tt * 8.5);
      const v = Math.sin(2 * Math.PI * f * tt) * env * gain;
      L[idx] += v; R[idx] += v;
    }
  }

  _addSnare(L, R, startSec, gain = 0.4) {
    this._addNoise(L, R, startSec, 0.19, gain, { decay: 26, lp: 5200 });
  }

  _addHat(L, R, startSec, gain = 0.16) {
    this._addNoise(L, R, startSec, 0.055, gain, { decay: 95, hp: 1 });
  }

  /** Инструментал: пэды, бас, барабаны по секциям формы */
  renderInstrumental() {
    const [L, R] = this.allocate();
    const s = this.song, bpb = this.bpb, beat = this.beat;
    const barDur = bpb * beat;
    const sectionAt = (bar) => {
      let acc = 0;
      for (const sec of s.form) { if (bar < acc + sec.bars) return sec; acc += sec.bars; }
      return { kind: 'outro', name: 'Кода' };
    };
    for (let bar = 0; bar < s.totalBars; bar++) {
      const ch = s.chords[Math.min(bar, s.chords.length - 1)] || { root: 0, q: 'm' };
      const rootMidi = s.tonic + ch.root;
      const chord = (QUALITY[ch.q] || QUALITY.m);
      const sec = sectionAt(bar);
      const t0 = this.t(bar);
      const inIntro = sec.kind === 'intro';
      const inChorus = sec.kind === 'chorus';
      const density = inChorus ? 1 : sec.kind === 'verse' ? 0.7 : 0.4;

      // пэд (две пары гармонических голосов, лёгкий хорус)
      for (const iv of chord.slice(0, 3)) {
        this._addTone(L, R, t0, barDur, mtof(rootMidi + iv), 0.075 * (inIntro ? 0.8 : 1), {
          harmonics: [1, 0.32, 0.16, 0.07], attack: 0.12, release: 0.5, lp: 2400,
          pan: (iv === chord[0] ? -0.25 : 0.25), detune: 0.0012,
        });
      }
      // бас: на 1-ю и 3-ю долю
      const bassMidi = rootMidi - 24 + (chord[0] || 0) - (chord[0] || 0);
      for (let b = 0; b < bpb; b += 2) {
        this._addTone(L, R, t0 + b * beat, beat * 1.65, mtof(bassMidi + (b === 0 ? 0 : 7)), 0.22, {
          harmonics: [1, 0.22], attack: 0.01, decay: 1.2, release: 0.1, lp: 900,
        });
      }
      // арпеджио в припеве
      if (inChorus) {
        const pattern = [0, 1, 2, 1];
        for (let b = 0; b < bpb; b++) {
          const iv = chord[pattern[b % pattern.length]] + 12;
          this._addTone(L, R, t0 + b * beat, beat * 0.9, mtof(rootMidi + iv + 12), 0.055, {
            harmonics: [1, 0.3], attack: 0.006, decay: 3.4, release: 0.08,
            pan: b % 2 ? 0.35 : -0.35,
          });
        }
      }
      // барабаны
      if (!inIntro) {
        this._addKick(L, R, t0, 0.72 * density);
        this._addKick(L, R, t0 + 2 * beat, 0.6 * density);
        if (inChorus) this._addKick(L, R, t0 + 2.75 * beat, 0.42);
        this._addSnare(L, R, t0 + 1 * beat, 0.34 * density);
        this._addSnare(L, R, t0 + 3 * beat, 0.34 * density);
        for (let b = 0; b < bpb; b++) {
          this._addHat(L, R, t0 + b * beat, 0.10 * density);
          if (inChorus) this._addHat(L, R, t0 + (b + 0.5) * beat, 0.055);
        }
      } else {
        for (let b = 0; b < bpb; b++) this._addHat(L, R, t0 + b * beat, 0.045);
      }
    }
    return this._normalize([L, R], 0.86);
  }

  /** Гайд-вокал партии: синус+гармоники с портаменто и вибрато */
  renderGuide(part) {
    const [L, R] = this.allocate();
    const lines = this.song.vocal[part] || [];
    let prevMidi = null;
    for (const ln of lines) {
      let beat = ln.bar * this.bpb + ln.beat;
      for (const syl of ln.syllables) {
        const t0 = beat * this.beat;
        const dur = syl.d * this.beat;
        if (syl.midi != null) {
          this._addTone(L, R, t0, Math.max(0.06, dur * 0.92), mtof(syl.midi), 0.3, {
            harmonics: [1, 0.42, 0.18, 0.08, 0.04],
            attack: 0.024, release: 0.09, vibrato: 0.22, vibRate: 5.1,
            glideFrom: prevMidi ? mtof(prevMidi) : null, lp: 3600,
            pan: part === 'A' ? -0.12 : 0.12,
          });
          prevMidi = syl.midi;
        }
        beat += syl.d;
      }
    }
    return this._normalize([L, R], 0.62);
  }

  _normalize(bufs, peakTarget) {
    let peak = 0;
    for (const b of bufs) for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > peak) peak = a; }
    if (peak > 0) {
      const k = peakTarget / peak;
      for (const b of bufs) for (let i = 0; i < b.length; i++) b[i] *= k;
    }
    return bufs;
  }

  /** Все три стема за один проход */
  renderAll(onProgress = () => {}) {
    const out = {};
    out.instrumental = this.renderInstrumental();
    onProgress(0.45);
    out.A = this.renderGuide('A');
    onProgress(0.75);
    out.B = this.renderGuide('B');
    onProgress(1);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Часы воспроизведения
// ─────────────────────────────────────────────────────────────────────────────
export class MusicClock {
  /**
   * @param {AudioContext} ctx
   * @param {object} cfg
   *   song, stems {instrumental, A, B}, startAtServer (epoch ms),
   *   clockOffsetMs (serverTime - clientTime), listenPart ('A'|'B')
   */
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.song = cfg.song;
    this.startAtServer = cfg.startAtServer;
    this.offsetMs = cfg.clockOffsetMs || 0;
    this.listenPart = cfg.listenPart || 'A';
    this.started = false;
    this.ctxStart = null;
    this.sources = [];
    this.gains = {};
    this.lastDriftMs = 0;
    this.corrections = 0;
    this.seekCount = 0;
    this.volumes = { inst: 0.9, ownGuide: 0.5, auxGuide: 0.0, master: 1 };

    // мастер-шина
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.comp = ctx.createDynamicsCompressor?.();
    if (this.comp) {
      this.comp.threshold.value = -12; this.comp.knee.value = 18; this.comp.ratio.value = 3;
      this.master.connect(this.comp).connect(ctx.destination);
    } else this.master.connect(ctx.destination);

    this.makeBuffers(cfg.stems);
  }

  /**
   * Приводит стемы к единому виду.
   * Синтезированные стемы — массивы каналов [L, R]; загруженные файлы —
   * готовые AudioBuffer. Поддерживаем оба варианта и моно-файлы.
   */
  makeBuffers(stems) {
    const mk = (data) => {
      if (data && typeof data.getChannelData === 'function') {
        if (data.numberOfChannels >= 2) return data;
        // моно → стерео
        const b = this.ctx.createBuffer(2, data.length, data.sampleRate);
        b.copyToChannel(data.getChannelData(0), 0);
        b.copyToChannel(data.getChannelData(0), 1);
        return b;
      }
      const left = data && data[0] ? data[0] : null;
      const right = data && data[1] ? data[1] : left;
      const len = left ? left.length : Math.ceil((this.song.durationSec || 1) * this.ctx.sampleRate);
      const b = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
      if (left) b.copyToChannel(left.subarray(0, len), 0);
      if (right) b.copyToChannel(right.subarray(0, len), 1);
      return b;
    };
    this.buffers = {
      instrumental: mk(stems.instrumental),
      A: mk(stems.A),
      B: mk(stems.B),
    };
  }

  /** Позиция по часам сервера (сек от начала трека) */
  desiredPosition() {
    return (Date.now() + this.offsetMs - this.startAtServer) / 1000;
  }

  /** Позиция, которую реально играет AudioContext */
  actualPosition() {
    if (this.ctxStart == null) return null;
    return this.ctx.currentTime - this.ctxStart;
  }

  setVolumes({ inst, ownGuide, auxGuide, master }) {
    if (inst != null) { this.volumes.inst = inst; this.gains.inst?.gain.setTargetAtTime(inst, this.ctx.currentTime, 0.03); }
    if (ownGuide != null) { this.volumes.ownGuide = ownGuide; this.gains.own?.gain.setTargetAtTime(ownGuide, this.ctx.currentTime, 0.03); }
    if (auxGuide != null) { this.volumes.auxGuide = auxGuide; this.gains.aux?.gain.setTargetAtTime(auxGuide, this.ctx.currentTime, 0.03); }
    if (master != null) { this.volumes.master = master; this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.03); }
  }

  start() {
    const ctx = this.ctx;
    // момент старта в шкале AudioContext
    const nowServer = Date.now() + this.offsetMs;
    const leadSec = (this.startAtServer - nowServer) / 1000;
    this.ctxStart = ctx.currentTime + Math.max(0, leadSec);
    const ownPart = this.listenPart;
    const auxPart = ownPart === 'A' ? 'B' : 'A';
    const mkSource = (buf, vol) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(this.master);
      return { src, g };
    };
    const inst = mkSource(this.buffers.instrumental, this.volumes.inst);
    const own = mkSource(this.buffers[ownPart], this.volumes.ownGuide);
    const aux = mkSource(this.buffers[auxPart], this.volumes.auxGuide);
    this.gains = { inst: inst.g, own: own.g, aux: aux.g };
    this.sources = [inst.src, own.src, aux.src];
    const offset = Math.max(0, (this.desiredPosition()));
    for (const s of this.sources) {
      try { s.start(Math.max(ctx.currentTime, this.ctxStart), Math.min(offset, s.buffer.duration - 0.05)); } catch (e) { /* повтор */ }
    }
    this.started = true;
    return this.ctxStart;
  }

  /** Вызывать ~10 раз в секунду: измеряет и корректирует рассинхронизацию */
  tick() {
    if (!this.started) return { driftMs: 0 };
    const desired = this.desiredPosition();
    const actual = this.actualPosition();
    let drift = (desired - actual) * 1000; // >0: играем раньше нужного (надо ускорить? нет — надо подождать)
    this.lastDriftMs = drift;

    if (desired < 0) return { driftMs: drift, before: true };

    // жёсткий seek при сильном расхождении
    if (Math.abs(drift) > 700) {
      this.seekTo(desired);
      this.seekCount++;
      return { driftMs: drift, seek: true };
    }
    // мягкая коррекция скоростью: ±5% (незаметно на слух, но закрывает дрейф)
    const rate = Math.max(0.95, Math.min(1.05, 1 + drift / 2200));
    for (const s of this.sources) {
      if (s.playbackRate) s.playbackRate.value = rate;
    }
    if (Math.abs(drift) - Math.abs(this._prevDrift || 0) > 1) this.corrections++;
    this._prevDrift = drift;
    return { driftMs: drift, rate };
  }

  seekTo(posSec) {
    const ctx = this.ctx;
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.ctxStart = ctx.currentTime - posSec;
    const ownPart = this.listenPart, auxPart = ownPart === 'A' ? 'B' : 'A';
    const mk = (buf, g) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; g.gain.cancelScheduledValues(ctx.currentTime);
      src.connect(g);
      try { src.start(ctx.currentTime, Math.max(0, Math.min(posSec, buf.duration - 0.05))); } catch {}
      return src;
    };
    this.sources = [
      mk(this.buffers.instrumental, this.gains.inst),
      mk(this.buffers[ownPart], this.gains.own),
      mk(this.buffers[auxPart], this.gains.aux),
    ];
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.started = false;
    this.sources = [];
  }
}

/** Огибающая уровня (для индикаторов) */
export function levelFrom(buf) {
  if (!buf?.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}
