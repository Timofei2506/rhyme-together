// Собирает src/data/songs/*.json в ES-модуль для Worker —
// Workers не умеют читать файлы с диска, поэтому данные вшиваются в бандл.
import fs from 'node:fs';
import path from 'node:path';

const dir = 'src/data/songs';
const songs = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  songs[s.id] = s;
}
const out = `// СГЕНЕРИРОВАНО tools/build-songs-module.mjs — не редактировать вручную.
export const SONGS = ${JSON.stringify(songs)};
export const SONG_IDS = Object.keys(SONGS);
`;
fs.writeFileSync('worker/songs.js', out);
console.log(`worker/songs.js: ${Object.keys(songs).length} песен, ${(out.length / 1024).toFixed(1)} КБ`);
