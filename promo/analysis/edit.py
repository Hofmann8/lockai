import numpy as np, soundfile as sf, librosa, json
y, sr = sf.read('song.wav', dtype='float32')  # stereo 44.1k
SRA=22050; H=128
def onset_near(stem, t, lo, hi, w=0.12):
    x = librosa.load(stem, sr=SRA, mono=True, offset=t-w, duration=2*w)[0]
    S = np.abs(librosa.stft(x, n_fft=512, hop_length=64)); f = librosa.fft_frequencies(sr=SRA, n_fft=512)
    e = S[(f>=lo)&(f<hi)].sum(0); d = np.maximum(0, np.diff(e, prepend=e[0]))
    i = int(np.argmax(d)); return t - w + i*64/SRA
tA = 69.6430
tB = 102.1630
tS = onset_near('stem_drums.wav', 111.25, 150, 5000)
print('refined tA %.4f tB %.4f stop %.4f' % (tA, tB, tS))
pre = 0.006  # 切在瞬态前 6ms
xf = int(0.008*sr)
def seg(a, b): return y[int(a*sr):int(b*sr)].copy()
s1 = seg(0, tA - pre); s2 = seg(tB - pre, tS - pre)
# 等功率交叉淡化
fade = np.linspace(0, np.pi/2, xf)[:, None]
s1[-xf:] *= np.cos(fade); s2[:xf] *= np.sin(fade)
body = np.concatenate([s1[:-xf], s1[-xf:] + s2[:xf], s2[xf:]])
# 收尾：body 末尾 15ms 淡出 → 静一拍 → 迟到一拍的那一下
beat = 0.5050
end_fade = int(0.015*sr); body[-end_fade:] *= np.linspace(1, 0, end_fade)[:, None]
gap = np.zeros((int(beat*sr), 2), dtype=np.float32)
hit = seg(tS - pre, tS - pre + 1.6)
tt = np.arange(len(hit))/sr
env = np.where(tt < 0.14, 1.0, np.exp(-(tt-0.14)/0.32)).astype(np.float32)
hit *= env[:, None]
# 合成混响尾巴：指数衰减噪声 IR，低混合比
rng = np.random.default_rng(7); L = int(2.6*sr)
ir = (rng.standard_normal((L, 2)) * np.exp(-np.arange(L)/sr/0.55)[:, None]).astype(np.float32)
ir[:int(0.012*sr)] = 0
from scipy.signal import fftconvolve
wet = np.stack([fftconvolve(hit[:, c], ir[:, c]) for c in range(2)], 1)
wet /= np.abs(wet).max() + 1e-9
tail_len = len(wet)
dry = np.zeros_like(wet); dry[:len(hit)] = hit
ending = dry + 0.18 * wet * np.abs(hit).max()
out = np.concatenate([body, gap, ending, np.zeros((int(1.5*sr), 2), np.float32)])
peak = np.abs(out).max(); print('peak', peak)
if peak > 0.98: out *= 0.98/peak
sf.write('../public/audio/score.wav', out, sr, subtype='PCM_16')
marks = dict(cut_film=float(len(s1)-xf)/sr, stop_film=float(len(body))/sr, hit_film=float(len(body)+len(gap))/sr,
             total=float(len(out))/sr, tA=tA, tB=tB, tS=tS, pre=pre)
json.dump(marks, open('edit_marks.json', 'w'), indent=1); print(marks)
# 同样剪出各轨，给后面找画面卡点用
for k in ['drums','bass','other','vocals']:
    z, _ = sf.read(f'stem_{k}.wav', dtype='float32')
    a = z[:int((tA-pre)*sr)]; b2 = z[int((tB-pre)*sr):int((tS-pre)*sr)]
    h = z[int((tS-pre)*sr):int((tS-pre+1.6)*sr)] * env[:, None]
    sf.write(f'edit_{k}.wav', np.concatenate([a, b2, gap, h]), sr, subtype='PCM_16')
