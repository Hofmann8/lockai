import numpy as np, librosa, json
M = json.load(open('edit_marks.json')); cut = M['cut_film']
SR=22050; H=64; fps=SR/H
x = librosa.load('edit_drums.wav', sr=SR, mono=True)[0]
e = librosa.onset.onset_strength(y=x, sr=SR, hop_length=H)
def local_P(t0,t1):
    s = e[int(t0*fps):int(t1*fps)]; s=s-s.mean(); ac=np.correlate(s,s,'full')[len(s)-1:]
    lo,hi=int(0.47*fps),int(0.55*fps); return (lo+np.argmax(ac[lo:hi]))/fps
def phase_at_cut(t0, t1, P, backward):
    # predicted beat positions relative to cut: cut + ph + kP ; find ph in [-P/2,P/2)
    best=(-1,0)
    for ph in np.arange(-P/2, P/2, 0.002):
        ks = np.arange(-40, 41); ts = cut + ph + ks*P; ts = ts[(ts>=t0)&(ts<t1)]
        v = e[(ts*fps).astype(int)].mean()
        if v>best[0]: best=(v,ph)
    return best[1]
for W in (3.0, 4.0, 6.0):
    Pa = local_P(cut-W-2, cut); Pb = local_P(cut, cut+W+2)
    a = phase_at_cut(cut-W, cut-0.02, Pa, True); b = phase_at_cut(cut+0.02, cut+W, Pb, False)
    print(f'W={W}: P before {Pa:.4f} after {Pb:.4f}; beat phase at seam before {a*1000:+.0f}ms after {b*1000:+.0f}ms  -> jump {(b-a)*1000:+.0f} ms')
