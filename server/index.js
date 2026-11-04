/**
 * RHYME TOGETHER — игровой сервер (Node.js + WebSocket).
 *
 * Отвечает за:
 *  • комнаты и шестизначные коды приглашения (единственный авторитетный источник);
 *  • выбор песни и назначение вокальных партий (на сервере, не на клиенте);
 *  • синхронизацию часов (ping/pong) и назначение момента старта;
 *  • обратный отсчёт, мониторинг рассинхронизации, авто-коррекцию позиции;
 *  • WebRTC-сигналинг для голосовой связи (медиа идёт напрямую между игроками);
 *  • повторное подключение по sessionId и обработку отключений;
 *  • приём локально посчитанных результатов и сборку командного балла.
 *
 * Медиа не проходит через сервер: голос — WebRTC, оценка — на устройстве.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// отладочные хуки (эмуляция обрыва связи) — только по явному флагу
const DEBUG_HOOKS = process.env.RHYME_TOGETHER_DEBUG === '1';

// ─── загрузка библиотеки песен ────────────────────────────────────────────────
const SONGS_DIR = path.join(ROOT, 'src', 'data', 'songs');
const SONGS = new Map();
for (const f of fs.readdirSync(SONGS_DIR)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const s = JSON.parse(fs.readFileSync(path.join(SONGS_DIR, f), 'utf8'));
  SONGS.set(s.id, s);
}
console.log(`[songs] загружено ${SONGS.size}: ${[...SONGS.keys()].join(', ')}`);

// ─── утилиты ─────────────────────────────────────────────────────────────────
const now = () => Date.now();
const rand = (n) => Math.floor(Math.random() * n);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function makeCode() {
  for (let i = 0; i < 500; i++) {
    const c = String(100000 + rand(900000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('нет свободных кодов комнат');
}

const rooms = new Map();   // code -> room
const sessions = new Map(); // sessionId -> {name, code, slot, lastSeen}

class Room {
  constructor(code, hostSession) {
    this.code = code;
    this.createdAt = now();
    this.phase = 'lobby';         // lobby | countdown | playing | results | closed
    this.song = null;
    this.playerOrder = [];        // sessionId[] — порядок входа, [0] → партия A
    this.players = new Map();     // sessionId -> player
    this.startAt = null;          // серверное время старта музыки (epoch ms)
    this.countdownAt = null;      // когда начался обратный отсчёт
    this.results = new Map();     // part -> result
    this.lastActivity = now();
    this.timers = [];
    this.rematchVotes = new Set();
  }
  addPlayer(sessionId, name) {
    const slot = this.playerOrder.length === 0 ? 0 : (this.playerOrder.includes(sessionId) ? this.playerOrder.indexOf(sessionId) : 1);
    if (!this.playerOrder.includes(sessionId)) {
      if (this.playerOrder.length >= 2) throw new Error('FULL');
      this.playerOrder.push(sessionId);
    }
    const part = this.playerOrder.indexOf(sessionId) === 0 ? 'A' : 'B';
    const p = {
      sessionId, name, part, ready: false, connected: false,
      micOn: false, micLevel: 0, drift: 0,
      clockOffset: 0, clockRtt: 0, joinedAt: now(),
    };
    this.players.set(sessionId, p);
    this.lastActivity = now();
    return p;
  }
  snapshot() {
    return {
      code: this.code, phase: this.phase,
      songId: this.song?.id || null,
      playerCount: this.players.size,
      startAt: this.startAt, countdownAt: this.countdownAt,
      serverTime: now(),
      results: this.phase === 'results' ? [...this.results.keys()] : [],
      players: this.playerOrder
        .map((sid) => this.players.get(sid))
        .filter(Boolean)
        .map((p) => ({
          sessionId: p.sessionId, name: p.name, part: p.part, ready: p.ready,
          connected: p.connected, micOn: p.micOn, micLevel: round(p.micLevel, 3),
          drift: round(p.drift, 1),
          clockRtt: Math.round(p.clockRtt),
          latency: Math.round((p.clockRtt || 0) / 2),
        })),
    };
  }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));

// ── CORS: фронтенд может быть развёрнут отдельно (Vercel) от игрового сервера ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(ROOT, 'src'), { extensions: ['html'] }));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, songs: SONGS.size, rooms: rooms.size, serverTime: now(), version: '1.0.0', debugHooks: DEBUG_HOOKS });
});

// Индекс библиотеки (лёгкий) и полная партитура по требованию
app.get('/api/songs', (req, res) => {
  res.json([...SONGS.values()].map(s => ({
    id: s.id, title: s.title, artist: s.artist, bpm: s.bpm, key: s.key,
    duration: s.durationSec, difficulty: s.difficulty, parts: s.parts,
    notes: { A: s.vocal.A.reduce((n, l) => n + l.syllables.length, 0), B: s.vocal.B.reduce((n, l) => n + l.syllables.length, 0) },
    license: s.license, mood: s.mood, bars: s.totalBars,
  })));
});
app.get('/api/songs/:id', (req, res) => {
  const s = SONGS.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(s);
});

// ICE-конфигурация для WebRTC: STUN всегда, TURN — если задан в окружении
app.get('/api/rtc-config', (req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({
    iceServers,
    turnConfigured: Boolean(process.env.TURN_URL),
    iceTransportPolicy: process.env.FORCE_RELAY === '1' ? 'relay' : 'all',
  });
});

app.get('/api/stats', async (req, res) => res.json(await store.stats()));
app.get('/api/leaderboard', async (req, res) => res.json(await store.leaderboard(12)));

// Проверка кода комнаты перед подключением (чтобы UI сразу сказал «нет такой»)
app.get('/api/room/:code', (req, res) => {
  const r = rooms.get(req.params.code);
  if (!r) return res.json({ exists: false });
  res.json({
    exists: true, phase: r.phase, playerCount: r.players.size,
    full: r.players.size >= 2,
    songId: r.song?.id || null,
  });
});

const server = http.createServer(app);

// ─── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(ws, type, data = {}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function sendTo(code, type, data, exceptSession = null) {
  const room = rooms.get(code);
  if (!room) return;
  for (const p of room.players.values()) {
    if (p.sessionId === exceptSession) continue;
    send(p.ws, type, data);
  }
}
function broadcastState(room) {
  sendTo(room.code, 'room', { room: room.snapshot() });
}
function log(...a) { console.log('[rt]', ...a); }

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.sessionId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type } = msg;
    try {
      switch (type) {

        // ── синхронизация часов ────────────────────────────────────────────
        case 'time': {
          // t0 (клиент) → t1 (сервер) ... клиент считает offset = ((t1 - t0) + (t2 - t3)) / 2
          send(ws, 'time', { t0: msg.t0, t1: now() });
          break;
        }

        // ── создание комнаты ───────────────────────────────────────────────
        case 'create': {
          const sessionId = String(msg.sessionId || '').slice(0, 64) || cryptoRandom();
          const name = sanitizeName(msg.name);
          const code = makeCode();
          const room = new Room(code, sessionId);
          rooms.set(code, room);
          if (msg.preferredSong && SONGS.has(msg.preferredSong)) room.preferredSong = msg.preferredSong;
          const p = room.addPlayer(sessionId, name);
          p.connected = true; p.ws = ws;
          ws.sessionId = sessionId; ws.code = code;
          sessions.set(sessionId, { name, code, slot: 0, lastSeen: now() });
          await store.touchPlayer(sessionId, name);
          log(`комната ${code} создана игроком ${name} (${sessionId.slice(0, 8)})`);
          send(ws, 'joined', {
            code, sessionId, part: p.part, room: room.snapshot(),
            serverTime: now(), songs: [...SONGS.keys()],
          });
          break;
        }

        // ── вход по коду / переподключение ────────────────────────────────
        case 'join': {
          const code = String(msg.code || '').replace(/\D/g, '').slice(0, 6);
          const room = rooms.get(code);
          if (!room) return send(ws, 'error', { code: 'NO_ROOM', message: `Комната ${code || '—'} не найдена` });
          let sessionId = String(msg.sessionId || '').slice(0, 64) || cryptoRandom();
          const name = sanitizeName(msg.name);
          let p = room.players.get(sessionId);

          if (!p) {
            // новый игрок
            if (room.players.size >= 2) {
              // возможно, это возврат игрока, у которого потерялся sessionId — не пускаем
              return send(ws, 'error', { code: 'FULL', message: 'В комнате уже два игрока' });
            }
            if (room.phase !== 'lobby') {
              return send(ws, 'error', { code: 'IN_PROGRESS', message: 'Игра уже началась — попросите создать новую комнату' });
            }
            p = room.addPlayer(sessionId, name);
          } else {
            // возврат после обрыва: сохраняем партию и готовность
            p.name = name || p.name;
            log(`переподключение ${p.name} в ${code} (партия ${p.part})`);
          }
          p.connected = true; p.ws = ws;
          ws.sessionId = sessionId; ws.code = code;
          sessions.set(sessionId, { name: p.name, code, slot: room.playerOrder.indexOf(sessionId), lastSeen: now() });
          await store.touchPlayer(sessionId, p.name);

          send(ws, 'joined', {
            code, sessionId, part: p.part, room: room.snapshot(),
            serverTime: now(), songs: [...SONGS.keys()], resumed: Boolean(msg.sessionId),
          });
          // сообщаем второму игроку и сразу даём ему роль инициатора WebRTC
          sendTo(code, 'peer-joined', {
            sessionId, name: p.name, part: p.part,
            shouldOffer: room.playerOrder[0] === sessionId, // хост создаёт оффер
            room: room.snapshot(),
          }, sessionId);
          broadcastState(room);
          break;
        }

        // ── готовность ────────────────────────────────────────────────────
        case 'ready': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          p.ready = Boolean(msg.ready);
          broadcastState(room);
          room.lastActivity = now();
          maybeStart(room);
          break;
        }

        // ── смена песни (только в лобби, хост) ────────────────────────────
        case 'pick-song': {
          const room = rooms.get(ws.code);
          if (!room || room.phase !== 'lobby') return;
          const s = SONGS.get(msg.songId);
          if (!s) return send(ws, 'error', { code: 'NO_SONG', message: 'Нет такой песни' });
          room.song = null; // выбор делается сервером при старте; здесь — только пожелание
          room.preferredSong = s.id;
          broadcastState(room);
          break;
        }

        // ── состояние микрофона / метрики (для UI второго игрока) ─────────
        case 'mic': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          p.micOn = Boolean(msg.on);
          p.micLevel = Number(msg.level) || 0;
          p.muted = Boolean(msg.muted);
          // не спамим полным состоянием: только лёгкое событие
          sendTo(room.code, 'peer-mic', {
            sessionId: ws.sessionId, on: p.micOn, level: round(p.micLevel, 3), muted: p.muted,
          }, ws.sessionId);
          break;
        }

        // ── отчёт о рассинхронизации ──────────────────────────────────────
        case 'drift': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          p.drift = Number(msg.drift) || 0;
          p.playbackRate = Number(msg.rate) || 1;
          p.corrected = Boolean(msg.corrected);
          sendTo(room.code, 'peer-drift', {
            sessionId: ws.sessionId, drift: round(p.drift, 1), corrected: p.corrected,
          }, ws.sessionId);
          if (Math.abs(p.drift) > 450 && room.phase === 'playing') {
            log(`⚠ рассинхрон ${Math.abs(p.drift).toFixed(0)} мс у ${p.name} в ${room.code} — коррекция`);
          }
          break;
        }

        // ── WebRTC-сигналинг (голос) ──────────────────────────────────────
        case 'rtc-offer':
        case 'rtc-answer':
        case 'rtc-ice':
        case 'rtc-renegotiate': {
          const room = rooms.get(ws.code);
          if (!room) return;
          const target = [...room.players.values()].find(p => p.sessionId !== ws.sessionId);
          if (!target?.ws) return;
          send(target.ws, type, { from: ws.sessionId, sdp: msg.sdp, candidate: msg.candidate });
          break;
        }

        // ── прогресс исполнения (пинг для «живого» состояния второго) ──────
        case 'progress': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          p.progress = Number(msg.progress) || 0;
          p.liveScore = msg.score || null;
          sendTo(room.code, 'peer-progress', {
            sessionId: ws.sessionId, progress: round(p.progress, 3), score: p.liveScore,
          }, ws.sessionId);
          break;
        }

        // ── сдача локально посчитанного результата ────────────────────────
        case 'result': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          if (room.phase !== 'playing' && room.phase !== 'results') return;
          if (room.finalized) return; // поздний пересчёт после публикации итога игнорируем
          room.results.set(p.part, { ...msg.result, name: p.name, part: p.part, sessionId: ws.sessionId });
          p.ready = false;
          if (room.results.size === 2) {
            // даём 1,5 с на пересчёт синхронности по онсетам партнёра
            clearTimeout(room.finalizeTimer);
            room.finalizeTimer = setTimeout(() => finalize(room), 1500);
            room.timers.push(room.finalizeTimer);
            broadcastState(room);
          } else {
            // сразу отдаём партнёру таймстемпы атак (не звук!), чтобы он мог
            // локально посчитать синхронность до публикации итога
            sendTo(room.code, 'peer-result', {
              part: p.part,
              onsets: msg.result?.onsets || [],
              score: msg.result?.score || null,
            }, ws.sessionId);
            sendTo(room.code, 'waiting-peer-result', { from: p.part });
            broadcastState(room);
          }
          break;
        }

        // ── реванш ────────────────────────────────────────────────────────
        case 'rematch': {
          const room = rooms.get(ws.code);
          const p = room?.players.get(ws.sessionId);
          if (!room || !p) return;
          room.rematchVotes.add(ws.sessionId);
          sendTo(room.code, 'rematch-vote', { sessionId: ws.sessionId, count: room.rematchVotes.size });
          if (room.rematchVotes.size >= 2 || (room.rematchVotes.size >= 1 && room.players.size === 1)) {
            resetToLobby(room);
          }
          break;
        }

        // ── покинуть комнату ──────────────────────────────────────────────
        case 'leave': {
          await leaveRoom(ws, 'leave');
          break;
        }

        // ── тестовый хук: имитация обрыва сети (RHYME_TOGETHER_DEBUG=1) ──────
        case 'debug-drop': {
          if (!DEBUG_HOOKS) {
            return send(ws, 'error', { code: 'DISABLED', message: 'хук отключён' });
          }
          log(`debug-drop: принудительно рву соединение ${ws.sessionId?.slice(0, 8)}`);
          ws.terminate();
          break;
        }

        case 'ping-state': {
          const room = rooms.get(ws.code);
          if (room) send(ws, 'room', { room: room.snapshot() });
          break;
        }

        default:
          send(ws, 'error', { code: 'BAD_TYPE', message: `Неизвестный тип: ${type}` });
      }
    } catch (e) {
      log('ошибка обработки', type, e.message);
      send(ws, 'error', { code: 'SERVER', message: e.message });
    }
  });

  ws.on('close', () => { handleDisconnect(ws); });
  ws.on('error', () => { handleDisconnect(ws); });
});

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
function sanitizeName(n) {
  return String(n || 'Игрок').replace(/[<>&"']/g, '').trim().slice(0, 24) || 'Игрок';
}

async function leaveRoom(ws, reason) {
  const room = rooms.get(ws.code);
  if (!room) return;
  const p = room.players.get(ws.sessionId);
  if (!p) return;
  p.connected = false;
  p.ready = false;
  room.players.delete(ws.sessionId);
  room.playerOrder = room.playerOrder.filter(s => s !== ws.sessionId);
  room.results.delete(p.part);
  room.rematchVotes.delete(ws.sessionId);
  log(`${p.name} покинул ${room.code} (${reason})`);
  sendTo(room.code, 'peer-left', { sessionId: ws.sessionId, part: p.part, name: p.name, reason });
  if (room.players.size === 0) {
    room.clearTimers();
    room.phase = 'closed';
    rooms.delete(room.code);
    log(`комната ${room.code} закрыта`);
  } else {
    // оставшийся игрок становится хостом и получает партию A
    room.clearTimers();
    room.phase = 'lobby';
    room.results.clear();
    room.startAt = null;
    room.song = null;
    for (const pl of room.players.values()) {
      pl.part = room.playerOrder.indexOf(pl.sessionId) === 0 ? 'A' : 'B';
      pl.ready = false;
    }
    broadcastState(room);
    sendTo(room.code, 'room-reset', { reason: 'peer-left' });
  }
  ws.code = null;
}

function handleDisconnect(ws) {
  const room = rooms.get(ws.code);
  if (!room) return;
  const p = room.players.get(ws.sessionId);
  if (!p) return;
  if (p.ws !== ws) return; // старое соединение, уже заменено новым
  p.connected = false;
  p.micOn = false;
  log(`${p.name} потерял связь в ${room.code} — ждём переподключения`);
  sendTo(room.code, 'peer-disconnected', { sessionId: ws.sessionId, name: p.name, graceSec: 45 });
  broadcastState(room);
  // если игрок не вернулся за 45 с — удаляем из комнаты
  const t = setTimeout(() => {
    const r = rooms.get(room.code);
    const pl = r?.players.get(ws.sessionId);
    if (r && pl && !pl.connected) {
      log(`${pl.name} не вернулся — удаляю из ${r.code}`);
      pl.ws = { readyState: 3, send() {} };
      leaveRoom({ code: r.code, sessionId: ws.sessionId, readyState: 3, send() {} }, 'timeout');
    }
  }, 45000);
  room.timers.push(t);
}

// ─── старт игры ──────────────────────────────────────────────────────────────
function maybeStart(room) {
  if (room.phase !== 'lobby') return;
  if (room.players.size !== 2) return;
  const all = [...room.players.values()];
  if (!all.every(p => p.ready && p.connected)) return;

  // 1) сервер выбирает песню (или учитывает пожелание хоста)
  const ids = [...SONGS.keys()];
  const songId = room.preferredSong && SONGS.has(room.preferredSong)
    ? room.preferredSong
    : ids[rand(ids.length)];
  room.song = SONGS.get(songId);
  room.preferredSong = null;
  room.phase = 'countdown';
  room.results.clear();
  room.rematchVotes.clear();
  room.finalized = false;

  // 2) сервер назначает абсолютный момент старта.
  //    Считаем по самому медленному клиенту: его сетевая задержка + запас.
  const maxLatency = Math.max(...all.map(p => (p.clockRtt || 0) / 2));
  const leadMs = Math.max(7000, maxLatency + 4500);   // время на загрузку стемов
  room.countdownAt = now();
  room.startAt = now() + leadMs;

  const payload = {
    songId: room.song.id,
    startAt: room.startAt,
    serverTime: now(),
    leadMs,
    assignments: all.map(p => ({ sessionId: p.sessionId, name: p.name, part: p.part })),
    driftToleranceMs: 120,
  };
  log(`старт в ${room.code}: «${room.song.title}», через ${(leadMs / 1000).toFixed(1)} с, ` +
      `макс. задержка ${maxLatency.toFixed(0)} мс`);
  sendTo(room.code, 'song-assigned', { ...payload, room: room.snapshot() });
  broadcastState(room);

  // 3) переводим фазу в playing ровно в момент старта
  const t = setTimeout(() => {
    room.phase = 'playing';
    broadcastState(room);
  }, Math.max(0, room.startAt - now()));
  room.timers.push(t);

  // 4) страховка: если результат не пришёл за длительность песни + 20 с
  const t2 = setTimeout(() => {
    if (room.phase === 'playing') {
      log(`таймаут результатов в ${room.code} — закрываю трек`);
      finalize(room, true);
    }
  }, Math.max(0, room.startAt - now()) + room.song.durationSec * 1000 + 20000);
  room.timers.push(t2);
}

function finalize(room, timeout = false) {
  if (!room.song || room.finalized) return;
  room.finalized = true;
  room.phase = 'results';
  room.clearTimers();
  const parts = ['A', 'B'];
  const entries = parts.map(part => {
    const r = room.results.get(part);
    const p = [...room.players.values()].find(x => x.part === part);
    return {
      part, sessionId: r?.sessionId || p?.sessionId || null, name: r?.name || p?.name || part,
      score: r?.score || null, timeout: !r,
    };
  });

  // ── командный результат: среднее по игрокам (не сумма — игра командная, не соревнование)
  const scored = entries.filter(e => e.score);
  const avgOf = (k) => {
    const vals = scored.map(e => e.score[k]).filter(v => v != null);
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    // если один из партнёров не смог оценить метрику (например, не было
    // совместных атак), команда не должна получать за неё ноль
    return round(mean, 1);
  };
  const team = {
    pitch: avgOf('pitch'),
    rhythm: avgOf('rhythm'),
    sync: avgOf('sync'),
    accuracy: avgOf('accuracy'),
    total: null,
    incomplete: scored.length < 2,
  };
  if (scored.length) {
    // 50% / 30% / 20% — взвешивание строго по ТЗ; отсутствующая метрика
    // не обнуляет итог, а перераспределяется между остальными
    const parts = [['pitch', 0.5], ['rhythm', 0.3], ['sync', 0.2]].filter(([k]) => team[k] != null);
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    team.total = wsum > 0 ? round(parts.reduce((a, [k, w]) => a + team[k] * w, 0) / wsum, 1) : null;
  }
  const payload = {
    songId: room.song.id, songTitle: room.song.title, code: room.code,
    entries, team, timeout,
    duetCoverage: duetCoverage(room, entries),
  };
  sendTo(room.code, 'results', { results: payload });
  store.recordResult({
    songId: room.song.id, songTitle: room.song.title, code: room.code,
    players: entries.map(e => ({ sessionId: e.sessionId, name: e.name, part: e.part, score: e.score })),
    team,
  }).catch(() => {});
  room.lastResults = payload;
  log(`итог ${room.code}: песня «${room.song.title}», командный балл ${team.total ?? '—'}`);
  // авто-очистка заброшенных комнат
  const t = setTimeout(() => {
    if (room.phase === 'results') { room.phase = 'closed'; rooms.delete(room.code); }
  }, 10 * 60 * 1000);
  room.timers.push(t);
}

/**
 * Покрытие дуэта: доля таймлайна, где обе партии звучат одновременно.
 * Это объективная характеристика аранжировки, а не оценка игроков.
 */
function duetCoverage(room, entries) {
  const song = room.song;
  if (!song) return null;
  const bpm = song.bpm, bpb = song.beatsPerBar, beat = 60 / bpm;
  const span = (part) => {
    const lines = song.vocal[part];
    if (!lines.length) return null;
    const first = lines[0], last = lines[lines.length - 1];
    return [ (first.bar * bpb + first.beat) * beat, (last.bar * bpb + last.beat) * beat ];
  };
  const A = span('A'), B = span('B');
  if (!A || !B) return null;
  const overlap = Math.max(0, Math.min(A[1], B[1]) - Math.max(A[0], B[0]));
  const union = Math.max(A[1], B[1]) - Math.min(A[0], B[0]);
  return { overlapSec: round(overlap, 1), unionSec: round(union, 1), ratio: round(overlap / union, 2) };
}

function resetToLobby(room) {
  room.clearTimers();
  room.phase = 'lobby';
  room.song = null;
  room.startAt = null;
  room.results.clear();
  room.rematchVotes.clear();
  room.finalized = false;
  for (const p of room.players.values()) p.ready = false;
  sendTo(room.code, 'room-reset', { reason: 'rematch', room: room.snapshot() });
  broadcastState(room);
  log(`реванш в ${room.code}`);
}

// ─── уборка ──────────────────────────────────────────────────────────────────
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    const idle = t - room.lastActivity;
    const noConn = [...room.players.values()].every(p => !p.connected);
    if (idle > 30 * 60 * 1000 || (noConn && idle > 60 * 1000)) {
      room.clearTimers();
      rooms.delete(code);
      log(`комната ${code} удалена по таймауту`);
    }
  }
}, 60 * 1000).unref();

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

await store.init();
server.listen(PORT, HOST, () => {
  console.log(`\n  RHYME TOGETHER — сервер запущен`);
  console.log(`  http://localhost:${PORT}  (WebSocket: /ws)`);
  console.log(`  хранилище: ${store.kind}\n`);
});

export { app, server, rooms, SONGS };
