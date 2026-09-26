"""分析用户手打的点：测按键延迟、吸附到真实音头、找出"比拍子密"的段落和对应乐器。"""
import json
import numpy as np

taps = json.load(open('taps.json', encoding='utf-8'))['taps']
T = np.array([p['t'] for p in taps])
bm = json.load(open('../src/beatmap.json'))
beats = np.array([b['t'] for b in bm['beats']])
hits = json.load(open('../src/hits.json'))
M = bm['marks']

# 1) 延迟：离拍子最近的点，和拍子的差
d = np.array([t - beats[np.argmin(np.abs(beats - t))] for t in T])
on_beat = np.abs(d) < 0.12
lat = float(np.median(d[on_beat]))
print(f'按键延迟中位数 {lat*1000:+.0f}ms（{on_beat.sum()} 个点在拍子附近），离散 {np.std(d[on_beat])*1000:.0f}ms')

# 2) 吸附：校正延迟后，找 ±90ms 内最强的音头（任一分轨）
ons = sorted([(t, s, k) for k, v in hits.items() for t, s, q in v])
ot = np.array([o[0] for o in ons])


def beat_pos(t):
    i = np.searchsorted(beats, t) - 1
    i = max(0, min(i, len(beats) - 2))
    return i + (t - beats[i]) / (beats[i + 1] - beats[i])


snapped = []
for p in taps:
    t = p['t'] - lat
    w = np.where(np.abs(ot - t) < 0.09)[0]
    if len(w):
        cand = sorted([ons[i] for i in w], key=lambda o: -o[1] + abs(o[0] - t) * 4)
        best = cand[0]
        stems = sorted({ons[i][2] for i in w if abs(ons[i][0] - best[0]) < 0.03})
        snapped.append(dict(tap=p['t'], t=round(best[0], 4), stems=stems, b=round(beat_pos(best[0]), 2)))
    else:
        snapped.append(dict(tap=p['t'], t=round(t, 4), stems=[], b=round(beat_pos(t), 2)))

# 去重（同一个音头被打了多次）
uniq = []
for s in snapped:
    if uniq and abs(uniq[-1]['t'] - s['t']) < 0.04:
        continue
    uniq.append(s)

# 3) 密集段落：相邻间隔 < 0.38s（比一拍短）
dense = []
cur = [uniq[0]]
for a, b in zip(uniq, uniq[1:]):
    if b['t'] - a['t'] < 0.38:
        cur.append(b)
    else:
        if len(cur) >= 2:
            dense.append(cur)
        cur = [b]
if len(cur) >= 2:
    dense.append(cur)

print(f'\n吸附后 {len(uniq)} 个点；密集段落 {len(dense)} 处：')
for g in dense:
    print(f"  {g[0]['t']:6.2f}–{g[-1]['t']:6.2f}s  " + '  '.join(f"b{x['b']:.2f}[{'/'.join(s[:3] for s in x['stems']) or '—'}]" for x in g))

print('\n停/落附近：stop', round(M['stop_film'], 3), 'hit', round(M['hit_film'], 3))
for s in snapped:
    if 76.8 < s['tap'] < 78.4:
        print('  tap', s['tap'], '→', s['t'], s['stems'], 'b', s['b'])

json.dump(dict(latency=lat, points=uniq, dense=[[x['t'] for x in g] for g in dense]), open('taps_snapped.json', 'w'), indent=1)

# 4) 人工纠错：手打的点不是都准（尤其密集处和结尾）。和音头逐个对过之后：
#    - 15.916：附近没有任何音头，是多按的一下 → 删
#    - 18.071：真正的音是 18.194 的吉他（1.5），手早了 120ms，超出吸附窗 → 改
#    - 67.736 / 68.034：同一个音（67.896，"Follow me" 的 me + 贝斯 + 吉他）打了两次，一早一晚 → 合并
#    - 75.673：那四下是整拍（75.28 / 75.73 / 76.27 / 76.81），被吸到了早 70ms 的贝斯上 → 改回拍上的鼓
#    - 77.568：停顿里的那一下是"心里的拍"，没有音头，保留
FIX = {15.9163: None, 18.0713: 18.194, 67.7361: 67.896, 68.0343: None, 75.673: 75.733}
fixed = []
for s in uniq:
    k = next((k for k in FIX if abs(k - s['t']) < 0.002), None)
    if k is None:
        fixed.append(s)
    elif FIX[k] is not None:
        fixed.append(dict(s, t=FIX[k], b=round(beat_pos(FIX[k]), 2), fixed=True))
json.dump([[s['t'], s['b']] for s in fixed], open('../src/taps.json', 'w'))
print('\n纠错后', len(fixed), '个点写入 src/taps.json')
