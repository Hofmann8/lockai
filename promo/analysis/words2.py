"""分段跑 whisper（base，本机已缓存），逐词时间 + 人声分轨能量起点。"""
import json

import numpy as np
import whisper

SR = 16000
model = whisper.load_model('base', device='cuda')
full = whisper.load_audio('edit_vocals.wav')
prompt = "Get up offa that thing, and dance 'till you feel better. Get up offa that thing, and try to release that pressure. Follow me."
out = []
for a, b in [(18, 30), (28, 42), (40, 54), (50, 60), (62, 71), (79, 85)]:
    clip = full[int(a * SR):int(b * SR)]
    res = model.transcribe(clip, language='en', word_timestamps=True, initial_prompt=prompt, condition_on_previous_text=False, no_speech_threshold=0.9)
    print(f'--- {a}-{b}')
    for seg in res['segments']:
        for w in seg['words']:
            o = dict(w=w['word'].strip(), start=round(a + w['start'], 3), end=round(a + w['end'], 3), p=round(w['probability'], 2))
            out.append(o)
            print(f"  {o['start']:7.2f}-{o['end']:6.2f} {o['p']:.2f} {o['w']}")
json.dump(out, open('words.json', 'w'), indent=1)
