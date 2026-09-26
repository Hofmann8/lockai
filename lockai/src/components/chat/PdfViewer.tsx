'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, Minus, MonitorPlay, Plus, X } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';

/* ------------------------------------------------------------------ */
/* pdf.js：worker 和字体资源都从同源的 /pdfjs/ 取（scripts/copy-pdfjs-assets.mjs） */
/* ------------------------------------------------------------------ */

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    return pdfjs;
  });
  return pdfjsPromise;
}

interface PageSize {
  w: number;
  h: number;
}

export interface PdfInfo {
  pages: number;
  /** 横版（幻灯片）：可以放映 */
  landscape: boolean;
}

/** 竖版文档再宽也不超过这个宽度，读起来舒服 */
const MAX_PAGE_WIDTH = 920;
const PAGE_GAP = 16;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/* ------------------------------------------------------------------ */
/* 单页：进入视口附近才画，离远了释放画布 */
/* ------------------------------------------------------------------ */

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pdfjs: PdfJs;
  index: number;
  size: PageSize;
  scale: number;
  near: boolean;
  textLayer?: boolean;
}

const PdfPage = memo(function PdfPage({ doc, pdfjs, index, size, scale, near, textLayer = true }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const drawnScaleRef = useRef<number | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!canvas) return;
    if (!near) {
      // 远离视口：释放画布内存（长文档不然会越翻越卡）
      canvas.width = 0;
      canvas.height = 0;
      if (text) text.replaceChildren();
      drawnScaleRef.current = null;
      setDrawn(false);
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    let layer: InstanceType<PdfJs['TextLayer']> | null = null;
    // 缩放连续变化时别每一档都画，停一下再画
    const timer = window.setTimeout(async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.floor(viewport.width * ratio);
        offscreen.height = Math.floor(viewport.height * ratio);
        task = page.render({
          canvas: offscreen,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await task.promise;
        if (cancelled) return;
        // 画好了再一次性换上去，缩放时不闪白
        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
        drawnScaleRef.current = scale;
        setDrawn(true);
        if (textLayer && text) {
          text.replaceChildren();
          layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
          await layer.render();
        }
      } catch {
        // 取消渲染会抛 RenderingCancelledException，忽略
      }
    }, drawnScaleRef.current === null ? 0 : 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
      layer?.cancel();
    };
  }, [doc, index, near, pdfjs, scale, textLayer]);

  return (
    <div
      className="pdf-page relative mx-auto overflow-hidden rounded-[3px] bg-white shadow-[0_0_0_1px_oklch(0_0_0/0.06),0_2px_12px_-2px_oklch(0.2_0.01_60/0.18)]"
      style={{
        width: Math.floor(size.w * scale),
        height: Math.floor(size.h * scale),
        ['--scale-factor' as string]: scale,
      }}
      data-page={index + 1}
    >
      <canvas ref={canvasRef} className={cn('absolute inset-0 h-full w-full transition-opacity duration-200', drawn ? 'opacity-100' : 'opacity-0')} />
      {!drawn && <div className="absolute inset-0 animate-pulse bg-[oklch(0.97_0.003_80)]" />}
      {textLayer && <div ref={textRef} className="textLayer" />}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* 放映：横版 PDF（幻灯片）全屏一页一页放 */
/* ------------------------------------------------------------------ */

function Presenter({ doc, pdfjs, sizes, start, onClose }: {
  doc: PDFDocumentProxy;
  pdfjs: PdfJs;
  sizes: PageSize[];
  start: number;
  onClose: (page: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(start);
  const [screen, setScreen] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [chrome, setChrome] = useState(true);
  const hideTimer = useRef<number | null>(null);

  const go = useCallback((delta: number) => setPage((p) => Math.min(sizes.length - 1, Math.max(0, p + delta))), [sizes.length]);
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  const close = useCallback(() => onClose(pageRef.current), [onClose]);

  useEffect(() => {
    const el = rootRef.current;
    el?.requestFullscreen?.().catch(() => {});
    const onResize = () => setScreen({ w: window.innerWidth, h: window.innerHeight });
    const onFs = () => { if (!document.fullscreenElement) close(); };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go(1); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === 'Home') setPage(0);
      else if (e.key === 'End') setPage(sizes.length - 1);
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey, true);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [close, go, sizes.length]);

  const poke = () => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 1800);
  };
  useEffect(() => {
    poke();
    return () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); };
  }, []);

  const size = sizes[page];
  const scale = Math.min(screen.w / size.w, screen.h / size.h);

  return createPortal(
    <div
      ref={rootRef}
      className={cn('fixed inset-0 z-[400] flex items-center justify-center bg-black', !chrome && 'cursor-none')}
      onMouseMove={poke}
      onClick={(e) => go(e.clientX < window.innerWidth / 3 ? -1 : 1)}
    >
      <PdfPage key={page} doc={doc} pdfjs={pdfjs} index={page} size={size} scale={scale} near textLayer={false} />
      {/* 下一页预先画好，翻页不等 */}
      {page + 1 < sizes.length && (
        <div className="pointer-events-none absolute -left-[9999px] opacity-0" aria-hidden>
          <PdfPage doc={doc} pdfjs={pdfjs} index={page + 1} size={sizes[page + 1]} scale={scale} near textLayer={false} />
        </div>
      )}
      <div
        className={cn(
          'absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/10 px-2 py-1.5 text-[13px] text-white/85 backdrop-blur-md transition-opacity duration-300',
          chrome ? 'opacity-100' : 'opacity-0',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="上一页" onClick={() => go(-1)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-14 text-center tabular-nums">{page + 1} / {sizes.length}</span>
        <button type="button" aria-label="下一页" onClick={() => go(1)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15">
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="mx-1 h-4 w-px bg-white/20" />
        <button type="button" aria-label="退出放映" onClick={close} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* 阅读器 */
/* ------------------------------------------------------------------ */

function ToolButton({ label, onClick, disabled, children, active }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent',
          active && 'bg-surface-2 text-fg',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

interface PdfViewerProps {
  url: string;
  className?: string;
  onInfo?: (info: PdfInfo) => void;
}

/**
 * 自己的 PDF 阅读器（pdf.js）：纸张卡片、按需绘制、文字可选中复制；
 * 底部浮着一条工具栏（翻页、缩放、适合宽度），横版文档可以全屏放映。
 */
export function PdfViewer({ url, className, onInfo }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<PdfJs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState(false);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(0);
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1]));
  const [presenting, setPresenting] = useState(false);
  const [pageInput, setPageInput] = useState<string | null>(null);
  const onInfoRef = useRef(onInfo);
  useEffect(() => { onInfoRef.current = onInfo; }, [onInfo]);

  // 加载文档
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setSizes([]);
    setError(false);
    setZoom(1);
    setCurrent(0);
    (async () => {
      try {
        const [lib, buffer] = await Promise.all([
          loadPdfJs(),
          fetch(url, { mode: 'cors' }).then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            return res.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        const task = lib.getDocument({
          data: new Uint8Array(buffer),
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
        });
        loaded = await task.promise;
        if (cancelled) { void loaded.destroy(); return; }
        const pages: PageSize[] = [];
        for (let i = 1; i <= loaded.numPages; i += 1) {
          const vp = (await loaded.getPage(i)).getViewport({ scale: 1 });
          pages.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setPdfjs(lib);
        setDoc(loaded);
        setSizes(pages);
        onInfoRef.current?.({ pages: pages.length, landscape: pages[0] ? pages[0].w > pages[0].h : false });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [url]);

  // 可用宽度
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const maxW = sizes.reduce((m, s) => Math.max(m, s.w), 0) || 1;
  const landscape = sizes[0] ? sizes[0].w > sizes[0].h : false;
  const fitScale = width > 0 ? Math.min(width - 40, landscape ? 1600 : MAX_PAGE_WIDTH) / maxW : 1;
  const scale = Math.max(0.2, fitScale * zoom);

  // 哪些页在视口附近、当前是第几页
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !doc) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
    const nearObserver = new IntersectionObserver((entries) => {
      setNear((prev) => {
        const next = new Set(prev);
        for (const entry of entries) {
          const i = Number((entry.target as HTMLElement).dataset.page) - 1;
          if (entry.isIntersecting) next.add(i); else next.delete(i);
        }
        return next;
      });
    }, { root, rootMargin: '120% 0px' });
    nodes.forEach((n) => nearObserver.observe(n));
    return () => nearObserver.disconnect();
  }, [doc, sizes.length]);

  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const mid = root.scrollTop + root.clientHeight * 0.35;
    const nodes = root.querySelectorAll<HTMLElement>('[data-page]');
    let found = 0;
    nodes.forEach((n, i) => { if (n.offsetTop <= mid) found = i; });
    setCurrent(found);
  };

  const goTo = useCallback((index: number, smooth = true) => {
    const root = scrollRef.current;
    const node = root?.querySelector<HTMLElement>(`[data-page="${index + 1}"]`);
    if (root && node) root.scrollTo({ top: node.offsetTop - PAGE_GAP, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // 缩放时保持当前页在原位
  const setZoomKeep = (next: number) => {
    const root = scrollRef.current;
    const ratio = root ? root.scrollTop / Math.max(1, root.scrollHeight) : 0;
    setZoom(next);
    requestAnimationFrame(() => { if (root) root.scrollTop = ratio * root.scrollHeight; });
  };
  const zoomIn = () => setZoomKeep(ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? zoom);
  const zoomOut = () => setZoomKeep([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? zoom);

  // Ctrl + 滚轮缩放
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.5, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))));
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  const loading = !doc && !error;

  return (
    <div className={cn('group/pdf relative flex h-full min-h-0 flex-col bg-sunken', className)}>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto overscroll-contain" tabIndex={-1}>
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-fg-soft">
            <span>PDF 没能打开</span>
            <span className="text-fg-faint">可能是网络问题，稍后重试或直接下载</span>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center gap-4 px-5 py-5" aria-label="正在打开">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="w-full max-w-[640px] animate-pulse rounded-[3px] bg-surface shadow-soft"
                style={{ aspectRatio: '1 / 1.414', animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-w-fit flex-col items-center px-5 pb-20 pt-5" style={{ gap: PAGE_GAP }}>
            {doc && pdfjs && sizes.map((size, i) => (
              <PdfPage key={i} doc={doc} pdfjs={pdfjs} index={i} size={size} scale={scale} near={near.has(i)} />
            ))}
          </div>
        )}
      </div>

      {doc && sizes.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-line bg-surface/90 px-1.5 py-1 shadow-float backdrop-blur-md transition-opacity duration-200 animate-rise">
            <ToolButton label="上一页" onClick={() => goTo(Math.max(0, current - 1))} disabled={current === 0}>
              <ChevronLeft className="h-4 w-4" />
            </ToolButton>
            <label className="flex items-center gap-1 px-1 text-[12.5px] tabular-nums text-fg-soft">
              <input
                value={pageInput ?? String(current + 1)}
                onFocus={(e) => { setPageInput(String(current + 1)); e.currentTarget.select(); }}
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onBlur={() => setPageInput(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const n = Number(pageInput);
                    if (n >= 1 && n <= sizes.length) goTo(n - 1);
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') e.currentTarget.blur();
                }}
                aria-label="页码"
                className="h-6 w-8 rounded-md bg-transparent text-center text-fg outline-none transition-colors hover:bg-surface-2 focus:bg-surface-2"
              />
              <span className="text-fg-faint">/ {sizes.length}</span>
            </label>
            <ToolButton label="下一页" onClick={() => goTo(Math.min(sizes.length - 1, current + 1))} disabled={current >= sizes.length - 1}>
              <ChevronRight className="h-4 w-4" />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-line" />
            <ToolButton label="缩小" onClick={zoomOut} disabled={zoom <= ZOOM_STEPS[0] + 0.001}>
              <Minus className="h-4 w-4" />
            </ToolButton>
            <button
              type="button"
              onClick={() => setZoomKeep(1)}
              className="h-7 min-w-12 rounded-full px-1.5 text-[12px] tabular-nums text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
              aria-label="适合宽度"
            >
              {Math.round(zoom * 100)}%
            </button>
            <ToolButton label="放大" onClick={zoomIn} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001}>
              <Plus className="h-4 w-4" />
            </ToolButton>
            {landscape ? (
              <>
                <span className="mx-1 h-4 w-px bg-line" />
                <ToolButton label="全屏放映" onClick={() => setPresenting(true)}>
                  <MonitorPlay className="h-4 w-4" />
                </ToolButton>
              </>
            ) : (
              zoom !== 1 && (
                <ToolButton label="适合宽度" onClick={() => setZoomKeep(1)}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </ToolButton>
              )
            )}
          </div>
        </div>
      )}

      {presenting && doc && pdfjs && (
        <Presenter
          doc={doc}
          pdfjs={pdfjs}
          sizes={sizes}
          start={current}
          onClose={(page) => {
            setPresenting(false);
            requestAnimationFrame(() => goTo(page, false));
          }}
        />
      )}
    </div>
  );
}
