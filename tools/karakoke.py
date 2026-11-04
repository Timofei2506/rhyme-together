#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RHYME TOGETHER — караоке-конвертер.

Превращает обычные треки в песни, которые приложение умеет петь:

  1. ТЕКСТ. Кладёте рядом с треком файл с текстом (см. формат ниже).
     Из него собираются две вокальные партии (A и B) с таймингом.

  2. АУДИО. Из mp3/flac/wav делаются стемы:
       instrumental.mp3 — минус (если дали отдельный минус — берём его)
       guideA.mp3       — вспомогательный вокал партии A
       guideB.mp3       — вспомогательный вокал партии B
     mp3 выбран ради совместимости: его декодируют все браузеры без исключений.
     Если минуса нет, он вычитается из стерео-микса (center channel removal):
     это работает как в бытовых караоке-машинах — вокал уходит, инструментал остаётся.

  3. ПАРТИТУРА. Собирается JSON в формате приложения, плюс спектрограмма
     и волна — по ним удобно выставить тайминг текста на слух.

ФОРМАТ ТЕКСТА (обычный .txt):

    #title: Название
    #artist: Исполнитель
    #bpm: 96
    #bars: 32
    #beats: 4
    #tonic: 57
    #key: minor

    [0:12.4] Здесь первая строка партии A
    [0:15.9] Вторая строка партии A
    | [0:12.4] Это ответная строка партии B
    [0:19.2] Снова A

  • строка начинается с [мм:сс.д] — момент, когда она зазвучит;
  • строки без префикса | — партия A (первый игрок), с | — партия B;
  • слоги разделяются дефисом: «ло-у-фай», слова — пробелом;
  • если указать ноты нельзя, мелодия берётся из контура голоса: конвертер
    анализирует основной тон записи и выставляет etaлонные ноты автоматически;
  • #bpm нужен только для сетки; тайминг строк всё равно берётся из [мм:сс].

Запуск:
    python3 tools/karakoke.py song.mp3 song.txt my_song_id
    python3 tools/karakoke.py song.mp3 song.txt my_song_id --minus minus.mp3
    python3 tools/karakoke.py song.mp3 song.txt my_song_id --no-vocal-removal
"""
import json
import os
import re
import shutil
import subprocess
import sys

SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
OUT_DIR = os.path.join(SRC_DIR, 'data', 'songs')
AUDIO_DIR = 'data/audio'     # относительно src/
FFMPEG = shutil.which('ffmpeg') or '/tmp/ffmpeg'


# ─────────────────────────────────────────────────────────────────────────────
# разбор текста
# ─────────────────────────────────────────────────────────────────────────────
def parse_lyrics(path):
    meta, lines = {}, []
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            if line.startswith('#'):
                m = re.match(r'#(\w+):\s*(.+)', line)
                if m:
                    meta[m.group(1).lower()] = m.group(2).strip()
                continue
            part = 'A'
            if line.startswith('|'):
                part = 'B'
                line = line[1:].strip()
            m = re.match(r'\[(\d+):(\d+(?:\.\d+)?)\]\s*(.+)', line)
            if not m:
                print(f'  ! строка без тайминга пропущена: {line[:40]}')
                continue
            t = int(m.group(1)) * 60 + float(m.group(2))
            lines.append({'part': part, 't': t, 'text': m.group(3).strip()})
    return meta, lines


def syllables_of(text):
    """«ло-у-фай и дождь» → ['ло','у','фай','и','дождь'] с отметками слов."""
    out = []
    for wi, word in enumerate(text.split()):
        parts = [p for p in re.split(r'[-–]', word) if p]
        for j, p in enumerate(parts):
            out.append({'t': p, 'w': 1 if j == 0 else 0, 'word': wi})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# аудио
# ─────────────────────────────────────────────────────────────────────────────
def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'ffmpeg: {r.stderr[-500:]}')


def probe_duration(path):
    r = subprocess.run([FFMPEG, '-i', path], capture_output=True, text=True)
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', r.stderr)
    if not m:
        raise RuntimeError('не удалось определить длительность')
    h, mnt, sec = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return h * 3600 + mnt * 60 + sec


def make_instrumental(src, dst, remove_vocals=True):
    """Минус: вырезание центрального канала (вокал обычно по центру)."""
    if remove_vocals:
        # center removal через mid/side: side = L-R
        af = ('pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0,'
              'highpass=f=90,lowpass=f=15000')
    else:
        af = 'anull'
    run([FFMPEG, '-y', '-i', src, '-af', af, '-c:a', 'libmp3lame', '-q:a', '4', dst])


def make_guide(src, dst, gain_db=0.0):
    """Вспомогательный вокал: тот же трек с фильтром «телефонного» диапазона,
    чтобы голос читался поверх минуса и не спорил с ним по низам."""
    af = f'highpass=f=180,lowpass=f=8000,volume={gain_db}dB'
    run([FFMPEG, '-y', '-i', src, '-af', af, '-c:a', 'libmp3lame', '-q:a', '6', dst])


def make_spectrogram(src, dst, width=1600):
    """Спектрограмма + волна: по ним выставлять тайминг строк глазами."""
    # волна и спектр рисуются отдельно и склеиваются — так надёжнее на всех сборках
    wave = dst + '.wave.png'
    spec = dst + '.spec.png'
    run([FFMPEG, '-y', '-i', src, '-filter_complex',
         f'showwavespic=s={width}x120:colors=0x23f0ff', '-frames:v', '1', wave])
    run([FFMPEG, '-y', '-i', src, '-lavfi',
         f'showspectrumpic=s={width}x360:legend=1', '-frames:v', '1', spec])
    r = subprocess.run([FFMPEG, '-y', '-i', wave, '-i', spec, '-filter_complex',
                        'vstack=inputs=2', dst], capture_output=True, text=True)
    if r.returncode != 0:
        # нет фильтра vstack — оставляем хотя бы спектр
        shutil.copy(spec, dst)
    for f in (wave, spec):
        if os.path.exists(f):
            os.remove(f)


def analyze_pitch_contour(src, hop=0.05):
    """
    Оценка основного тона по кадрам (автокорреляция на numpy).
    Нужна, чтобы автоматически выставить эталонные ноты партий,
    когда в тексте они не заданы.
    """
    import numpy as np
    import wave

    tmp = src + '.tmp.wav'
    run([FFMPEG, '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp])
    with wave.open(tmp) as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    os.remove(tmp)
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    win = int(0.04 * sr)
    step = int(hop * sr)
    frames = []
    for i in range(0, max(1, len(x) - win), step):
        chunk = x[i:i + win]
        if np.sqrt((chunk ** 2).mean()) < 0.01:
            frames.append(None)
            continue
        c = np.correlate(chunk, chunk, 'full')[win - 1:]
        lo, hi = int(sr / 800), int(sr / 70)
        if hi >= len(c):
            frames.append(None)
            continue
        seg = c[lo:hi]
        lag = int(np.argmax(seg)) + lo
        frames.append(sr / lag if lag else None)
    return frames, hop, sr


def midi_of(freq):
    import math
    return int(round(69 + 12 * math.log2(freq / 440.0)))


# ─────────────────────────────────────────────────────────────────────────────
# сборка партитуры
# ─────────────────────────────────────────────────────────────────────────────
def build_song(song_id, meta, lines, duration, beats_per_bar=4, bpm=100, tonic=57, key='minor'):
    beat = 60.0 / bpm
    total_bars = int(duration / (beat * beats_per_bar)) + 1
    contour, hop, _ = analyze_pitch_contour(meta['_src'])

    vocal = {'A': [], 'B': []}
    for ln in lines:
        syl = syllables_of(ln['text'])
        if not syl:
            continue
        bar = ln['t'] / beat / beats_per_bar
        # длительность строки — до следующей строки той же партии, но не больше 4 тактов
        nxt = [x['t'] for x in lines if x['part'] == ln['part'] and x['t'] > ln['t'] + 0.05]
        end = min(nxt[0] if nxt else ln['t'] + 3.0, ln['t'] + 4 * beats_per_bar * beat)
        span = max(0.4, end - ln['t'])
        per = span / len(syl)

        # эталонная высота: медиана тона записи на этом отрезке
        seg = []
        for k in range(int(ln['t'] / hop), int((ln['t'] + span) / hop)):
            if 0 <= k < len(contour) and contour[k]:
                seg.append(contour[k])
        ref_midi = midi_of(sorted(seg)[len(seg) // 2]) if seg else tonic + 12

        syllables = []
        for i, s in enumerate(syl):
            midi = ref_midi
            syllables.append({
                't': s['t'], 'd': round(per / beat, 3), 'w': s['w'],
                'n': midi - tonic, 'midi': midi,
            })
        vocal[ln['part']].append({
            'bar': int(bar),
            'beat': round(bar - int(bar), 3) * beats_per_bar,
            'syllables': syllables,
            'text': ln['text'],
        })

    form = [{'name': 'Трек', 'bars': total_bars, 'kind': 'verse'}]
    # простая гармония-заглушка: тоника/субдоминанта/доминанта по кругу
    steps = [0, 0, 5, 7] if key == 'minor' else [0, 5, 7, 5]
    chords = [{'root': steps[i % 4], 'q': 'm' if key == 'minor' else 'M', 'bar': i}
              for i in range(total_bars)]

    return {
        'id': song_id,
        'title': meta.get('title', song_id),
        'artist': meta.get('artist', 'Неизвестный исполнитель'),
        'license': meta.get('license', 'CC BY 4.0'),
        'mood': meta.get('mood', 'современная'),
        'genre': meta.get('genre', 'pop'),
        'bpm': bpm, 'beatsPerBar': beats_per_bar,
        'key': key, 'tonic': tonic,
        'scale': [0, 2, 3, 5, 7, 8, 10] if key == 'minor' else [0, 2, 4, 5, 7, 9, 11],
        'difficulty': 2,
        'totalBars': total_bars,
        'countdownBars': 2,
        'durationSec': round(duration, 3),
        'parts': {'A': meta.get('partA', 'Вокал A'), 'B': meta.get('partB', 'Вокал B')},
        'form': form, 'chords': chords, 'vocal': vocal,
        'audio': {
            'instrumental': f'/{AUDIO_DIR}/{song_id}/instrumental.mp3',
            'guideA': f'/{AUDIO_DIR}/{song_id}/guideA.mp3',
            'guideB': f'/{AUDIO_DIR}/{song_id}/guideB.mp3',
        },
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    minus = None
    if '--minus' in sys.argv:
        minus = sys.argv[sys.argv.index('--minus') + 1]
        args = [a for a in args if a != minus]
    if len(args) < 3:
        print(__doc__)
        return 1
    audio, lyrics, song_id = args[0], args[1], args[2]

    if not os.path.exists(FFMPEG):
        print('Нужен ffmpeg: положите бинарник в /tmp/ffmpeg или в PATH')
        return 1

    meta, lines = parse_lyrics(lyrics)
    if not lines:
        print('В файле текста нет строк с таймингом [мм:сс.д]')
        return 1
    duration = probe_duration(minus or audio)
    bpm = float(meta.get('bpm', 100))
    bpb = int(meta.get('beats', 4))
    tonic = int(meta.get('tonic', 57))
    key = meta.get('key', 'minor')

    out_audio = os.path.join(SRC_DIR, *AUDIO_DIR.split('/'), song_id)
    os.makedirs(out_audio, exist_ok=True)

    print(f'• инструментал ({duration:.1f} c)')
    if minus:
        make_instrumental(minus, os.path.join(out_audio, 'instrumental.mp3'), remove_vocals=False)
    else:
        make_instrumental(audio, os.path.join(out_audio, 'instrumental.mp3'),
                          remove_vocals='--no-vocal-removal' not in flags)

    print('• вспомогательный вокал A и B')
    make_guide(audio, os.path.join(out_audio, 'guideA.mp3'), gain_db=-2)
    make_guide(audio, os.path.join(out_audio, 'guideB.mp3'), gain_db=-4)

    print('• спектрограмма для выставления тайминга')
    make_spectrogram(audio, os.path.join(out_audio, 'spectrogram.png'))

    meta['_src'] = audio
    song = build_song(song_id, meta, lines, duration, bpb, bpm, tonic, key)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, song_id + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(song, f, ensure_ascii=False, separators=(',', ':'))

    na = sum(len(l['syllables']) for l in song['vocal']['A'])
    nb = sum(len(l['syllables']) for l in song['vocal']['B'])
    print(f'\n✓ {song_id}: {duration:.1f} c, A — {na} слогов, B — {nb} слогов')
    print(f'  партитура: {path}')
    print(f'  стемы:     {out_audio}')
    print('\nДальше: пересоберите модуль песен для сервера и задеплойте:')
    print('  python3 tools/build_song_index.py && npm run deploy:cf')
    return 0


if __name__ == '__main__':
    sys.exit(main())
