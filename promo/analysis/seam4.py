import numpy as np, librosa, json
import sys; tA, tB = float(sys.argv[1]), float(sys.argv[2])
SR=22050; H=64; fps=SR/H; P=0.5105
for stem in ['bass','drums','other']:
    x = librosa.load(f'stem_{stem}.wav', sr=SR, mono=True)[0]
    e = librosa.onset.onset_strength(y=x, sr=SR, hop_length=H)
    ch = librosa.feature.chroma_stft(y=x, sr=SR, hop_length=H) if stem!='drums' else None
    def w(t, L=4.0): i=int(t*fps); return e[i:i+int(L*fps)]
    def c(t, L=4.0): i=int(t*fps); return ch[:, i:i+int(L*fps)].ravel()
    row=[]
    for k in range(-4,5):
        tb = tB + k*P
        r = np.corrcoef(w(tA), w(tb))[0,1]
        if ch is not None: r = (r + np.corrcoef(c(tA), c(tb))[0,1])/2
        row.append(r)
    print(f'{stem:6s} shift -4..+4 beats:', ' '.join(f'{v:+.2f}' for v in row), ' best', int(np.argmax(row))-4)
