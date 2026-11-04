#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор музыкальной библиотеки RHYME TOGETHER.

Каждая песня — JSON-партитура: аккорды по тактам, форма, ДВЕ вокальные партии
(слоги + ноты + длительности). Из партитуры браузер синтезирует стемы:
инструментал, гайд-вокал A, гайд-вокал B (каждый — свой файл).

Формат строки вокальной партии:
    L(так, доля, "сло-ги сло-ва", "ступени", "длительности")
    ступень — номер ступени в ладу (0 = тоника, 7 = тоника октавой выше)
    длительность — в долях такта

Лицензии:
  • народные мелодии и баллады — Public Domain (аранжировка авторская);
  • современные треки — оригинальные сочинения для этого проекта (CC BY 4.0):
    мелодия и текст написаны здесь, чужие произведения не используются.
"""
import json, os

MINOR = [0, 2, 3, 5, 7, 8, 10]
MAJOR = [0, 2, 4, 5, 7, 9, 11]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "data", "songs")


def semi(degree, scale):
    oct_, step = divmod(degree, 7)
    return oct_ * 12 + scale[step]


class Song:
    def __init__(self, sid, title, artist, bpm, bpb, tonic, key, difficulty,
                 form, chords, part_labels, mood, countdown_bars=2,
                 license="Public Domain", genre="folk"):
        self.sid, self.title, self.artist = sid, title, artist
        self.bpm, self.bpb, self.tonic, self.key = bpm, bpb, tonic, key
        self.scale = MINOR if key == "minor" else MAJOR
        self.difficulty, self.form, self.chords = difficulty, form, chords
        self.part_labels, self.mood = part_labels, mood
        self.countdown_bars = countdown_bars
        self.license, self.genre = license, genre
        self.lines = {"A": [], "B": []}
        self.errors = []
        self.total_bars = sum(b for (_, b, _) in form)

    def L(self, part, bar, beat, text, degs, durs):
        syl = [s for w in text.split() for s in w.split("-") if s]
        dg = [int(x) for x in degs.split()]
        du = [float(x) for x in durs.split()]
        if len(syl) != len(dg) or len(syl) != len(du):
            self.errors.append(
                f"[{self.sid}/{part}] бар {bar}: слогов {len(syl)}, нот {len(dg)}, длит {len(du)}"
                f"\n    текст: {text}\n    ноты : {degs}\n    длит : {durs}")
            dg = (dg + [0] * len(syl))[:len(syl)]
            du = (du + [0.5] * len(syl))[:len(syl)]
        syls, k = [], 0
        for w in text.split():
            parts = [p for p in w.split("-") if p]
            for j, s in enumerate(parts):
                syls.append({"t": s, "d": du[k], "w": 1 if j == 0 else 0,
                             "n": dg[k], "midi": self.tonic + semi(dg[k], self.scale)})
                k += 1
        self.lines[part].append({"bar": bar, "beat": beat, "syllables": syls,
                                 "text": " ".join(text.split())})
        return self

    def _despace(self, part):
        """Разводит строки так, чтобы ноты никогда не перекрывались.
        Возвращает величину сдвига в долях — для диагностики."""
        lines = sorted(self.lines[part], key=lambda l: (l["bar"], l["beat"]))
        prev_end = -1e9
        drift = 0.0
        for ln in lines:
            start = ln["bar"] * self.bpb + ln["beat"]
            dur = sum(x["d"] for x in ln["syllables"])
            if start < prev_end + 0.2:
                start = prev_end + 0.2
            ln["bar"] = int(start // self.bpb)
            ln["beat"] = round(start - ln["bar"] * self.bpb, 4)
            prev_end = start + dur
            drift = max(drift, prev_end - self.total_bars * self.bpb)
        self.lines[part] = lines
        return drift

    def check_and_fix(self):
        """Проверяет партитуру: перекрытия, выход за границы, пустые партии."""
        problems, fixes = [], []
        for part in ("A", "B"):
            if not self.lines[part]:
                problems.append(f"{self.sid}: партия {part} пуста")
                continue
            overflow = self._despace(part)
            if overflow > 0:
                problems.append(f"{self.sid}/{part}: выходит за длительность на {overflow:.2f} долей")
            # повторная проверка перекрытий
            prev_end = -1e9
            for ln in self.lines[part]:
                start = ln["bar"] * self.bpb + ln["beat"]
                dur = sum(x["d"] for x in ln["syllables"])
                if start < prev_end - 1e-6:
                    problems.append(f"{self.sid}/{part}: перекрытие в такте {ln['bar']}")
                prev_end = start + dur
            fixes.append(f"{self.sid}/{part}: {len(self.lines[part])} фраз, "
                         f"последняя заканчивается на {prev_end/self.bpb:.2f} такта")
        return problems, fixes

    def score(self):
        def t(bar):
            return bar * self.bpb * 60.0 / self.bpm
        return {
            "id": self.sid, "title": self.title, "artist": self.artist,
            "license": self.license, "mood": self.mood, "genre": self.genre,
            "bpm": self.bpm, "beatsPerBar": self.bpb, "key": self.key,
            "tonic": self.tonic, "scale": self.scale, "difficulty": self.difficulty,
            "totalBars": self.total_bars, "countdownBars": self.countdown_bars,
            "durationSec": round(t(self.total_bars), 3),
            "parts": self.part_labels,
            "form": [{"name": n, "bars": b, "kind": k} for (n, b, k) in self.form],
            "chords": [{"root": r, "q": q, "bar": i} for i, (r, q) in enumerate(self.chords)],
            "vocal": {p: sorted(self.lines[p], key=lambda l: (l["bar"], l["beat"]))
                      for p in ("A", "B")},
        }


def kalinka():
    s = Song("kalinka", "Калинка", "Русская народная", 120, 4, 57, "minor", 2,
             [("Вступление", 4, "intro"), ("Куплет 1", 8, "verse"), ("Припев", 8, "chorus"),
              ("Куплет 2", 8, "verse"), ("Припев", 8, "chorus"), ("Кода", 4, "outro")],
             [("A", "m")] * 2 + [("E", "M")] * 2 + [("A", "m")] * 2 + [("D", "m"), ("E", "M")] +
             [("A", "m")] * 2 + [("E", "M")] * 2 + [("A", "m")] * 2 + [("D", "m"), ("E", "M")] +
             [("A", "m")] * 2 + [("E", "M")] * 2 + [("A", "m")] * 2 + [("D", "m"), ("E", "M")] +
             [("A", "m")] * 2 + [("E", "M")] * 2 + [("A", "m")] * 2 + [("D", "m"), ("E", "M")],
             {"A": "Мелодия", "B": "Подголосок"}, "зажигательная")
    # ── Куплет 1 (такты 4–11)
    s.L("A", 4, 0, "Ка-лин-ка, ка-лин-ка", "7 9 8 7 9 8", "0.5 0.5 0.5 0.5 0.5 0.5")
    s.L("A", 5, 2, "ка-лин-ка мо-я", "9 10 9 8 7", "0.5 0.5 0.5 0.5 0.5")
    s.L("A", 6, 0, "В са-ду я-го-да", "7 9 10 9 8 9", "0.5 0.5 0.5 0.5 0.5 0.5")
    s.L("A", 7, 1, "ма-лин-ка мо-я", "8 9 10 9 8", "0.5 0.5 1 0.5 1")
    # ── Припев (такты 12–19)
    s.L("A", 12, 0, "Ой, ка-лин-ка, ка-лин-ка", "9 10 9 8 7 8 7", "0.5 0.5 0.5 0.5 0.5 0.5 1")
    s.L("A", 13, 2, "ка-лин-ка мо-я", "9 10 9 8 9", "0.5 0.5 0.5 0.5 0.5")
    s.L("A", 14, 0, "В са-ду я-го-да", "10 9 8 7 8 9", "0.5 0.5 0.5 0.5 0.5 1.5")
    s.L("A", 15, 1, "ма-лин-ка мо-я", "10 9 8 7 7", "0.5 0.5 0.5 0.5 1")
    s.L("A", 16, 0, "Ой, ка-лин-ка, ка-лин-ка", "9 10 9 8 7 8 9", "0.5 0.5 0.5 0.5 0.5 0.5 1")
    s.L("A", 17, 2, "ка-лин-ка мо-я", "9 10 9 8 9", "0.5 0.5 0.5 0.5 0.5")
    s.L("A", 18, 0, "В са-ду я-го-да", "10 9 8 7 8 9", "0.5 0.5 0.5 0.5 0.5 1.5")
    s.L("A", 19, 0, "ма-лин-ка мо-я", "9 8 7 7 7", "0.5 0.5 1 1 1")
    # ── партия B: подголосок терцией ниже
    s.L("B", 4, 2, "Ка-лин-ка", "4 5 4", "0.5 0.5 1")
    s.L("B", 5, 0, "ой да мо-я", "3 4 5 4", "0.5 0.5 1 1")
    s.L("B", 6, 2, "я-го-да", "4 5 4", "0.5 0.5 1")
    s.L("B", 7, 0, "ма-лин-ка-а", "3 4 5 4", "0.5 0.5 1 1")
    s.L("B", 12, 2, "Ой, ка-лин-ка", "5 6 5 6", "0.5 0.5 0.5 0.5")
    s.L("B", 13, 0, "ой да мо-я", "4 5 6 5", "0.5 0.5 1 1")
    s.L("B", 14, 2, "я-го-да", "5 6 5", "0.5 0.5 1")
    s.L("B", 15, 0, "ма-лин-ка-а", "4 5 6 5", "0.5 0.5 1 1")
    s.L("B", 16, 2, "Ой, ка-лин-ка", "5 7 6 7", "0.5 0.5 0.5 0.5")
    s.L("B", 17, 0, "ой да мо-я", "4 6 7 6", "0.5 0.5 1 1")
    s.L("B", 18, 2, "я-го-да", "6 7 6", "0.5 0.5 1")
    s.L("B", 19, 0, "ма-лин-ка-а", "5 4 3 2", "0.5 0.5 1 2")
    return s


def bereza():
    s = Song("bereza", "Во поле берёза стояла", "Русская народная", 84, 4, 52, "minor", 1,
             [("Вступление", 2, "intro"), ("Куплет 1", 8, "verse"), ("Припев", 8, "chorus"),
              ("Кода", 2, "outro")],
             [("E", "m"), ("E", "m"), ("A", "m"), ("A", "m"), ("G", "M"), ("D", "M"),
              ("E", "m"), ("E", "m")] * 2 + [("E", "m"), ("E", "m")],
             {"A": "Запев", "B": "Отклик"}, "плавная")
    s.L("A", 2, 0, "Во по-ле бе-рё-за", "7 8 9 8 7 5", "1 0.5 0.5 0.5 0.5 1")
    s.L("A", 3, 2, "сто-я-ла", "7 8 7", "0.5 0.5 1")
    s.L("A", 4, 0, "Во по-ле ку-дря-ва-я", "7 8 9 10 9 8 7", "1 0.5 0.5 0.5 0.5 0.5 0.5")
    s.L("A", 5, 2, "сто-я-ла", "9 8 7", "0.5 0.5 1")
    s.L("A", 6, 0, "Лю-ли, лю-ли", "7 9 8 7", "0.5 0.5 0.5 0.5")
    s.L("A", 6, 2, "сто-я-ла", "7 8 7", "0.5 0.5 1")
    s.L("A", 7, 0, "Лю-ли, лю-ли", "9 10 9 8", "0.5 0.5 0.5 0.5")
    s.L("A", 7, 2, "сто-я-ла", "7 7 7", "0.5 0.5 1")
    s.L("A", 9, 0, "Ко-му бе-рё-зу", "7 8 9 8 7", "1 0.5 0.5 0.5 1.5")
    s.L("A", 10, 0, "за-ло-ма-ти", "5 7 8 7", "1 0.5 0.5 2")
    s.L("A", 11, 0, "Ко-му ку-дря-ву-ю", "7 8 9 10 9 8", "1 0.5 0.5 0.5 0.5 1")
    s.L("A", 12, 0, "за-ло-ма-ти", "9 8 7 7", "1 0.5 0.5 2")
    s.L("A", 13, 0, "Лю-ли, лю-ли", "7 9 8 7", "0.5 0.5 0.5 0.5")
    s.L("A", 13, 2, "за-ло-ма-ти", "7 8 7 7", "0.5 0.5 1 2")
    s.L("A", 15, 0, "Лю-ли, лю-ли", "9 10 9 7", "0.5 0.5 1 2")
    s.L("B", 2, 2, "бе-рё-за", "4 5 4", "0.5 0.5 1")
    s.L("B", 4, 2, "ку-дря-ва-я", "3 4 5 4", "0.5 0.5 0.5 0.5")
    s.L("B", 5, 0, "ой да бе-рё-за", "2 3 4 5 4", "0.5 0.5 0.5 0.5 1")
    s.L("B", 6, 0, "Лю-ли, лю-ли", "4 6 5 4", "0.5 0.5 0.5 0.5")
    s.L("B", 7, 0, "ой да лю-ли", "6 7 6 5", "0.5 0.5 0.5 0.5")
    s.L("B", 9, 2, "бе-рё-зу", "4 5 4", "0.5 0.5 1")
    s.L("B", 11, 0, "ку-дря-ву-ю", "3 4 5 4", "1 0.5 0.5 1")
    s.L("B", 13, 0, "Лю-ли, лю-ли", "4 6 5 4", "0.5 0.5 0.5 0.5")
    s.L("B", 14, 0, "ой да лю-ли", "6 7 6 5", "1 0.5 0.5 1")
    s.L("B", 15, 0, "за-ло-ма-ти", "7 7 7 7", "0.5 0.5 1 2")
    return s


def grace():
    s = Song("amazing_grace", "Amazing Grace", "Trad. / J. Newton, 1779", 76, 3, 55, "major", 1,
             [("Вступление", 3, "intro"), ("Куплет 1", 9, "verse"), ("Куплет 2", 9, "verse"),
              ("Кода", 3, "outro")],
             [("G", "M"), ("G", "M"), ("C", "M"), ("G", "M"), ("D", "M"), ("G", "M"), ("G", "M"),
              ("D", "M"), ("G", "M"), ("G", "M"), ("D", "M"), ("G", "M"), ("G", "M"), ("C", "M"),
              ("G", "M"), ("D", "M"), ("G", "M"), ("G", "M"), ("D", "M"), ("G", "M"), ("G", "M"),
              ("G", "M"), ("D", "M"), ("G", "M")],
             {"A": "Melody", "B": "Harmony"}, "hymn")
    s.L("A", 3, 0, "A-ma-zing grace, how sweet", "4 7 7 9 9 7", "0.75 0.75 0.75 0.75 0.5 0.5")
    s.L("A", 4, 1, "the sound", "7 7", "1 1")
    s.L("A", 5, 0, "That saved a wretch of", "5 4 4 7 7", "0.75 0.75 0.75 0.75 1")
    s.L("A", 6, 0, "like me", "9 7", "1 2")
    s.L("A", 7, 0, "I once was lost", "9 9 9 11", "0.75 0.75 0.75 0.75")
    s.L("A", 8, 0, "but now am found", "9 7 9 7", "0.75 0.75 0.75 0.75")
    s.L("A", 9, 0, "Was blind but now", "5 4 7 7", "0.75 0.75 0.75 0.75")
    s.L("A", 10, 0, "I see", "9 7", "1 2")
    s.L("A", 12, 0, "'Twas grace that taught my", "4 7 7 9 9", "0.75 0.75 0.75 0.75 0.75")
    s.L("A", 13, 0, "my heart to fear", "7 7 9 7", "0.75 0.75 0.75 0.75")
    s.L("A", 14, 0, "And grace my fears re-", "5 4 4 7 7", "0.75 0.75 0.75 0.75 0.75")
    s.L("A", 15, 0, "re-lieved", "9 7", "1 2")
    s.L("A", 16, 0, "How pre-cious did", "9 9 11 9", "0.75 0.75 0.75 0.75")
    s.L("A", 17, 0, "that grace ap-pear", "7 9 7 5", "0.75 0.75 0.75 0.75")
    s.L("A", 18, 0, "The hour I first", "4 7 7 9", "0.75 0.75 0.75 0.75")
    s.L("A", 19, 0, "be-lieved", "7 7", "1 2")
    s.L("B", 4, 0, "how sweet the ver-y", "2 4 4 2 0", "0.75 0.75 0.75 0.75 0.75")
    s.L("B", 6, 1, "a wretch like me I", "4 5 4 2 0", "0.75 0.75 0.75 0.75 0.75")
    s.L("B", 8, 0, "was lost but now", "6 7 6 5", "1 1 1 1")
    s.L("B", 9, 1, "am found", "2 0", "1 1")
    s.L("B", 10, 0, "I see", "2 0", "1 2")
    s.L("B", 13, 0, "that taught my heart to", "2 4 4 2 0", "0.75 0.75 0.75 0.75 0.75")
    s.L("B", 15, 0, "to fear", "4 2", "1 2")
    s.L("B", 16, 1, "grace a-", "6 7", "1 1")
    s.L("B", 17, 1, "my fears", "5 4", "1 2")
    s.L("B", 19, 0, "I see", "2 0", "1 2")
    return s


def scarborough():
    s = Song("scarborough", "Scarborough Fair", "English trad. ballade", 96, 3, 57, "minor", 3,
             [("Вступление", 3, "intro"), ("Куплет 1", 9, "verse"), ("Куплет 2", 9, "verse"),
              ("Кода", 3, "outro")],
             [("A", "m"), ("A", "m"), ("G", "M"), ("A", "m"), ("C", "M"), ("A", "m"), ("G", "M"),
              ("E", "M"), ("A", "m"), ("A", "m"), ("A", "m"), ("G", "M"), ("A", "m"), ("C", "M"),
              ("A", "m"), ("G", "M"), ("E", "M"), ("A", "m"), ("A", "m"), ("A", "m"), ("G", "M"),
              ("A", "m"), ("E", "M"), ("A", "m")],
             {"A": "Верхний голос", "B": "Нижний голос"}, "старинная")
    s.L("A", 3, 0, "Are you go-ing", "7 7 12 12", "1 1 0.5 0.5")
    s.L("A", 4, 0, "to Scar-bo-rough Fair", "12 11 12 11 9", "0.75 0.5 0.5 0.5 0.75")
    s.L("A", 5, 0, "Pars-ley, sage,", "9 9 8", "1 1 1")
    s.L("A", 6, 0, "rose-ma-ry and thyme", "7 9 8 7 6", "0.75 0.75 0.5 0.5 0.5")
    s.L("A", 7, 0, "Re-mem-ber me", "12 11 9 9", "1 1 0.5 0.5")
    s.L("A", 8, 0, "to one who lives there", "7 7 9 7 6", "0.75 0.75 0.5 0.5 0.5")
    s.L("A", 9, 0, "She once was", "7 9 11", "1 1 1")
    s.L("A", 10, 0, "a true love of mine", "12 12 11 9 7", "1 1 0.5 0.5 1")
    s.L("A", 12, 0, "Tell her to make me", "7 7 12 12 11", "0.75 0.75 0.5 0.5 0.5")
    s.L("A", 13, 0, "a cam-bric shirt", "12 11 9 8", "0.75 0.75 0.75 0.75")
    s.L("A", 14, 0, "Pars-ley, sage,", "9 9 8", "1 1 1")
    s.L("A", 15, 0, "rose-ma-ry and thyme", "7 9 8 7 6", "0.75 0.75 0.5 0.5 0.5")
    s.L("A", 16, 0, "With-out no seams", "12 12 11 9", "0.75 0.75 0.75 0.75")
    s.L("A", 17, 0, "nor nee-dle-work", "7 7 6 7", "0.75 0.75 0.75 0.75")
    s.L("A", 18, 0, "Then she will be", "7 9 11 9", "0.75 0.75 0.75 0.75")
    s.L("A", 19, 0, "a true love of mine", "12 12 11 9 7", "1 1 0.5 0.5 1")
    s.L("B", 3, 0, "go-ing to", "4 4 9", "1 1 1")
    s.L("B", 4, 0, "Scar-bo-rough Fair", "9 9 8 9", "1 0.5 0.5 1")
    s.L("B", 6, 0, "thyme", "4", "3")
    s.L("B", 7, 0, "Re-mem-ber me", "9 8 6 6", "1 1 0.5 0.5")
    s.L("B", 8, 0, "one who lives there", "4 4 2 4", "1 1 0.5 0.5")
    s.L("B", 9, 0, "once was", "4 8", "1 2")
    s.L("B", 10, 0, "a true love of mine", "9 9 8 6 4", "1 1 0.5 0.5 1")
    s.L("B", 12, 0, "Tell her to make", "4 4 9 9", "0.75 0.75 0.75 0.75")
    s.L("B", 13, 0, "a cam-bric shirt", "8 8 6 4", "1 1 0.5 1")
    s.L("B", 15, 0, "thyme", "4", "3")
    s.L("B", 16, 0, "with-out", "9 6", "1 2")
    s.L("B", 17, 0, "nor nee-dle-work", "4 4 2 4", "0.75 0.75 0.75 0.75")
    s.L("B", 18, 0, "then she will", "4 8 6", "1 1 1")
    s.L("B", 19, 0, "a true love of mine", "9 9 8 6 4", "1 1 0.5 0.5 1")
    return s


def main():
    os.makedirs(OUT, exist_ok=True)
    songs = [kalinka(), bereza(), grace(), scarborough()]
    index = []
    for sc in songs:
        if sc.errors:
            print("\n".join(sc.errors)); raise SystemExit(f"Ошибки разметки: {sc.sid}")
        problems, fixes = sc.check_and_fix()
        if problems:
            print("ПРОБЛЕМЫ:\n  " + "\n  ".join(problems))
            raise SystemExit("Партитура не прошла проверку перекрытий")
        for f in fixes:
            print("  •", f)
        data = sc.score()
        path = os.path.join(OUT, data["id"] + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        na = sum(len(l["syllables"]) for l in data["vocal"]["A"])
        nb = sum(len(l["syllables"]) for l in data["vocal"]["B"])
        index.append({
            "id": data["id"], "title": data["title"], "artist": data["artist"],
            "duration": data["durationSec"], "bpm": data["bpm"], "parts": data["parts"],
            "difficulty": data["difficulty"], "notes": {"A": na, "B": nb},
            "license": data["license"], "mood": data["mood"], "bars": data["totalBars"],
        })
        print(f"✓ {data['id']:<15} {data['durationSec']:6.1f} c  A:{na:3d} нот  B:{nb:3d} нот  "
              f"{data['title']} ({os.path.getsize(path)} байт)")
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f"\nБиблиотека: {len(index)} песни → {OUT}")


if __name__ == "__main__":
    main()
