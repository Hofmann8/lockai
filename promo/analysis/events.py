"""成片配乐（按剪辑后的时间）的细节事件：各分轨的音头、贝斯快跑、离拍重音。

输出 events.json，给画面卡点用。每个事件：t（成片秒）、stem、strength（该分轨内归一化 0–1）、
b（所在拍号 + 拍内位置，按十六分音符取整）、pitch（贝斯，MIDI）。
"""
import json

import librosa
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


def onsets(stem, delta):
    y, _ = librosa.load(f'edit_{stem}.wav', sr=SR, mono=True)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    fr = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, backtrack=False, delta=delta, wait=6, units='frames')
    t = librosa.frames_to_time(fr, sr=SR, hop_length=HOP)
    s = env[fr]
    s = s / np.percentile(s, 98) if len(s) else s
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    loud = rms[np.minimum(fr + 4, len(rms) - 1)]
    return t, np.clip(s, 0, 1.5), y, loud / (rms.max() + 1e-9)


out = []
for stem, delta in [('bass', 0.08), ('drums', 0.1), ('other', 0.1), ('vocals', 0.12)]:
    t, s, y, loud = onsets(stem, delta)
    pitches = None
    if stem == 'bass':
        f0, _, _ = librosa.pyin(y, fmin=30, fmax=300, sr=SR, hop_length=HOP * 2)
        ft = librosa.times_like(f0, sr=SR, hop_length=HOP * 2)
        pitches = []
        for tt in t:
            w = (ft > tt + 0.02) & (ft < tt + 0.09)
            v = f0[w]
            v = v[~np.isnan(v)]
            pitches.append(float(np.round(librosa.hz_to_midi(np.median(v)), 1)) if len(v) else None)
    for k, tt in enumerate(t):
        b = to_beat(tt)
        q = round(b * 4) / 4
        ev = {'t': round(float(tt), 4), 'stem': stem, 'strength': round(float(s[k]), 3), 'loud': round(float(loud[k]), 3), 'b': round(float(b), 3), 'q': q, 'off': abs(b - q)}
        if pitches is not None:
            ev['pitch'] = pitches[k]
        out.append(ev)

out.sort(key=lambda e: e['t'])

# 贝斯快跑：连续 ≥3 个间隔 ≤ 0.16s 的音头
bass = [e for e in out if e['stem'] == 'bass']
runs = []
cur = [bass[0]] if bass else []
for a, b in zip(bass, bass[1:]):
    if b['t'] - a['t'] <= 0.16:
        cur.append(b)
    else:
        if len(cur) >= 3:
            runs.append(cur)
        cur = [b]
if len(cur) >= 3:
    runs.append(cur)

res = {
    'events': out,
    'bass_runs': [{'t0': r[0]['t'], 't1': r[-1]['t'], 'n': len(r), 'notes': [e['t'] for e in r], 'pitch': [e.get('pitch') for e in r]} for r in runs],
}
json.dump(res, open('events.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

print('bass runs:')
for r in res['bass_runs']:
    print(f"  {r['t0']:7.3f}–{r['t1']:7.3f}  b{to_beat(r['t0']):6.2f}  n={r['n']}  pitch={r['pitch']}")


def show(t0, t1):
    print(f'--- {t0}–{t1}s')
    for e in out:
        if t0 <= e['t'] < t1 and (e['strength'] > 0.35 or e['stem'] == 'bass'):
            pos = e['q'] % 1
            tag = {0: '拍', 0.25: 'e', 0.5: '&', 0.75: 'a'}.get(round(pos, 2), '?')
            print(f"  {e['t']:7.3f} b{e['q']:7.2f}{tag:>2} {e['stem']:6} s={e['strength']:.2f} L={e['loud']:.2f} {e.get('pitch') or ''}")


show(53.5, 57.5)
