"""导出画面卡点用的音头表 src/hits.json：每个分轨一串 [成片秒, 强度, 十六分音符位置(拍号)]。"""
import json
import librosa
import numpy as np
from events_beat import to_beat

SR = 22050
H = 110
out = {}
for stem in ['bass', 'drums', 'other', 'vocals']:
    y, _ = librosa.load(f'edit_{stem}.wav', sr=SR, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=H)
    t = librosa.times_like(env, sr=SR, hop_length=H)
    ref = np.percentile(env, 99)
    pk = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=np.percentile(env, 90) * 0.35, wait=3)
    rows = []
    for p in pk:
        s = float(env[p] / ref)
        if s < 0.3:
            continue
        rows.append([round(float(t[p]), 4), round(min(s, 1.5), 3), round(to_beat(t[p]) * 4) / 4])
    out[stem] = rows
    print(stem, len(rows))
json.dump(out, open('../src/hits.json', 'w'), separators=(',', ':'))
