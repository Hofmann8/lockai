import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowUp, AppWindow, Brain, CalendarDays, Check, ChevronDown, Copy, Download, FileSpreadsheet, FileText, Files, FolderDown,
  GitBranch, Globe, Image as ImageIcon, Loader2, Mic, MoreHorizontal, PanelLeftClose, PenLine, Plus, Presentation, RotateCcw,
  Search, SquarePen, SquareTerminal, CalendarCheck, X, ExternalLink, MessageCircleQuestion,
} from 'lucide-react';
import { easeLock, easeOut, FPS } from '../lib/time';

/*
 * 产品界面的静态复刻：结构和 className 逐字取自 lockai/src 的组件。
 * 产品里的 CSS 动画（流光、转圈、思考竖线）在这里改成按帧计算，保证逐帧渲染稳定。
 */

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/* ---------------- 品牌 ---------------- */

/** 锁标。lift：锁梁抬起的像素（viewBox 单位，产品静止态 1.6，忙碌时抬到 4） */
export function LockMark({ size = 24, lift = 1.6, rot = 0, className, bg = 'var(--bg)', style }: {
  size?: number; lift?: number; rot?: number; className?: string; bg?: string; style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={cn('shrink-0 overflow-visible', className)} style={style}>
      <g style={{ transformOrigin: '11px 15px', transform: `translateY(${-lift}px) rotate(${rot}deg)` }}>
        <path d="M11 15V11.5a5 5 0 0 1 10 0V13" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
      </g>
      <rect x="6.5" y="14" width="19" height="14.5" rx="4.6" fill="currentColor" />
      <rect x="13.6" y="18" width="1.7" height="6.4" rx="0.85" fill={bg} />
      <rect x="16.7" y="18" width="1.7" height="6.4" rx="0.85" fill="var(--accent)" />
    </svg>
  );
}

/** 忙碌时锁梁的循环（抬—停—落—停，第二小节带一个小转），按帧算 */
export function busyShackle(frame: number): { lift: number; rot: number } {
  const t = ((frame / FPS) % 2.14 + 2.14) % 2.14;
  const seg = (a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  let y = 0;
  let r = 0;
  if (t < 0.14) y = 4 * easeOut(seg(0, 0.14));
  else if (t < 0.34) y = 4;
  else if (t < 0.46) y = 4 * (1 - easeLock(seg(0.34, 0.46)));
  else if (t < 0.76) y = 0;
  else if (t < 0.9) y = 4 * easeOut(seg(0.76, 0.9));
  else if (t < 1.08) { y = 4; r = -14 * seg(0.9, 1.08); }
  else if (t < 1.24) { y = 4; r = -14 * (1 - seg(1.08, 1.24)); }
  else if (t < 1.36) y = 4 * (1 - easeLock(seg(1.24, 1.36)));
  return { lift: y, rot: r };
}

export function Wordmark({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      className={cn('font-display text-[19px] leading-none tracking-[-0.02em] text-fg', className)}
      style={{ fontVariationSettings: '"SOFT" 100, "WONK" 1, "opsz" 72', ...style }}
    >
      <span className="italic">Lock</span>
      <span className="ml-[1px] text-fg-soft" style={{ fontVariationSettings: '"SOFT" 0, "WONK" 0, "opsz" 72' }}>AI</span>
    </span>
  );
}

/* ---------------- 按帧驱动的小动效 ---------------- */

/** .shimmer-text：流光文字，2.2s 一个周期 */
export function Shimmer({ children, frame, className }: { children: ReactNode; frame: number; className?: string }) {
  const p = ((frame / FPS) % 2.2) / 2.2;
  return (
    <span
      className={className}
      style={{
        background: 'linear-gradient(90deg, var(--fg-faint) 0%, var(--fg-faint) 40%, var(--fg) 50%, var(--fg-faint) 60%, var(--fg-faint) 100%)',
        backgroundSize: '250% 100%',
        backgroundPosition: `${150 - 200 * p}% 0`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      }}
    >
      {children}
    </span>
  );
}

export function Spin({ frame, className }: { frame: number; className?: string }) {
  return <Loader2 className={className} style={{ transform: `rotate(${(frame / FPS) * 360}deg)` }} />;
}

/** 思考竖线：两道细线按"抬—停—落—停"起伏，后一道晚半拍；phase 由外面按拍子给 */
export function ThinkBars({ a, b }: { a: number; b: number }) {
  return (
    <span className="inline-flex items-end" style={{ gap: 2, height: 12 }}>
      <span style={{ width: 2, height: 12, borderRadius: 2, background: 'var(--fg-faint)', transformOrigin: '50% 100%', transform: `scaleY(${a})` }} />
      <span style={{ width: 2, height: 12, borderRadius: 2, background: 'var(--accent)', transformOrigin: '50% 100%', transform: `scaleY(${b})` }} />
    </span>
  );
}

/** 产品的 --ease-lock 入场（lock-in）：给定进度 0–1 返回样式 */
export function lockIn(p: number): CSSProperties {
  if (p <= 0) return { opacity: 0, transform: 'translateY(6px) scale(0.985)' };
  if (p >= 1) return {};
  const e = easeLock(p);
  return { opacity: Math.min(1, p * 2.2), transform: `translateY(${6 * (1 - e)}px) scale(${0.985 + 0.015 * e})` };
}
export function rise(p: number, dist = 10): CSSProperties {
  if (p <= 0) return { opacity: 0, transform: `translateY(${dist}px)` };
  if (p >= 1) return {};
  const e = easeOut(p);
  return { opacity: e, transform: `translateY(${dist * (1 - e)}px)` };
}

export function formatSeconds(s: number) {
  const v = Math.max(0, Math.round(s));
  if (v < 60) return `${v}s`;
  if (v < 3600) return `${Math.floor(v / 60)}m${String(v % 60).padStart(2, '0')}s`;
  return `${Math.floor(v / 3600)}h${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}m`;
}

/* ---------------- 外壳 ---------------- */

export interface SessionRow { title: string; active?: boolean; running?: boolean }

export function Sidebar({ groups, frame, busy }: { groups: { label: string; rows: SessionRow[] }[]; frame: number; busy?: boolean }) {
  const s = busy ? busyShackle(frame) : { lift: 1.6, rot: 0 };
  return (
    <aside className="relative flex h-full shrink-0 flex-col border-r border-line bg-sunken/60 w-[272px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
          <span className="flex items-center gap-2 rounded-lg">
            <LockMark size={22} className="text-fg" lift={s.lift} rot={s.rot} />
            <Wordmark />
          </span>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-faint">
            <PanelLeftClose className="h-[18px] w-[18px]" />
          </span>
        </div>
        <div className="space-y-0.5 px-2 pb-2">
          <div className="group flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] text-fg">
            <SquarePen className="h-4 w-4 text-fg-soft" />
            <span className="flex-1 text-left">新对话</span>
          </div>
          <div className="group flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] text-fg-soft">
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left">搜索对话</span>
          </div>
        </div>
        <nav className="min-h-0 flex-1 overflow-hidden px-2 pb-3">
          {groups.map((g) => (
            <div key={g.label} className="pt-3">
              <div className="flex items-center gap-1.5 px-3 pb-1 text-[11.5px] font-medium text-fg-faint">{g.label}</div>
              <div className="space-y-px">
                {g.rows.map((r) => (
                  <div key={r.title} className={cn('group/item relative flex items-center rounded-xl', r.active && 'bg-surface-2')}>
                    <span className={cn('min-w-0 flex-1 truncate py-2 pl-3.5 pr-2 text-left text-[13.5px]', r.active ? 'text-fg' : 'text-fg-soft')}>
                      <span className="relative">
                        {r.active && (
                          <>
                            <span className="absolute rounded-[2px] bg-accent" style={{ left: -9, top: '50%', width: 2, height: 14, transform: 'translateY(-50%)' }} />
                            <span className="absolute rounded-[2px] bg-accent" style={{ left: -5, top: '50%', width: 2, height: 14, transform: 'translateY(-50%)' }} />
                          </>
                        )}
                        {r.title}
                      </span>
                    </span>
                    {r.running && (
                      <span
                        className="pointer-events-none absolute right-[15px] top-1/2 -mt-[3px] h-1.5 w-1.5 rounded-full bg-accent"
                        style={{ opacity: 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(((frame / FPS) % 2) * Math.PI)), transform: `scale(${0.8 + 0.2 * (0.5 - 0.5 * Math.cos(((frame / FPS) % 2) * Math.PI))})` }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="shrink-0 border-t border-line p-2">
          <div className="flex items-center gap-2.5 rounded-xl h-11 w-full px-2.5">
            <span className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-medium text-fg-soft" style={{ width: 28, height: 28 }}>F</span>
            <span className="min-w-0 flex-1 truncate text-left text-[13.5px] text-fg">Funk&amp;Love</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function ChatHeader({ title, showActions = true }: { title?: string; showActions?: boolean }) {
  return (
    <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 px-4">
      <div className="min-w-0 flex-1">
        {title && <span className="max-w-full truncate rounded-lg px-2 py-1 text-[14px] text-fg-soft">{title}</span>}
      </div>
      {showActions && (
        <div className="flex items-center gap-0.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-soft"><MessageCircleQuestion className="h-[18px] w-[18px]" /></span>
          <span className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-soft"><MoreHorizontal className="h-[18px] w-[18px]" /></span>
        </div>
      )}
    </header>
  );
}

/* ---------------- 输入框 ---------------- */

export function Composer({
  variant, text, caret, placeholder, sendState = 'mic', pressed = 0, model = 'Campbell 3.0', thinking = 'deep', caretStyle,
}: {
  variant: 'hero' | 'dock'; text: string; caret?: boolean; placeholder?: string; sendState?: 'mic' | 'send' | 'stop';
  pressed?: number; model?: string; thinking?: 'think' | 'deep'; caretStyle?: CSSProperties;
}) {
  const ph = placeholder ?? (variant === 'hero' ? '想聊点什么？' : '继续说…');
  return (
    <div className="relative">
      <div className={cn('relative rounded-[26px] border bg-surface', text ? 'border-line-strong shadow-pop' : 'border-line shadow-float')}>
        <div
          className={cn(
            'block w-full resize-none bg-transparent px-5 text-[15.5px] leading-[1.65] text-fg',
            variant === 'hero' ? 'min-h-[88px] pt-4' : 'min-h-[52px] pt-3.5',
          )}
        >
          {text ? (
            <span className="whitespace-pre-wrap">{text}</span>
          ) : (
            <span className="text-fg-faint">{ph}</span>
          )}
          {caret && (
            <span
              className="inline-block align-middle"
              style={{ width: 2, height: 22, marginLeft: text ? 1 : -2, marginTop: -3, borderRadius: 1, background: 'var(--accent)', ...caretStyle }}
            />
          )}
        </div>
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-full text-fg-soft"><Plus className="h-[18px] w-[18px]" /></span>
          <span className="flex h-9 items-center gap-1 rounded-full px-3 text-[13.5px] text-fg-soft">
            <span>{model}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
          <span className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13.5px] text-fg">
            {thinking === 'deep' ? <SparkIcon /> : <Brain className="h-3.5 w-3.5" />}
            <span>{thinking === 'deep' ? '深度思考' : '思考'}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            {sendState === 'mic' && (
              <span className="flex h-9 w-9 items-center justify-center rounded-full text-fg-soft"><Mic className="h-[18px] w-[18px]" /></span>
            )}
            {sendState === 'send' && (
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ink-fg"
                style={{ transform: `scale(${1 - 0.1 * pressed})` }}
              >
                <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />
              </span>
            )}
            {sendState === 'stop' && (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ink-fg">
                <span className="h-3 w-3 rounded-[2px] bg-current" />
              </span>
            )}
          </div>
        </div>
      </div>
      {variant === 'dock' && (
        <p className="mt-2 text-center text-[11px] text-fg-faint">{sendState === 'stop' ? '回答中 · Esc 停止' : 'Enter 发送 · Shift Enter 换行'}</p>
      )}
    </div>
  );
}

function SparkIcon() {
  // lucide Sparkles，accent 色
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" />
    </svg>
  );
}

export function StarterChips({ progress = 1 }: { progress?: number }) {
  const chips: [ReactNode, string][] = [
    [<PenLine key="a" className="h-3.5 w-3.5 text-fg-faint" />, '写点东西'],
    [<ImageIcon key="b" className="h-3.5 w-3.5 text-fg-faint" />, '画张图'],
    [<Globe key="c" className="h-3.5 w-3.5 text-fg-faint" />, '查一查'],
    [<CalendarCheck key="d" className="h-3.5 w-3.5 text-fg-faint" />, '排个计划'],
  ];
  return (
    <div className="mx-auto mt-5 flex w-full max-w-[46rem] flex-wrap justify-center gap-2" style={{ opacity: progress }}>
      {chips.map(([icon, label]) => (
        <span key={label} className="group flex items-center gap-2 rounded-full border border-line px-3.5 py-2 text-[13.5px] text-fg-soft">
          {icon}
          {label}
        </span>
      ))}
    </div>
  );
}

/* ---------------- 消息 ---------------- */

export function UserBubble({ text, time = '21:07', style }: { text: string; time?: string; style?: CSSProperties }) {
  return (
    <div className="group/user flex flex-col items-end" style={style}>
      <div className="max-w-[80%] rounded-[22px] rounded-br-lg bg-surface-2 px-4 py-2.5 text-[15px] leading-[1.7] text-fg">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
      <div className="mt-1 flex items-center gap-0.5 opacity-0">
        <span className="mr-1 text-[11px] text-fg-faint">{time}</span>
      </div>
    </div>
  );
}

export function ThinkingChip({ live, seconds, tokens, frame, bars }: {
  live: boolean; seconds: number; tokens?: string; frame: number; bars: [number, number];
}) {
  if (live) {
    return (
      <div className="mb-2.5 flex h-6 items-center gap-2 text-[13px]">
        <ThinkBars a={bars[0]} b={bars[1]} />
        <Shimmer frame={frame}>思考中</Shimmer>
        {seconds > 0 && <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>}
      </div>
    );
  }
  return (
    <div className="mb-2.5 flex h-6 items-center">
      <span className="flex items-center gap-2 text-[13px] text-fg-faint">
        <ThinkBars a={0.62} b={0.62} />
        <span>思考 <span className="tabular-nums">{Math.max(1, Math.round(seconds))}</span> 秒</span>
        {tokens && (
          <>
            <span className="h-[3px] w-[3px] rounded-full bg-line-strong" />
            <span className="tabular-nums">{tokens} tokens</span>
          </>
        )}
      </span>
    </div>
  );
}

/** 等待 / 空闲状态行 */
export function StatusRow({ label, seconds, frame, className }: { label: string; seconds?: number; frame: number; className?: string }) {
  const s = busyShackle(frame);
  return (
    <div className={cn('flex h-8 items-center gap-2.5 text-[13.5px]', className)}>
      <LockMark size={18} className="text-fg" lift={s.lift} rot={s.rot} />
      <Shimmer frame={frame}>{label}</Shimmer>
      {!!seconds && <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>}
    </div>
  );
}

export function ActionRow() {
  return (
    <div className="mt-2 flex items-center gap-0.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-faint"><Copy className="h-4 w-4" /></span>
      <span className="-ml-1 flex h-8 w-4 items-center justify-center rounded-lg text-fg-faint"><ChevronDown className="h-3 w-3" /></span>
      <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-faint"><RotateCcw className="h-3.5 w-3.5" /></span>
      <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-faint"><GitBranch className="h-3.5 w-3.5" /></span>
    </div>
  );
}

/* ---------------- 搜索 ---------------- */

export interface Source { title: string; site: string; letter: string; tint: string }

export function SourceDot({ s, size = 16, ring = true }: { s: Source; size?: number; ring?: boolean }) {
  return (
    <span
      className={cn('flex items-center justify-center rounded-full font-semibold leading-none text-white', ring && 'ring-2 ring-bg')}
      style={{ width: size, height: size, fontSize: size * 0.56, background: s.tint }}
    >
      {s.letter}
    </span>
  );
}

export function SearchRow({ state, query, count, seconds, sources, frame, label }: {
  state: 'running' | 'done'; query: string; count?: string; seconds: number; sources: Source[]; frame: number; label?: string;
}) {
  return (
    <div className="my-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
        {state === 'running' ? (
          <>
            <Spin frame={frame} className="h-3.5 w-3.5 text-accent" />
            <Shimmer frame={frame}>正在搜索</Shimmer>
            <span className="max-w-[22rem] truncate text-fg">{query}</span>
            <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>
          </>
        ) : (
          <>
            <Globe className="h-3.5 w-3.5 text-fg-faint" />
            <span className="text-fg-soft">{label ?? '搜索了'}</span>
            <span className="max-w-[22rem] truncate text-fg">{query}</span>
            <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>
            <span className="ml-0.5 flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-1 pr-2 text-xs text-fg-soft">
              <span className="flex -space-x-1.5">
                {sources.slice(0, 4).map((s) => <SourceDot key={s.site} s={s} />)}
              </span>
              <span>{count}</span>
              <ChevronDown className="h-3 w-3" />
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function SourceCard({ s, i, style }: { s: Source; i: number; style?: CSSProperties }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2" style={style}>
      <span className="mt-0.5 text-[11px] tabular-nums text-fg-faint">{i}</span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-[13px] text-fg">{s.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-faint">
          <SourceDot s={s} size={12} ring={false} />
          <span className="truncate">{s.site}</span>
        </span>
      </span>
    </div>
  );
}

/* ---------------- 派活卡片 ---------------- */

export interface StepView { title: string; done?: boolean; seconds?: number }

export function StepStatus({ state, frame }: { state: 'running' | 'done'; frame: number }) {
  if (state === 'running') {
    return (
      <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-bg">
        <Spin frame={frame} className="h-3.5 w-3.5 text-accent" />
      </span>
    );
  }
  return (
    <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 ring-1 ring-line">
      <Check className="h-2.5 w-2.5 text-fg-soft" strokeWidth={3} />
    </span>
  );
}

export function LiveSteps({ older, steps, current, tail, frame, shift = 0 }: {
  older: number; steps: StepView[]; current?: StepView; tail: string[]; frame: number; shift?: number;
}) {
  return (
    <div className="mt-2 ml-[1px]">
      {older > 0 && (
        <div className="relative flex h-7 w-full items-start pl-7 text-left text-[12px] text-fg-faint">
          <span className="absolute bottom-0 left-[7.5px] top-4 w-px bg-line" />
          <span className="absolute left-[4.5px] top-[6px] h-[7px] w-[7px] rounded-full bg-line-strong" />
          <span className="tabular-nums">前面 {older} 步</span>
        </div>
      )}
      <ol>
        {steps.map((s) => (
          <li key={s.title} className="relative pb-2 pl-7">
            <span className="absolute bottom-0 left-[7.5px] top-5 w-px bg-line" />
            <span className="absolute left-0 top-[3px]"><StepStatus state="done" frame={frame} /></span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.6] text-fg-soft">{s.title}</span>
              <span className="shrink-0 text-[11.5px]"><span className="tabular-nums text-fg-faint">{formatSeconds(s.seconds ?? 4)}</span></span>
            </div>
          </li>
        ))}
        {current && (
          <li className="relative pl-7">
            <span className="absolute left-0 top-[3px]"><StepStatus state="running" frame={frame} /></span>
            <div className="flex min-w-0 items-center gap-2">
              <Shimmer frame={frame} className="min-w-0 flex-1 truncate text-[13px] leading-[1.6]">{current.title}</Shimmer>
            </div>
            <div className="mt-1.5 rounded-lg bg-surface-2/60 px-2.5 py-1.5">
              <pre
                className="flex h-[4.1rem] flex-col justify-end overflow-hidden font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap break-all text-fg-faint"
                style={{ WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 1.1rem)', maskImage: 'linear-gradient(to bottom, transparent, #000 1.1rem)', margin: 0 }}
              >
                <span style={{ display: 'block', transform: `translateY(${shift}px)` }}>{tail.join('\n')}</span>
              </pre>
            </div>
          </li>
        )}
      </ol>
    </div>
  );
}

export function TaskCard({
  title, state, sub, seconds, stepCount, frame, children, model = 'Scooby 2.0', style, highlight = 0,
}: {
  title: string; state: 'running' | 'done'; sub: string; seconds: number; stepCount: number; frame: number;
  children?: ReactNode; model?: string; style?: CSSProperties; highlight?: number;
}) {
  return (
    <div
      className="my-3 rounded-2xl border border-line bg-surface px-3.5 py-3"
      style={{ boxShadow: highlight ? `0 0 0 ${highlight}px color-mix(in oklch, var(--accent) 35%, transparent), var(--shadow-md)` : undefined, ...style }}
    >
      <div className="group/task flex w-full min-w-0 items-center gap-3 text-left">
        {state === 'running' ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Spin frame={frame} className="h-4 w-4" />
          </span>
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-soft">
            <Check className="h-4 w-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{title}</span>
            <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-px text-[11px] text-fg-faint">{model} 执行</span>
          </span>
          {state === 'running' ? (
            <Shimmer frame={frame} className="mt-0.5 block truncate text-[12px]">{sub}</Shimmer>
          ) : (
            <span className="mt-0.5 block truncate text-[12px] text-fg-faint">{sub}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-fg-faint">
          <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>
          {stepCount > 0 && <span className="tabular-nums">{stepCount} 步</span>}
          <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </div>
      {children && <div className="pt-1">{children}</div>}
    </div>
  );
}

export function ShellHeadline({ label, seconds, frame, done }: { label: string; seconds: number; frame: number; done?: boolean }) {
  return (
    <div className="flex min-h-7 max-w-full items-center gap-2 text-left text-[13.5px]">
      {done ? <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-fg-faint" /> : <Spin frame={frame} className="h-3.5 w-3.5 shrink-0 text-accent" />}
      {done ? <span className="min-w-0 truncate text-fg-soft">{label}</span> : <Shimmer frame={frame} className="min-w-0 truncate">{label}</Shimmer>}
      <span className="flex shrink-0 items-center gap-2 text-[12px] text-fg-faint">
        <span className="tabular-nums text-fg-faint">{formatSeconds(seconds)}</span>
      </span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
    </div>
  );
}

/* ---------------- 交付文件 ---------------- */

export type Kind = 'ppt' | 'sheet' | 'doc' | 'pdf' | 'html' | 'image' | 'calendar';

export const KIND: Record<Kind, { icon: typeof FileText; tint: string; label: string }> = {
  ppt: { icon: Presentation, tint: 'bg-[oklch(0.68_0.15_40/0.14)] text-[oklch(0.58_0.16_40)]', label: 'PPT' },
  sheet: { icon: FileSpreadsheet, tint: 'bg-[oklch(0.65_0.13_150/0.14)] text-[oklch(0.52_0.12_150)]', label: 'Excel' },
  doc: { icon: FileText, tint: 'bg-[oklch(0.62_0.13_255/0.14)] text-[oklch(0.52_0.14_255)]', label: 'Word' },
  pdf: { icon: FileText, tint: 'bg-[oklch(0.6_0.18_27/0.13)] text-[oklch(0.56_0.18_27)]', label: 'PDF' },
  html: { icon: AppWindow, tint: 'bg-[oklch(0.66_0.12_200/0.14)] text-[oklch(0.52_0.11_200)]', label: '网页' },
  image: { icon: ImageIcon, tint: 'bg-surface-2 text-fg-soft', label: 'PNG' },
  calendar: { icon: CalendarDays, tint: 'bg-[oklch(0.62_0.17_20/0.12)] text-[oklch(0.57_0.17_22)]', label: 'ICS' },
};

export function FileThumb({ kind, img }: { kind: Kind; img?: ReactNode }) {
  if (img) return <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-line">{img}</span>;
  const K = KIND[kind];
  const Icon = K.icon;
  return (
    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', K.tint)}>
      <Icon className="h-5 w-5" />
    </span>
  );
}

export function DocCard({ name, meta, kind, img, active, style }: {
  name: string; meta: string; kind: Kind; img?: ReactNode; active?: boolean; style?: CSSProperties;
}) {
  return (
    <div
      className={cn('group/file relative flex min-w-0 items-center gap-3 rounded-2xl border bg-surface px-3 py-2.5 text-left', active ? 'border-line-strong shadow-soft' : 'border-line')}
      style={style}
    >
      {active && <span className="absolute inset-y-3 left-0 w-[2px] rounded-full bg-accent" />}
      <FileThumb kind={kind} img={img} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 break-words text-[13.5px] leading-snug text-fg">{name}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-fg-faint">{meta}</span>
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-fg-faint"><Download className="h-4 w-4" /></span>
    </div>
  );
}

export function DeliverablesHeader({ label, zip = true }: { label: string; zip?: boolean }) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-1.5 text-[12.5px] text-fg-faint">
      <Files className="h-3.5 w-3.5" />
      <span className="tabular-nums">{label}</span>
      {zip && (
        <span className="ml-auto flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-soft">
          <FolderDown className="h-3.5 w-3.5" />
          <span className="tabular-nums">全部打包下载</span>
        </span>
      )}
    </div>
  );
}

/* ---------------- 文件面板 ---------------- */

export function PanelHeader({ kind, title, meta, tabs, active }: { kind: Kind; title: string; meta: string; tabs?: string[]; active?: string }) {
  const K = KIND[kind];
  const Icon = K.icon;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
      <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', K.tint)}><Icon className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <span className="flex max-w-full items-center gap-1 rounded-md text-left text-[13.5px] font-medium text-fg">
          <span className="truncate">{title}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        </span>
        <p className="truncate text-[11.5px] text-fg-faint">{meta}</p>
      </div>
      {tabs && (
        <div className="flex shrink-0 gap-0.5 rounded-xl bg-surface-2 p-0.5">
          {tabs.map((t) => (
            <span key={t} className={cn('flex h-7 items-center rounded-[10px] px-2.5 text-[12.5px]', t === active ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint')}>{t}</span>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft"><Download className="h-4 w-4" /></span>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft"><ExternalLink className="h-4 w-4" /></span>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft"><X className="h-4 w-4" /></span>
      </div>
    </header>
  );
}

export function ViewerBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-bg px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-[12px] text-fg-faint">{children}</div>
      <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
    </div>
  );
}
export const Dot = () => <span className="text-line-strong">·</span>;

export function Segmented({ options, active }: { options: string[]; active: string }) {
  return (
    <div className="flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
      {options.map((o) => (
        <span key={o} className={cn('flex h-6 items-center rounded-lg px-2.5 text-[12px]', o === active ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint')}>{o}</span>
      ))}
    </div>
  );
}
