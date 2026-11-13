'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { MicVocal, Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { FileArtifact, MusicMeta } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, humanSize, PreviewFallback, ViewerBar } from './shared';

/**
 * 作曲生成的歌专用的播放器：唱片机。播放时唱片转起来、唱臂落到唱片上并随进度往里走，
 * 暂停时唱片慢慢停下、唱臂抬回；封面就是唱片中间的标签。整页一屏放下，歌词在自己的区域里滚。
 * 上传的音频和沙箱里做出来的音频走普通播放器（AudioView）。
 */

/** 转一圈的秒数（真唱片 33⅓ 转是 1.8 秒，慢一点更从容） */
const SPIN_SECONDS = 2.6;
/** 唱臂角度：抬起、落在第一圈、走到最里圈 */
const ARM_REST = -6;
const ARM_START = 9;
const ARM_END = 20;

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 配色：从封面取主色；没有封面（或跨域取不到像素）用应用的琥珀主色 */
/* ------------------------------------------------------------------ */

interface Palette {
  hue: number;
  sat: number;
}

function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** 和 --accent（oklch 48°）同一个色相的 HSL 近似 */
const ACCENT_PALETTE: Palette = { hue: 28, sat: 0.62 };

function usePalette(cover: string | undefined): Palette {
  const [palette, setPalette] = useState<{ cover: string; value: Palette } | null>(null);
  useEffect(() => {
    if (!cover) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);
        let x = 0;
        let y = 0;
        let sat = 0;
        let weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const { h, s, l } = rgbToHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
          // 越鲜艳、越不偏黑偏白的像素越能代表这张图的颜色
          const w = s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.8);
          x += Math.cos((h * Math.PI) / 180) * w;
          y += Math.sin((h * Math.PI) / 180) * w;
          sat += s * w;
          weight += w;
        }
        if (cancelled || weight < 1) return;
        const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        setPalette({ cover, value: { hue, sat: Math.min(0.8, Math.max(0.3, sat / weight)) } });
      } catch {
        // 跨域没放行：画布被污染，用主色
      }
    };
    img.src = cover;
    return () => {
      cancelled = true;
    };
  }, [cover]);
  return palette && palette.cover === cover ? palette.value : ACCENT_PALETTE;
}

/* ------------------------------------------------------------------ */
/* 歌词：[Verse] / [Chorus] 这类标记当段落名 */
/* ------------------------------------------------------------------ */

type LyricLine = { kind: 'section' | 'line' | 'gap'; text: string };

function parseLyrics(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+?)\]$/.exec(line);
    if (section) out.push({ kind: 'section', text: section[1] });
    else if (line) out.push({ kind: 'line', text: line });
    else if (out.length && out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap', text: '' });
  }
  while (out.length && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

/* ------------------------------------------------------------------ */
/* 唱片机 */
/* ------------------------------------------------------------------ */

/** 唱臂：坐标和唱片同一个 0–100 的方框，支点在右上角外侧 */
function Tonearm({ angle }: { angle: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f6f3ec" />
          <stop offset="0.45" stopColor="#bdb7ac" />
          <stop offset="1" stopColor="#e9e4da" />
        </linearGradient>
        <radialGradient id={`${id}-base`} cx="0.38" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#f4f0e8" />
          <stop offset="1" stopColor="#8f897f" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="1.2" dy="1.8" stdDeviation="1.1" floodColor="#000" floodOpacity="0.35" />
        </filter>
      </defs>
      <circle cx="96" cy="6" r="6.6" fill="#1c1a18" filter={`url(#${id}-shadow)`} />
      <circle cx="96" cy="6" r="4.6" fill={`url(#${id}-base)`} />
      <g
        filter={`url(#${id}-shadow)`}
        style={{
          transformBox: 'view-box',
          transformOrigin: '96px 6px',
          transform: `rotate(${angle}deg)`,
          transition: 'transform 0.9s cubic-bezier(0.3, 0.7, 0.2, 1)',
        }}
      >
        <rect x="93.4" y="-6.5" width="5.2" height="7" rx="1.4" fill="#2a2724" />
        <path d="M96 6 L96 61 Q96 65.5 94.4 68.6" fill="none" stroke={`url(#${id}-metal)`} strokeWidth="1.5" strokeLinecap="round" />
        <g transform="rotate(22 93.6 71.2)">
          <rect x="91.2" y="67.4" width="4.8" height="7.6" rx="1" fill="#2b2826" />
          <rect x="92.6" y="74.4" width="2" height="1.4" rx="0.4" fill="#c9c3b8" />
        </g>
      </g>
      <circle cx="96" cy="6" r="1.5" fill="#2b2826" />
    </svg>
  );
}

function Turntable({
  meta,
  discRef,
  armAngle,
  playing,
}: {
  meta: MusicMeta;
  discRef: RefObject<HTMLDivElement | null>;
  armAngle: number;
  playing: boolean;
}) {
  return (
    <div className="relative aspect-square animate-lock-in" style={{ width: 'min(80cqw, 84cqh)' }}>
      {/* 唱片下面的光：封面的颜色，跟着低音明暗 */}
      <div
        className="absolute inset-[6%] translate-y-[5%] rounded-full blur-2xl"
        style={{ background: 'var(--glow)', opacity: 'calc(0.32 + var(--pulse) * 0.55)' }}
        aria-hidden
      />
      <div
        className="absolute inset-0 transition-transform duration-700 ease-out"
        style={{ transform: playing ? 'scale(1)' : 'scale(0.985)' }}
      >
        {/* 唱片本体（转动） */}
        <div
          ref={discRef}
          className="absolute inset-0 rounded-full will-change-transform"
          style={{
            background: [
              // 曲目之间的空槽
              'radial-gradient(circle, transparent 0 61.6%, rgb(255 255 255 / 0.07) 62%, transparent 62.5%)',
              'radial-gradient(circle, transparent 0 79.6%, rgb(255 255 255 / 0.06) 80%, transparent 80.5%)',
              // 细密的音槽
              // 细密的音槽：渐变不留硬边，转起来不出摩尔纹
              'repeating-radial-gradient(circle, rgb(255 255 255 / 0.028) 0, transparent 1.5px, rgb(255 255 255 / 0.028) 3px)',
              'radial-gradient(circle, #171513 0 37%, #11100f 37.5% 97%, #1a1816 97.5% 100%)',
            ].join(', '),
            boxShadow: '0 22px 44px -20px rgb(0 0 0 / 0.55), inset 0 0 0 1px rgb(255 255 255 / 0.05)',
          }}
        >
          <div className="absolute left-1/2 top-1/2 aspect-square w-[36%] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full shadow-[0_0_0_1px_rgb(0_0_0/0.5),inset_0_0_12px_rgb(0_0_0/0.35)]">
            {meta.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.cover} alt="" draggable={false} className="h-full w-full scale-110 object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(120%_120%_at_30%_20%,var(--tint),var(--glow)_60%,#2a2622)]">
                <span className="font-display text-[clamp(18px,7cqmin,44px)] leading-none text-white/85">{(meta.title || '♪').slice(0, 1)}</span>
              </div>
            )}
          </div>
        </div>
        {/* 高光：光源不动，所以不跟着转 */}
        <div
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              'conic-gradient(from 215deg, transparent 0deg, rgb(255 255 255 / 0.11) 22deg, transparent 58deg, transparent 180deg, rgb(255 255 255 / 0.08) 202deg, transparent 238deg)',
            WebkitMaskImage: 'radial-gradient(circle, transparent 0 18.4%, #000 18.8% 100%)',
            maskImage: 'radial-gradient(circle, transparent 0 18.4%, #000 18.8% 100%)',
          }}
          aria-hidden
        />
        {/* 主轴 */}
        <div className="absolute left-1/2 top-1/2 h-[2.4%] w-[2.4%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_35%_30%,#f2eee6,#8d877d)] shadow-[0_1px_2px_rgb(0_0_0/0.5)]" />
      </div>
      <Tonearm angle={armAngle} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 细的拖动条（进度、音量共用） */
/* ------------------------------------------------------------------ */

function Track({
  value,
  onSeek,
  label,
  valueText,
  trackRef,
  className,
}: {
  value: number;
  onSeek: (ratio: number) => void;
  label: string;
  valueText?: string;
  trackRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };
  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={valueText}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && pick(e)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek(Math.min(1, value + 0.05));
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, value - 0.05));
      }}
      className={cn('group/track relative h-5 cursor-pointer touch-none outline-none', className)}
      style={{ '--v': value } as CSSProperties}
    >
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-fg/12 transition-[height] duration-200 group-hover/track:h-[5px]">
        <div className="h-full rounded-full bg-fg/80" style={{ width: 'calc(var(--v) * 100%)' }} />
      </div>
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-50 rounded-full bg-fg opacity-0 shadow-float transition-[opacity,transform] duration-200 group-hover/track:scale-100 group-hover/track:opacity-100 group-focus-visible/track:scale-100 group-focus-visible/track:opacity-100"
        style={{ left: 'calc(var(--v) * 100%)' }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 播放器 */
/* ------------------------------------------------------------------ */

export default function MusicView({ file }: { file: FileArtifact }) {
  const meta: MusicMeta = file.music ?? { title: file.name.replace(/\.[^.]+$/, '') };
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const discRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);

  // 先按跨域模式加载（低音呼吸光要读音频数据）；存储没放行这个域名就退回普通模式，照样能放
  const [corsMode, setCorsMode] = useState(true);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [metaDuration, setMetaDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);

  const palette = usePalette(meta.cover);
  const duration = metaDuration > 0 && Number.isFinite(metaDuration) ? metaDuration : meta.duration || 0;
  const progress = duration ? Math.min(1, time / duration) : 0;
  const lyrics = useMemo(() => parseLyrics(meta.lyrics ?? ''), [meta.lyrics]);
  const hasLyrics = lyrics.length > 0;
  const chips = useMemo(
    () => (meta.style ?? '').split(/[,，、]/).map((s) => s.trim()).filter((s) => s && !/^\d+\s*bpm$/i.test(s)).slice(0, 3),
    [meta.style],
  );

  /* ---- 每帧：唱片转速有惯性，低音推动光晕，进度条平滑走 ---- */
  const motion = useRef({ angle: 0, speed: 0, last: 0, glow: 0 });
  const frame = useRef<number | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const tick = useCallback((now: number) => {
    frame.current = null;
    const audio = audioRef.current;
    if (!audio) return;
    const m = motion.current;
    const dt = m.last ? Math.min(0.05, (now - m.last) / 1000) : 0;
    m.last = now;
    const target = audio.paused ? 0 : 360 / SPIN_SECONDS;
    // 起转快一点，停下慢一点，像唱机的转盘
    m.speed += (target - m.speed) * (1 - Math.exp(-dt / (audio.paused ? 0.7 : 0.35)));
    m.angle = (m.angle + m.speed * dt) % 360;
    if (discRef.current) discRef.current.style.transform = `rotate(${m.angle.toFixed(2)}deg)`;

    let bass = 0;
    const graph = graphRef.current;
    if (graph && !audio.paused) {
      const bins = new Uint8Array(graph.analyser.frequencyBinCount);
      graph.analyser.getByteFrequencyData(bins);
      const hz = graph.ctx.sampleRate / 2 / bins.length;
      let sum = 0;
      let n = 0;
      for (let j = Math.floor(40 / hz); j <= Math.ceil(160 / hz) && j < bins.length; j += 1) {
        sum += bins[j];
        n += 1;
      }
      bass = Math.pow(n ? sum / n / 255 : 0, 2.2);
    }
    m.glow = Math.max(bass, m.glow * 0.93);
    stageRef.current?.style.setProperty('--pulse', m.glow.toFixed(3));

    const total = durationRef.current;
    if (total) seekRef.current?.style.setProperty('--v', String(Math.min(1, audio.currentTime / total)));

    if (!audio.paused || m.speed > 0.4 || m.glow > 0.01) frame.current = requestAnimationFrame(tick);
    else m.last = 0;
  }, []);

  const kick = useCallback(() => {
    if (frame.current !== null) return;
    motion.current.last = 0;
    frame.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    void graphRef.current?.ctx.close();
    graphRef.current = null;
  }, []);

  const ensureGraph = () => {
    const audio = audioRef.current;
    if (graphRef.current || !corsMode || !audio) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -18;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      graphRef.current = { ctx, analyser };
    } catch {
      // 浏览器不支持：照常播放，只是没有呼吸光
    }
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      ensureGraph();
      void graphRef.current?.ctx.resume();
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.min(duration, Math.max(0, seconds));
    setTime(audio.currentTime);
    kick();
  };

  const applyVolume = (value: number, mute: boolean) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = value;
    audio.muted = mute;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在按钮或拖动条上时由它们自己处理
      if ((e.target as HTMLElement)?.closest('input,textarea,button,[role="slider"],[contenteditable]')) return;
      const audio = audioRef.current;
      if (!audio) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight') {
        seekTo(audio.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        seekTo(audio.currentTime - 5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (failed) {
    return <PreviewFallback file={file} note={`浏览器放不了这种音频（${fileExt(file.name).toUpperCase()}），下载后用播放器打开`} />;
  }

  const armAngle = playing ? ARM_START + (ARM_END - ARM_START) * progress : ARM_REST;
  const tint = `hsl(${palette.hue} ${Math.round(palette.sat * 100)}% 62%)`;
  const glow = `hsl(${palette.hue} ${Math.round(palette.sat * 95)}% 48%)`;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span className="font-medium text-fg-soft">{fileExt(file.name).toUpperCase()}</span>
        {duration > 0 && (<><Dot /><span className="tabular-nums">{clock(duration)}</span></>)}
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
        {meta.version ? (<><Dot /><span>版本 {meta.version}</span></>) : null}
      </ViewerBar>

      <div
        ref={stageRef}
        className="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-sunken"
        style={{ '--tint': tint, '--glow': glow, '--pulse': 0 } as CSSProperties}
      >
        {/* 背景：封面虚化成一层很淡的颜色，底部回到页面底色，控制区读得清 */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {meta.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={meta.cover} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-3xl saturate-150 dark:opacity-30" />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_30%,var(--glow),transparent_70%)] opacity-20" />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_35%,var(--sunken)_92%)]" />
        </div>

        {/* 唱片 / 歌词：宽的时候并排，窄的时候切换 */}
        <div className="relative flex min-h-0 flex-1 gap-8 px-6 pt-6 @3xl:px-12 @3xl:pt-10">
          <div className={cn('min-h-0 min-w-0 flex-1 place-items-center [container-type:size]', showLyrics && hasLyrics ? 'hidden @3xl:grid' : 'grid')}>
            <Turntable meta={meta} discRef={discRef} armAngle={armAngle} playing={playing} />
          </div>
          {hasLyrics && (
            <div className={cn('min-h-0 min-w-0 flex-col @3xl:w-[40%] @3xl:max-w-md @3xl:flex-none', showLyrics ? 'flex flex-1' : 'hidden @3xl:flex')}>
              <div className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,#000_10%,#000_88%,transparent)] [scrollbar-width:none]">
                <div className="space-y-1.5 py-10 text-[15px] leading-relaxed text-fg-soft">
                  {lyrics.map((line, i) => (
                    line.kind === 'section' ? (
                      <p key={i} className="pt-4 text-[10.5px] font-medium uppercase tracking-[0.2em] text-fg-faint first:pt-0">{line.text}</p>
                    ) : line.kind === 'gap' ? (
                      <div key={i} className="h-1.5" />
                    ) : (
                      <p key={i} className="text-fg">{line.text}</p>
                    )
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 歌名、进度、控制 */}
        <div className="relative mx-auto w-full max-w-xl shrink-0 px-6 pb-6 pt-5">
          <div className="text-center">
            <h2 className="truncate font-display text-[22px] font-medium leading-tight tracking-tight text-fg">{meta.title}</h2>
            {(chips.length > 0 || meta.instrumental) && (
              <div className="mt-2 flex h-5 justify-center gap-1.5 overflow-hidden">
                {meta.instrumental && <Chip>纯音乐</Chip>}
                {chips.map((chip) => <Chip key={chip}>{chip}</Chip>)}
              </div>
            )}
          </div>

          <div className="mt-4">
            <Track
              trackRef={seekRef}
              value={progress}
              label="播放进度"
              valueText={`${clock(time)} / ${clock(duration)}`}
              onSeek={(ratio) => seekTo(ratio * duration)}
            />
            <div className="flex justify-between text-[11px] tabular-nums text-fg-faint">
              <span>{clock(time)}</span>
              <span>-{clock(Math.max(0, duration - time))}</span>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center">
            <div className="flex items-center">
              {hasLyrics && (
                <button
                  type="button"
                  aria-label="歌词"
                  aria-pressed={showLyrics}
                  onClick={() => setShowLyrics((v) => !v)}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full transition-colors @3xl:hidden',
                    showLyrics ? 'bg-fg/10 text-fg' : 'text-fg-faint hover:bg-fg/5 hover:text-fg',
                  )}
                >
                  <MicVocal className="h-[17px] w-[17px]" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-5">
              <button type="button" aria-label="后退 10 秒" onClick={() => seekTo(time - 10)} className="flex h-10 w-10 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-fg/5 hover:text-fg">
                <RotateCcw className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                aria-label={playing ? '暂停' : '播放'}
                onClick={toggle}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-ink text-ink-fg shadow-float transition-transform duration-150 hover:scale-105 active:scale-95"
              >
                {playing ? <Pause className="h-6 w-6" fill="currentColor" /> : <Play className="ml-0.5 h-6 w-6" fill="currentColor" />}
              </button>
              <button type="button" aria-label="前进 10 秒" onClick={() => seekTo(time + 10)} className="flex h-10 w-10 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-fg/5 hover:text-fg">
                <RotateCw className="h-[18px] w-[18px]" />
              </button>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                aria-label={muted ? '取消静音' : '静音'}
                onClick={() => {
                  setMuted(!muted);
                  applyVolume(volume, !muted);
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-fg/5 hover:text-fg"
              >
                <VolumeIcon className="h-[17px] w-[17px]" />
              </button>
              <Track
                value={muted ? 0 : volume}
                label="音量"
                className="hidden w-20 @md:block"
                onSeek={(ratio) => {
                  setVolume(ratio);
                  setMuted(false);
                  applyVolume(ratio, false);
                }}
              />
            </div>
          </div>
        </div>

        <audio
          key={corsMode ? 'cors' : 'plain'}
          ref={audioRef}
          src={file.url}
          crossOrigin={corsMode ? 'anonymous' : undefined}
          preload="metadata"
          onPlay={() => {
            setPlaying(true);
            kick();
          }}
          onPause={() => {
            setPlaying(false);
            kick();
          }}
          onEnded={() => setPlaying(false)}
          onSeeked={kick}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            setMetaDuration(e.currentTarget.duration);
            applyVolume(volume, muted);
          }}
          onError={() => (corsMode ? setCorsMode(false) : setFailed(true))}
          className="hidden"
        />
      </div>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="max-w-40 shrink-0 truncate rounded-full bg-fg/[0.06] px-2.5 py-0.5 text-[11px] leading-4 text-fg-soft">{children}</span>
  );
}
