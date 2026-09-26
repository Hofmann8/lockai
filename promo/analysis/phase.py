import json, numpy as np, librosa
A = json.load(open('analysis.json')); beats=np.array(A['beats']); db=np.array(A['downbeats'])
SR=22050; H=128
d = librosa.load('stem_drums.wav', sr=SR, mono=True)[0]
S = np.abs(librosa.stft(d, n_fft=1024, hop_length=H)); f = librosa.fft_frequencies(sr=SR, n_fft=1024)
def env(lo,hi):
    e = np.log1p(50*S[(f>=lo)&(f<hi)].sum(0)); return np.maximum(0,np.diff(e,prepend=e[0]))
for name,(lo,hi) in {'kick':(30,110),'snare':(180,350),'hat':(6000,11000)}.items():
    e = env(lo,hi)
    on = librosa.onset.onset_detect(onset_envelope=e, sr=SR, hop_length=H, units='time', delta=0.3*e.max()/3)
    strength = np.interp(on, librosa.frames_to_time(np.arange(len(e)),sr=SR,hop_length=H), e)
    keep = on[(on>20)&(on<230)&(strength>np.percentile(strength,60))]
    # phase relative to downbeat grid in beats
    ph=[]
    for t in keep:
        i = np.searchsorted(db, t)-1
        if i<0 or i>=len(db)-1: continue
        ph.append(4*(t-db[i])/(db[i+1]-db[i]))
    ph=np.array(ph)
    hist,_=np.histogram(ph%4, bins=16, range=(0,4))
    print(f'{name:6s} n={len(ph):4d}  16th-note histogram over bar:', ' '.join(f'{h:3d}' for h in hist))
