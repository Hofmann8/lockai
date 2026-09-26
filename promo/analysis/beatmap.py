import numpy as np, librosa, json
M = json.load(open('edit_marks.json'))
SR=22050; H=64; fps=SR/H
ld=lambda p: librosa.load(p, sr=SR, mono=True)[0]
d, b, o, v = [ld(f'edit_{k}.wav') for k in ['drums','bass','other','vocals']]
e = librosa.onset.onset_strength(y=d, sr=SR, hop_length=H)
# dynamic beat tracking on edited drums (start after the intro pickup)
tempo, bt = librosa.beat.beat_track(onset_envelope=e, sr=SR, hop_length=H, start_bpm=118, tightness=300, units='time')
bt = np.array([t for t in bt if t < M['fade_film'] + 2.0])
# refine each beat to local onset-strength peak ±35ms, then subtract 10ms lag (transient onset)
T = np.arange(len(e))/fps
ref=[]
for t in bt:
    m=(T>=t-0.035)&(T<=t+0.035); i=np.where(m)[0]; ref.append(T[i[np.argmax(e[i])]]-0.010)
bt=np.array(ref)
S = np.abs(librosa.stft(d, n_fft=1024, hop_length=H)); f = librosa.fft_frequencies(sr=SR, n_fft=1024)
def band(lo,hi):
    x=np.log1p(40*S[(f>=lo)&(f<hi)].sum(0)); return np.maximum(0,np.diff(x,prepend=x[0]))
sn, kk = band(180,350), band(30,110)
oe = librosa.onset.onset_strength(y=o, sr=SR, hop_length=H)
vr = librosa.feature.rms(y=v, hop_length=H)[0]
def pk(x,t,w=0.04): m=(T>=t-w)&(T<=t+w); return float(x[m].max()) if m.any() else 0.
def mean(x,t0,t1): m=(T>=t0)&(T<t1); return float(x[m].mean()) if m.any() else 0.
n = lambda arr: (np.array(arr)/np.percentile(arr,97)).clip(0,1.5)
snare = n([pk(sn,t) for t in bt]); kick = n([pk(kk,t) for t in bt]); horn = n([pk(oe,t) for t in bt])
voc = n([mean(vr,t,t+0.5) for t in bt])
# horn stabs anywhere (not only on beats)
hon = librosa.onset.onset_detect(onset_envelope=oe, sr=SR, hop_length=H, units='time')
hs = np.interp(hon, T, oe); stabs = [float(t-0.01) for t,s in zip(hon,hs) if s>np.percentile(hs,85)]
out = dict(marks=M, beats=[dict(t=round(float(t),4), snare=round(float(a),2), kick=round(float(c),2), horn=round(float(h),2), voc=round(float(w),2))
          for t,a,c,h,w in zip(bt,snare,kick,horn,voc)], horn_stabs=[round(t,4) for t in stabs])
json.dump(out, open('../src/beatmap.json','w'))
print('beats', len(bt), 'first', np.round(bt[:6],3), 'last', np.round(bt[-3:],3))
print('median ibi', np.median(np.diff(bt)))
# print compact: per beat index, time, S/K/H/V bars (every beat) for film planning
for i,(t,a,c,h,w) in enumerate(zip(bt,snare,kick,horn,voc)):
    print(f'{i:3d} {t:6.2f} S{int(a*5)} K{int(c*5)} H{int(h*5)} V{int(w*5)}', end=' | ' if i%4!=3 else '\n')
