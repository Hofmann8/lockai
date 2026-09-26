'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ChevronDown, Download, Globe, ImageIcon, Loader2, Maximize2, X } from 'lucide-react';
import type { ImageGenToolTrace, SearchSource, SearchToolTrace } from '@/types';
import { cn } from '@/lib/cn';
import { Collapse } from '@/components/ui/Collapse';
import { useHoldAnchor } from '@/lib/hooks/useScrollAnchor';

gsap.registerPlugin(useGSAP);

/* ------------------------------------------------------------------ */

/** 从 startedAt 开始计秒，只让用到它的小组件每秒重渲染 */
export function useElapsed(startedAtMs: number | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // 重新开始计时时先对一下表，不然第一帧用的是上次停下时的旧时间
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!running || !startedAtMs) return 0;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

/** 42s · 3m32s · 1h05m */
export function formatSeconds(value: number): string {
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function Seconds({ value }: { value: number }) {
  if (value <= 0) return null;
  return <span className="tabular-nums text-fg-faint">{formatSeconds(value)}</span>;
}

const playedPreambles = new Set<string>();

/**
 * 模型调工具前说的那句"我去查一下…"。流式时它先以正文出现，工具一开始就在原地
 * 从正文字号缩成卡片上方的一行说明。翻历史消息时直接是收好的样子。
 */
export function ToolPreamble({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // 同一句只演一次：单张卡片变成"搜索了 N 次"一组时会换组件重挂载，不能再演一遍
  const [play] = useState(() => live && !playedPreambles.has(text));
  useGSAP(() => {
    if (!play || !ref.current) return;
    playedPreambles.add(text);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // 起点和正文 .md 一致（15.5px / 1.78 行高 / 不透明），所以看起来是同一句话在收拢
    gsap.from(ref.current, {
      fontSize: '15.5px',
      lineHeight: '27.6px',
      opacity: 1,
      paddingLeft: 0,
      borderLeftWidth: 0,
      duration: 0.6,
      ease: 'power3.inOut',
    });
  }, { scope: ref });
  return (
    <p ref={ref} className="mb-1.5 border-l-2 border-line pl-2.5 text-[12.5px] leading-5 text-fg opacity-55">
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* 联网搜索 */
/* ------------------------------------------------------------------ */

function SourceIcon({ source, className }: { source: SearchSource; className?: string }) {
  const [failed, setFailed] = useState(false);
  const letter = (source.site || source.title || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  if (source.icon && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={source.icon}
        alt=""
        onError={() => setFailed(true)}
        className={cn('h-4 w-4 rounded-full bg-surface object-cover ring-2 ring-bg', className)}
      />
    );
  }
  return (
    <span className={cn('flex h-4 w-4 items-center justify-center rounded-full bg-line-strong text-[9px] leading-none font-semibold text-fg ring-2 ring-bg', className)}>
      {letter}
    </span>
  );
}

export function SearchCard({ trace, settlingLabel }: { trace: SearchToolTrace; settlingLabel?: string }) {
  const running = trace.status === 'running';
  const elapsed = useElapsed(trace.startedAtMs, running);
  const [open, setOpen] = useState(false);
  const holdAnchor = useHoldAnchor();
  const sources = trace.sources ?? [];
  const query = trace.query.trim();

  return (
    <div className="my-3">
      {trace.preamble && <ToolPreamble text={trace.preamble} live={running} />}
      <div className="animate-rise">
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <Globe className={cn('h-3.5 w-3.5', trace.success === false ? 'text-danger' : 'text-fg-faint')} />
          )}
          <span className={cn(running || settlingLabel ? 'shimmer-text' : 'text-fg-soft')}>
            {running
              ? '正在搜索'
              : settlingLabel
                ? settlingLabel
                : trace.success === false
                  ? '搜索没有成功'
                  : '搜索了'}
          </span>
          {query && <span className="max-w-[22rem] truncate text-fg">{query}</span>}
          {trace.engine && (
            <span className="rounded-full border border-line px-1.5 text-[11px] leading-4.5 text-fg-faint">{trace.engine}</span>
          )}
          <Seconds value={running ? elapsed : trace.durationSeconds ?? 0} />
          {sources.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                holdAnchor(e.currentTarget);
                setOpen((v) => !v);
              }}
              aria-expanded={open}
              className="group/src ml-0.5 flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-1 pr-2 text-xs text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
            >
              <span className="flex -space-x-1.5">
                {sources.slice(0, 4).map((s, i) => (
                  <SourceIcon key={`${s.url}-${i}`} source={s} />
                ))}
              </span>
              <span>{sources.length} 个来源</span>
              <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', open && 'rotate-180')} />
            </button>
          )}
        </div>
        <Collapse open={open && sources.length > 0}>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {sources.map((s, i) => (
              <a
                key={`${s.url}-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group/link flex min-w-0 items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <span className="mt-0.5 text-[11px] tabular-nums text-fg-faint">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 text-[13px] text-fg">{s.title || s.url}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-faint">
                    <SourceIcon source={s} className="h-3 w-3 ring-0" />
                    <span className="truncate">{s.site}</span>
                  </span>
                </span>
              </a>
            ))}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

/** 连续多次搜索：收成一行"搜索了 N 次 · M 个来源"，点开看每一次 */
export function SearchGroup({ traces, settlingLabel }: { traces: SearchToolTrace[]; settlingLabel?: string }) {
  const [open, setOpen] = useState(false);
  const holdAnchor = useHoldAnchor();
  const running = traces.find((t) => t.status === 'running');
  const elapsed = useElapsed(running?.startedAtMs, Boolean(running));
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return traces.flatMap((t) => t.sources ?? []).filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  }, [traces]);
  const totalSeconds = traces.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0);
  const allFailed = traces.every((t) => t.status === 'done' && t.success === false);
  // 收起时显示最新一步的说明；展开后每张卡片各自带着
  const preamble = [...traces].reverse().find((t) => t.preamble)?.preamble;

  return (
    <div className="my-3">
      {!open && preamble && <ToolPreamble key={preamble} text={preamble} live={Boolean(running)} />}
      <div className="animate-rise">
        <button
          type="button"
          onClick={(e) => {
            holdAnchor(e.currentTarget);
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          className="group/sg flex min-h-7 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-left text-[13.5px]"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <Globe className={cn('h-3.5 w-3.5', allFailed ? 'text-danger' : 'text-fg-faint')} />
          )}
          {running ? (
            <>
              <span className="shimmer-text">正在搜索</span>
              <span className="max-w-[20rem] truncate text-fg">{running.query}</span>
              <Seconds value={elapsed} />
            </>
          ) : (
            <>
              <span className={cn(settlingLabel ? 'shimmer-text' : 'text-fg-soft group-hover/sg:text-fg')}>
                {settlingLabel ?? `搜索了 ${traces.length} 次`}
              </span>
              <Seconds value={totalSeconds} />
            </>
          )}
          {sources.length > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-1 pr-2 text-xs text-fg-soft">
              <span className="flex -space-x-1.5">
                {sources.slice(0, 4).map((s, i) => (
                  <SourceIcon key={`${s.url}-${i}`} source={s} />
                ))}
              </span>
              {sources.length} 个来源
            </span>
          )}
          <ChevronDown className={cn('h-3.5 w-3.5 text-fg-faint transition-transform duration-200', open && 'rotate-180')} />
        </button>
        <Collapse open={open}>
          <div className="mt-1 border-l-2 border-line pl-4">
            {traces.map((t, i) => (
              <SearchCard key={`${t.query}-${i}`} trace={t} />
            ))}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 图片生成 / 编辑 */
/* ------------------------------------------------------------------ */

function pickFirst(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) [x, y] = [y, x % y];
  return x || 1;
}

function aspectLabel(trace: ImageGenToolTrace): string {
  const fromDims = trace.outputWidth && trace.outputHeight
    ? `${trace.outputWidth / gcd(trace.outputWidth, trace.outputHeight)}:${trace.outputHeight / gcd(trace.outputWidth, trace.outputHeight)}`
    : '';
  return pickFirst(
    trace.outputAspectRatio,
    trace.resolvedEditRequest?.imageConfig?.aspectRatio,
    trace.editRequest?.imageConfig?.aspectRatio,
    trace.request?.imageConfig?.aspectRatio,
    fromDims,
  );
}

function sizeLabel(trace: ImageGenToolTrace): string {
  return pickFirst(
    trace.resolvedEditRequest?.imageConfig?.imageSize,
    trace.editRequest?.imageConfig?.imageSize,
    trace.request?.imageConfig?.imageSize,
  );
}

async function downloadImage(url: string) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `lockai-${Date.now()}.${(blob.type.split('/')[1] || 'png').split(';')[0]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

export function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[260] flex flex-col bg-scrim backdrop-blur-md animate-fade" onClick={onClose}>
      <div className="flex items-center justify-between gap-3 px-5 py-4" onClick={(e) => e.stopPropagation()}>
        <p className="min-w-0 truncate text-sm text-fg-soft">{alt}</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await downloadImage(url);
              setBusy(false);
            }}
            className="flex h-9 items-center gap-2 rounded-xl bg-surface px-3 text-[13px] text-fg shadow-soft transition-colors hover:bg-surface-2"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            下载
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface text-fg shadow-soft transition-colors hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-2xl object-contain shadow-pop animate-lock-in"
        />
      </div>
    </div>,
    document.body,
  );
}

function ImagePreview({
  url,
  blurredUrl,
  alt,
  blur,
  ratioStyle,
  placeholder,
}: {
  url?: string;
  blurredUrl?: string;
  alt: string;
  blur: boolean;
  ratioStyle?: CSSProperties;
  placeholder: string;
}) {
  const src = blur && blurredUrl ? blurredUrl : url;
  const [loaded, setLoaded] = useState(false);
  const [measured, setMeasured] = useState<CSSProperties | undefined>(ratioStyle);
  const [lightbox, setLightbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const ratioKey = ratioStyle?.aspectRatio ? String(ratioStyle.aspectRatio) : '';

  useEffect(() => {
    setLoaded(false);
    setMeasured(ratioKey ? { aspectRatio: ratioKey } : undefined);
  }, [ratioKey, src]);

  const attach = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete && node.naturalWidth > 0) {
      setLoaded(true);
      if (!ratioKey) setMeasured({ aspectRatio: `${node.naturalWidth} / ${node.naturalHeight}` });
    }
  }, [ratioKey]);

  const locked = Boolean(measured?.aspectRatio);
  const interactive = Boolean(src) && loaded && !blur;

  return (
    <>
      <div
        className={cn(
          'group/img relative mt-3 w-full max-w-[440px] overflow-hidden rounded-2xl border border-line bg-surface-2',
          !locked && 'min-h-[240px]',
        )}
        style={measured}
      >
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={attach}
            src={src}
            alt={alt}
            onLoad={(e) => {
              if (!ratioKey) setMeasured({ aspectRatio: `${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}` });
              setLoaded(true);
            }}
            onClick={() => interactive && setLightbox(true)}
            className={cn(
              'h-full w-full object-cover transition-[opacity,filter] duration-700 ease-out',
              locked ? 'absolute inset-0' : 'block max-h-[440px]',
              loaded ? 'opacity-100' : 'opacity-0',
              interactive && 'cursor-zoom-in',
            )}
          />
        )}
        {(!src || !loaded || blur) && (
          <div className="absolute inset-0 overflow-hidden">
            {/* 显影：一道很淡的光慢慢扫过 */}
            <div className="absolute inset-0 bg-[linear-gradient(100deg,transparent_30%,color-mix(in_oklch,var(--fg)_6%,transparent)_50%,transparent_70%)] bg-[length:250%_100%] animate-[shimmer-text_2.4s_linear_infinite]" />
            <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl bg-surface/85 px-3 py-2 text-xs text-fg-soft backdrop-blur-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {placeholder}
            </div>
          </div>
        )}
        {interactive && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-linear-to-t from-black/40 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover/img:opacity-100">
            <button
              type="button"
              onClick={() => setLightbox(true)}
              aria-label="放大"
              className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/70"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!src) return;
                setBusy(true);
                await downloadImage(src);
                setBusy(false);
              }}
              aria-label="下载"
              className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/70"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
      </div>
      {lightbox && src && <Lightbox url={src} alt={alt} onClose={() => setLightbox(false)} />}
    </>
  );
}

function DetailGroup({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1.5 text-[11px] tracking-wide text-fg-faint">{title}</div>
      <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-fg-faint">{row.label}</dt>
            <dd className="whitespace-pre-wrap break-words text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type Row = { label: string; value: string } | null;
const rows = (list: Row[]) => list.filter((r): r is { label: string; value: string } => Boolean(r));

export function ImageCard({ trace, settlingLabel }: { trace: ImageGenToolTrace; settlingLabel?: string }) {
  const running = trace.status === 'running';
  const elapsed = useElapsed(trace.startedAtMs, running || Boolean(settlingLabel));
  const [showDetails, setShowDetails] = useState(false);
  const isEdit = trace.mode === 'edit';
  const subject = isEdit
    ? trace.editRequest?.instruction?.trim() || trace.prompt
    : trace.request?.subject?.trim() || trace.prompt;
  const ratio = aspectLabel(trace);
  const size = sizeLabel(trace);
  const canvas = trace.outputWidth && trace.outputHeight ? `${trace.outputWidth} × ${trace.outputHeight}` : '';
  const ratioStyle = useMemo<CSSProperties | undefined>(() => {
    if (trace.outputWidth && trace.outputHeight) return { aspectRatio: `${trace.outputWidth} / ${trace.outputHeight}` };
    return ratio.includes(':') ? { aspectRatio: ratio.replace(':', ' / ') } : undefined;
  }, [ratio, trace.outputHeight, trace.outputWidth]);

  const status = settlingLabel
    || (running
      ? (isEdit ? '正在修改图片' : '正在画')
      : trace.success
        ? (isEdit ? '改好了' : '画好了')
        : (isEdit ? '图片修改失败' : '图片生成失败'));

  const chips = [ratio, size, trace.request?.style?.trim()].filter(Boolean) as string[];
  const req = trace.request;
  const edit = trace.editRequest;
  const core = rows(isEdit
    ? [
        subject ? { label: '修改要求', value: subject } : null,
        trace.sourceLabel ? { label: '源图', value: trace.sourceLabel } : null,
        edit?.preserve?.trim() ? { label: '保留', value: edit.preserve.trim() } : null,
      ]
    : [
        subject ? { label: '主体', value: subject } : null,
        req?.details?.trim() ? { label: '细节', value: req.details.trim() } : null,
        req?.background?.trim() ? { label: '背景', value: req.background.trim() } : null,
        req?.textOverlay?.trim() ? { label: '图中文字', value: req.textOverlay.trim() } : null,
      ]);
  const visual = rows([
    req?.style?.trim() ? { label: '风格', value: req.style.trim() } : null,
    req?.composition?.trim() ? { label: '构图', value: req.composition.trim() } : null,
    req?.camera?.trim() ? { label: '镜头', value: req.camera.trim() } : null,
    req?.lighting?.trim() ? { label: '光线', value: req.lighting.trim() } : null,
    req?.colorTone?.trim() ? { label: '色调', value: req.colorTone.trim() } : null,
    ratio ? { label: '比例', value: ratio } : null,
    size ? { label: '分辨率', value: size } : null,
    canvas ? { label: '画布', value: canvas } : null,
  ]);
  const avoid = rows([
    (isEdit ? edit?.negativePrompt : req?.negativePrompt)?.trim()
      ? { label: '避免', value: ((isEdit ? edit?.negativePrompt : req?.negativePrompt) ?? '').trim() }
      : null,
  ]);
  const hasDetails = core.length + visual.length + avoid.length > 0;

  return (
    <div className="my-3">
      {trace.preamble && <ToolPreamble text={trace.preamble} live={running} />}
      <div className="animate-rise">
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <ImageIcon className={cn('h-3.5 w-3.5', trace.success === false ? 'text-danger' : 'text-fg-faint')} />
          )}
          <span className={cn(running || settlingLabel ? 'shimmer-text' : 'text-fg-soft')}>{status}</span>
          <Seconds value={running || settlingLabel ? (trace.durationSeconds ?? 0) + elapsed : trace.durationSeconds ?? 0} />
          {trace.modelLabel && (
            <span className="rounded-md border border-line px-1.5 py-px text-[10.5px] text-fg-faint">{trace.modelLabel}</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="line-clamp-2 text-fg">{subject}</span>
          {chips.map((chip) => (
            <span key={chip} className="rounded-full bg-surface-2 px-2 py-px text-[11.5px] text-fg-soft">{chip}</span>
          ))}
          {hasDetails && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="flex items-center gap-0.5 text-[12px] text-fg-faint transition-colors hover:text-fg"
            >
              {showDetails ? '收起参数' : '参数'}
              <ChevronDown className={cn('h-3 w-3 transition-transform', showDetails && 'rotate-180')} />
            </button>
          )}
        </div>
        {showDetails && (
          <div className="mt-2 rounded-2xl border border-line bg-surface px-4 py-3 animate-fade">
            <DetailGroup title="内容" rows={core} />
            <DetailGroup title="画面" rows={visual} />
            <DetailGroup title="约束" rows={avoid} />
          </div>
        )}
        {(running || trace.url) && (
          <ImagePreview
            url={trace.url}
            blurredUrl={trace.blurredUrl}
            alt={subject || '生成的图片'}
            blur={Boolean(trace.url && settlingLabel)}
            ratioStyle={ratioStyle}
            placeholder={running ? (isEdit ? '正在渲染修改' : '正在显影') : settlingLabel || '加载中'}
          />
        )}
      </div>
    </div>
  );
}
