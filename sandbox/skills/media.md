# 音视频

先 `ffprobe -hide_banner in.mp4` 或 `mediainfo in.mp4` 看清编码、时长、分辨率、帧率，再决定参数。长任务把 `timeout` 调大（转码 1 分钟视频约需 10–60 秒）。

## ffmpeg 常用配方
- 剪一段（快、不重编码，切点落在关键帧附近）：`ffmpeg -ss 00:01:05 -to 00:01:40 -i in.mp4 -c copy out.mp4`
- 精确剪切（重编码）：`ffmpeg -i in.mp4 -ss 65 -to 100 -c:v libx264 -crf 20 -c:a aac out.mp4`
- 压缩（微信 / 网盘）：`ffmpeg -i in.mp4 -c:v libx264 -crf 26 -preset medium -vf "scale='min(1280,iw)':-2" -c:a aac -b:a 128k out.mp4`
- 转格式：mov/mkv/avi → mp4 用上面的 libx264 + aac；`-movflags +faststart` 让网页能边下边播。
- 提取音频：`ffmpeg -i in.mp4 -vn -c:a libmp3lame -q:a 2 out.mp3`
- 静音 / 替换配乐：`-an`；换音轨 `ffmpeg -i v.mp4 -i music.mp3 -map 0:v -map 1:a -c:v copy -shortest out.mp4`
- 镜像（学舞看镜面）：`-vf hflip`
- 慢放 0.5 倍（画面+声音）：`-filter_complex "[0:v]setpts=2.0*PTS[v];[0:a]atempo=0.5[a]" -map "[v]" -map "[a]"`
- 只变速不变调的音乐：`rubberband -T 0.9 in.wav out.wav`（0.9 倍速），或 ffmpeg `atempo=0.9`
- 拼接多段（同编码）：写 `list.txt`（每行 `file 'a.mp4'`），`ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`
- 转 GIF（清晰的调色板法）：`ffmpeg -i in.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif`
- 抽帧 / 封面：`ffmpeg -ss 3 -i in.mp4 -frames:v 1 cover.jpg`；每秒一张 `-vf fps=1 frames/%03d.jpg`
- 加字幕（烧进画面）：`-vf "subtitles=sub.srt:force_style='FontName=Noto Sans CJK SC,FontSize=22'"`
- 加文字 / 水印：`drawtext=fontfile=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc:text='…'`，图片水印用 `overlay`
- 横竖屏：竖屏 9:16 加模糊背景：`-vf "split[a][b];[a]scale=1080:1920,boxblur=20[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2"`

## 音频分析（librosa）
- BPM 和节拍点：
  ```python
  import librosa, numpy as np
  y, sr = librosa.load('song.mp3')
  tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
  tempo = float(np.atleast_1d(tempo)[0])  # 新版 librosa 返回数组
  times = librosa.frames_to_time(beats, sr=sr)
  ```
  BPM 可能是实际的一半或两倍，结合听感（街舞曲多在 90–130）说明。
- 音量标准化：`ffmpeg -i in.mp3 -af loudnorm out.mp3`
- 截取音乐片段并淡入淡出：`-af "afade=t=in:d=1,afade=t=out:st=28:d=2"`

## 其他
- 网上视频下载：`yt-dlp`（仅限用户有权下载的内容；B 站等可能需要登录，失败就如实告诉用户）。
- 做完后抽 1–2 帧用 `show` 确认画面（镜像方向、字幕位置、裁切是否正确）。
- 成品写到 `/home/user/outputs/`；超过 200MB 交付不了，先压缩。
