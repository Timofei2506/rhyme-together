#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Собирает из src/data/songs/*.json индекс библиотеки и модуль песен для Worker.
Запускать после добавления/правки песни: python3 tools/build_song_index.py
"""
import json, os, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SONGS = os.path.join(ROOT, 'src', 'data', 'songs')
index = []
for f in sorted(os.listdir(SONGS)):
    if not f.endswith('.json') or f == 'index.json':
        continue
    with open(os.path.join(SONGS, f), encoding='utf-8') as fh:
        s = json.load(fh)
    na = sum(len(l['syllables']) for l in s['vocal']['A'])
    nb = sum(len(l['syllables']) for l in s['vocal']['B'])
    index.append({
        'id': s['id'], 'title': s['title'], 'artist': s['artist'],
        'duration': s['durationSec'], 'bpm': s['bpm'], 'parts': s['parts'],
        'difficulty': s['difficulty'], 'notes': {'A': na, 'B': nb},
        'license': s.get('license', ''), 'mood': s.get('mood', ''),
        'genre': s.get('genre', 'folk'), 'bars': s['totalBars'],
        'audio': bool(s.get('audio')),
    })
with open(os.path.join(SONGS, 'index.json'), 'w', encoding='utf-8') as fh:
    json.dump(index, fh, ensure_ascii=False, indent=1)
print(f'индекс: {len(index)} песен (с загруженным аудио: {sum(1 for x in index if x["audio"])})')

# модуль для Worker
r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'build-songs-module.mjs')]
                   if False else ['node', os.path.join(ROOT, 'tools', 'build-songs-module.mjs')],
                   cwd=ROOT, capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip())
