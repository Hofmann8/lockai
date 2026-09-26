import numpy as np, librosa
SR=22050
for name, path, t0, t1 in [('edit', 'edit_drums.wav', 64, 78), ('orig A', 'stem_drums.wav', 64, 76), ('orig B', 'stem_drums.wav', 96, 110)]:
    x = librosa.load(path, sr=SR, mono=True, offset=t0, duration=t1-t0)[0]
    S = np.abs(librosa.stft(x, n_fft=512, hop_length=64)); f = librosa.fft_frequencies(sr=SR, n_fft=512)
    e = np.log1p(50*S[(f>=180)&(f<350)].sum(0)); d = np.maximum(0, np.diff(e, prepend=e[0]))
    on = librosa.onset.onset_detect(onset_envelope=d, sr=SR, hop_length=64, units='time', backtrack=False)
    st = np.interp(on, np.arange(len(d))*64/SR, d); on = on[st > 0.5*np.percentile(st, 90)] + t0
    print(name, 'snare-ish onsets:', np.round(on, 3).tolist())
    print('   intervals:', np.round(np.diff(on), 3).tolist())
