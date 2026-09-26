import json, numpy as np, librosa
A = json.load(open('analysis.json'))
beats = np.array(A['beats']); db = np.array(A['downbeats'])
print('first 40 beat times:', np.round(beats[:40],2).tolist())
print('ibi first 40:', np.round(np.diff(beats[:41]),3).tolist())
SR=22050
def load(p): return librosa.load(p, sr=SR, mono=True)[0]
st = {k: load(f'stem_{k}.wav') for k in ['drums','bass','other','vocals']}
mix = load('song.wav')
def rms(y,t0,t1):
    a,b=int(t0*SR),int(t1*SR); s=y[a:b]; return float(np.sqrt((s**2).mean())) if len(s) else 0
mx = {k: np.percentile([rms(v, t, t+0.25) for t in np.arange(0,240,0.25)], 99) for k,v in st.items()}
def grid(t0, t1, step):
    print(f'--- {t0:.2f}-{t1:.2f} step {step:.3f}s  (drums bass other vocals), * = downbeat')
    t=t0
    while t < t1:
        mark = '*' if np.min(np.abs(db - t)) < step/2 else ' '
        vals = [min(9,int(9*rms(st[k],t,t+step)/mx[k])) for k in ['drums','bass','other','vocals']]
        print(f'{mark}{t:7.2f} ' + ' '.join('#'*v + '.'*(9-v) for v in vals))
        t += step
beat = 60/A['tempo']
grid(0, 22, beat/2)
grid(99.5, 116, beat/2)
