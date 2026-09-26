import json, numpy as np, librosa, soundfile as sf
SR = 22050
def load(p):
    y, _ = librosa.load(p, sr=SR, mono=True); return y
mix, drums, bass, other, voc = [load(p) for p in ['song.wav','stem_drums.wav','stem_bass.wav','stem_other.wav','stem_vocals.wav']]
H = 256
# onset envelopes
oenv = librosa.onset.onset_strength(y=drums, sr=SR, hop_length=H)
tempo, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=SR, hop_length=H, start_bpm=110, tightness=400, units='time')
tempo = float(np.atleast_1d(tempo)[0])
print('tempo', tempo, 'n beats', len(beats))
# kick / snare bands from drum stem
S = np.abs(librosa.stft(drums, n_fft=2048, hop_length=H))
freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
def band_env(lo, hi):
    e = S[(freqs>=lo)&(freqs<hi)].sum(0)
    d = np.maximum(0, np.diff(e, prepend=e[0]))
    return d / (d.max()+1e-9)
kick = band_env(30, 120); snare = band_env(150, 400) + band_env(1500, 5000)
times = librosa.frames_to_time(np.arange(S.shape[1]), sr=SR, hop_length=H)
def at(env, t, w=0.05):
    m = (times>=t-w)&(times<=t+w); return float(env[m].max()) if m.any() else 0.0
# refine beats to nearest drum onset peak within 40ms
refined = []
for b in beats:
    m = (times>=b-0.04)&(times<=b+0.04)
    idx = np.where(m)[0]
    refined.append(float(times[idx[np.argmax(oenv[idx])]]) if len(idx) else float(b))
beats = np.array(refined)
K = np.array([at(kick,b) for b in beats]); Sn = np.array([at(snare,b) for b in beats])
# phase with kick on 1 & 3, snare on 2 & 4
scores = []
for ph in range(4):
    pos = (np.arange(len(beats)) - ph) % 4
    scores.append(K[pos==0].mean() + 0.5*K[pos==2].mean() + Sn[(pos==1)|(pos==3)].mean() - Sn[(pos==0)].mean())
ph = int(np.argmax(scores)); print('phase scores', np.round(scores,3), 'phase', ph)
downbeats = beats[ph::4]
# per-bar features
def rms_at(y, t0, t1):
    a, b = int(t0*SR), int(t1*SR); seg = y[a:b]; return float(np.sqrt((seg**2).mean())) if len(seg) else 0.0
bars = []
for i in range(len(downbeats)-1):
    t0, t1 = downbeats[i], downbeats[i+1]
    bars.append(dict(i=i, t=round(float(t0),3), dur=round(float(t1-t0),3),
        mix=rms_at(mix,t0,t1), drums=rms_at(drums,t0,t1), bass=rms_at(bass,t0,t1), other=rms_at(other,t0,t1), voc=rms_at(voc,t0,t1)))
mx = {k: max(b[k] for b in bars) for k in ['mix','drums','bass','other','voc']}
print(' bar     t   mix drm bas oth voc')
for b in bars:
    print(f"{b['i']:4d} {b['t']:7.2f}  " + ' '.join(f"{int(9*b[k]/mx[k]):3d}" for k in ['mix','drums','bass','other','voc']))
# strong hits: drum onset peaks (both bands) — list top hits with times
hits = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, hop_length=H, units='time', backtrack=False)
hit_strength = [at(oenv/oenv.max(), h, 0.01) for h in hits]
json.dump(dict(tempo=tempo, beats=beats.tolist(), downbeats=downbeats.tolist(), bars=bars,
               hits=[dict(t=float(h), s=float(s)) for h,s in zip(hits, hit_strength)]), open('analysis.json','w'))
