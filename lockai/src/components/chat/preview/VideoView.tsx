'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, humanSize, PreviewFallback, ViewerBar } from './shared';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const IDLE_MS = 2200;
const FRAME = 1 / 24;

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 悬停时间：短视频（10 秒内）精确到 0.1 秒，不然一秒的片子永远显示 0:00 */
function fineClock(seconds: number, total: number) {
  if (total >= 10 || !Number.isFinite(seconds)) return clock(seconds);
  return `0:${Math.max(0, seconds).toFixed(1).padStart(4, '0')}`;
}

/** 悬停预览的宽度：不超过 168px，窄屏时不超过进度条的三分之一 */
const PREVIEW_W = 'min(168px, 34%)';

/** 底栏里的圆形小按钮 */
function Control({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/12 hover:text-white',
        active && 'text-white',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 视频：画面放在暗色舞台上，控件浮在画面底部，播放时不动鼠标就收起来。
 * 进度条悬停能看到那一帧，带已缓冲的范围；音量、倍速、画中画、全屏；
 * 空格 / K 播放，← → 5 秒，↑ ↓ 音量，M 静音，F 全屏，暂停时 , . 逐帧。
 */
export default function VideoView({ file }: { file: FileArtifact }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<{ ratio: number; x: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  // 画中画要在浏览器里才知道支不支持；渲染时直接读 document 会和服务端渲染的结果对不上
  const [pipSupported, setPipSupported] = useState(false);
  useEffect(() => setPipSupported(Boolean(document.pictureInPictureEnabled)), []);

  const video = () => videoRef.current;

  /* ---------- 控件收起 ---------- */
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  const showControls = !playing || !idle || scrubbing || hover !== null;

  /* ---------- 动作 ---------- */
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  }, []);
  const seekTo = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration, Math.max(0, seconds));
    setTime(v.currentTime);
  }, []);
  const setVol = useCallback((next: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, next));
    v.muted = v.volume === 0;
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frameRef.current?.requestFullscreen?.();
  }, []);
  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void v.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /* ---------- 键盘 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      const key = e.key.toLowerCase();
      const handled = (() => {
        if (key === ' ' || key === 'k') toggle();
        else if (key === 'arrowright') seekTo(v.currentTime + 5);
        else if (key === 'arrowleft') seekTo(v.currentTime - 5);
        else if (key === 'arrowup') setVol(v.volume + 0.1);
        else if (key === 'arrowdown') setVol(v.volume - 0.1);
        else if (key === 'm') v.muted = !v.muted;
        else if (key === 'f') toggleFullscreen();
        else if ((key === ',' || key === '.') && v.paused) seekTo(v.currentTime + (key === '.' ? FRAME : -FRAME));
        else return false;
        return true;
      })();
      if (handled) {
        e.preventDefault();
        wake();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seekTo, setVol, toggleFullscreen, wake]);

  /* ---------- 进度条：拖动、悬停看帧 ---------- */
  const ratioAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { ratio: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), x: e.clientX - rect.left, width: rect.width };
  };
  const peek = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { ratio, x } = ratioAt(e);
    setHover({ ratio, x });
    const p = previewRef.current;
    // 预览用另一个静音的同源视频跳到那一帧；上一次还没跳完就先不跳，免得排队
    if (p && duration && !p.seeking) p.currentTime = ratio * duration;
    if (e.buttons === 1) seekTo(ratio * duration);
  };

  if (failed) {
    return <PreviewFallback file={file} note={`浏览器放不了这种视频（${fileExt(file.name).toUpperCase()}），下载后用播放器打开；也可以让我转成 MP4`} />;
  }

  const progress = duration ? time / duration : 0;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const aspect = size ? size.w / size.h : 16 / 9;

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span className="font-medium text-fg-soft">{fileExt(file.name).toUpperCase()}</span>
        {size && (<><Dot /><span className="tabular-nums">{size.w}×{size.h}</span></>)}
        {duration > 0 && (<><Dot /><span className="tabular-nums">{clock(duration)}</span></>)}
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
      </ViewerBar>

      {/* 舞台：深色、不随主题变，画面四周留一圈呼吸的空间 */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[oklch(0.17_0.006_60)] p-4 sm:p-6">
        <div className="flex h-full w-full items-center justify-center [container-type:size]">
          <div
            ref={frameRef}
            onPointerMove={wake}
            onPointerLeave={() => playing && setIdle(true)}
            className={cn(
              'group/frame relative overflow-hidden bg-black',
              fullscreen ? 'flex h-screen w-screen items-center justify-center' : 'rounded-2xl shadow-[0_24px_60px_-20px_oklch(0_0_0/0.7),0_0_0_1px_oklch(1_0_0/0.06)]',
              !showControls && 'cursor-none',
            )}
            style={fullscreen ? undefined : { width: `min(100cqw, calc(100cqh * ${aspect}))`, aspectRatio: String(aspect) }}
          >
            <video
              ref={videoRef}
              src={file.url}
              autoPlay
              playsInline
              preload="auto"
              onClick={toggle}
              onDoubleClick={toggleFullscreen}
              onPlay={() => { setPlaying(true); setEnded(false); wake(); }}
              onPause={() => setPlaying(false)}
              onEnded={() => { setPlaying(false); setEnded(true); }}
              onWaiting={() => setWaiting(true)}
              onCanPlay={() => setWaiting(false)}
              onPlaying={() => setWaiting(false)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setDuration(v.duration);
                if (v.videoWidth) setSize({ w: v.videoWidth, h: v.videoHeight });
              }}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
              onProgress={(e) => {
                const v = e.currentTarget;
                if (v.buffered.length && v.duration) setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration);
              }}
              onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
              onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
              onError={() => setFailed(true)}
              className={cn('block h-full w-full object-contain', fullscreen && 'max-h-screen max-w-[100vw]')}
            />

            {/* 中间的大按钮：没在放、或者放完了 */}
            {(!playing || ended) && !waiting && (
              <button
                type="button"
                aria-label={ended ? '重新播放' : '播放'}
                onClick={toggle}
                className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white shadow-float backdrop-blur-md transition-transform duration-200 animate-lock-in hover:scale-105 active:scale-95"
              >
                {ended ? <RotateCcw className="h-6 w-6" /> : <Play className="ml-1 h-7 w-7" fill="currentColor" />}
              </button>
            )}
            {waiting && (
              <Loader2 className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />
            )}

            {/* 底栏 */}
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent px-3 pb-2.5 pt-10 transition-opacity duration-300',
                showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              {/* 进度条 */}
              <div
                role="slider"
                aria-label="播放进度"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(time)}
                aria-valuetext={`${clock(time)} / ${clock(duration)}`}
                tabIndex={0}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setScrubbing(true);
                  seekTo(ratioAt(e).ratio * duration);
                }}
                onPointerMove={peek}
                onPointerUp={() => setScrubbing(false)}
                onPointerLeave={() => setHover(null)}
                className="group/seek relative mx-1 h-4 cursor-pointer touch-none outline-none"
                style={{ '--p': progress, '--b': buffered } as CSSProperties}
              >
                <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-[height] duration-200 group-hover/seek:h-[5px]">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: 'calc(var(--b) * 100%)' }} />
                  {hover && <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${hover.ratio * 100}%` }} />}
                  <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: 'calc(var(--p) * 100%)' }} />
                </div>
                <div
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow-float transition-transform duration-200 group-hover/seek:scale-100 group-focus-visible/seek:scale-100"
                  style={{ left: 'calc(var(--p) * 100%)' }}
                />
                {/* 悬停：那一帧和时间 */}
                <div
                  className={cn(
                    'pointer-events-none absolute bottom-6 -translate-x-1/2 transition-opacity duration-150',
                    hover ? 'opacity-100' : 'opacity-0',
                  )}
                  style={{ left: hover ? `clamp(calc(${PREVIEW_W} / 2), ${hover.x}px, calc(100% - ${PREVIEW_W} / 2))` : 0, width: PREVIEW_W }}
                >
                  <div className="overflow-hidden rounded-lg bg-black shadow-pop ring-1 ring-white/15" style={{ aspectRatio: String(aspect) }}>
                    <video ref={previewRef} src={file.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                  </div>
                  <div className="mt-1 text-center text-[11px] font-medium tabular-nums text-white [text-shadow:0_1px_2px_oklch(0_0_0/0.6)]">
                    {fineClock((hover?.ratio ?? 0) * duration, duration)}
                  </div>
                </div>
              </div>

              <div className="mt-1 flex items-center gap-1 text-white">
                <Control label={playing ? '暂停' : '播放'} onClick={toggle}>
                  {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
                </Control>

                {/* 音量：悬停展开滑条 */}
                <div className="group/vol flex items-center">
                  <Control label={muted ? '取消静音' : '静音'} onClick={() => { const v = video(); if (v) v.muted = !v.muted; }}>
                    <VolumeIcon className="h-4 w-4" />
                  </Control>
                  <div className="w-0 overflow-hidden transition-[width] duration-300 ease-out group-hover/vol:w-20 group-focus-within/vol:w-20">
                    <div
                      role="slider"
                      aria-label="音量"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
                      tabIndex={0}
                      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setVol(ratioAt(e).ratio); }}
                      onPointerMove={(e) => e.buttons === 1 && setVol(ratioAt(e).ratio)}
                      className="relative mx-2 h-4 w-16 cursor-pointer touch-none outline-none"
                    >
                      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/25">
                        <div className="h-full bg-white" style={{ width: `${(muted ? 0 : volume) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                </div>

                <span className="ml-1 text-[12px] tabular-nums text-white/85">
                  {clock(time)}<span className="text-white/45"> / {clock(duration)}</span>
                </span>

                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="播放速度"
                    title="播放速度"
                    onClick={() => {
                      const v = video();
                      if (v) v.playbackRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
                    }}
                    className={cn(
                      'h-7 min-w-10 rounded-full px-2 text-[12px] font-medium tabular-nums transition-colors hover:bg-white/12',
                      rate === 1 ? 'text-white/85' : 'bg-white/15 text-white',
                    )}
                  >
                    {rate}×
                  </button>
                  {pipSupported && (
                    <Control label="画中画" onClick={togglePip}>
                      <PictureInPicture2 className="h-4 w-4" />
                    </Control>
                  )}
                  <Control label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
                    {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                  </Control>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
