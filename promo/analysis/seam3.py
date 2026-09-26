import numpy as np, librosa, json
M = json.load(open('edit_marks.json')); cut = M['cut_film']
SR=22050; H=64; fps=SR/H; P=0.5105
def env(path):
    x = librosa.load(path, sr=SR, mono=True)[0]
    return librosa.onset.onset_strength(y=x, sr=SR, hop_length=H)
def fold(e, t0, nbars, L=8):  # fold into 2-bar (8 beat) cycle, 16th resolution
    out=np.zeros(L*4); cnt=np.zeros(L*4)
    for k in range(int(nbars/2*L*4)):
        t=t0+k*P/4; i=int(t*fps)
        if i+2<len(e): out[k%(L*4)]+=e[i-1:i+2].max(); cnt[k%(L*4)]+=1
    return out/np.maximum(cnt,1)
def check(path, c, label):
    e = env(path)
    # anchor both folds to the same absolute grid: start of 'before' = c - 8 bars exactly
    a = fold(e, c - 16*P, 4); b = fold(e, c, 4)
    sc = [np.corrcoef(a, np.roll(b, s))[0,1] for s in range(32)]
    best = int(np.argmax(sc))
    print(f'{label:22s} best shift {best/4:+.2f} beats (0 = seamless)  corr@0 {sc[0]:.2f}  best {sc[best]:.2f}  corr@4beats {sc[16]:.2f}')
for stem in ['bass','drums','other']:
    check(f'edit_{stem}.wav', cut, f'edit {stem} @cut')
    check(f'edit_{stem}.wav', 50.0, f'edit {stem} @50s(ref)')
