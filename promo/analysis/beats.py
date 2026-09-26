import json, numpy as np
from beat_this.inference import File2Beats
f2b = File2Beats(checkpoint_path="final0", device="cuda", dbn=False)
beats, downbeats = f2b("song.wav")
json.dump({"beats": [float(b) for b in beats], "downbeats": [float(b) for b in downbeats]}, open("beats.json", "w"))
ib = np.diff(beats)
print(len(beats), len(downbeats), "median ibi", np.median(ib), "bpm", 60/np.median(ib))
print("first beats", np.round(beats[:12], 3))
print("first downbeats", np.round(downbeats[:8], 3))
