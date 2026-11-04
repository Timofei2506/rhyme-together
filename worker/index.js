/**
 * RHYME TOGETHER — игровой сервер для Cloudflare Workers.
 *
 * Архитектура:
 *   • Worker (этот файл) — HTTP API + раздача фронтенда + проксирование WebSocket
 *     в Durable Object по коду комнаты;
 *   • RoomDO — один Durable Object на комнату: единственный авторитетный источник
 *     состояния комнаты, WebRTC-сигналинга, выбора песни и командного итога.
 *
 * Протокол сообщений полностью совпадает с Node-версией (server/index.js),
 * поэтому клиент работает с любым из двух серверов без изменений.
 *
 * Медиа через сервер не проходит: голос — WebRTC напрямую, оценка — на устройстве.
 */
import { SONGS, SONG_IDS } from './songs.js';

const now = () => Date.now();
const rand = (n) => Math.floor(Math.random() * n);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const CORS_MAX_AGE = '86400';

// ─────────────────────────────────────────────────────────────────────────────
// CORS: фронтенд живёт на Vercel, сервер — здесь
// ─────────────────────────────────────────────────────────────────────────────
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowAll = allowed.includes('*');
  const ok = allowAll || allowed.some((a) => origin === a || (a.startsWith('*.') && origin.endsWith(a.slice(1))));
  return {
    'Access-Control-Allow-Origin': ok ? (allowAll ? '*' : origin) : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': CORS_MAX_AGE,
    Vary: 'Origin',
  };
}

function json(data, { status = 200, req, env, extra = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(req ? corsHeaders(req, env) : {}),
      ...extra,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Статика фронтенда — вшита в бандл при сборке (workers/assets.js)
// ─────────────────────────────────────────────────────────────────────────────
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon',
  woff2: 'font/woff2', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

async function serveStatic(request, env, pathname) {
  if (!env.ASSETS) return new Response('Not Found', { status: 404 });
  const key = pathname === '/' ? '/index.html' : pathname;
  let res = await env.ASSETS.fetch(new Request(new URL(key, request.url), request));
  // файл с расширением не найден — честный 404, а не «страница приложения»
  if (res.status === 404 && !/\.[a-z0-9]{1,5}$/i.test(pathname)) {
    res = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
  }
  if (res.status === 404) return res;
  const ext = key.split('.').pop().toLowerCase();
  const headers = new Headers(res.headers);
  headers.set('Content-Type', MIME[ext] || 'application/octet-stream');
  headers.set('Cache-Control', ext === 'html' ? 'no-cache' : 'public, max-age=300');
  return new Response(res.body, { status: res.status, headers });
}

// ─────────────────────────────────────────────────────────────────────────────
// Главный обработчик Worker
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // ── WebSocket: /ws на любом адресе → DO комнаты ───────────────────────
    //    Если в адресе есть код (?code=123456) — соединение сразу попадает
    //    в нужную комнату; иначе первый кадр create/join переводит сокет.
    if (path === '/ws' || path === '/ws/') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json({ error: 'Ожидается WebSocket Upgrade' }, { status: 426, req: request, env });
      }
      const roomCode = (url.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
      if (!roomCode) {
        return new Response(JSON.stringify({ type: 'error', code: 'NO_CODE', message: 'Нужен код комнаты в адресе: /ws?code=123456' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return roomStub(env, roomCode).fetch(request);
    }

    // ── API ───────────────────────────────────────────────────────────────
    if (path === '/api/health') {
      let rooms = null;
      try {
        const r = await env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(
          new Request('https://do/api/countrooms', { method: 'POST' })
        );
        rooms = (await r.json()).count;
      } catch { rooms = null; }
      return json({
        ok: true, songs: SONG_IDS.length, rooms,
        serverTime: now(), version: '2.0.0-cloudflare',
        platform: 'cloudflare-workers',
        /* debugHooks нужны e2e-тесту (эмуляция обрыва) */
        debugHooks: env.RHYME_TOGETHER_DEBUG === '1' || env.RHYME_TOGETHER_DEBUG === 'true',
      }, { req: request, env });
    }

    // код будущей комнаты — клиент открывает сокет сразу на него
    if (path === '/api/newcode') {
      const r = await env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(
        new Request('https://do/api/newcode', { method: 'POST' })
      );
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
      });
    }

    if (path === '/api/songs') {
      return json(Object.values(SONGS).map((s) => ({
        id: s.id, title: s.title, artist: s.artist, bpm: s.bpm, key: s.key,
        duration: s.durationSec, difficulty: s.difficulty, parts: s.parts,
        notes: {
          A: s.vocal.A.reduce((n, l) => n + l.syllables.length, 0),
          B: s.vocal.B.reduce((n, l) => n + l.syllables.length, 0),
        },
        license: s.license, mood: s.mood, bars: s.totalBars,
      })), { req: request, env });
    }

    if (path.startsWith('/api/songs/')) {
      const s = SONGS[decodeURIComponent(path.slice('/api/songs/'.length))];
      if (!s) return json({ error: 'NOT_FOUND' }, { status: 404, req: request, env });
      return json(s, { req: request, env });
    }

    // ICE-конфигурация: STUN всегда, TURN — если задан в переменных окружения
    if (path === '/api/rtc-config') {
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
      if (env.TURN_URL) {
        iceServers.push({
          urls: env.TURN_URL.split(','),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        });
      }
      return json({
        iceServers,
        turnConfigured: Boolean(env.TURN_URL),
        iceTransportPolicy: env.FORCE_RELAY === '1' ? 'relay' : 'all',
      }, { req: request, env });
    }

    if (path === '/api/stats' || path === '/api/leaderboard') {
      const r = await env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(
        new Request(`https://do${path}`, { method: 'GET' })
      );
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
      });
    }

    // Проверка кода комнаты до подключения (UI сразу скажет «нет такой»)
    if (path.startsWith('/api/room/')) {
      const code = path.slice('/api/room/'.length).replace(/\D/g, '').slice(0, 6);
      if (!code) return json({ exists: false }, { req: request, env });
      const r = await roomStub(env, code).fetch(new Request('https://do/api/peek', { method: 'POST' }));
      const body = await r.text();
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
      });
    }

    // ── всё остальное — статика (фронтенд, стемы, тексты песен) ────────────
    //    env.ASSETS сам раздаёт файлы и отдаёт 404 на отсутствующие,
    //    а not_found_handling отдаёт index.html только для путей без файла.
    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(request, env, path);
    return json({ error: 'NOT_FOUND' }, { status: 404, req: request, env });
  },
};

/** Стаб Durable Object комнаты по коду */
function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName('room:' + String(code).replace(/\D/g, '').slice(0, 6)));
}

// ─────────────────────────────────────────────────────────────────────────────
// LOBBY — раздаёт коды комнат и проксирует «безадресные» сокеты
// ─────────────────────────────────────────────────────────────────────────────
export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.results = [];      // история матчей (JSON в storage)
    this.players = new Map(); // sessionId -> {name, games, total, last}
  }

  async load() {
    if (this._loaded) return;
    this.results = (await this.state.storage.get('results')) || [];
    const p = (await this.state.storage.get('players')) || {};
    this.players = new Map(Object.entries(p));
    this._loaded = true;
  }

  async persist() {
    await this.state.storage.put('results', this.results.slice(-500));
    await this.state.storage.put('players', Object.fromEntries(
      [...this.players.entries()].slice(-500)
    ));
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const path = url.pathname;

    // ── выдача свободного шестизначного кода ─────────────────────────────
    if (path === '/api/newcode') {
      const used = (await this.state.storage.get('used')) || [];
      let code = null;
      for (let i = 0; i < 200; i++) {
        const c = String(100000 + Math.floor(Math.random() * 900000));
        if (used.includes(c)) continue;
        // проверяем, что комната с таким кодом реально не занята
        const alive = await this.aliveCheck(c);
        if (!alive) { code = c; break; }
      }
      if (!code) return json({ error: 'нет свободных кодов' }, { status: 503 });
      used.push(code);
      await this.state.storage.put('used', used.slice(-2000));
      return json({ code });
    }

    if (path === '/api/countrooms') {
      const n = (await this.state.storage.get('roomCount')) || 0;
      return json({ count: n });
    }

    if (path === '/api/stats') {
      const total = this.results.length;
      const avg = total ? round(this.results.reduce((a, r) => a + (r.team?.total || 0), 0) / total, 1) : 0;
      const best = total ? Math.max(...this.results.map((r) => r.team?.total || 0)) : 0;
      return json({
        matches: total, players: this.players.size, avgScore: avg, bestScore: best,
        duets: total, kind: 'cloudflare-do',
      });
    }

    if (path === '/api/leaderboard') {
      const top = [...this.results]
        .filter((r) => r.team?.total)
        .sort((a, b) => b.team.total - a.team.total)
        .slice(0, 12)
        .map((r) => ({
          songId: r.songId, songTitle: r.songTitle, total: r.team.total,
          names: (r.players || []).map((p) => p.name), at: r.at,
        }));
      return json(top);
    }

    if (path === '/api/recordresult') {
      const body = await request.json();
      this.results.push({ ...body, at: now() });
      for (const p of body.players || []) {
        const cur = this.players.get(p.sessionId) || { name: p.name, games: 0, total: 0, best: 0, last: 0 };
        cur.name = p.name || cur.name;
        cur.games += 1;
        cur.total += p.score?.accuracy || 0;
        cur.best = Math.max(cur.best, p.score?.accuracy || 0);
        cur.last = now();
        this.players.set(p.sessionId, cur);
      }
      await this.persist();
      const count = (await this.state.storage.get('roomCount')) || 0;
      await this.state.storage.put('roomCount', Math.max(0, count - 1));
      return json({ ok: true });
    }

    // ── WebSocket без кода: держим сокет, читаем первый кадр ─────────────
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      // при create — выдаём код и пересылаем сокет в комнату
      let handed = false;
      server.addEventListener('message', async (ev) => {
        if (handed) return;
        handed = true;
        let msg = {};
        try { msg = JSON.parse(ev.data); } catch {}
        const wantCreate = msg.type === 'create';
        const code = wantCreate
          ? (await this.newCode())
          : String(msg.code || '').replace(/\D/g, '').slice(0, 6);

        if (!code) {
          server.send(JSON.stringify({ type: 'error', code: 'BAD_CODE', message: 'Нужен код комнаты' }));
          server.close(1002, 'нужен код');
          return;
        }
        // передаём сокет в DO комнаты вместе с первым сообщением
        const headers = new Headers(request.headers);
        headers.set('X-RT-Message', JSON.stringify(msg).slice(0, 4000));
        headers.set('X-RT-Code', code);
        const forwarded = new Request('https://do/ws' + (wantCreate ? '?create=1' : ''), {
          method: 'GET', headers,
        });
        try {
          await roomStub(this.env, code).fetch(forwarded);
          // сокет УЖЕ принят в комнате; здесь его не закрываем
        } catch (e) {
          server.send(JSON.stringify({ type: 'error', code: 'SERVER', message: String(e?.message || e) }));
          try { server.close(1011, 'ошибка комнаты'); } catch {}
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  async newCode() {
    const used = (await this.state.storage.get('used')) || [];
    for (let i = 0; i < 200; i++) {
      const c = String(100000 + Math.floor(Math.random() * 900000));
      if (used.includes(c)) continue;
      if (await this.aliveCheck(c)) continue;
      used.push(c);
      await this.state.storage.put('used', used.slice(-2000));
      return c;
    }
    return null;
  }

  async aliveCheck(code) {
    try {
      const r = await roomStub(this.env, code).fetch(new Request('https://do/api/peek', { method: 'POST' }));
      const d = await r.json();
      return Boolean(d.exists);
    } catch { return false; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOM — одна комната (Durable Object)
// ─────────────────────────────────────────────────────────────────────────────
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();   // sessionId -> WebSocket
    this.meta = null;           // состояние комнаты
  }

  log(...a) { console.log('[room]', ...a); }

  // ── состояние ──────────────────────────────────────────────────────────────
  blankRoom(code) {
    return {
      code, phase: 'lobby', songId: null, startAt: null, countdownAt: null,
      playerOrder: [], players: {}, results: {}, rematchVotes: [],
      finalized: false, preferredSong: null, lastActivity: now(), createdAt: now(),
    };
  }

  async load() {
    if (this.meta) return this.meta;
    const stored = await this.state.storage.get('room');
    this.meta = stored || null;
    return this.meta;
  }

  async save() {
    if (this.meta) await this.state.storage.put('room', this.meta);
  }

  snapshot() {
    const r = this.meta;
    return {
      code: r.code, phase: r.phase, songId: r.songId,
      playerCount: r.playerOrder.length,
      startAt: r.startAt, countdownAt: r.countdownAt,
      serverTime: now(),
      results: r.phase === 'results' ? Object.keys(r.results) : [],
      players: r.playerOrder.map((sid) => r.players[sid]).filter(Boolean).map((p) => ({
        sessionId: p.sessionId, name: p.name, part: p.part, ready: p.ready,
        connected: p.connected, micOn: p.micOn, micLevel: round(p.micLevel, 3),
        drift: round(p.drift, 1), clockRtt: Math.round(p.clockRtt),
        latency: Math.round((p.clockRtt || 0) / 2),
      })),
    };
  }

  send(sessionId, type, data = {}) {
    const ws = this.sockets.get(sessionId);
    if (!ws) return false;
    try { ws.send(JSON.stringify({ type, ...data })); return true; } catch { return false; }
  }
  sendTo(type, data, except = null) {
    for (const [sid, ws] of this.sockets) {
      if (sid === except) continue;
      try { ws.send(JSON.stringify({ type, ...data })); } catch {}
    }
  }
  broadcastState() { this.sendTo('room', { room: this.snapshot() }); }

  // ── HTTP внутри комнаты ───────────────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    await this.load();

    if (url.pathname === '/api/peek') {
      if (!this.meta) return json({ exists: false });
      return json({
        exists: true, phase: this.meta.phase,
        playerCount: this.meta.playerOrder.length,
        full: this.meta.playerOrder.length >= 2,
        songId: this.meta.songId,
      });
    }

    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade === 'websocket') return this.acceptSocket(request);

    return json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  async acceptSocket(request) {
    const url = new URL(request.url);
    const code = request.headers.get('X-RT-Code') || url.searchParams.get('code') || '';
    const firstRaw = request.headers.get('X-RT-Message');
    const wantsCreate = url.searchParams.get('create') === '1';
    const roomCode = (code || url.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);

    // комната создаётся первым подключением по её коду
    if (!this.meta) this.meta = this.blankRoom(roomCode);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // первое сообщение пришло заголовком (сокет уже «горячий»)
    if (firstRaw) {
      this.handle(server, firstRaw).catch((e) => this.log('ошибка первого кадра', e?.message));
    }

    server.addEventListener('message', (ev) => {
      this.handle(server, ev.data).catch((e) => {
        this.log('ошибка обработки', e?.message);
        try { server.send(JSON.stringify({ type: 'error', code: 'SERVER', message: e?.message })); } catch {}
      });
    });
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  onClose(ws) {
    const sid = ws._rtSession;
    if (!sid) return;
    if (this.sockets.get(sid) !== ws) return; // уже заменён новым соединением
    this.sockets.delete(sid);
    const p = this.meta?.players?.[sid];
    if (!p) return;
    p.connected = false;
    p.micOn = false;
    this.log(`${p.name} потерял связь в ${this.meta.code}`);
    this.sendTo('peer-disconnected', { sessionId: sid, name: p.name, graceSec: 45 });
    this.broadcastState();
    // если не вернулся за 45 с — убираем из комнаты
    this.state.storage.setAlarm(now() + 45000);
    this.save();
  }

  async handle(ws, raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw)); } catch { return; }
    const r = this.meta;
    const { type } = msg;
    r.lastActivity = now();

    switch (type) {
      // ── синхронизация часов ──────────────────────────────────────────────
      case 'time':
        ws.send(JSON.stringify({ type: 'time', t0: msg.t0, t1: now() }));
        break;

      // ── создание комнаты ────────────────────────────────────────────────
      case 'create': {
        // на Workers комната уже создана подключением по коду —
        // create ведёт себя как вход первого игрока
        const sessionId = String(msg.sessionId || '').slice(0, 64) || crypto.randomUUID().slice(0, 16);
        const name = sanitizeName(msg.name);
        if (msg.preferredSong && SONGS[msg.preferredSong]) r.preferredSong = msg.preferredSong;
        const p = this.addPlayer(sessionId, name);
        ws._rtSession = sessionId;
        this.sockets.set(sessionId, ws);
        p.connected = true;
        await this.save();
        this.send(sessionId, 'joined', {
          code: r.code, sessionId, part: p.part, room: this.snapshot(),
          serverTime: now(), songs: SONG_IDS,
        });
        this.log(`комната ${r.code}: первый игрок ${name}`);
        break;
      }

      // ── вход по коду / переподключение ──────────────────────────────────
      case 'join': {
        const sessionId = String(msg.sessionId || '').slice(0, 64) || crypto.randomUUID().slice(0, 16);
        const name = sanitizeName(msg.name);
        let p = r.players[sessionId];
        if (!p) {
          if (r.playerOrder.length >= 2) {
            try { ws.send(JSON.stringify({ type: 'error', code: 'FULL', message: 'В комнате уже два игрока' })); } catch {}
            return;
          }
          if (r.phase !== 'lobby') {
            try { ws.send(JSON.stringify({ type: 'error', code: 'IN_PROGRESS', message: 'Игра уже началась — попросите создать новую комнату' })); } catch {}
            return;
          }
          p = this.addPlayer(sessionId, name);
        } else {
          p.name = name || p.name;
        }
        p.connected = true;
        ws._rtSession = sessionId;
        this.sockets.set(sessionId, ws);
        await this.save();
        this.send(sessionId, 'joined', {
          code: r.code, sessionId, part: p.part, room: this.snapshot(),
          serverTime: now(), songs: SONG_IDS, resumed: Boolean(msg.sessionId),
        });
        this.sendTo('peer-joined', {
          sessionId, name: p.name, part: p.part,
          shouldOffer: r.playerOrder[0] === sessionId,
          room: this.snapshot(),
        }, sessionId);
        this.broadcastState();
        break;
      }

      case 'ready': {
        const p = r.players[ws._rtSession];
        if (!p) return;
        p.ready = Boolean(msg.ready);
        r.lastActivity = now();
        this.broadcastState();
        await this.maybeStart();
        break;
      }

      case 'pick-song': {
        if (r.phase !== 'lobby') return;
        if (!SONGS[msg.songId]) return this.send(ws._rtSession, 'error', { code: 'NO_SONG', message: 'Нет такой песни' });
        r.preferredSong = msg.songId;
        this.broadcastState();
        break;
      }

      case 'mic': {
        const p = r.players[ws._rtSession];
        if (!p) return;
        p.micOn = Boolean(msg.on);
        p.micLevel = Number(msg.level) || 0;
        p.muted = Boolean(msg.muted);
        this.sendTo('peer-mic', {
          sessionId: ws._rtSession, on: p.micOn, level: round(p.micLevel, 3), muted: p.muted,
        }, ws._rtSession);
        break;
      }

      case 'drift': {
        const p = r.players[ws._rtSession];
        if (!p) return;
        p.drift = Number(msg.drift) || 0;
        p.playbackRate = Number(msg.rate) || 1;
        p.corrected = Boolean(msg.corrected);
        this.sendTo('peer-drift', {
          sessionId: ws._rtSession, drift: round(p.drift, 1), corrected: p.corrected,
        }, ws._rtSession);
        break;
      }

      // ── WebRTC-сигналинг ────────────────────────────────────────────────
      case 'rtc-offer': case 'rtc-answer': case 'rtc-ice': case 'rtc-renegotiate': {
        const target = r.playerOrder.find((sid) => sid !== ws._rtSession);
        if (!target) return;
        this.send(target, type, { from: ws._rtSession, sdp: msg.sdp, candidate: msg.candidate });
        break;
      }

      case 'progress': {
        const p = r.players[ws._rtSession];
        if (!p) return;
        p.progress = Number(msg.progress) || 0;
        p.liveScore = msg.score || null;
        this.sendTo('peer-progress', {
          sessionId: ws._rtSession, progress: round(p.progress, 3), score: p.liveScore,
        }, ws._rtSession);
        break;
      }

      // ── локально посчитанный результат ──────────────────────────────────
      case 'result': {
        const p = r.players[ws._rtSession];
        if (!p) return;
        if (r.phase !== 'playing' && r.phase !== 'results') return;
        if (r.finalized) return;
        r.results[p.part] = { ...msg.result, name: p.name, part: p.part, sessionId: ws._rtSession };
        p.ready = false;
        if (Object.keys(r.results).length === 2) {
          // 1,5 с на пересчёт синхронности по онсетам партнёра
          this.state.storage.setAlarm(now() + 1500);
          this.broadcastState();
        } else {
          this.sendTo('peer-result', {
            part: p.part, onsets: msg.result?.onsets || [], score: msg.result?.score || null,
          }, ws._rtSession);
          this.sendTo('waiting-peer-result', { from: p.part });
          this.broadcastState();
        }
        await this.save();
        break;
      }

      case 'rematch': {
        if (!r.players[ws._rtSession]) return;
        if (!r.rematchVotes.includes(ws._rtSession)) r.rematchVotes.push(ws._rtSession);
        this.sendTo('rematch-vote', { sessionId: ws._rtSession, count: r.rematchVotes.length });
        if (r.rematchVotes.length >= 2 || (r.rematchVotes.length >= 1 && r.playerOrder.length === 1)) {
          await this.resetToLobby();
        }
        break;
      }

      case 'leave': {
        await this.leaveRoom(ws._rtSession, 'leave');
        break;
      }

      case 'debug-drop': {
        const enabled = this.env.RHYME_TOGETHER_DEBUG === '1' || this.env.RHYME_TOGETHER_DEBUG === 'true';
        if (!enabled) return this.send(ws._rtSession, 'error', { code: 'DISABLED', message: 'хук отключён' });
        this.log(`debug-drop: рву соединение ${ws._rtSession?.slice(0, 8)}`);
        const s = this.sockets.get(ws._rtSession);
        try { s?.close(4000, 'debug-drop'); } catch {}
        break;
      }

      case 'ping-state': {
        this.send(ws._rtSession, 'room', { room: this.snapshot() });
        break;
      }

      default:
        this.send(ws._rtSession, 'error', { code: 'BAD_TYPE', message: `Неизвестный тип: ${type}` });
    }
  }

  addPlayer(sessionId, name) {
    const r = this.meta;
    if (!r.playerOrder.includes(sessionId)) {
      if (r.playerOrder.length >= 2) throw new Error('FULL');
      r.playerOrder.push(sessionId);
    }
    const part = r.playerOrder.indexOf(sessionId) === 0 ? 'A' : 'B';
    const p = {
      sessionId, name, part, ready: false, connected: false,
      micOn: false, micLevel: 0, drift: 0, clockRtt: 0, joinedAt: now(),
    };
    r.players[sessionId] = p;
    r.lastActivity = now();
    return p;
  }

  // ── старт игры ────────────────────────────────────────────────────────────
  async maybeStart() {
    const r = this.meta;
    if (r.phase !== 'lobby' || r.playerOrder.length !== 2) return;
    const all = r.playerOrder.map((sid) => r.players[sid]).filter(Boolean);
    if (!all.every((p) => p.ready && p.connected)) return;

    const songId = r.preferredSong && SONGS[r.preferredSong]
      ? r.preferredSong
      : SONG_IDS[rand(SONG_IDS.length)];
    r.songId = songId;
    r.preferredSong = null;
    r.phase = 'countdown';
    r.results = {};
    r.rematchVotes = [];
    r.finalized = false;

    const maxLatency = Math.max(...all.map((p) => (p.clockRtt || 0) / 2));
    const leadMs = Math.max(7000, maxLatency + 4500);
    r.countdownAt = now();
    r.startAt = now() + leadMs;
    await this.save();

    const song = SONGS[songId];
    this.log(`старт в ${r.code}: «${song.title}», через ${(leadMs / 1000).toFixed(1)} с`);
    this.sendTo('song-assigned', {
      songId, startAt: r.startAt, serverTime: now(), leadMs,
      assignments: all.map((p) => ({ sessionId: p.sessionId, name: p.name, part: p.part })),
      driftToleranceMs: 120,
      room: this.snapshot(),
    });
    this.broadcastState();

    // фаза playing — ровно в момент старта; таймаут — конец песни + 20 с
    this.state.storage.setAlarm(r.startAt);
    this._phaseAt = 'playing';
  }

  // ── пробуждение по alarm: начало игры, публикация итога, очистка ──────────
  async alarm() {
    await this.load();
    const r = this.meta;
    if (!r) return;
    const t = now();

    // 1) публикация итога (после сбора двух результатов)
    if (Object.keys(r.results).length === 2 && !r.finalized) {
      await this.finalize();
      return;
    }
    // 2) начало песни
    if (r.startAt && t >= r.startAt && r.phase === 'countdown') {
      r.phase = 'playing';
      await this.save();
      this.broadcastState();
      // следующий будильник — конец песни + запас на результат
      const song = SONGS[r.songId];
      this.state.storage.setAlarm(r.startAt + song.durationSec * 1000 + 20000);
      return;
    }
    // 3) страховка: песня закончилась, а результат не пришёл
    if (r.phase === 'playing') {
      const song = SONGS[r.songId];
      if (t >= (r.startAt || 0) + song.durationSec * 1000 + 18000) {
        this.log(`таймаут результатов в ${r.code}`);
        await this.finalize(true);
        return;
      }
      this.state.storage.setAlarm((r.startAt || t) + song.durationSec * 1000 + 20000);
      return;
    }
    // 4) игрок не вернулся после обрыва — убираем
    const gone = r.playerOrder.find((sid) => !r.players[sid]?.connected);
    if (gone) await this.leaveRoom(gone, 'timeout');
  }

  async finalize(timeout = false) {
    const r = this.meta;
    if (!r?.songId || r.finalized) return;
    r.finalized = true;
    r.phase = 'results';
    const parts = ['A', 'B'];
    const entries = parts.map((part) => {
      const res = r.results[part];
      const p = r.playerOrder.map((sid) => r.players[sid]).find((x) => x?.part === part);
      return {
        part, sessionId: res?.sessionId || p?.sessionId || null,
        name: res?.name || p?.name || part,
        score: res?.score || null, timeout: !res,
      };
    });

    // командный результат: среднее по игрокам (игра командная, не соревнование)
    const scored = entries.filter((e) => e.score);
    const avgOf = (k) => {
      const vals = scored.map((e) => e.score[k]).filter((v) => v != null);
      if (!vals.length) return null;
      return round(vals.reduce((a, b) => a + b, 0) / vals.length, 1);
    };
    const team = {
      pitch: avgOf('pitch'), rhythm: avgOf('rhythm'), sync: avgOf('sync'),
      accuracy: avgOf('accuracy'), total: null, incomplete: scored.length < 2,
    };
    if (scored.length) {
      // 50/30/20; отсутствующая метрика не обнуляет итог, а перераспределяется
      const w = [['pitch', 0.5], ['rhythm', 0.3], ['sync', 0.2]].filter(([k]) => team[k] != null);
      const wsum = w.reduce((a, [, x]) => a + x, 0);
      team.total = wsum > 0 ? round(w.reduce((a, [k, x]) => a + team[k] * x, 0) / wsum, 1) : null;
    }

    const song = SONGS[r.songId];
    const payload = {
      songId: r.songId, songTitle: song.title, code: r.code,
      entries, team, timeout, duetCoverage: duetCoverage(song),
    };
    this.sendTo('results', { results: payload });
    r.lastResults = payload;
    await this.save();
    this.log(`итог ${r.code}: «${song.title}», командный балл ${team.total ?? '—'}`);

    // сохраняем матч в статистику (LOBBI)
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')).fetch(new Request('https://do/api/recordresult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songId: r.songId, songTitle: song.title, code: r.code,
          players: entries.map((e) => ({ sessionId: e.sessionId, name: e.name, part: e.part, score: e.score })),
          team,
        }),
      }));
    } catch (e) { this.log('не удалось записать статистику', e?.message); }

    // авто-очистка через 10 минут
    this.state.storage.setAlarm(now() + 10 * 60 * 1000);
  }

  async leaveRoom(sessionId, reason) {
    const r = this.meta;
    if (!r) return;
    const p = r.players[sessionId];
    if (!p) return;
    delete r.players[sessionId];
    r.playerOrder = r.playerOrder.filter((s) => s !== sessionId);
    delete r.results[p.part];
    r.rematchVotes = r.rematchVotes.filter((s) => s !== sessionId);
    this.sockets.delete(sessionId);
    this.sendTo('peer-left', { sessionId, part: p.part, name: p.name, reason });
    if (r.playerOrder.length === 0) {
      r.phase = 'closed';
      await this.state.storage.deleteAll();
      this.meta = null;
      this.log(`комната ${r.code} закрыта`);
      return;
    }
    // оставшийся становится хостом и получает партию A
    r.phase = 'lobby';
    r.results = {};
    r.startAt = null;
    r.countdownAt = null;
    r.songId = null;
    for (const sid of r.playerOrder) {
      const pl = r.players[sid];
      pl.part = r.playerOrder.indexOf(sid) === 0 ? 'A' : 'B';
      pl.ready = false;
    }
    await this.save();
    this.broadcastState();
    this.sendTo('room-reset', { reason: 'peer-left' });
  }

  async resetToLobby() {
    const r = this.meta;
    r.phase = 'lobby';
    r.songId = null;
    r.startAt = null;
    r.countdownAt = null;
    r.results = {};
    r.rematchVotes = [];
    r.finalized = false;
    for (const sid of r.playerOrder) r.players[sid].ready = false;
    await this.save();
    this.sendTo('room-reset', { reason: 'rematch', room: this.snapshot() });
    this.broadcastState();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// утилиты
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeName(n) {
  return String(n || 'Игрок').replace(/[<>&"']/g, '').trim().slice(0, 24) || 'Игрок';
}

/**
 * Покрытие дуэта: доля таймлайна, где обе партии звучат одновременно.
 * Характеристика аранжировки, а не оценка игроков.
 */
function duetCoverage(song) {
  const bpb = song.beatsPerBar, beat = 60 / song.bpm;
  const span = (part) => {
    const lines = song.vocal[part];
    if (!lines.length) return null;
    const first = lines[0], last = lines[lines.length - 1];
    return [(first.bar * bpb + first.beat) * beat, (last.bar * bpb + last.beat) * beat];
  };
  const A = span('A'), B = span('B');
  if (!A || !B) return null;
  const overlap = Math.max(0, Math.min(A[1], B[1]) - Math.max(A[0], B[0]));
  const union = Math.max(A[1], B[1]) - Math.min(A[0], B[0]);
  return { overlapSec: round(overlap, 1), unionSec: round(union, 1), ratio: round(overlap / union, 2) };
}

// для отладки в консоли воркера
export { SONGS, SONG_IDS };
