'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, humanSize, PreviewFallback, ViewerBar } from './shared';
import { KindIcon, kindTint } from './icons';

const BARS = 96;
const RATES = [1, 1.25, 1.5, 2, 0.75];

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 解码出波形（每段取峰值）；太大的文件不解码，给一条平的 */
function useWaveform(url: string | undefined, size: number) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [length, setLength] = useState(0);
  useEffect(() => {
    if (!url || size > 60 * 1024 * 1024) return;
    let cancelled = false;
    (async () => {
      const buffer = await (await fetch(url, { mode: 'cors' })).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buffer);
      const data = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / BARS));
      const out: number[] = [];
      for (let i = 0; i < BARS; i += 1) {
        let peak = 0;
        for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) peak = Math.max(peak, Math.abs(data[j]));
        out.push(peak);
      }
      const max = Math.max(...out, 0.01);
      if (cancelled) return;
      setPeaks(out.map((p) => Math.max(0.06, Math.pow(p / max, 0.8))));
      setLength(audio.duration);
    })().catch(() => { if (!cancelled) setPeaks(null); });
    return () => { cancelled = true; };
  }, [url, size]);
  return { peaks, length };
}

/** 音频：波形、点哪放哪、快进快退、倍速；像语音备忘录那样安静好用 */
export default function AudioView({ file }: { file: FileArtifact }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [metaDuration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const { peaks, length } = useWaveform(file.url, file.size);
  // 有的服务器不给元数据（没有 Range / 流式），就用解码出来的时长
  const duration = Number.isFinite(metaDuration) && metaDuration > 0 ? metaDuration : length;
  const progress = duration ? time / duration : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return;
      e.preventDefault();
      const a = audioRef.current;
      if (a) void (a.paused ? a.play() : a.pause());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (failed) return <PreviewFallback file={file} note={`浏览器放不了这种音频（${fileExt(file.name).toUpperCase()}），下载后用播放器打开`} />;

  const seek = (e: ReactPointerEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };
  const skip = (delta: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = Math.min(duration, Math.max(0, a.currentTime + delta));
  };

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span className="font-medium text-fg-soft">{fileExt(file.name).toUpperCase()}</span>
        {duration > 0 && (<><Dot /><span className="tabular-nums">{clock(duration)}</span></>)}
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
      </ViewerBar>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 bg-sunken px-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className={cn('flex h-16 w-16 items-center justify-center rounded-[22px] shadow-soft', kindTint(file))}>
            <KindIcon file={file} className="h-7 w-7" />
          </span>
          <p className="max-w-md break-all text-[14px] font-medium text-fg">{file.name.split('/').pop()}</p>
        </div>

        <div className="w-full max-w-xl">
          <div
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seek(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && seek(e)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') skip(5);
              if (e.key === 'ArrowLeft') skip(-5);
            }}
            className="group/wave relative flex h-20 cursor-pointer items-center gap-[2px] outline-none"
          >
            {(peaks ?? Array.from({ length: BARS }, () => 0.12)).map((p, i) => (
              <span
                key={i}
                className={cn(
                  'min-w-0 flex-1 rounded-full transition-[background-color,height] duration-300',
                  i / BARS < progress ? 'bg-accent' : 'bg-fg/15 group-hover/wave:bg-fg/25',
                  !peaks && 'animate-pulse',
                )}
                style={{ height: `${Math.round(p * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[11.5px] tabular-nums text-fg-faint">
            <span>{clock(time)}</span>
            <span>-{clock(Math.max(0, duration - time))}</span>
          </div>
        </div>

        <div className="flex items-center gap-5">
          <button type="button" aria-label="后退 10 秒" onClick={() => skip(-10)} className="flex h-10 w-10 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg">
            <RotateCcw className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            aria-label={playing ? '暂停' : '播放'}
            onClick={() => { const a = audioRef.current; if (a) void (a.paused ? a.play() : a.pause()); }}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-ink-fg shadow-float transition-transform duration-150 hover:scale-105 active:scale-95"
          >
            {playing ? <Pause className="h-6 w-6" fill="currentColor" /> : <Play className="ml-0.5 h-6 w-6" fill="currentColor" />}
          </button>
          <button type="button" aria-label="前进 10 秒" onClick={() => skip(10)} className="flex h-10 w-10 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg">
            <RotateCw className="h-[18px] w-[18px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
            setRate(next);
            if (audioRef.current) audioRef.current.playbackRate = next;
          }}
          className="-mt-3 rounded-full border border-line px-3 py-1 text-[12px] tabular-nums text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
        >
          {rate}×
        </button>

        <audio
          ref={audioRef}
          src={file.url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onError={() => setFailed(true)}
          className="hidden"
        />
      </div>
    </div>
  );
}
