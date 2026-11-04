/**
 * RHYME TOGETHER — клиентское приложение.
 * Связывает: сеть (GameSocket) → комнату → голос (VoiceLink) → музыку (MusicClock)
 * → локальный анализ (PerformanceAnalyzer) → результаты.
 */
import { GameSocket } from '../net/socket.js';
import { VoiceLink } from '../net/voice.js';
import { StemRenderer, MusicClock, noteName } from '../audio/engine.js';
import { PerformanceAnalyzer, buildNoteTimeline, detectPitch, weighted } from '../audio/analysis.js';
import { icon, hydrateIcons } from './icons.js';
import { resolveEndpoints, apiUrl, clearEndpointOverrides } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (n, d = 0) => Number(n).toFixed(d);

const S = {
  screen: 'menu',
  room: null,
  myPart: 'A',
  peerPart: 'B',
  song: null,
  stems: null,
  clock: null,
  analyser: null,
  peerOnsets: [],
  result: null,
  renderToken: 0,
  rafId: null,
  tickId: null,
  settings: loadSettings(),
  rtcConfig: null,
  lastFrameAt: 0,
  micOn: false,
  peerConnected: false,
  liveAcc: [],
  songCache: new Map(),
  songsIndex: [],
  peerResultPending: false,
  secondsLeft: null,
  myResult: null,
};

function loadSettings() {
  const def = {
    peerVol: 1, inst: 0.9, own: 0.5, master: 1, micGain: 1,
    echo: true, noise: true, agc: true, autoSync: true, deviceId: '', name: '',
  };
  try { return { ...def, ...JSON.parse(localStorage.getItem('rt.settings') || '{}') }; } catch { return def; }
}
function saveSettings() { localStorage.setItem('rt.settings', JSON.stringify(S.settings)); }

// ─── сеть ────────────────────────────────────────────────────────────────────
const ENDPOINTS = resolveEndpoints();
const socket = new GameSocket(ENDPOINTS.wsUrl);
const voice = new VoiceLink(socket);
/** URL API игрового сервера (пустая строка = тот же origin) */
const api = (path) => apiUrl(path, ENDPOINTS.apiBase);

// ─── уведомления ─────────────────────────────────────────────────────────────
export function toast(text, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}

// ─── навигация ───────────────────────────────────────────────────────────────
const SCREENS = ['menu', 'create', 'join', 'room', 'mic', 'game', 'results', 'library', 'settings'];
function nav(name, back = null) {
  if (!SCREENS.includes(name)) return;
  if (back) S.backStack = [...(S.backStack || []), back];
  S.screen = name;
  $$('.screen').forEach(el => el.classList.toggle('active', el.id === `screen-${name}`));
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  location.hash = name === 'menu' ? '' : `#${name}`;
}
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (h && SCREENS.includes(h) && h !== S.screen) nav(h);
});

// ─── статусы в шапке ─────────────────────────────────────────────────────────
function setConnStatus(status) {
  const pill = $('#pillConn'), txt = $('#connTxt'), banner = $('#connBanner');
  const map = {
    connecting: ['подключение…', ''], connected: ['онлайн', 'ok'],
    disconnected: ['нет связи', 'err'], reconnecting: ['переподключение…', 'warn'],
  };
  const [t, k] = map[status] || ['—', ''];
  txt.textContent = t;
  pill.className = `pill ${k}`;
  banner.classList.toggle('show', status !== 'connected');
}
function updateClockPill() {
  const c = socket.clock;
  const el = $('#clockTxt');
  if (!c.synced) { el.textContent = '—'; return; }
  el.textContent = `${c.rtt} мс`;
  $('#pillClock').className = `pill ${c.rtt < 120 ? 'ok' : c.rtt < 300 ? 'warn' : 'err'}`;
  $('#setOffset').textContent = `${c.offset > 0 ? '+' : ''}${Math.round(c.offset)} мс`;
  $('#setRtt').textContent = `${c.rtt} мс`;
  $('#setQuality').textContent = `${Math.round(c.quality * 100)}%`;
}
function updateMicPill() {
  const on = S.micOn && !voice.muted;
  $('#micStateTxt').textContent = on ? 'вкл' : 'выкл';
  $('#pillMic').className = `pill ${on ? 'ok' : ''}`;
}

// ─── серверные данные ────────────────────────────────────────────────────────
async function loadSongIndex() {
  try {
    const r = await fetch(api('/api/songs'));
    S.songsIndex = await r.json();
    $('#statSongs').textContent = S.songsIndex.length;
    return S.songsIndex;
  } catch { return []; }
}
async function getSong(id) {
  if (S.songCache.has(id)) return S.songCache.get(id);
  const r = await fetch(api(`/api/songs/${encodeURIComponent(id)}`));
  if (!r.ok) throw new Error('Не удалось загрузить партитуру');
  const s = await r.json();
  S.songCache.set(id, s);
  return s;
}
async function loadStats() {
  try {
    const [st, lb] = await Promise.all([
      fetch(api('/api/stats')).then(r => r.json()),
      fetch(api('/api/leaderboard')).then(r => r.json()),
    ]);
    $('#statMatches').textContent = st.matches ?? 0;
    $('#statAvg').textContent = st.avgTeamScore ?? '—';
    $('#statPlayers').textContent = st.players ?? 0;
    return { st, lb };
  } catch { return null; }
}

// ─── КОМНАТА ─────────────────────────────────────────────────────────────────
function renderRoom(room) {
  if (!room) return;
  S.room = room;
  const code = room.code || socket.code || '';
  $('#codeDisplay').innerHTML = [...String(code).padEnd(6, '·')]
    .map(d => `<span class="d">${d}</span>`).join('');

  const phaseMap = {
    lobby: ['ожидание игроков', 'warn'], countdown: ['отсчёт', 'ok'],
    playing: ['поём', 'ok'], results: ['результаты', 'ok'],
  };
  const [ptxt, pk] = phaseMap[room.phase] || ['—', ''];
  $('#roomPhasePill').innerHTML = `<span class="led"></span><span>${ptxt}</span>`;
  $('#roomPhasePill').className = `pill ${pk}`;

  room.players.forEach((p, i) => {
    const el = $(`#slot${i}`);
    if (!el) return;
    const mine = p.sessionId === socket.sessionId;
    el.classList.toggle('filled', true);
    el.classList.toggle('me', mine);
    el.innerHTML = `
      <div class="avatar">${escapeHtml((p.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="name">${escapeHtml(p.name)}${mine ? ' <small class="faint">(вы)</small>' : ''}</div>
      <div class="role">партия ${p.part}${p.part === 'A' ? ' · игрок 1' : ' · игрок 2'}</div>
      <div class="ready-state ${p.ready ? 'on' : ''}">${p.connected ? (p.ready ? '✓ готов' : 'не готов') : '⚠ нет связи'}</div>
      <div class="row" style="gap:6px;justify-content:center">
        ${p.micOn ? '<span class="pill ok" style="font-size:11px;padding:3px 8px">🎙</span>' : '<span class="pill" style="font-size:11px;padding:3px 8px">🔇</span>'}
        <span class="pill" style="font-size:11px;padding:3px 8px">${p.latency ?? 0} мс</span>
      </div>`;
  });
  const emptySlot = $('#slot1');
  if (room.players.length < 2 && emptySlot) {
    emptySlot.classList.remove('filled', 'me');
    emptySlot.innerHTML = `<div class="avatar">?</div><div class="name">Свободное место</div>
      <div class="role">партия B</div><div class="ready-state">ждём второго игрока</div>`;
  }

  const me = room.players.find(p => p.sessionId === socket.sessionId);
  if (me) {
    S.myPart = me.part;
    S.peerPart = me.part === 'A' ? 'B' : 'A';
    $('#myPartBadge').textContent = `ПАРТИЯ ${me.part}`;
    $('#myPartBadge').className = `badge-part ${me.part.toLowerCase()}`;
    $('#btnReady').textContent = me.ready ? `✓ Готов (${me.part}) — отменить` : `Я готов петь (${me.part})`;
    $('#btnReady').className = me.ready ? 'btn-lg btn-block' : 'btn-primary btn-lg';
    $('#readyHint').textContent = me.ready
      ? 'Ждём готовности партнёра…'
      : 'Оба игрока должны нажать «готов» — тогда сервер выберет песню и назначит момент старта.';
  }
  if (room.songId) {
    const s = S.songsIndex.find(x => x.id === room.songId);
    if (s) {
      $('#roomSongTitle').textContent = s.title;
      $('#roomSongMeta').textContent = `${s.artist} · ${s.bpm} BPM · ${fmt(s.duration)} с · ${s.notes.A + s.notes.B} нот`;
    }
  }
  S.peerConnected = room.players.length === 2 && room.players.every(p => p.connected);
  $('#gamePartnerTxt').textContent = room.players.length === 2 ? room.players.find(p => p.part === S.peerPart)?.name || 'партнёр' : 'нет партнёра';
  $('#gamePartnerPill').className = `pill ${S.peerConnected ? 'ok' : 'warn'}`;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── ГОЛОС ───────────────────────────────────────────────────────────────────
async function enableMic(deviceId = null) {
  try {
    await voice.ensureMic(deviceId || S.settings.deviceId || undefined);
    S.micOn = true;
    updateMicPill();
    toast('Микрофон включён', 'ok');
    socket.send('mic', { on: true, muted: voice.muted, level: 0 });
    if (S.room?.players?.length === 2 && !voice.pc) await setupPeerCall();
    refreshDevices();
    return true;
  } catch (e) {
    console.warn(e);
    toast(`Микрофон недоступен: ${e.message}`, 'err', 6000);
    S.micOn = false;
    updateMicPill();
    return false;
  }
}

async function setupPeerCall() {
  const peer = S.room?.players?.find(p => p.sessionId !== socket.sessionId);
  if (!peer) return;
  if (!voice.localStream) { const ok = await enableMic(); if (!ok) return; }
  const amHost = S.room.players[0]?.sessionId === socket.sessionId;
  await voice.createPeer(amHost, peer.sessionId);
  if (amHost) await voice.makeOffer();
  $('#voiceHint').textContent = 'Устанавливаем головое соединение…';
}

function toggleMuteGame() {
  const next = !voice.muted;
  voice.setMuted(next);
  socket.send('mic', { on: S.micOn, muted: next, level: 0 });
  $('#btnGameMute').textContent = next ? '🎙 Включить микрофон' : '🔇 Микрофон';
  updateMicPill();
}

// индикаторы уровня
function meterLoop() {
  const t = performance.now();
  const level = S.micOn ? voice.readMicLevel() : 0;
  const peerLevel = voice.readPeerLevel();
  const db = level > 0 ? Math.round(20 * Math.log10(level + 1e-6)) : null;
  const setMeter = (sel, v) => { const el = $(sel); if (el) el.style.width = `${clamp(v * 100, 0, 100)}%`; };
  setMeter('#micMeter', level);
  setMeter('#roomMicMeter', level);
  setMeter('#gameMicMeter', level);
  setMeter('#micPeerMeter', peerLevel);
  setMeter('#roomPeerMeter', peerLevel);
  setMeter('#gamePeerMeter', peerLevel);
  const setTxt = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  setTxt('#micDbTxt', db == null ? '— дБ' : `${db} дБ`);
  setTxt('#roomMicDb', db == null ? '— дБ' : `${db} дБ`);
  setTxt('#peerVoiceDb', voice._peerAnalyser ? `${Math.round(20 * Math.log10(peerLevel + 1e-6))} дБ` : '— дБ');
  setTxt('#gameMicLevelTxt', `${Math.round(level * 100)}%`);
  if (socket.connected && S.screen === 'game' && t - S.lastFrameAt > 250) {
    S.lastFrameAt = t;
    socket.send('mic', { on: S.micOn, muted: voice.muted, level: Math.round(level * 100) / 100 });
  }
  const iceMap = { new: 'ожидание', checking: 'проверка', connected: 'соединено', completed: 'соединено', disconnected: 'обрыв', failed: 'ошибка', closed: 'закрыто' };
  setTxt('#iceTxt', iceMap[voice.iceState] || '—');
  setTxt('#iceType', voice.stats.type || '—');
  setTxt('#iceRtt', voice.stats.rtt != null ? `${voice.stats.rtt} мс` : '—');
  setTxt('#iceBr', voice.stats.bitrate ? `${voice.stats.bitrate} кбит/с` : '—');
  const vp = $('#peerVoicePill');
  if (vp) {
    const st = voice.pc?.connectionState;
    vp.innerHTML = `<span class="led"></span><span>${st === 'connected' ? 'соединено' : st === 'connecting' ? 'подключение' : st === 'failed' ? 'ошибка' : 'нет'}</span>`;
    vp.className = `pill ${st === 'connected' ? 'ok' : st === 'connecting' ? 'warn' : st === 'failed' ? 'err' : ''}`;
  }
  const pp = $('#micPeerPill');
  if (pp) {
    const inRoom = S.room?.players?.length === 2;
    pp.innerHTML = `<span class="led"></span><span>${inRoom ? (voice.pc?.connectionState === 'connected' ? 'соединено' : 'в комнате') : 'не в комнате'}</span>`;
    pp.className = `pill ${voice.pc?.connectionState === 'connected' ? 'ok' : ''}`;
  }
  requestAnimationFrame(meterLoop);
}

// ─── МУЗЫКА ──────────────────────────────────────────────────────────────────
/**
 * Готовит стемы и запускает синхронное воспроизведение.
 * @param {object} msg song-assigned: {songId, startAt, serverTime, leadMs, assignments}
 */
async function prepareAndPlay(msg) {
  const token = ++S.renderToken;
  const song = await getSong(msg.songId);
  if (token !== S.renderToken) return;
  S.song = song;
  S.peerOnsets = [];
  S.myResult = null;
  S.analyser = new PerformanceAnalyzer();

  const ctx = voice._ctx || new (window.AudioContext || window.webkitAudioContext)();
  voice._ctx = ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  showCountdown(song, msg);
  $('#gameSongTitle').textContent = song.title;
  $('#gameSongMeta').textContent = `${song.artist} · ${song.bpm} BPM · ${song.totalBars} тактов`;
  $('#gamePartBadge').textContent = `ПАРТИЯ ${S.myPart}`;
  $('#gamePartBadge').className = `badge-part ${S.myPart.toLowerCase()}`;
  $('#gamePartnerPart').textContent = `ПАРТИЯ ${S.peerPart}`;
  $('#gamePartnerPart').className = `badge-part ${S.peerPart.toLowerCase()}`;
  renderSections(song);
  renderNoteChips(song.vocal[S.myPart], song);

  // синтез стемов (может занять 0,5–2 c — начинаем сразу после назначения старта)
  await new Promise(r => setTimeout(r, 30));
  const renderer = new StemRenderer(song, ctx.sampleRate);
  const stems = renderer.renderAll();
  if (token !== S.renderToken) return;
  S.stems = stems;

  const clock = new MusicClock(ctx, {
    song, stems,
    startAtServer: msg.startAt,
    clockOffsetMs: socket.clock.offset,
    listenPart: S.myPart,
  });
  clock.setVolumes({
    inst: S.settings.inst, ownGuide: S.settings.own,
    auxGuide: 0, master: S.settings.master,
  });
  S.clock = clock;

  // ждём момента старта: инициируем запуск заранее на 1,5 с
  const waitMs = Math.max(0, msg.startAt - socket.serverNow() - 600);
  await new Promise(r => setTimeout(r, waitMs));
  if (token !== S.renderToken) return;

  S.myResultSubmitted = false;
  navigateToGame();
  clock.start();
  startTickLoop();
  startAnalyzeLoop();
  closeCountdown();
}

function startTickLoop() {
  clearInterval(S.tickId);
  S.tickId = setInterval(() => {
    if (!S.clock) return;
    const { driftMs, rate } = S.clock.tick();
    $('#gameDrift').textContent = Math.round(driftMs);
    const p = $('#gameDriftPill');
    p.className = `pill ${Math.abs(driftMs) < 120 ? 'ok' : Math.abs(driftMs) < 400 ? 'warn' : 'err'}`;
    socket.send('drift', { drift: Math.round(driftMs), rate, corrected: Math.abs(driftMs) > 120 });
  }, 1000);
}

/**
 * Анализ исполнения: фиксированный шаг 20 мс (50 Гц) по часам AudioContext.
 * requestAnimationFrame в фоновой вкладке троттлится, поэтому кадры анализа
 * снимаются таймером, а rAF используется только для отрисовки.
 */
function startAnalyzeLoop() {
  cancelAnimationFrame(S.rafId);
  clearInterval(S.analyzeTimer);
  S.analyzeTimer = setInterval(() => {
    if (!S.clock || !S.analyser) return;
    const pos = S.clock.desiredPosition();
    if (pos < -0.5) return;
    if (pos > S.song.durationSec + 0.6) {
      if (!S.myResultSubmitted) submitResult();
      clearInterval(S.analyzeTimer);
      return;
    }
    const an = voice.analyser;
    let freq = null, rms = 0;
    if (an && S.micOn && !voice.muted) {
      if (!S._frameBuf || S._frameBuf.length !== an.fftSize) S._frameBuf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(S._frameBuf);
      const buf = S._frameBuf;
      let sq = 0;
      for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
      rms = Math.sqrt(sq / buf.length);
      freq = detectPitch(buf, an.context.sampleRate);
    }
    const clamped = Math.max(0, Math.min(pos, S.song.durationSec));
    S.analyser.pushFrame(clamped, freq, rms);
    S.currentFreq = freq;
    if (S.forceFinish && !S.myResultSubmitted) return submitResult();
    // прогресс партнёру (редко, чтобы не забивать канал)
    if (!S._lastProgressAt || performance.now() - S._lastProgressAt > 700) {
      S._lastProgressAt = performance.now();
      socket.send('progress', { progress: clamped / S.song.durationSec });
    }
    if (!S._lastMicAt || performance.now() - S._lastMicAt > 300) {
      S._lastMicAt = performance.now();
      socket.send('mic', { on: S.micOn, muted: voice.muted, level: Math.round(levelFromBuf(S._frameBuf) * 100) / 100 });
    }
  }, 20);

  // отрисовка
  const draw = () => {
    if (S.clock && S.screen === 'game') {
      const pos = S.clock.desiredPosition();
      if (pos >= 0) updateGameUI(pos, S.currentFreq);
    }
    S.rafId = requestAnimationFrame(draw);
  };
  S.rafId = requestAnimationFrame(draw);
}

function levelFromBuf(buf) {
  if (!buf) return 0;
  let sq = 0;
  for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
  return Math.sqrt(sq / buf.length);
}

let currentLineIndex = -1;
function updateGameUI(pos, freq) {
  const song = S.song;
  const progress = clamp(pos / song.durationSec, 0, 1);
  $('#gameProgress').style.width = `${progress * 100}%`;
  highlightSection(pos);

  const beat = 60 / song.bpm;
  const notes = S.myNotes || (S.myNotes = buildNoteTimeline(song, S.myPart));
  const lines = song.vocal[S.myPart];
  // активная строка
  let li = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = (lines[i].bar * song.beatsPerBar + lines[i].beat) * beat;
    const total = lines[i].syllables.reduce((a, s) => a + s.d, 0) * beat;
    if (pos >= start - 1.6 && pos <= start + total + 0.4) { li = i; break; }
  }
  if (li !== currentLineIndex) {
    currentLineIndex = li;
    renderLyricsLines(pos, li);
  }
  updateSyllableStates(pos);
  drawPitchLane(pos);

  // текущая нота
  const active = notes.find(n => pos >= n.start && pos <= n.end);
  $('#gameNoteNow').textContent = active ? `${noteName(active.midi)} · «${active.syl}»` : '—';
  $('#gameLatency').textContent = `${socket.clock.rtt} мс`;

  // живая точность
  if (active && freq) {
    const cents = 1200 * Math.log2(freq / active.freq);
    const acc = Math.max(0, 1 - Math.abs(cents) / 120);
    S.liveAcc.push(acc);
    if (S.liveAcc.length > 90) S.liveAcc.shift();
  }
  if (S.liveAcc.length > 8) {
    const a = S.liveAcc.reduce((x, y) => x + y, 0) / S.liveAcc.length;
    $('#gameLiveAcc').textContent = `${Math.round(a * 100)}%`;
  }

  updatePartnerLyrics(pos);
  updateCoach(pos, notes);
  const partnerProgress = Number.isFinite(S.peerProgress) ? S.peerProgress : progress;
  $('#gamePartnerProgress').textContent = `${Math.round(partnerProgress * 100)}%`;
  const st = voice.pc?.connectionState;
  $('#gamePartnerStatus').textContent = st === 'connected' ? 'на связи · поёт' : S.peerConnected ? 'в комнате' : 'нет связи';
}

function renderLyricsLines(pos, activeIndex) {
  const song = S.song, lines = song.vocal[S.myPart], beat = 60 / song.bpm;
  const container = $('#gameSylLine');
  const pick = [];
  if (activeIndex >= 0) {
    const lineStart = (lines[activeIndex].bar * song.beatsPerBar + lines[activeIndex].beat) * beat;
    if (activeIndex > 0 && pos < lineStart + 0.8) pick.push({ ln: lines[activeIndex - 1], prev: true });
    pick.push({ ln: lines[activeIndex], active: true });
    if (lines[activeIndex + 1]) pick.push({ ln: lines[activeIndex + 1], next: true });
  } else if (lines.length) pick.push({ ln: lines[0], next: true });
  container.innerHTML = pick.map(({ ln, prev, next }) => {
    const start = (ln.bar * song.beatsPerBar + ln.beat) * beat;
    // слоги группируются в слова, чтобы слова не разрывались переносом
    let html = '', open = false;
    ln.syllables.forEach((sy, i) => {
      if (sy.w === 1) { if (open) html += '</span>'; html += '<span class="word">'; open = true; }
      html += `<span class="syl${next ? ' soon' : prev ? ' past' : ''}" data-i="${i}">${escapeHtml(sy.t)}</span>`;
    });
    if (open) html += '</span>';
    return `<div class="syl-line${prev ? ' prev-line' : ''}" data-start="${start}">${html}</div>`;
  }).join('');
}

let lastLineStart = null;
function updateSyllableStates(pos) {
  const lineEls = $$('#gameSylLine .syl-line');
  const song = S.song, beat = 60 / song.bpm;
  lineEls.forEach((lineEl) => {
    const start = Number(lineEl.dataset.start);
    // найдём строку в партитуре
    const ln = song.vocal[S.myPart].find(l => (l.bar * song.beatsPerBar + l.beat) * beat === start);
    if (!ln) return;
    let t = start;
    [...lineEl.children].forEach((el, i) => {
      const sy = ln.syllables[i];
      if (!sy) return;
      const dur = sy.d * beat;
      const on = pos >= t && pos < t + dur;
      el.classList.toggle('active', on);
      if (pos >= t + dur) el.classList.remove('soon');
      t += dur;
    });
  });
}

function renderSections(song) {
  const el = $('#gameSections');
  el.innerHTML = song.form.map((f, i) =>
    `<div class="sec" data-i="${i}" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>`).join('');
}
function highlightSection(pos) {
  const song = S.song;
  const barDur = song.beatsPerBar * 60 / song.bpm;
  const bar = pos / barDur;
  let acc = 0, idx = 0;
  for (let i = 0; i < song.form.length; i++) {
    if (bar >= acc && bar < acc + song.form[i].bars) { idx = i; break; }
    acc += song.form[i].bars;
  }
  $$('#gameSections .sec').forEach((el, i) => el.classList.toggle('on', i === idx));
}

function renderNoteChips(lines, song) {
  const beat = 60 / song.bpm;
  const notes = buildNoteTimeline(song, S.myPart);
  const el = $('#gameNotes');
  el.innerHTML = notes.slice(0, 18).map((n, i) =>
    `<span class="note-chip" data-start="${n.start}" data-i="${i}">${noteName(n.midi)}</span>`).join('') +
    `<span class="note-chip faint">+${Math.max(0, notes.length - 18)}</span>`;
}
function updateNoteChips(pos) {
  $$('#gameNotes .note-chip[data-start]').forEach(el => {
    const s = Number(el.dataset.start);
    el.classList.toggle('on', pos >= s - 0.1 && pos < s + 0.5);
  });
}

const laneCanvas = () => $('#pitchLane');
function drawPitchLane(pos) {
  const c = laneCanvas();
  if (!c) return;
  const ctx2 = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.clearRect(0, 0, w, h);
  const song = S.song;
  const notes = S.myNotes || [];
  const windowSec = 4.5;
  const t0 = pos - 0.7, t1 = t0 + windowSec;
  const inWin = notes.filter(n => n.end > t0 && n.start < t1);
  if (!inWin.length) { updateNoteChips(pos); return; }
  const midis = inWin.map(n => n.midi);
  const lo = Math.min(...midis) - 4, hi = Math.max(...midis) + 4;
  const y = (m) => h - ((m - lo) / (hi - lo)) * h;
  const x = (t) => ((t - t0) / windowSec) * w;
  // сетка
  ctx2.strokeStyle = 'rgba(255,255,255,.06)';
  for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) {
    ctx2.beginPath(); ctx2.moveTo(0, y(m)); ctx2.lineTo(w, y(m)); ctx2.stroke();
  }
  // ноты
  inWin.forEach(n => {
    const xx = x(n.start), ww = Math.max(6, x(n.start + n.dur) - xx);
    const active = pos >= n.start && pos <= n.end;
    ctx2.fillStyle = active ? 'rgba(35,240,255,.85)' : 'rgba(139,92,255,.45)';
    ctx2.shadowColor = active ? 'rgba(35,240,255,.9)' : 'transparent';
    ctx2.shadowBlur = active ? 18 : 0;
    const yy = y(n.midi), hh = 9;
    ctx2.beginPath();
    if (ctx2.roundRect) ctx2.roundRect(xx, yy - hh / 2, ww, hh, 4); else ctx2.rect(xx, yy - hh / 2, ww, hh);
    ctx2.fill();
  });
  ctx2.shadowBlur = 0;
  // поющийся звук
  if (S.currentFreq && pos > 0) {
    const m = 69 + 12 * Math.log2(S.currentFreq / 440);
    const cy = y(m);
    if (cy > 0 && cy < h) {
      const grad = ctx2.createRadialGradient(w * 0.22, cy, 0, w * 0.22, cy, 26);
      grad.addColorStop(0, 'rgba(61,255,168,.95)');
      grad.addColorStop(1, 'rgba(61,255,168,0)');
      ctx2.fillStyle = grad;
      ctx2.beginPath(); ctx2.arc(w * 0.22, cy, 26, 0, Math.PI * 2); ctx2.fill();
    }
  }
  // курсор «сейчас»
  ctx2.strokeStyle = 'rgba(255,255,255,.5)';
  ctx2.beginPath(); ctx2.moveTo(x(pos), 0); ctx2.lineTo(x(pos), h); ctx2.stroke();
  updateNoteChips(pos);
}

/** Подсказка «когда вступать» — по ближайшей ноте своей партии */
function updateCoach(pos, notes) {
  const el = $('#gameCoachTxt'), box = $('#gameCoach');
  if (!el) return;
  const next = notes.find(n => n.start > pos + 0.05);
  const active = notes.find(n => pos >= n.start && pos <= n.end);
  if (active) {
    el.innerHTML = `Поёте <b>«${escapeHtml(active.syl)}»</b> · держите ноту <b>${noteName(active.midi)}</b>`;
    box.className = 'coach';
  } else if (next) {
    const inSec = next.start - pos;
    el.innerHTML = inSec < 3
      ? `Вступление через <b>${inSec.toFixed(1)} с</b> — «${escapeHtml(next.syl)}» (${noteName(next.midi)})`
      : `Держите дыхание: следующая фраза через <b>${Math.round(inSec)} с</b>`;
    box.className = inSec < 3 ? 'coach warn' : 'coach';
  } else {
    el.textContent = 'Финальная нота — держите вместе с партнёром';
    box.className = 'coach';
  }
}

function submitResult() {
  if (!S.analyser || S.myResultSubmitted) return;
  S.myResultSubmitted = true;
  const { score, perNote, onsets } = S.analyser.finish(S.peerOnsets, S.song, S.myPart, S.peerPart);
  S.myResult = { score, perNote };
  socket.send('result', {
    result: { score, onsets, part: S.myPart, songId: S.song.id, at: Date.now() },
  });
  showWaitingOverlay();
}

// ─── ОВЕРЛЕИ ─────────────────────────────────────────────────────────────────
function showCountdown(song, msg) {
  closeCountdown();
  const el = document.createElement('div');
  el.className = 'countdown';
  el.id = 'countdownOverlay';
  el.innerHTML = `
    <div>
      <div class="song-title">${escapeHtml(song.title)}</div>
      <div class="num" id="cdNum">5</div>
      <div class="sub">Старт по серверному времени<br>
        <span class="mono">${new Date(msg.startAt).toLocaleTimeString('ru-RU')}</span>
        · вы поёте партию <b>${S.myPart}</b></div>
    </div>`;
  $('#overlays').append(el);
  const timer = setInterval(() => {
    const left = Math.ceil((msg.startAt - socket.serverNow()) / 1000);
    const num = $('#cdNum');
    if (!num) return clearInterval(timer);
    num.textContent = left > 0 ? left : '♪';
    if (left <= 0) clearInterval(timer);
  }, 120);
  el._timer = timer;
}
function closeCountdown() {
  const el = $('#countdownOverlay');
  if (el) { clearInterval(el._timer); el.remove(); }
}

function showWaitingOverlay() {
  closeWaitingOverlay();
  const el = document.createElement('div');
  el.className = 'countdown';
  el.id = 'waitOverlay';
  el.innerHTML = `<div class="center">
      <div class="num" style="font-size:clamp(48px,10vw,84px)">✓</div>
      <div class="song-title" style="font-size:22px">Ваша партия записана</div>
      <div class="sub">Ждём результат партнёра…</div></div>`;
  $('#overlays').append(el);
}
function closeWaitingOverlay() { $('#waitOverlay')?.remove(); }

function navigateToGame() {
  nav('game');
  const badge = $('#gamePartBadge');
  badge.textContent = `ПАРТИЯ ${S.myPart}`;
  badge.className = `badge-part ${S.myPart.toLowerCase()}`;
  $('#gameSongTitle').textContent = S.song.title;
  S.myNotes = buildNoteTimeline(S.song, S.myPart);
  renderPartnerLyrics();
}

function renderPartnerLyrics() {
  const song = S.song;
  const lines = song.vocal[S.peerPart] || [];
  const beat = 60 / song.bpm;
  const start = lines.length ? (lines[0].bar * song.beatsPerBar + lines[0].beat) * beat : 0;
  $('#gamePartnerLyrics').innerHTML = lines.length
    ? `<div class="syl-line" data-start="${start}">${lines[0].syllables.map((sy) =>
        `<span class="syl soon${sy.w ? ' w' : ''}">${escapeHtml(sy.t)}</span>`).join('')}</div>`
    : '<div class="syl-line"><span class="syl faint">—</span></div>';
  S.partnerRenderedLine = 0;
}

/** Подсветка партии партнёра (по той же шкале времени) */
function updatePartnerLyrics(pos) {
  const song = S.song;
  if (!song) return;
  const lines = song.vocal[S.peerPart] || [];
  const beat = 60 / song.bpm;
  const el = $('#gamePartnerLyrics');
  if (!el) return;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const st = (lines[i].bar * song.beatsPerBar + lines[i].beat) * beat;
    const dur = lines[i].syllables.reduce((a, x) => a + x.d, 0) * beat;
    if (pos >= st - 1.2 && pos <= st + dur + 0.3) { idx = i; break; }
  }
  if (idx !== S.partnerRenderedLine || !el.querySelector('.syl')) {
    S.partnerRenderedLine = idx;
    const ln = idx >= 0 ? lines[idx] : lines[0];
    if (!ln) return;
    const st = (ln.bar * song.beatsPerBar + ln.beat) * beat;
    let html = '', open = false;
    ln.syllables.forEach((sy) => {
      if (sy.w === 1) { if (open) html += '</span>'; html += '<span class="word">'; open = true; }
      html += `<span class="syl soon">${escapeHtml(sy.t)}</span>`;
    });
    if (open) html += '</span>';
    el.innerHTML = `<div class="syl-line" data-start="${st}">${html}</div>`;
  }
  const lineEl = el.querySelector('.syl-line');
  if (!lineEl) return;
  const st = Number(lineEl.dataset.start);
  const ln = lines.find(l => (l.bar * song.beatsPerBar + l.beat) * beat === st);
  if (!ln) return;
  let t = st;
  [...lineEl.querySelectorAll('.syl')].forEach((sp, i) => {
    const sy = ln.syllables[i];
    if (!sy) return;
    const on = pos >= t && pos < t + sy.d * beat;
    sp.classList.toggle('active', on);
    sp.classList.toggle('soon', pos < t);
    t += sy.d * beat;
  });
}

// ─── РЕЗУЛЬТАТЫ ──────────────────────────────────────────────────────────────
function showResults(res) {
  closeWaitingOverlay();
  closeCountdown();
  S.result = res;
  S.clock?.stop();
  clearInterval(S.tickId);
  clearInterval(S.analyzeTimer);
  cancelAnimationFrame(S.rafId);
  nav('results');

  const t = res.team;
  $('#resSong').textContent = res.songTitle;
  $('#resTotal').textContent = t.total == null ? '—' : Math.round(t.total);
  const verdict = t.total == null ? 'Результат недоступен'
    : t.total >= 90 ? 'Идеальный дуэт! Вы спели как одно целое.'
    : t.total >= 75 ? 'Отличный дуэт — партии легли друг на друга.'
    : t.total >= 55 ? 'Хорошо! Ритм и строй местами расходились.'
    : t.total >= 30 ? 'Есть над чем поработать вместе.'
    : 'Попробуйте ещё раз — слушайте друг друга.';
  $('#resVerdict').textContent = verdict;
  $('#resSubtitle').textContent = res.team.incomplete ? 'Командный результат (неполный)' : 'Командный результат';

  const setBar = (barSel, valSel, v) => {
    $(barSel).style.width = v == null ? '0%' : `${clamp(v, 0, 100)}%`;
    $(valSel).textContent = v == null ? '—' : fmt(v, 1);
  };
  setBar('#barPitch', '#valPitch', t.pitch);
  setBar('#barRhythm', '#valRhythm', t.rhythm);
  setBar('#barSync', '#valSync', t.sync);

  $('#resPlayers').innerHTML = res.entries.map(e => {
    const s = e.score;
    return `<div class="player-card">
      <h4><span class="badge-part ${e.part.toLowerCase()}">ПАРТИЯ ${e.part}</span>
        <span>${escapeHtml(e.name)}</span></h4>
      ${s ? `<div class="mini-stats">
        <div class="ms"><b>${s.pitch == null ? '—' : Math.round(s.pitch)}</b><span>ноты</span></div>
        <div class="ms"><b>${s.rhythm == null ? '—' : Math.round(s.rhythm)}</b><span>ритм</span></div>
        <div class="ms"><b>${s.sync == null ? '—' : Math.round(s.sync)}</b><span>синхр.</span></div>
      </div>
      <ul class="list-plain" style="margin-top:10px">
        <li><span>Точность партии</span><b>${s.accuracy == null ? '—' : fmt(s.accuracy, 1)}</b></li>
        <li><span>Попаданий в ноты</span><b>${s.notesHit} / ${s.notesTotal}</b></li>
        <li><span>Медиана отклонения</span><b>${s.medianCents == null ? '—' : s.medianCents + ' ¢'}</b></li>
        <li><span>Онсетов</span><b>${s.onsets}</b></li>
      </ul>`
      : `<p class="faint">Партнёр не прислал результат${e.timeout ? ' (таймаут)' : ''}.</p>`}
    </div>`;
  }).join('');

  const tech = [];
  tech.push(`<li><span>Ноты (медианный цент)</span><b>${t.pitch ?? '—'}</b></li>`);
  tech.push(`<li><span>Ритм (онсеты, окно 300 мс)</span><b>${t.rhythm ?? '—'}</b></li>`);
  tech.push(`<li><span>Синхронность (окно 450 мс)</span><b>${t.sync ?? '—'}</b></li>`);
  tech.push(`<li><span>Формула</span><b>50·ноты + 30·ритм + 20·синхр.</b></li>`);
  if (res.duetCoverage) tech.push(`<li><span>Обе партии звучат вместе</span><b>${Math.round(res.duetCoverage.ratio * 100)}% таймлайна</b></li>`);
  tech.push(`<li><span>Анализ выполнен</span><b>на устройстве</b></li>`);
  $('#resTech').innerHTML = tech.join('');

  loadStats().then(d => {
    if (!d) return;
    const lb = d.lb.slice(0, 5);
    $('#resLeaderboard').innerHTML = lb.length
      ? lb.map((m, i) => `<li><span>${i + 1}. ${escapeHtml(m.names.join(' + '))}</span><b>${m.total}</b></li>`).join('')
      : '<li><span class="faint">Пока нет записей</span></li>';
  });
  $('#rematchHint').textContent = 'Реванш: обе стороны нажимают кнопку — комната вернётся в лобби.';
}

// ─── БИБЛИОТЕКА ──────────────────────────────────────────────────────────────
async function renderLibrary() {
  if (!S.songsIndex.length) await loadSongIndex();
  const grid = $('#libraryGrid');
  grid.innerHTML = S.songsIndex.map(s => `
    <div class="song-card" data-id="${s.id}">
      <div class="cover">${s.id === 'kalinka' ? '🔥' : s.id === 'bereza' ? '🌳' : s.id === 'amazing_grace' ? '🕊' : '🌸'}</div>
      <div>
        <div class="song-title">${escapeHtml(s.title)}</div>
        <div class="faint" style="font-size:12.5px">${escapeHtml(s.artist)}</div>
      </div>
      <div class="song-meta">
        <span class="tag">${s.bpm} BPM</span>
        <span class="tag">${fmt(s.duration)} с</span>
        <span class="tag">${s.notes.A + s.notes.B} нот</span>
        <span class="tag live">2 партии</span>
      </div>
      <div class="song-meta">
        <span class="tag">сложность ${'★'.repeat(s.difficulty)}${'☆'.repeat(3 - s.difficulty)}</span>
        <span class="tag">${escapeHtml(s.parts.A)} / ${escapeHtml(s.parts.B)}</span>
      </div>
    </div>`).join('');
  $$('#libraryGrid .song-card').forEach(card => {
    card.addEventListener('click', () => showSongDetail(card.dataset.id));
  });
  if (S.songsIndex[0]) showSongDetail(S.songsIndex[0].id);
}

async function showSongDetail(id) {
  const song = await getSong(id);
  const beat = 60 / song.bpm;
  const preview = (part) => {
    const n = buildNoteTimeline(song, part).slice(0, 8);
    return n.map(x => noteName(x.midi)).join(' ');
  };
  $('#songDetail').innerHTML = `
    <div class="row between">
      <div>
        <h3 style="margin-bottom:2px">${escapeHtml(song.title)}</h3>
        <div class="faint" style="font-size:12.5px">${escapeHtml(song.artist)} · ${escapeHtml(song.license)}</div>
      </div>
      <span class="pill ok"><span class="led"></span>разметка готова</span>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="player-card">
        <h4><span class="badge-part a">ПАРТИЯ A</span><span>${escapeHtml(song.parts.A)}</span></h4>
        <p class="mono faint" style="font-size:12px;margin:8px 0 0">${preview('A')} …</p>
        <div class="faint" style="font-size:12.5px;margin-top:8px">
          ${song.vocal.A.length} фраз · ${song.vocal.A.reduce((s, l) => s + l.syllables.length, 0)} слогов</div>
      </div>
      <div class="player-card">
        <h4><span class="badge-part b">ПАРТИЯ B</span><span>${escapeHtml(song.parts.B)}</span></h4>
        <p class="mono faint" style="font-size:12px;margin:8px 0 0">${preview('B')} …</p>
        <div class="faint" style="font-size:12.5px;margin-top:8px">
          ${song.vocal.B.length} фраз · ${song.vocal.B.reduce((s, l) => s + l.syllables.length, 0)} слогов</div>
      </div>
    </div>
    <div class="row" style="margin-top:16px">
      <span class="tag">${song.bpm} BPM</span>
      <span class="tag">${song.beatsPerBar}/4</span>
      <span class="tag">${song.key === 'minor' ? 'минор' : 'мажор'}</span>
      <span class="tag">${song.totalBars} тактов</span>
      <span class="tag">${fmt(song.durationSec)} с</span>
    </div>
    <div class="divider"></div>
    <div class="sections">${song.form.map(f => `<div class="sec">${escapeHtml(f.name)} · ${f.bars}</div>`).join('')}</div>
    <div class="actions" style="margin-top:18px">
      <button class="btn-primary btn-sm" id="btnUseSong">Создать комнату с этой песней</button>
      <button class="btn-sm btn-ghost" id="btnPreviewSong">▶ Прослушать инструментал</button>
    </div>`;
  $('#btnUseSong').onclick = () => {
    S.preferredSong = song.id;
    nav('create');
    $('#createName').value = S.settings.name || '';
  };
  $('#btnPreviewSong').onclick = () => previewSong(song);
}

let previewCtx = null, previewNodes = [];
async function previewSong(song) {
  try {
    stopPreview();
    const ctx = previewCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    toast('Синтез превью…', '', 1500);
    const renderer = new StemRenderer(song, ctx.sampleRate);
    const stems = renderer.renderAll();
    const buf = ctx.createBuffer(2, stems.instrumental[0].length, ctx.sampleRate);
    buf.copyToChannel(stems.instrumental[0], 0);
    buf.copyToChannel(stems.instrumental[1], 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = S.settings.inst;
    src.connect(g).connect(ctx.destination);
    src.start(0, song.countdownBars * song.beatsPerBar * 60 / song.bpm);
    previewNodes = [src];
    toast('Превью инструментала (8 секунд)', 'ok');
    setTimeout(stopPreview, 8000);
  } catch (e) { toast('Не удалось проиграть: ' + e.message, 'err'); }
}
function stopPreview() {
  previewNodes.forEach(n => { try { n.stop(); } catch {} });
  previewNodes = [];
  try { previewCtx?.close(); } catch {}
  previewCtx = null;
}

// ─── НАСТРОЙКИ ───────────────────────────────────────────────────────────────
async function renderSettings() {
  const st = await fetch(api('/api/rtc-config')).then(r => r.json()).catch(() => null);
  if (st) {
    S.rtcConfig = st;
    $('#turnStatus').textContent = st.turnConfigured
      ? 'TURN-сервер настроен: голос пройдёт даже за симметричным NAT.'
      : 'TURN не настроен — используется только STUN (Google). Для строгих NAT задайте переменные TURN_URL / TURN_USERNAME / TURN_CREDENTIAL на сервере.';
    $('#iceServerList').innerHTML = st.iceServers.map(s =>
      `<li><span>${(Array.isArray(s.urls) ? s.urls : [s.urls]).join(', ')}</span><b>${s.credential ? 'авторизация' : '—'}</b></li>`).join('');
  }
  updateClockPill();
  const sessionId = socket.sessionId || '—';
  $('#diagList').innerHTML = `
    <li><span>Сервер</span><b>${ENDPOINTS.wsUrl.replace(/^wss?:\/\//, '')}</b></li>
    <li><span>Фронтенд</span><b>${location.host}</b></li>
    <li><span>Сессия</span><b class="mono">${sessionId.slice(0, 10)}…</b></li>
    <li><span>Комната</span><b class="mono">${socket.code || '—'}</b></li>
    <li><span>Состояние WS</span><b>${socket.connected ? 'открыто' : 'закрыто'}</b></li>
    <li><span>ICE-соединение</span><b>${voice.iceState || '—'}</b></li>
    <li><span>Аудио</span><b>${(window.AudioContext || window.webkitAudioContext) ? 'Web Audio API' : 'недоступно'}</b></li>`;
}

// ─── ОБРАБОТЧИКИ СОБЫТИЙ СЕТИ ────────────────────────────────────────────────
function bindSocket() {
  socket.on('status', ({ status }) => { setConnStatus(status); });
  socket.on('clock', () => updateClockPill());
  socket.on('reconnecting', ({ attempt }) => {
    setConnStatus('reconnecting');
    toast(`Связь потеряна. Переподключение (попытка ${attempt})…`, 'warn', 3000);
  });
  socket.on('reconnect-attempt', () => setConnStatus('connecting'));
  socket.on('neterror', ({ message }) => toast(message, 'err'));

  socket.on('joined', (msg) => {
    S.room = msg.room;
    S.myPart = msg.part;
    S.peerPart = msg.part === 'A' ? 'B' : 'A';
    renderRoom(msg.room);
    if (msg.resumed) toast('Сессия восстановлена', 'ok');
    if (S.screen !== 'room') nav('room');
    // если уже есть второй игрок — поднимаем голос
    if (msg.room.players.length === 2) {
      $('#voiceHint').textContent = 'Второй игрок в комнате. Включите микрофон, чтобы говорить.';
    }
  });

  socket.on('room', ({ room }) => {
    renderRoom(room);
    if (room.phase === 'lobby' && S.screen === 'results') { /* реванш — останемся */ }
  });

  socket.on('peer-joined', ({ sessionId, name, part }) => {
    toast(`${name} присоединился — партия ${part}`, 'ok');
    $('#voiceHint').textContent = 'Нажмите «Включить микрофон», чтобы слышать друг друга.';
    renderRoom(S.room);
  });

  socket.on('peer-left', ({ name, part }) => {
    toast(`${name} покинул комнату`, 'warn');
    voice.closePeer();
    if (S.screen === 'game' || S.screen === 'results') {
      closeWaitingOverlay(); closeCountdown(); S.clock?.stop();
      nav('room');
    }
  });

  socket.on('peer-disconnected', ({ name, graceSec }) => {
    toast(`${name} потерял связь. Ждём ${graceSec} с…`, 'warn', 5000);
    S.peerConnected = false;
  });

  socket.on('peer-mic', ({ on, muted, level }) => {
    const el = $('#peerVoiceDb');
    if (el && level != null) el.dataset.level = level;
  });

  socket.on('room-reset', ({ reason }) => {
    if (reason === 'rematch') { toast('Реванш — комната снова в лобби', 'ok'); nav('room'); }
    if (S.clock) { S.clock.stop(); S.clock = null; }
    clearInterval(S.tickId);
    clearInterval(S.analyzeTimer);
    cancelAnimationFrame(S.rafId);
  });

  socket.on('song-assigned', async (msg) => {
    S.peerOnsets = [];
    const a = msg.assignments.find(x => x.sessionId === socket.sessionId);
    if (a) { S.myPart = a.part; S.peerPart = a.part === 'A' ? 'B' : 'A'; }
    try {
      await prepareAndPlay(msg);
    } catch (e) {
      console.error(e);
      toast('Не удалось подготовить трек: ' + e.message, 'err', 6000);
    }
  });

  socket.on('peer-progress', ({ progress, score }) => {
    S.peerProgress = progress;
    if (score) $('#gamePartnerStatus').textContent = 'поёт…';
  });

  socket.on('peer-drift', ({ drift }) => {
    // метрика партнёра доступна для диагностики
    S.peerDrift = drift;
  });

  // партнёр сдал результат: получаем его онсеты (числа, не звук) и
  // пересчитываем синхронность локально, затем отправляем обновление
  const applyPeerResult = (result) => {
    S.peerOnsets = result.onsets || [];
    S.peerResultPending = true;
    if (S.myResult && !S.myResult.recomputed && S.analyser && S.song) {
      const { score, perNote } = S.analyser.finish(S.peerOnsets, S.song, S.myPart, S.peerPart);
      S.myResult = { score, perNote, recomputed: true };
      socket.send('result', {
        result: {
          score, onsets: S.analyser.onsets, part: S.myPart,
          songId: S.song.id, at: Date.now(), recomputed: true,
        },
      });
    }
  };
  socket.on('peer-result', ({ onsets, score }) => applyPeerResult({ onsets, score }));
  socket.on('result', ({ result }) => applyPeerResult(result));

  socket.on('results', ({ results }) => { showResults(results); });

  socket.on('waiting-peer-result', () => {
    showWaitingOverlay();
  });

  socket.on('rematch-vote', ({ count }) => {
    $('#rematchHint').textContent = `Голосов за реванш: ${count}/2`;
  });

  socket.on('error', ({ code, message }) => {
    toast(message || code, 'err', 5000);
    if (code === 'FULL' || code === 'NO_ROOM' || code === 'IN_PROGRESS') {
      socket.clearResume();
      if (S.screen === 'room' || S.screen === 'game') nav('join');
    }
  });

  // WebRTC-сигналинг
  ['rtc-offer', 'rtc-answer', 'rtc-ice', 'rtc-renegotiate'].forEach(t => {
    socket.on(t, (msg) => voice.handleSignal(t, msg).catch(e => console.warn('signal', t, e.message)));
  });

  voice.addEventListener('pc', (e) => {
    if (e.detail.state === 'connected') {
      toast('Голосовая связь установлена 🎧', 'ok');
      $('#voiceHint').textContent = 'Связь есть. Регулируйте громкость друг друга ползунком справа.';
    }
    if (e.detail.state === 'failed') toast('Голосовой канал потерян, восстанавливаю…', 'warn');
  });
  voice.addEventListener('mic', ({ detail }) => {
    S.micOn = detail.on;
    updateMicPill();
  });
  voice.addEventListener('audio-blocked', () => {
    toast('Нажмите в любом месте страницы, чтобы разрешить воспроизведение звука партнёра', 'warn', 6000);
  });
}

// ─── ОБРАБОТЧИКИ ИНТЕРФЕЙСА ──────────────────────────────────────────────────
function bindUI() {
  $$('[data-nav]').forEach(el => el.addEventListener('click', () => {
    const target = el.dataset.nav;
    if (target === 'back') {
      const prev = (S.backStack || []).pop() || 'menu';
      nav(prev);
    } else nav(target);
  }));

  $('#btnGoCreate').onclick = () => { nav('create'); $('#createName').value = S.settings.name || socket.name || ''; $('#createName').focus(); };
  $('#btnGoJoin').onclick = () => { nav('join'); $('#joinName').value = S.settings.name || socket.name || ''; $('#joinCode').focus(); };
  $('#btnGoLibrary').onclick = () => nav('library');

  // создание комнаты
  $('#btnCreateRoom').onclick = async () => {
    const name = ($('#createName').value || '').trim() || 'Игрок 1';
    S.settings.name = name; saveSettings();
    socket.name = name;
    socket.sessionId = null;
    localStorage.removeItem('rt.sessionId');
    // 1) просим у сервера свободный код комнаты (эндпоинт есть на обоих серверах)
    let code = null;
    try {
      const r = await fetch(api('/api/newcode')).then((x) => x.json());
      code = r?.code || null;
    } catch { code = null; }

    if (code) {
      // 2) открываем сокет сразу на эту комнату
      S.preferredSong = null;
      socket.openRoom(code, name);
      return;
    }
    // запасной путь (сервер не отдал код) — старый протокол create
    if (!socket.connected) {
      socket.connect();
      await new Promise((r) => setTimeout(r, 900));
    }
    if (!socket.connected) return toast('Нет связи с сервером. Проверьте интернет.', 'err', 5000);
    socket.send('create', { name, preferredSong: S.preferredSong || null });
    S.preferredSong = null;
  };

  // вход по коду
  const codeInput = $('#joinCode');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (codeInput.value.length === 6) $('#btnJoinRoom').focus();
  });
  $('#btnJoinRoom').onclick = async () => {
    const code = $('#joinCode').value.trim();
    const name = ($('#joinName').value || '').trim() || 'Игрок 2';
    if (code.length !== 6) return toast('Код комнаты — 6 цифр', 'warn');
    S.settings.name = name; saveSettings();
    socket.name = name;
    const check = await fetch(api(`/api/room/${code}`)).then(r => r.json()).catch(() => null);
    if (check && !check.exists) return toast(`Комната ${code} не найдена`, 'err');
    if (check && check.full) return toast('В комнате уже два игрока', 'err');
    socket.sessionId = null;
    socket.openRoom(code, name);
  };

  // комната: копирование кода
  $('#btnCopyCode').onclick = async () => {
    const code = S.room?.code || socket.code;
    try { await navigator.clipboard.writeText(code); toast('Код скопирован', 'ok'); }
    catch { toast(`Код: ${code}`, ''); }
  };
  $('#btnCopyLink').onclick = async () => {
    const code = S.room?.code || socket.code;
    const link = `${location.origin}/#join?code=${code}`;
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована', 'ok'); }
    catch { toast(link, ''); }
  };
  $('#btnShareCode').onclick = async () => {
    const code = S.room?.code || socket.code;
    const text = `Спой со мной в RHYME TOGETHER! Код комнаты: ${code}\n${location.origin}`;
    if (navigator.share) { try { await navigator.share({ title: 'RHYME TOGETHER', text }); } catch {} }
    else { try { await navigator.clipboard.writeText(text); toast('Приглашение скопировано', 'ok'); } catch {} }
  };

  $('#btnReady').onclick = () => {
    const me = S.room?.players?.find(p => p.sessionId === socket.sessionId);
    socket.send('ready', { ready: !me?.ready });
  };
  $('#btnRandomSong').onclick = () => {
    const pick = S.songsIndex[Math.floor(Math.random() * S.songsIndex.length)];
    if (!pick) return;
    socket.send('pick-song', { songId: pick.id });
    toast(`Пожелание: «${pick.title}»`, '', 2500);
  };
  $('#btnLeaveRoom').onclick = () => {
    socket.send('leave', {});
    socket.clearResume();
    S.clock?.stop(); S.clock = null;
    voice.closePeer();
    nav('menu');
  };
  $('#btnRoomMic').onclick = () => enableMic();
  $('#btnRoomMicSetup').onclick = () => nav('mic', 'room');
  $('#roomPeerVol').oninput = (e) => {
    S.settings.peerVol = Number(e.target.value); saveSettings();
    voice.setPeerVolume(S.settings.peerVol);
    $('#setPeerVol').value = S.settings.peerVol;
  };

  // микрофон
  $('#btnMicEnable').onclick = () => enableMic($('#micDevice').value || null);
  $('#btnMicMute').onclick = () => { toggleMuteGame(); toast(voice.muted ? 'Микрофон выключен' : 'Микрофон включён', ''); };
  $('#btnMicRefresh').onclick = () => refreshDevices(true);
  $('#micDevice').onchange = (e) => {
    S.settings.deviceId = e.target.value; saveSettings();
    voice.localStream?.getTracks().forEach(t => t.stop());
    voice.localStream = null;
    enableMic(e.target.value || null);
  };
  const micGain = $('#micGain');
  micGain.value = S.settings.micGain;
  $('#micGainVal').textContent = `${fmt(S.settings.micGain, 2)}×`;
  micGain.oninput = (e) => {
    S.settings.micGain = Number(e.target.value); saveSettings();
    voice.setMicGain(S.settings.micGain);
    $('#micGainVal').textContent = `${fmt(S.settings.micGain, 2)}×`;
  };
  const bindOpt = (sel, key, apply) => {
    const el = $(sel);
    el.checked = S.settings[key];
    el.onchange = () => {
      S.settings[key] = el.checked; saveSettings();
      // перезапустить поток с новыми настройками
      (voice.localStream?.getAudioTracks() || []).forEach(t => t.stop());
      voice.localStream = null;
      if (S.micOn) enableMic();
      apply?.(el.checked);
    };
  };
  bindOpt('#optEcho', 'echo');
  bindOpt('#optNoise', 'noise');
  bindOpt('#optAgc', 'agc');

  // игра: ползунки микса
  const bindMix = (sel, valSel, key, apply) => {
    const el = $(sel);
    el.value = S.settings[key];
    $(valSel).textContent = `${Math.round(S.settings[key] * 100)}%`;
    el.oninput = () => {
      S.settings[key] = Number(el.value); saveSettings();
      $(valSel).textContent = `${Math.round(S.settings[key] * 100)}%`;
      apply(S.settings[key]);
    };
  };
  bindMix('#volInst', '#volInstVal', 'inst', v => S.clock?.setVolumes({ inst: v }));
  bindMix('#volOwn', '#volOwnVal', 'own', v => S.clock?.setVolumes({ ownGuide: v }));
  const auxEl = $('#volAux');
  auxEl.value = 0;
  $('#volAuxVal').textContent = '0%';
  auxEl.oninput = () => { $('#volAuxVal').textContent = `${Math.round(Number(auxEl.value) * 100)}%`; };
  $('#btnGameMute').onclick = toggleMuteGame;
  $('#btnGameLeave').onclick = () => {
    socket.send('leave', {});
    socket.clearResume();
    S.clock?.stop(); S.clock = null;
    closeWaitingOverlay(); closeCountdown();
    nav('menu');
  };

  // результаты
  $('#btnRematch').onclick = () => { socket.send('rematch', {}); toast('Голос за реванш отправлен', ''); };
  $('#btnResultsRoom').onclick = () => nav('room');
  $('#btnResultsMenu').onclick = () => nav('menu');

  // настройки
  const bindSet = (sel, valSel, key, apply) => {
    const el = $(sel);
    el.value = S.settings[key];
    $(valSel).textContent = `${Math.round(S.settings[key] * 100)}%`;
    el.oninput = () => {
      S.settings[key] = Number(el.value); saveSettings();
      $(valSel).textContent = `${Math.round(S.settings[key] * 100)}%`;
      apply?.(S.settings[key]);
    };
  };
  bindSet('#setPeerVol', '#setPeerVolVal', 'peerVol', v => { voice.setPeerVolume(v); $('#roomPeerVol').value = v; });
  bindSet('#setInst', '#setInstVal', 'inst', v => S.clock?.setVolumes({ inst: v }));
  bindSet('#setOwn', '#setOwnVal', 'own', v => S.clock?.setVolumes({ ownGuide: v }));
  bindSet('#setMaster', '#setMasterVal', 'master', v => S.clock?.setVolumes({ master: v }));
  $('#optAutoSync').checked = S.settings.autoSync;
  $('#optAutoSync').onchange = (e) => { S.settings.autoSync = e.target.checked; saveSettings(); };
  $('#btnResync').onclick = () => { socket.syncClock(7); toast('Пересинхронизация часов…', ''); };
  $('#btnDiagVoice').onclick = async () => {
    await enableMic();
    if (S.room?.players?.length === 2) await setupPeerCall();
    else toast('Голосовой тест: включите микрофон и войдите в комнату со вторым игроком', 'warn');
  };
  $('#btnResetSession').onclick = () => {
    localStorage.removeItem('rt.sessionId');
    sessionStorage.removeItem('rt.resumeCode');
    clearEndpointOverrides();
    location.reload();
  };
}

async function refreshDevices(notify = false) {
  const devs = await voice.listDevices();
  const sel = $('#micDevice');
  const current = S.settings.deviceId || '';
  sel.innerHTML = `<option value="">Устройство по умолчанию</option>` +
    devs.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === current ? 'selected' : ''}>${escapeHtml(d.label || `Микрофон ${i + 1}`)}</option>`).join('');
  if (notify) toast(`Найдено устройств: ${devs.length}`, '', 2200);
}

// ─── СТАРТ ───────────────────────────────────────────────────────────────────
async function boot() {
  hydrateIcons();
  bindUI();
  bindSocket();
  setConnStatus('connecting');
  socket.connect();
  requestAnimationFrame(meterLoop);
  await Promise.all([loadSongIndex(), loadStats()]);
  voice.setPeerVolume(S.settings.peerVol);

  if (S.settings.name) socket.name = S.settings.name;
  $('#createName').value = S.settings.name || '';
  $('#joinName').value = S.settings.name || '';

  // диплинк вида #join?code=123456
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('join')) {
    nav('join');
    const m = hash.match(/code=(\d{6})/);
    if (m) $('#joinCode').value = m[1];
  } else if (hash && SCREENS.includes(hash)) nav(hash);

  // восстановление сессии после перезагрузки страницы
  const resume = sessionStorage.getItem('rt.resumeCode');
  if (resume) {
    const check = await fetch(api(`/api/room/${resume}`)).then(r => r.json()).catch(() => null);
    if (check?.exists && !check.full) {
      socket.send('join', { code: resume, name: S.settings.name || 'Игрок', sessionId: socket.sessionId });
    } else sessionStorage.removeItem('rt.resumeCode');
  }

  // разблокировка аудио по первому касанию (требование мобильных браузеров)
  const unlock = async () => {
    try {
      const ctx = voice._ctx || new (window.AudioContext || window.webkitAudioContext)();
      voice._ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      if (voice.peerAudioEl) voice.peerAudioEl.play().catch(() => {});
    } catch {}
    document.removeEventListener('pointerdown', unlock);
  };
  document.addEventListener('pointerdown', unlock);

  window.addEventListener('beforeunload', () => {
    if (socket.code) sessionStorage.setItem('rt.resumeCode', socket.code);
  });
  window.RT = { S, socket, voice, nav, toast, endpoints: ENDPOINTS };  // для отладки и автотестов
  console.log('[RT] приложение готово');
}

boot();
