import json
import numpy as np
SR = 22050
HOP = 128  # ≈5.8ms
beatmap = json.load(open('../src/beatmap.json', encoding='utf-8'))
raw = np.array([b['t'] for b in beatmap['beats']])
cut_t = beatmap['marks']['cut_film']
cut_i = int(np.argmax(raw >= cut_t - 0.05))


def fit(i0, i1):
    x = np.arange(i0, i1 + 1)
    k, c = np.polyfit(x, raw[i0:i1 + 1], 1)
    return k, c


SEG = [(0, 31, *fit(0, 31)), (32, cut_i - 1, *fit(32, cut_i - 1)), (cut_i, len(raw) - 1, *fit(cut_i, len(raw) - 1))]


def to_beat(t):
    """成片时间 → 拍号（浮点），用和画面一样的分段拟合拍网"""
    best = None
    for i0, i1, k, c in SEG:
        b = (t - c) / k
        if i0 - 0.5 <= b <= i1 + 1.5 or best is None:
            best = b
            if i0 - 0.5 <= b <= i1 + 1.5:
                break
    return best


