"""给打点工具生成数据：拍网、各分轨音头、成片时间的歌词、段落。"""
import json
import re

M = json.load(open('edit_marks.json'))
bm = json.load(open('../src/beatmap.json'))
hits = json.load(open('../src/hits.json'))
A, B, pre, cut = M['tA'], M['tB'], M['pre'], M['cut_film']


def to_film(t):
    if t < A - pre:
        return t
    if t >= B - pre:
        return cut + (t - (B - pre))
    return None


lyrics = []
for line in open('../../james-brown-get-up-offa-that-thing.lrc', encoding='utf-8'):
    m = re.match(r'\[(\d+):(\d+\.\d+)\](.*)', line.strip())
    if not m:
        continue
    text = m.group(3).strip()
    if not text or not re.search('[A-Za-z]', text) or 'James Brown' in text:
        continue
    t = to_film(int(m.group(1)) * 60 + float(m.group(2)))
    if t is not None and t < M['total']:
        lyrics.append({'t': round(t, 3), 'text': text})

data = {
    'total': M['total'],
    'marks': M,
    'beats': [b['t'] for b in bm['beats']],
    'onsets': {k: [[r[0], r[1]] for r in v] for k, v in hits.items()},
    'lyrics': lyrics,
    'scenes': [[0, '开场'], [19.5, '提问'], [31.8, 'Campbell'], [39.8, '派活'], [47.9, '做出来'], [M['cut_film'], '高潮（新剪辑）'], [M['stop_film'], '停'], [M['hit_film'], '落'], [M['fade_film'], '淡出']],
}
open('../tools/tap-data.js', 'w', encoding='utf-8').write('window.TAP_DATA = ' + json.dumps(data, ensure_ascii=False) + ';\n')
print(len(lyrics), 'lyric lines;', [(l['t'], l['text'][:30]) for l in lyrics])
