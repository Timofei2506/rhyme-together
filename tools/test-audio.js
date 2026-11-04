/**
 * RHYME TOGETHER — юнит-проверки аудио-подсистем (Node, без браузера).
 *   node tools/test-audio.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { PerformanceAnalyzer, buildNoteTimeline, detectPitch, weighted } from '../src/audio/analysis.js';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(Boolean(cond));
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
};
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const SONG_DIR = path.join(process.cwd(), 'src', 'data', 'songs');
const songs = fs.readdirSync(SONG_DIR)
  .filter(f => f.endsWith('.json') && f !== 'index.json')
  .map(f => JSON.parse(fs.readFileSync(path.join(SONG_DIR, f), 'utf8')));

console.log('\n═══ 1. Партитуры ═══');
for (const s of songs) {
  const beat = 60 / s.bpm;
  let overlaps = 0, outOfRange = 0, empty = 0;
  for (const part of ['A', 'B']) {
    const lines = [...s.vocal[part]].sort((a, b) => (a.bar * s.beatsPerBar + a.beat) - (b.bar * s.beatsPerBar + b.beat));
    if (!lines.length) empty++;
    let prevEnd = -1e9;
    for (const ln of lines) {
      const start = (ln.bar * s.beatsPerBar + ln.beat);
      const dur = ln.syllables.reduce((a, x) => a + x.d, 0);
      if (start < prevEnd - 1e-6) overlaps++;
      if (start + dur > s.totalBars * s.beatsPerBar + 1e-6) outOfRange++;
      // каждый слог имеет либо ноту, либо явную паузу
      if (ln.syllables.some(x => typeof x.d !== 'number')) outOfRange++;
      prevEnd = start + dur;
    }
  }
  ok(`${s.id}: две непустые партии, без перекрытий и выходов за границы`,
    !empty && !overlaps && !outOfRange, `перекрытий ${overlaps}, за границей ${outOfRange}`);
  const notesA = buildNoteTimeline(s, 'A').length;
  const notesB = buildNoteTimeline(s, 'B').length;
  ok(`${s.id}: разметка нот для обеих партий`, notesA > 20 && notesB > 20, `A ${notesA}, B ${notesB}`);
  ok(`${s.id}: длительность соответствует тактам`,
    Math.abs(s.durationSec - s.totalBars * s.beatsPerBar * beat) < 0.01, `${s.durationSec} c`);
}

console.log('\n═══ 2. Детектор высоты тона ═══');
{
  const sr = 44100, n = 2048;
  const gen = (freq, type = 'tri') => {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ph = ((i / sr) * freq) % 1;
      buf[i] = type === 'sin' ? 0.3 * Math.sin(2 * Math.PI * freq * i / sr)
        : (2 * Math.abs(2 * ph - 1) - 1) * 0.3 + (Math.random() - 0.5) * 0.008;
    }
    return buf;
  };
  let worst = 0;
  for (const f of [82.4, 110, 146.8, 196, 262, 330, 392, 523, 784, 988]) {
    const got = detectPitch(gen(f), sr);
    const cents = got ? Math.abs(1200 * Math.log2(got / f)) : 9999;
    worst = Math.max(worst, cents);
    if (cents > 60) console.log(`     ${f} Гц → ${got?.toFixed(1) ?? 'null'} (${cents.toFixed(0)} ¢)`);
  }
  ok('все тестовые частоты определены с точностью < 60 центов (включая октавную защиту)', worst < 60, `макс. ошибка ${worst.toFixed(0)} ¢`);
  ok('тишина → null', detectPitch(new Float32Array(n), sr) === null);
  ok('шум без тона → null', detectPitch(Float32Array.from({ length: n }, () => (Math.random() - 0.5) * 0.4), sr) === null);
}

console.log('\n═══ 3. Оценка исполнения ═══');
{
  const song = songs.find(s => s.id === 'bereza') || songs[0];
  const sing = (part, opts = {}) => {
    const { shift = 0, jitter = null, amp = 0.3, skip = new Set() } = opts;
    const notes = buildNoteTimeline(song, part);
    const an = new PerformanceAnalyzer();
    const off = new Map(notes.map(n => [n.start, jitter ? jitter(n) : 0]));
    for (let t = 0; t < song.durationSec; t += 0.02) {
      const cur = notes.find(n => {
        if (skip.has(n.start)) return false;
        const o = off.get(n.start);
        return t >= n.start + o && t < n.start + n.dur + o;
      });
      if (cur) {
        const o = off.get(cur.start);
        const end = cur.start + o + cur.dur;
        an.pushFrame(t, mtof(cur.midi + shift), (end - t) < 0.04 ? 0.006 : amp);
      } else an.pushFrame(t, null, 0.001);
    }
    return { an, notes };
  };

  const a = sing('A');
  const b = sing('B');
  const ra = a.an.finish(b.an.onsets, song, 'A', 'B');
  ok('идеальное исполнение → высокий балл', ra.score.accuracy > 85, `accuracy ${ra.score.accuracy}`);
  ok('идеальный дуэт → высокая синхронность', ra.score.sync > 85, `sync ${ra.score.sync}`);

  const silent = new PerformanceAnalyzer();
  for (let t = 0; t < song.durationSec; t += 0.02) silent.pushFrame(t, null, 0.0004);
  const rs = silent.finish([], song, 'A', 'B');
  ok('тишина → ноль (нет фиктивных баллов)', rs.score.accuracy < 3 && rs.score.notesHit === 0, `accuracy ${rs.score.accuracy}`);

  const wrong = sing('A', { shift: 5 });
  const rw = wrong.an.finish([], song, 'A', 'B');
  ok('пение на 5 полутонов мимо → ноты обнуляются', rw.score.pitch < 5,
    `ноты ${rw.score.pitch}, ритм ${rw.score.rhythm}, итог ${rw.score.accuracy}`);
  ok('при этом ритм сохраняется (метрики независимы)', rw.score.rhythm > 70, `ритм ${rw.score.rhythm}`);

  const half = new Set(buildNoteTimeline(song, 'A').slice(0, 15).map(n => n.start));
  const rHalf = sing('A', { skip: half }).an.finish([], song, 'A', 'B');
  ok('пропуск половины нот снижает балл', rHalf.score.notesHit < ra.score.notesHit, `попаданий ${rHalf.score.notesHit} против ${ra.score.notesHit}`);

  const late = sing('A', { jitter: () => (Math.random() - 0.5) * 0.5 });
  const rl = a.an.finish(late.an.onsets, song, 'A', 'B');
  ok('нестабильный ритм партнёра снижает синхронность', rl.score.sync != null && rl.score.sync < ra.score.sync - 8,
    `${rl.score.sync} против ${ra.score.sync}`);

  const bothShifted = sing('B', { jitter: () => 0.18 });
  const rShift = sing('A', { jitter: () => 0.18 }).an.finish(bothShifted.an.onsets, song, 'A', 'B');
  ok('оба сдвинуты одинаково — дуэт остаётся синхронным', rShift.score.sync > 70, `sync ${rShift.score.sync}`);

  const w = weighted(ra.score.pitch, ra.score.rhythm, ra.score.sync);
  ok('формула 50/30/20 применяется', Math.abs(w - (ra.score.pitch * 0.5 + ra.score.rhythm * 0.3 + ra.score.sync * 0.2)) < 0.01);
}

const passed = results.filter(Boolean).length;
console.log(`\n═══ Итог: ${passed}/${results.length} ═══\n`);
process.exit(passed === results.length ? 0 : 1);
