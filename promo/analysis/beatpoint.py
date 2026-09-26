import numpy as np, librosa, sys
SR=22050; H=64; fps=SR/H
x = librosa.load('stem_drums.wav', sr=SR, mono=True)[0]
e = librosa.onset.onset_strength(y=x, sr=SR, hop_length=H)
def local_P(t0,t1):
    s = e[int(t0*fps):int(t1*fps)]; s=s-s.mean(); ac=np.correlate(s,s,'full')[len(s)-1:]
    lo,hi=int(0.47*fps),int(0.55*fps); return (lo+np.argmax(ac[lo:hi]))/fps
def nearest_beat(t, side):
    t0, t1 = (t-4, t) if side=='before' else (t, t+4) if side=='after' else (t-3, t+3)
    P = local_P(t0-1, t1+1); best=(-1,0)
    for ph in np.arange(-P/2, P/2, 0.001):
        ts = t + ph + np.arange(-12,13)*P; ts=ts[(ts>=t0)&(ts<t1)]
        v = e[np.round(ts*fps).astype(int)].mean()
        if v>best[0]: best=(v,ph)
    return t+best[1], P
for t, side in [(69.643,'both'), (69.643,'before'), (102.110,'after'), (102.110,'both'), (111.31,'both')]:
    b, P = nearest_beat(t, side); print(f'{t:.3f} ({side:6s}) -> beat {b:.4f}  offset {1000*(b-t):+.0f}ms  P {P:.4f}')
