/**
 * RHYME TOGETHER — сквозной тест на двух независимых браузерах.
 *
 * Проверяет главный критерий готовности:
 *   два игрока с разных устройств (два браузерных контекста) → комната по коду
 *   → разные вокальные партии → синхронный старт по серверному времени
 *   → исполнение → общий командный результат.
 *
 * Дополнительно:
 *   • WebRTC-голос устанавливается (ICE connected);
 *   • оценка НЕ фиктивная: с «тишиной» в микрофоне балл ≈ 0,
 *     с реальным тоном в нотах — заметно выше;
 *   • обработка потери связи и переподключения.
 *
 * Запуск: node tools/e2e.js  (нужен работающий сервер на PORT, по умолчанию 3000)
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
for (const p of [
  'playwright-core',
  '/home/user/.npm/_npx/bbb8a2c4738e2b0c/node_modules/playwright-core',
  'playwright',
]) {
  try { ({ chromium } = require(p)); break; } catch {}
}
if (!chromium) {
  console.error('Не найден playwright-core. Установите: npx playwright install chromium');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://localhost:3000';
// если задана песня — играем её целиком (проверка честности оценки в живом тракте)
const SONG_ID = process.env.RT_SONG || '';
const FULL_RUN = process.env.RT_FULL === '1';
const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: Boolean(cond), extra });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CHROME_ARGS = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

async function makePlayer(browser, name, tone) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  if (tone) {
    // Подменяем микрофон на синтезированный голос, который следует РЕАЛЬНОЙ
    // мелодии своей партии (как если бы игрок пел идеально). Это делает оценку
    // измеримой и проверяемой: балл должен быть высоким.
    await page.addInitScript(() => {
      window.__rtTone = { midi: null, on: false, offsetCents: 0, missed: new Set() };
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await orig(c);
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 220;
        const gain = ctx.createGain();
        gain.gain.value = 0.28;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        const t = window.__rtTone;
        // каждый кадр: следуем ноте партии в текущей позиции трека
        setInterval(() => {
          const S = window.RT?.S;
          if (!S?.song || !S.clock) { gain.gain.value = 0; return; }
          const pos = S.clock.desiredPosition();
          const notes = S.myNotes || [];
          let cur = null;
          for (const n of notes) { if (pos >= n.start && pos < n.start + n.dur) { cur = n; break; } }
          if (cur && !t.missed.has(cur.start)) {
            osc.frequency.value = 440 * Math.pow(2, ((cur.midi * 100 + t.offsetCents) / 100 - 69) / 12);
            // артикуляция: короткий спад перед концом ноты → атака ровно в начале
            const sinceStart = pos - cur.start;
            const untilEnd = cur.dur - sinceStart;
            gain.gain.value = untilEnd < 0.05 ? 0.008 : 0.30;
            t.on = true;
          } else {
            gain.gain.value = 0.0005;
            t.on = false;
          }
        }, 12);
        return new MediaStream([dest.stream.getAudioTracks()[0]]);
      };
    });
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.RT?.socket?.connected === true, { timeout: 15000 });
  await page.evaluate((n) => {
    localStorage.setItem('rt.settings', JSON.stringify({ name: n }));
  }, name);
  return { ctx, page, name, errs };
}

async function main() {
  const browser = await chromium.launch({ args: CHROME_ARGS });
  console.log(`\n═══ RHYME TOGETHER — E2E ═══\nсервер: ${BASE}\n`);

  const A = await makePlayer(browser, 'Аня', true);   // поёт форте
  const B = await makePlayer(browser, 'Борис', true); // поёт форте на тон выше

  // ── 1. создание комнаты ────────────────────────────────────────────────────
  await A.page.click('#btnGoCreate');
  await A.page.waitForSelector('#screen-create.active');
  await A.page.fill('#createName', 'Аня');
  await A.page.click('#btnCreateRoom');
  await A.page.waitForSelector('#screen-room.active', { timeout: 15000 });
  const code = await A.page.evaluate(() => window.RT.socket.code);
  if (SONG_ID) {
    await A.page.evaluate((id) => window.RT.socket.send('pick-song', { songId: id }), SONG_ID);
    await sleep(300);
  }
  ok('комната создана, код — 6 цифр', /^\d{6}$/.test(code || ''), code);

  // ── 2. вход второго игрока по коду ────────────────────────────────────────
  await B.page.click('#btnGoJoin');
  await B.page.waitForSelector('#screen-join.active');
  await B.page.fill('#joinName', 'Борис');
  await B.page.fill('#joinCode', code);
  await B.page.click('#btnJoinRoom');
  await B.page.waitForSelector('#screen-room.active', { timeout: 15000 });
  const partsA = await A.page.evaluate(() => window.RT.S.myPart);
  const partsB = await B.page.evaluate(() => window.RT.S.myPart);
  ok('игроку 1 назначена партия A', partsA === 'A', partsA);
  ok('игроку 2 назначена партия B', partsB === 'B', partsB);
  const twoInRoom = await A.page.evaluate(() => window.RT.S.room?.players?.length === 2);
  ok('в комнате ровно два игрока', twoInRoom);

  // ── 3. микрофон и голосовой канал ─────────────────────────────────────────
  await A.page.click('#btnRoomMic');
  await B.page.click('#btnRoomMic');
  await sleep(4000);
  const voiceA = await A.page.evaluate(() => ({
    state: window.RT.voice.pc?.connectionState,
    ice: window.RT.voice.iceState,
    level: window.RT.voice.readMicLevel(),
  }));
  ok('WebRTC: соединение установлено', ['connected', 'completed'].includes(voiceA.state), `state=${voiceA.state}, ice=${voiceA.ice}`);

  // ── 4. готовность и синхронный старт ──────────────────────────────────────
  await A.page.click('#btnReady');
  await B.page.click('#btnReady');

  const startInfo = await Promise.race([
    A.page.waitForFunction(() => window.RT.S.clock != null, { timeout: 30000 }).then(() => A.page.evaluate(() => ({
      startAt: window.RT.S.clock.startAtServer,
      offset: window.RT.socket.clock.offset,
      songId: window.RT.S.song.id,
    }))),
    sleep(31000).then(() => null),
  ]);
  ok('сервер назначил момент старта', Boolean(startInfo?.startAt), startInfo ? new Date(startInfo.startAt).toISOString() : '');

  const songA = await A.page.evaluate(() => window.RT.S.song?.id);
  const songB = await B.page.evaluate(() => window.RT.S.song?.id);
  ok('обе стороны получили одну и ту же песню', songA != null && songA === songB, `${songA} / ${songB}`);

  await A.page.waitForSelector('#screen-game.active', { timeout: 20000 });
  await B.page.waitForSelector('#screen-game.active', { timeout: 20000 });
  ok('игровой экран открыт у обоих', true);

  // ── 5. рассинхронизация воспроизведения ───────────────────────────────────
  await sleep(3500);
  const drift = await A.page.evaluate(() => {
    const c = window.RT.S.clock;
    return { desired: c.desiredPosition(), actual: c.actualPosition(), started: c.started };
  });
  const driftMs = Math.abs((drift.desired - drift.actual) * 1000);
  ok('воспроизведение запущено и не разъехалось', drift.started && driftMs < 400, `Δ=${driftMs.toFixed(0)} мс`);

  // ── 6. реальная проверка оценки ───────────────────────────────────────────
  // ждём вступления вокальной партии (у «Калинки» 4 такта инструментала = 8 с)
  await A.page.waitForFunction(() => (window.RT.S.clock?.desiredPosition() || 0) > 10, { timeout: 25000 }).catch(() => {});
  await sleep(2500);
  const live = await Promise.all([A, B].map(P => P.page.evaluate(() => {
    const f = window.RT.S.analyser?.frames || [];
    return { frames: f.length, voiced: f.filter(x => x.freq).length, onsets: window.RT.S.analyser?.onsets?.length || 0 };
  })));
  ok('анализ идёт у обоих игроков', live.every(l => l.frames > 30), live.map(l => `${l.frames} кадров/${l.voiced} с тоном`).join(', '));
  const micLevel = await A.page.evaluate(() => window.RT.voice.readMicLevel());
  ok('микрофон даёт сигнал во время пения', micLevel > 0.05, `level=${micLevel.toFixed(3)}`);
  const totalOnsets = live.reduce((s, l) => s + l.onsets, 0);
  ok('онсеты (атаки нот) фиксируются', totalOnsets > 5, live.map(l => l.onsets).join(' / '));

  if (FULL_RUN) {
    // ждём реального окончания песни: результаты должны сдаться сами
    console.log('  … ждём окончания песни целиком');
    await A.page.waitForSelector('#screen-results.active', { timeout: 120000 });
  } else {
  // просим игровой цикл завершить трек немедленно (как будто песня кончилась)
  await Promise.all([A, B].map(P => P.page.evaluate(() => { window.RT.S.forceFinish = true; })));
  await sleep(1200);
  await Promise.all([A, B].map(P => P.page.evaluate(() => {
    // ручная сдача результата (как по завершении песни)
    const { score, perNote, onsets } = window.RT.S.analyser.finish(window.RT.S.peerOnsets || [], window.RT.S.song, window.RT.S.myPart);
    window.RT.S.myResult = { score, perNote };
    window.RT.S.myResultSubmitted = true;
    window.RT.socket.send('result', { result: { score, onsets, part: window.RT.S.myPart, songId: window.RT.S.song.id, at: Date.now() } });
    return score;
  })));
  }

  await A.page.waitForSelector('#screen-results.active', { timeout: 20000 });
  await B.page.waitForSelector('#screen-results.active', { timeout: 20000 });
  const ResA = await A.page.evaluate(() => window.RT.S.result);
  const ResB = await B.page.evaluate(() => window.RT.S.result);
  ok('результаты показаны обоим', Boolean(ResA?.team && ResB?.team));
  ok('командный балл одинаков у обоих', ResA.team.total === ResB.team.total, `${ResA.team.total}`);
  ok('командный балл — число в диапазоне 0..100', ResA.team.total >= 0 && ResA.team.total <= 100, String(ResA.team.total));
  ok('есть индивидуальные результаты обеих партий',
    ResA.entries.length === 2 && ResA.entries.every(e => e.score),
    ResA.entries.map(e => `${e.part}:${e.score?.accuracy}`).join(' '));
  // формула 50/30/20; отсутствующая метрика перераспределяется между остальными
  const parts = [['pitch', 0.5], ['rhythm', 0.3], ['sync', 0.2]].filter(([k]) => ResA.team[k] != null);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const formula = wsum > 0 ? parts.reduce((a, [k, w]) => a + ResA.team[k] * w, 0) / wsum : null;
  ok('балл соответствует формуле 50/30/20', formula != null && Math.abs(formula - ResA.team.total) < 0.6,
    `${formula?.toFixed(1)} ≈ ${ResA.team.total} (метрики: ${parts.map(p => p[0]).join('+')})`);
  if (FULL_RUN) {
    // метрика синхронности требует минимум 3 совместных атак — при досрочном
    // завершении песни их может не быть, поэтому проверяем на полном прогоне
    ok('синхронность посчитана в живом дуэте', ResA.team.sync != null, `sync=${ResA.team.sync}`);
  }
  ok('оценка не нулевая при наличии тона', ResA.team.total > 0, String(ResA.team.total));
  if (FULL_RUN) {
    ok('живой тракт (микрофон→анализ→сервер) даёт высокий балл', ResA.team.total > 45,
      `командный ${ResA.team.total}: ноты ${ResA.team.pitch}, ритм ${ResA.team.rhythm}, синхр. ${ResA.team.sync}`);
  }

  await A.page.screenshot({ path: '/tmp/shot-results.png', fullPage: true });

  // ── 7. честность оценки: тишина даёт ~0 ───────────────────────────────────
  const silent = await A.page.evaluate(async () => {
    const { PerformanceAnalyzer } = await import('/audio/analysis.js');
    const an = new PerformanceAnalyzer();
    const song = window.RT.S.song;
    for (let t = 0; t < song.durationSec; t += 0.02) an.pushFrame(t, null, 0.0005);
    const r = an.finish([], song, 'A');
    return r.score;
  });
  ok('тишина в микрофоне → балл около нуля', silent.accuracy < 5, `accuracy=${silent.accuracy}, notesHit=${silent.notesHit}`);

  // ── 8. оценка точной мелодии (эталон) через тот же анализатор ─────────────
  const precise = await A.page.evaluate(async () => {
    const { PerformanceAnalyzer, buildNoteTimeline } = await import('/audio/analysis.js');
    const an = new PerformanceAnalyzer();
    const song = window.RT.S.song;
    const notes = buildNoteTimeline(song, 'A');
    const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
    for (let t = 0; t < song.durationSec; t += 0.02) {
      const cur = notes.find(n => t >= n.start && t < n.start + n.dur);
      if (cur) {
        const onBeat = notes.some(n => Math.abs(n.start - t) < 0.02);
        an.pushFrame(t, mtof(cur.midi), onBeat ? 0.3 : 0.12);
      } else an.pushFrame(t, null, 0.001);
    }
    const r = an.finish(notes.map(n => n.start), song, 'A');
    return r.score;
  });
  ok('эталонная мелодия даёт высокий балл', precise.accuracy > 80, `accuracy=${precise.accuracy}, ноты=${precise.notesHit}/${precise.notesTotal}`);

  // ── 8b. пение не в ноту даёт низкий балл (проверка чувствительности) ──────
  const offKey = await A.page.evaluate(async () => {
    const { PerformanceAnalyzer, buildNoteTimeline } = await import('/audio/analysis.js');
    const an = new PerformanceAnalyzer();
    const song = window.RT.S.song;
    const notes = buildNoteTimeline(song, 'A');
    const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
    for (let t = 0; t < song.durationSec; t += 0.02) {
      const cur = notes.find(n => t >= n.start && t < n.start + n.dur);
      // поём на 4 полутона выше (грубо фальшиво)
      if (cur) an.pushFrame(t, mtof(cur.midi + 4), 0.2);
      else an.pushFrame(t, null, 0.001);
    }
    return an.finish(notes.map(n => n.start), song, 'A').score;
  });
  ok('пение не в ноту → низкий балл', offKey.accuracy < 35, `accuracy=${offKey.accuracy}`);

  // ── 9. потеря связи и переподключение ─────────────────────────────────────
  const codeBefore = await B.page.evaluate(() => window.RT.socket.code);
  // сервер принудительно рвёт TCP-соединение (так выглядит реальный обрыв сети)
  await B.page.evaluate(() => window.RT.socket.send('debug-drop', {}));
  const detected = await B.page.waitForFunction(() => window.RT.socket.connected === false, { timeout: 20000 })
    .then(() => true).catch(() => false);
  const offlineState = await B.page.evaluate(() => ({ connected: window.RT.socket.connected, status: window.RT.socket.status }));
  ok('обрыв связи обнаружен клиентом', detected && !offlineState.connected, offlineState.status);
  const reconnected = await B.page.waitForFunction(() => window.RT.socket.connected === true, { timeout: 25000 })
    .then(() => true).catch(() => false);
  ok('клиент переподключился автоматически', reconnected);
  const codeAfter = await B.page.evaluate(() => window.RT.socket.code);
  ok('сессия восстановлена в той же комнате', reconnected && codeAfter === codeBefore, `${codeBefore} → ${codeAfter}`);

  // ── 10. покидание комнаты ─────────────────────────────────────────────────
  await A.page.evaluate(() => window.RT.socket.send('leave', {}));
  await sleep(1200);
  const afterLeave = await B.page.evaluate(() => window.RT.S.room?.players?.length ?? 0);
  ok('выход из комнаты освобождает место', afterLeave <= 1, `${afterLeave} игроков`);

  // ── ошибки в консоли ─────────────────────────────────────────────────────
  const errFilter = (e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|WebSocket is closed|net::ERR_NETWORK_CHANGED/.test(e);
  const errsA = A.errs.filter(errFilter), errsB = B.errs.filter(errFilter);
  ok('нет JS-ошибок в консоли', errsA.length + errsB.length === 0, [...errsA, ...errsB].slice(0, 4).join(' | '));

  await browser.close();

  const passed = results.filter(r => r.pass).length;
  console.log(`\n═══ Итог: ${passed}/${results.length} проверок пройдено ═══`);
  fs.writeFileSync('/tmp/e2e-report.json', JSON.stringify({ base: BASE, code, passed, total: results.length, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('ТЕСТ УПАЛ:', e.message); process.exit(1); });
