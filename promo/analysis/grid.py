"""把各分轨的音头画成十六分音符网格（像鼓机谱），看清切分和加花。"""
import json
import librosa
import numpy as np

SR = 22050
H = 110
ev = json.load(open('events.json', encoding='utf-8'))
from events_beat import to_beat  # noqa

rows = {}
for stem in ['bass', 'drums', 'other', 'vocals']:
    y, _ = librosa.load(f'edit_{stem}.wav', sr=SR, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=H)
    t = librosa.times_like(env, sr=SR, hop_length=H)
    ref = np.percentile(env, 99)
    pk = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=np.percentile(env, 90) * 0.35, wait=3)
    rows[stem] = [(t[p], env[p] / ref) for p in pk]

cells = {}
for stem, hits in rows.items():
    for tt, s in hits:
        b = to_beat(tt)
        q = int(round(b * 4))
        if q < 0:
            continue
        cells.setdefault((stem, q), 0)
        cells[(stem, q)] = max(cells[(stem, q)], s)

def ch(v):
    return '.' if v < 0.3 else 'x' if v < 0.7 else 'X'

import sys
b0, b1 = int(sys.argv[1]), int(sys.argv[2])
for bar in range(b0, b1, 4):
    print(f'b{bar:3d}  ' + ' '.join(f'{bar + k:<4d}' for k in range(4)))
    for stem in ['vocals', 'other', 'bass', 'drums']:
        line = ''
        for k in range(16):
            line += ch(cells.get((stem, bar * 4 + k), 0))
            if k % 4 == 3:
                line += ' '
        print(f'  {stem[:3]} {line}')
