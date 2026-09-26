import numpy as np, librosa, json
M = json.load(open('edit_marks.json')); cut = M['cut_film']
SR=22050; H=64
def envs(path):
    x = librosa.load(path, sr=SR, mono=True)[0]
    S = np.abs(librosa.stft(x, n_fft=1024, hop_length=H)); f = librosa.fft_frequencies(sr=SR, n_fft=1024)
    def band(lo,hi):
        e=np.log1p(30*S[(f>=lo)&(f<hi)].sum(0)); return np.maximum(0,np.diff(e,prepend=e[0]))
    return {'all': librosa.onset.onset_strength(y=x, sr=SR, hop_length=H), 'snare': band(180,350), 'kick': band(30,110)}
D = envs('edit_drums.wav'); B = envs('edit_bass.wav')
fps = SR/H
def best_phase(e, t0, t1, P):
    # returns phase (s, measured from absolute time 0 modulo P) maximizing comb sum
    best=(-1,0)
    for ph in np.arange(0, P, 0.002):
        ts = np.arange(t0 + ((ph - t0) % P), t1, P)
        idx = (ts*fps).astype(int); v = e[idx].sum()/len(idx)
        if v>best[0]: best=(v,ph)
    return best[1]
def per(t0,t1):
    # local period via autocorrelation of 'all'
    e = D['all'][int(t0*fps):int(t1*fps)]; e=e-e.mean()
    ac = np.correlate(e,e,'full')[len(e)-1:]; lo,hi=int(0.45*fps),int(0.58*fps)
    return (lo+np.argmax(ac[lo:hi]))/fps
Pa, Pb = per(cut-12, cut), per(cut, cut+9)
P = (Pa+Pb)/2
print('period before %.4f after %.4f' % (Pa, Pb))
for name, e, mult in [('beat/all', D['all'],1), ('backbeat/snare', D['snare'],2), ('bar/kick', D['kick'],4), ('bar/bass', B['all'],4)]:
    Q = P*mult
    a = best_phase(e, cut-8, cut-0.05, Q); b = best_phase(e, cut+0.05, cut+8, Q)
    diff = ((b - a + Q/2) % Q) - Q/2
    print(f'{name:15s} period {Q:.3f}s  phase before {a:.3f} after {b:.3f}  diff {diff*1000:+.0f} ms')
