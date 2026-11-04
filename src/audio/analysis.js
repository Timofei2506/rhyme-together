/**
 * RHYME TOGETHER — локальный анализ исполнения.
 *
 * Всё считается НА УСТРОЙСТВЕ игрока: микрофонный звук не покидает клиент.
 * На сервер уходят только числа (баллы) и короткие таймстемпы онсетов
 * для расчёта синхронности между партнёрами.
 *
 * Метрики (веса по ТЗ): ноты 50 %, ритм 30 %, синхронность 20 %.
 */

const A4 = 440;
const midiToFreq = (m) => A4 * Math.pow(2, (m - 69) / 12);
const centsOf = (f, ref) => 1200 * Math.log2(f / ref);

/**
 * Автокорреляционный детектор высоты тона.
 * @returns {number|null} частота Гц или null (тишина/шум)
 */
export function detectPitch(buf, sampleRate, opts = {}) {
  const { rmsMin = 0.012, clarityMin = 0.62, fmin = 70, fmax = 1050 } = opts;
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < rmsMin) return null;

  // убираем постоянную составляющую
  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = buf[i] - mean;

  const minLag = Math.max(2, Math.floor(sampleRate / fmax));
  const maxLag = Math.min(Math.floor(sampleRate / fmin), n - 2);
  const corr = new Float32Array(maxLag + 2);
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const denom = Math.sqrt(e1 * e2) || 1;
    const v = sum / denom;
    corr[lag] = v;
    if (v > globalMax) globalMax = v;
  }
  if (globalMax < clarityMin) return null;

  // Защита от ошибок в октаву/субгармонику: берём ПЕРВЫЙ локальный максимум,
  // близкий к глобальному, а не самый большой лаг (иначе чистый тон 262 Гц
  // определяется как 87 Гц — период втрое длиннее).
  const threshold = globalMax * 0.88;
  let bestLag = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= threshold && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corr[lag] >= threshold) { bestLag = lag; break; }
    }
  }
  if (bestLag < 0) return null;
  const y0 = corr[bestLag - 1] ?? 0, y1 = corr[bestLag], y2 = corr[bestLag + 1] ?? 0;
  const denomP = 2 * (2 * y1 - y0 - y2);
  const shiftP = denomP !== 0 ? (y2 - y0) / denomP : 0;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, shiftP));
  const freq = sampleRate / lag;
  if (!isFinite(freq) || freq < fmin || freq > fmax) return null;
  return freq;
}

/** Все ноты партии с абсолютным временем (сек от старта трека) */
export function buildNoteTimeline(song, part) {
  const beat = 60 / song.bpm;
  const out = [];
  const lines = song.vocal[part] || [];
  lines.forEach((ln, li) => {
    let b = ln.bar * song.beatsPerBar + ln.beat;
    ln.syllables.forEach((syl, si) => {
      const start = b * beat;
      const dur = syl.d * beat;
      if (syl.midi != null) {
        out.push({
          start, dur, midi: syl.midi, freq: midiToFreq(syl.midi),
          syl: syl.t, word: syl.w === 1, lineIndex: li, sylIndex: si,
          end: start + dur,
        });
      }
      b += syl.d;
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Онлайн-анализ одного игрока.
 * Добавляйте кадры через pushFrame(), в конце вызовите finish(peerOnsets, song, part).
 */
export class PerformanceAnalyzer {
  constructor(opts = {}) {
    this.toleranceCents = opts.toleranceCents ?? 60;   // «попадание» в ноту
    this.onsetWindow = 0.30;                            // окно для ритма, сек
    this.syncWindow = 0.45;                             // окно синхронности, сек
    this.frames = [];                                   // {t, freq, rms}
    this.onsets = [];                                   // таймстемпы онсетов (сек)
    this._lastOnset = -1;
    this._prevRms = 0;
    this._hist = [];
    this._ring = new Float64Array(50).fill(0.0005);
    this._ringPos = 0;
    this._noise = 0.004;
    this.frameCount = 0;
    this.voicedCount = 0;
    this.peak = 0;
  }

  /** @param {number} t позиция в треке (сек) @param {number|null} freq @param {number} rms */
  pushFrame(t, freq, rms) {
    if (!isFinite(t) || t < 0) return;
    this.frameCount++;
    if (freq) this.voicedCount++;
    if (rms > this.peak) this.peak = rms;
    // медленная оценка шумового пола
    this._noise = this._noise * 0.98 + Math.min(rms, 0.2) * 0.02;
    this.frames.push({ t, freq, rms });

    // ── детектор атак (онсетов) ───────────────────────────────────────────
    // Порог адаптивный: минимум энергии за последнюю секунду (тишина между
    // нотами) + локальный минимум последних кадров. Так ловятся и стаккато,
    // и легато, но ровный тянущийся звук ложных онсетов не даёт.
    this._ring[this._ringPos % this._ring.length] = rms;
    this._ringPos++;
    let ringMin = Infinity;
    for (let i = 0; i < this._ring.length; i++) {
      const v = this._ring[i];
      if (v < ringMin) ringMin = v;
    }
    const floor = Math.max(0.008, ringMin * 1.35);
    this._noise = floor;                        // для оценки «есть ли звук»
    this._hist.push(rms);
    if (this._hist.length > 9) this._hist.shift();
    if (rms > 0.012 && rms > floor) {
      const localMin = Math.min(...this._hist.slice(0, -1));
      const jump = localMin > 1e-6 ? rms / localMin : (rms > 0.05 ? 99 : 1);
      const rising = rms >= this._prevRms * 1.04;
      if (jump > 1.30 && rising && (this._lastOnset < 0 || t - this._lastOnset > 0.09)) {
        this.onsets.push(t);
        this._lastOnset = t;
        this._hist = [rms];
      }
    }
    this._prevRms = rms;
  }

  /** Текущее «живое» состояние для индикаторов */
  liveState(t) {
    const recent = this.frames.filter(f => t - f.t < 0.4);
    const voiced = recent.filter(f => f.freq).length;
    return { level: recent.length ? Math.max(...recent.map(f => f.rms)) : 0, voiced: voiced > recent.length * 0.4 };
  }

  /**
   * Итоговая оценка.
   * @param {Array<number>} peerOnsets онсеты партнёра (сек от старта трека)
   */
  finish(peerOnsets, song, part, peerPart = null) {
    this.peerOnsetsSafe = peerOnsets || [];
    const notes = buildNoteTimeline(song, part);
    const tol = this.toleranceCents;

    // ── 1) НОТЫ (50 %)
    const perNote = notes.map(n => {
      // окно самой ноты — по нему считаем «спето/не спето»
      const from = n.start - 0.04;
      const to = n.start + Math.max(0.08, n.dur);
      const fr = this.frames.filter(f => f.t >= from && f.t <= to);
      const voiced = fr.filter(f => f.freq);
      if (!voiced.length) return { ...n, pitch: 0, cents: null, voicedRatio: 0, hit: false };
      const cents = voiced.map(f => centsOf(f.freq, n.freq)).sort((a, b) => a - b);
      const median = cents[Math.floor(cents.length / 2)];
      const inTune = cents.filter(c => Math.abs(c) <= tol).length / cents.length;
      const distQual = Math.max(0, 1 - Math.abs(median) / tol);
      // покрытие: нота должна быть спета, но короткая пауза в конце не штрафуется жёстко
      const ratio = voiced.length / Math.max(1, fr.length);
      const coverage = 0.6 + 0.4 * ratio;
      const pitch = Math.max(0, Math.min(1, inTune * 0.6 + distQual * 0.4)) * coverage;
      return { ...n, pitch, cents: median, voicedRatio: ratio, hit: Math.abs(median) <= tol };
    });

    // ── 2) РИТМ (30 %)
    const usedOnsets = new Set();
    const rhythmNotes = notes.map(n => {
      let best = null, bestD = Infinity;
      for (let i = 0; i < this.onsets.length; i++) {
        if (usedOnsets.has(i)) continue;
        const d = Math.abs(this.onsets[i] - n.start);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best != null && bestD <= this.onsetWindow) {
        usedOnsets.add(best);
        return Math.max(0, 1 - bestD / this.onsetWindow);
      }
      // нет онсета рядом — возможно, нота спета легато: смотрим энергию
      const fr = this.frames.filter(f => Math.abs(f.t - n.start) < 0.12);
      const hasEnergy = fr.some(f => f.rms > Math.max(0.02, this._noise * 2));
      return hasEnergy ? 0.35 : 0;
    });

    // ── 3) СИНХРОННОСТЬ (20 %) ────────────────────────────────────────────
    // Дуэт синхронен, когда оба игрока атакуют НОТЫ ОДНОГО МОМЕНТА вместе.
    // Сравниваем реальные онсеты (атаки) партнёров по ближайшим нотам их партий.
    const peerNotes = peerPart ? buildNoteTimeline(song, peerPart) : [];

    /**
     * Момент атаки ноты: ближайший онсет, а если его нет (легато) —
     * первый озвученный кадр внутри самой ноты. Это делает метрику
     * синхронности устойчивой к манере пения.
     */
    const attackAt = (refTime, win = 0.28) => {
      let best = null, bestD = Infinity;
      for (const o of this.onsets) {
        const d = Math.abs(o - refTime);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best != null && bestD <= win) return best;
      const gate = Math.max(0.012, this._noise * 1.6);
      for (const f of this.frames) {
        if (f.t < refTime - 0.16) continue;
        if (f.t > refTime + 0.34) break;
        if (f.freq && f.rms > gate) return f.t;
      }
      return null;
    };
    const peerOnsetAt = (refTime, win = 0.34) => {
      let best = null, bestD = Infinity;
      for (const p of (peerOnsets || [])) {
        const d = Math.abs(p - refTime);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best != null && bestD <= win ? best : null;
    };
    const nearestPeerNote = (refTime) => {
      let best = null, bestD = Infinity;
      for (const pn of peerNotes) {
        const d = Math.abs(pn.start - refTime);
        if (d < bestD) { bestD = d; best = pn; }
      }
      return best != null && bestD <= 1.2 ? best : null;
    };
    const myOnsetAt = (refTime, win = 0.3) => {
      let best = null, bestD = Infinity;
      for (const o of this.onsets) {
        const d = Math.abs(o - refTime);
        if (d < bestD) { bestD = d; best = o; }
      }
      return best != null && bestD <= win ? best : null;
    };
    const syncNotes = notes.map(n => {
      const pn = nearestPeerNote(n.start);
      if (!pn) return null;
      const mine = attackAt(n.start);
      const theirs = peerOnsetAt(pn.start);
      if (mine == null || theirs == null) return null;
      // сравниваем ОТКЛОНЕНИЯ от партитуры, а не абсолютные моменты:
      // если оба поют чуть позже доли — это по-прежнему синхронный дуэт
      const myDev = mine - n.start;
      const theirDev = theirs - pn.start;
      if (Math.abs(myDev) > 0.6 || Math.abs(theirDev) > 0.6) return null;
      return Math.max(0, 1 - Math.abs(myDev - theirDev) / this.syncWindow);
    });

    const avg = (arr) => {
      const v = arr.filter(x => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };

    const pitch = avg(perNote.map(n => n.pitch)) ?? 0;
    const rhythm = avg(rhythmNotes) ?? 0;
    const syncValues = syncNotes.filter(x => x != null);
    // синхронность валидна только если есть достаточно совместных атак
    const sync = syncValues.length >= 3 ? syncValues.reduce((a, b) => a + b, 0) / syncValues.length : null;

    const pct = (x) => x == null ? null : Math.round(x * 1000) / 10;
    const score = {
      pitch: pct(pitch),
      rhythm: pct(rhythm),
      sync: pct(sync),
      notesHit: perNote.filter(n => n.hit).length,
      notesTotal: notes.length,
      medianCents: perNote.filter(n => n.cents != null).length
        ? Math.round(perNote.filter(n => n.cents != null).map(n => n.cents).sort((a, b) => a - b)[
            Math.floor(perNote.filter(n => n.cents != null).length / 2)])
        : null,
      voicedRatio: Math.round((this.voicedCount / Math.max(1, this.frameCount)) * 1000) / 10,
      onsets: this.onsets.length,
      frames: this.frameCount,
      peaks: Math.round(this.peak * 1000) / 1000,
    };
    // индивидуальная точность = те же веса; при отсутствии данных о партнёре
    // синхронность не подменяется нулём, а перераспределяется
    score.accuracy = sync == null
      ? pct(pitch * (0.5 / 0.8) + rhythm * (0.3 / 0.8))
      : pct(pitch * 0.5 + rhythm * 0.3 + sync * 0.2);
    // командный балл считается так же (50/30/20) на сервере

    return {
      score,
      perNote: perNote.map(n => ({
        start: n.start, midi: n.midi, syl: n.syl, hit: n.hit,
        cents: n.cents == null ? null : Math.round(n.cents), pitch: Math.round(n.pitch * 100),
      })),
      onsets: this.onsets.map(t => Math.round(t * 1000) / 1000),
    };
  }
}

/** Взвешенный балл (50/30/20) — единая формула для игрока и команды */
export function weighted(pitch, rhythm, sync) {
  const hasSync = sync != null;
  if (!hasSync) return (pitch * 0.5 + rhythm * 0.3) / 0.8;
  return pitch * 0.5 + rhythm * 0.3 + sync * 0.2;
}
