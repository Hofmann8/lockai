import numpy as np, librosa, json
SR=22050; H=128
ld=lambda p: librosa.load(p, sr=SR, mono=True)[0]
d, b, o, v = ld('stem_drums.wav'), ld('stem_bass.wav'), ld('stem_other.wav'), ld('stem_vocals.wav')
S = np.abs(librosa.stft(d, n_fft=1024, hop_length=H)); f = librosa.fft_frequencies(sr=SR, n_fft=1024)
e = np.log1p(50*S[(f>=180)&(f<350)].sum(0)); sn = np.maximum(0,np.diff(e,prepend=e[0]))
T = librosa.frames_to_time(np.arange(len(sn)), sr=SR, hop_length=H)
on = librosa.onset.onset_detect(onset_envelope=sn, sr=SR, hop_length=H, units='time')
st = np.interp(on, T, sn); on = on[st > np.percentile(st, 70)]
# feature for similarity: onset env of drums(full) + bass, 
def feat(y):
    return librosa.onset.onset_strength(y=y, sr=SR, hop_length=H)
F = np.vstack([feat(d), feat(b)*0.7])
def win(t, a, bb):
    i0 = int(round((t+a)*SR/H)); return F[:, i0:i0+int(round((bb-a)*SR/H))]
def vrms(t, w=0.35):
    a=int((t-w)*SR); c=int((t+w)*SR); s=v[a:c]; return float(np.sqrt((s**2).mean()))
vmax = np.percentile([vrms(t) for t in np.arange(1,240,0.5)], 95)
A = [t for t in on if 60 < t < 72]; B = [t for t in on if 97 < t < 103.5]
res=[]
for ta in A:
    pre = win(ta, -4.1, 0)   # what we hear before the cut
    for tb in B:
        post = win(tb, 0, 4.1)
        # compare A's continuation (what would have come) with B's continuation, and A's past with B's past
        c1 = np.corrcoef(win(ta,0,4.1).ravel(), post.ravel())[0,1]
        c2 = np.corrcoef(pre.ravel(), win(tb,-4.1,0).ravel())[0,1]
        vc = (vrms(ta)+vrms(tb))/vmax
        res.append((c1+c2 - 0.8*vc, c1, c2, vc, ta, tb))
res.sort(reverse=True)
for r in res[:12]: print('score %.3f c1 %.3f c2 %.3f voc %.2f  A %.3f  B %.3f  total %.2f' % (*r, r[4]+ (111.25-r[5])))
