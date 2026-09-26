import numpy as np, soundfile as sf, torch
from demucs.pretrained import get_model
from demucs.apply import apply_model
wav, sr = sf.read('song.wav', dtype='float32')
model = get_model('htdemucs'); model.cuda().eval()
x = torch.from_numpy(wav.T).unsqueeze(0).cuda()
ref = x.mean(1)
x = (x - ref.mean()) / ref.std()
with torch.no_grad():
    out = apply_model(model, x, split=True, overlap=0.25, progress=False)[0]
out = out * ref.std() + ref.mean()
for name, s in zip(model.sources, out):
    sf.write(f'stem_{name}.wav', s.cpu().numpy().T, sr)
print(model.sources)
