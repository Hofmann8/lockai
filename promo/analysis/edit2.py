"""配乐剪辑 v2：只剪一刀，停顿和重音都用原曲里真实的。

原曲 176.26s 乐队整体停下、176.52s 全乐队砸回来（"停一拍，再落下"），之后按原曲的方式淡出。
剪辑点用 cutsearch3.py 找：A=70.629 → B=169.361，贝斯和鼓都在零错位时相关最高。
原曲 3:01 那句 "Get up offa that thing" 落在成片约 82.5s，正好压在结尾卡片上。
"""
import json

import numpy as np
import soundfile as sf

y, sr = sf.read('song.wav', dtype='float32')
A, B = 70.629, 169.361
STOP, HIT = 176.26, 176.518
TOTAL = 85.0
FADE = 4.5
pre = 0.006
xf = int(0.008 * sr)


def seg(z, a, b):
    return z[int(a * sr):int(b * sr)].copy()


def build(z):
    s1 = seg(z, 0, A - pre)
    film_b = len(s1) - xf  # 第二段在成片里的起点（样本）
    s2 = seg(z, B - pre, B - pre + (TOTAL * sr - film_b) / sr)
    fade = np.linspace(0, np.pi / 2, xf)[:, None]
    s1[-xf:] *= np.cos(fade)
    s2[:xf] *= np.sin(fade)
    out = np.concatenate([s1[:-xf], s1[-xf:] + s2[:xf], s2[xf:]])[: int(TOTAL * sr)]
    # 原曲式的淡出（余弦）
    n = int(FADE * sr)
    out[-n:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, n)))[:, None]
    return out, film_b


out, film_b = build(y)
peak = np.abs(out).max()
if peak > 0.98:
    out *= 0.98 / peak
sf.write('../public/audio/score.wav', out, sr, subtype='PCM_16')

to_film = lambda t: (film_b + (t - (B - pre)) * sr) / sr  # noqa: E731
marks = dict(
    cut_film=film_b / sr, stop_film=to_film(STOP), hit_film=to_film(HIT), total=len(out) / sr,
    fade_film=len(out) / sr - FADE, tA=A, tB=B, tStop=STOP, tHit=HIT, pre=pre,
)
json.dump(marks, open('edit_marks.json', 'w'), indent=1)
print(marks)

for k in ['drums', 'bass', 'other', 'vocals']:
    z, _ = sf.read(f'stem_{k}.wav', dtype='float32')
    o, _ = build(z)
    sf.write(f'edit_{k}.wav', o, sr, subtype='PCM_16')
