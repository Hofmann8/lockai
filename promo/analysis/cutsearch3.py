import numpy as np, librosa
SR=22050; H=128; fps=SR/H
ld=lambda p: librosa.load(p, sr=SR, mono=True)[0]
d,b,o,v = [ld(f'stem_{k}.wav') for k in ['drums','bass','other','vocals']]
Ed = librosa.onset.onset_strength(y=d, sr=SR, hop_length=H)
Eb = librosa.onset.onset_strength(y=b, sr=SR, hop_length=H)
Cb = librosa.feature.chroma_cqt(y=b, sr=SR, hop_length=H)
Co = librosa.feature.chroma_cqt(y=o, sr=SR, hop_length=H)
Vr = librosa.feature.rms(y=v, hop_length=H)[0]; Vr /= np.percentile(Vr, 95)
# snare-ish candidates
S = np.abs(librosa.stft(d, n_fft=1024, hop_length=H)); f = librosa.fft_frequencies(sr=SR, n_fft=1024)
e = np.log1p(50*S[(f>=180)&(f<350)].sum(0)); sn = np.maximum(0,np.diff(e,prepend=e[0]))
on = librosa.onset.onset_detect(onset_envelope=sn, sr=SR, hop_length=H, units='time')
st = np.interp(on, np.arange(len(sn))/fps, sn); on = on[st > np.percentile(st, 60)]
L = int(4.0*fps)
def sl(X, t, fwd):
    i=int(round(t*fps)); return (X[..., i:i+L] if fwd else X[..., i-L:i]).ravel()
def sim(ta, tb, fwd):
    r = 0
    for X, wgt in [(Ed,1.0),(Eb,1.0),(Cb,1.5),(Co,1.0)]:
        r += wgt*np.corrcoef(sl(X,ta,fwd), sl(X,tb,fwd))[0,1]
    return r/4.5
def voc(t): i=int(t*fps); return float(Vr[i-int(0.3*fps):i+int(0.6*fps)].mean())
A = [t for t in on if 60 < t < 74]; B = [t for t in on if 158 < t < 172]
res = []
for ta in A:
    for tb in B:
        c1, c2 = sim(ta,tb,True), sim(ta,tb,False)
        vc = voc(ta)+voc(tb)
        res.append((c1+c2-0.6*vc, c1, c2, vc, ta, tb))
res.sort(reverse=True)
res=[r for r in res if 77.0 < r[4]+(176.26-r[5]) < 80.5]
for r in res[:12]: print('score %.3f fwd %.3f back %.3f voc %.2f  A %.3f B %.3f  stop@film %.2f' % (*r, r[4]+(176.26-r[5])))
# sanity: same metric for natural continuation (ta == tb shifted by exactly N beats in steady part)
