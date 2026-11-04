/**
 * RHYME TOGETHER — хранилище статистики.
 *
 * MVP-адаптер: JSON-файл с атомарной записью (без внешних зависимостей).
 * Заменяется на Supabase через тот же интерфейс (см. store-supabase.js):
 *   await store.init(), store.recordResult(), store.leaderboard(), store.profile()
 */
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.RT_DB || path.join(process.cwd(), 'data', 'db.json');
const EMPTY = {
  version: 1,
  players: {},       // sessionId -> {name, createdAt, matches, bestTeamScore}
  matches: [],       // последние 200 матчей
};

let db = structuredClone(EMPTY);
let dirty = false;
let flushing = false;

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      db.players ||= {};
      db.matches ||= [];
    }
  } catch (e) {
    console.warn('[store] не удалось прочитать БД, стартую с пустой:', e.message);
  }
}

function save() {
  if (flushing) { dirty = true; return; }
  flushing = true;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.warn('[store] ошибка записи:', e.message);
  } finally {
    flushing = false;
    if (dirty) setTimeout(save, 50);
  }
}

export const store = {
  kind: 'json',
  async init() { load(); },

  async touchPlayer(sessionId, name) {
    if (!sessionId) return null;
    const p = db.players[sessionId] ||= { name, createdAt: Date.now(), matches: 0, bestTeamScore: 0, totalNotes: 0 };
    if (name) p.name = name;
    p.lastSeen = Date.now();
    dirty = true; save();
    return p;
  },

  async recordResult({ songId, songTitle, code, players, team }) {
    const match = {
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      songId, songTitle, code, at: Date.now(), team,
      players: players.map(p => ({
        sessionId: p.sessionId || null, name: p.name, part: p.part,
        pitch: p.score?.pitch ?? null, rhythm: p.score?.rhythm ?? null,
        sync: p.score?.sync ?? null, accuracy: p.score?.accuracy ?? null,
        notesHit: p.score?.notesHit ?? null, notesTotal: p.score?.notesTotal ?? null,
      })),
    };
    db.matches.unshift(match);
    db.matches = db.matches.slice(0, 200);
    for (const p of match.players) {
      if (!p.sessionId) continue;
      const rec = db.players[p.sessionId] ||= { name: p.name, createdAt: Date.now(), matches: 0, bestTeamScore: 0 };
      rec.name = p.name;
      rec.matches = (rec.matches || 0) + 1;
      rec.bestTeamScore = Math.max(rec.bestTeamScore || 0, Math.round(team.total || 0));
      rec.lastSong = songTitle;
      rec.lastAt = Date.now();
    }
    dirty = true; save();
    return match;
  },

  async leaderboard(limit = 10) {
    // лучшие командные результаты (пары)
    return db.matches
      .slice()
      .sort((a, b) => (b.team?.total || 0) - (a.team?.total || 0))
      .slice(0, limit)
      .map(m => ({
        at: m.at, song: m.songTitle, total: Math.round(m.team?.total || 0),
        names: m.players.map(p => `${p.name} (${p.part})`), code: m.code,
      }));
  },

  async profile(sessionId) {
    return db.players[sessionId] || null;
  },

  async stats() {
    const total = db.matches.length;
    const avg = total ? db.matches.reduce((s, m) => s + (m.team?.total || 0), 0) / total : 0;
    return {
      matches: total,
      players: Object.keys(db.players).length,
      avgTeamScore: Math.round(avg * 10) / 10,
      songsPlayed: [...new Set(db.matches.map(m => m.songId))].length,
    };
  },
};

export default store;
