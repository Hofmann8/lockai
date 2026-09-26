'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Grid2x2, Maximize2, Minimize2, Palette, PenLine, Rotate3d, Shapes } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Tooltip } from '@/components/ui/Tooltip';
import { formatCount, PreviewFallback } from './shared';
import { ModelStage, parseModel, SWATCHES, type ModelInfo, type ViewName } from './model3d';

const VIEWS: Array<{ name: ViewName; label: string }> = [
  { name: 'iso', label: '等轴' },
  { name: 'front', label: '正视' },
  { name: 'top', label: '俯视' },
  { name: 'side', label: '侧视' },
];

function dims(info: ModelInfo) {
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return `${info.size.map(fmt).join(' × ')}${info.unit ? ` ${info.unit}` : ''}`;
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg',
          active && 'bg-surface-2 text-fg',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 3D 模型：拖动旋转、滚轮缩放、右键平移；预设视角、线框 / 轮廓、网格、换颜色、截图、全屏 */
export default function ModelView({ file }: { file: FileArtifact }) {
  const { resolvedTheme } = useTheme();
  const shellRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<ModelStage | null>(null);
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<ViewName>('iso');
  const [spin, setSpin] = useState(true);
  const [wire, setWire] = useState(false);
  const [edges, setEdges] = useState(true);
  const [grid, setGrid] = useState(true);
  const [color, setColor] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [hint, setHint] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const dark = resolvedTheme === 'dark';

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !file.url) return;
    let cancelled = false;
    let stage: ModelStage | null = null;
    const ext = fileExt(file.name);
    setInfo(null);
    setFailed(null);
    setProgress(0);

    (async () => {
      const res = await fetch(file.url!, { mode: 'cors' });
      if (!res.ok) throw new Error(`下载失败（${res.status}）`);
      // 边下边报进度：大模型要下一会儿
      const total = Number(res.headers.get('content-length')) || file.size || 0;
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        if (total && !cancelled) setProgress(Math.min(0.95, got / total));
      }
      const bytes = new Uint8Array(got);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
      const object = await parseModel(bytes.buffer, ext, file.url!.replace(/[^/]*$/, ''));
      if (cancelled) return;
      stage = new ModelStage(host, {
        dark,
        onFirstInteraction: () => setHint(false),
        onAutoRotateChange: setSpin,
      });
      stageRef.current = stage;
      const result = stage.setModel(object, ext);
      setEdges(stage.hasEdges);
      setColor(result.colored ? null : SWATCHES[1].color);
      setInfo(result);
      setProgress(1);
    })().catch((err: unknown) => {
      if (!cancelled) setFailed(err instanceof Error ? err.message : '模型没能解析出来');
    });

    return () => {
      cancelled = true;
      stage?.dispose();
      stageRef.current = null;
    };
    // 主题切换不重新加载模型
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.url, file.name]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (failed) {
    return <PreviewFallback file={file} note={`${failed}。可以下载后用切片软件（Bambu Studio、Cura、PrusaSlicer）打开。`} />;
  }

  const stage = stageRef.current;
  const snapshot = () => {
    if (!stage) return;
    const a = document.createElement('a');
    a.href = stage.snapshot();
    a.download = `${file.name.split('/').pop()!.replace(/\.[^.]+$/, '')}.png`;
    a.click();
  };

  return (
    <div
      ref={shellRef}
      className="relative h-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_38%,var(--surface)_0%,var(--bg)_55%,var(--sunken)_100%)]"
    >
      <div ref={hostRef} className="absolute inset-0 touch-none" />

      {/* 加载中：细进度环 */}
      {!info && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
          <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" strokeWidth="2.5" />
            <circle
              cx="18" cy="18" r="15" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${Math.max(0.04, progress) * 94.2} 94.2`}
              className="transition-[stroke-dasharray] duration-200"
            />
          </svg>
          <span className="text-[12px] tabular-nums text-fg-faint">{progress > 0 ? `正在载入模型 ${Math.round(progress * 100)}%` : '正在载入模型'}</span>
        </div>
      )}

      {info && (
        <>
          {/* 尺寸与面数 */}
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1 animate-fade">
            <span className="w-fit rounded-xl border border-line bg-surface/80 px-2.5 py-1 text-[12px] font-medium tabular-nums text-fg shadow-soft backdrop-blur-md">
              {dims(info)}
            </span>
            <span className="w-fit rounded-lg px-1 text-[11px] tabular-nums text-fg-faint">
              {formatCount(info.triangles)} 个三角面{info.parts > 1 ? ` · ${info.parts} 个部件` : ''}
            </span>
          </div>

          {/* 视角 */}
          <div className="absolute right-3 top-3 flex gap-0.5 rounded-xl border border-line bg-surface/80 p-0.5 shadow-soft backdrop-blur-md animate-fade">
            {VIEWS.map((v) => (
              <button
                key={v.name}
                type="button"
                onClick={() => { setView(v.name); stage?.view(v.name); setHint(false); }}
                className={cn(
                  'h-7 rounded-[10px] px-2.5 text-[12px] transition-colors',
                  view === v.name ? 'bg-ink text-ink-fg' : 'text-fg-soft hover:text-fg',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* 操作 */}
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-2xl border border-line bg-surface/85 p-1 shadow-float backdrop-blur-md animate-rise">
            <ToolButton label={spin ? '停止旋转' : '自动旋转'} active={spin} onClick={() => { stage?.setAutoRotate(!spin); setSpin(!spin); }}>
              <Rotate3d className="h-4 w-4" />
            </ToolButton>
            <ToolButton label="线框" active={wire} onClick={() => { stage?.setWireframe(!wire); setWire(!wire); }}>
              <Shapes className="h-4 w-4" />
            </ToolButton>
            {stage?.hasEdges && (
              <ToolButton label="轮廓线" active={edges && !wire} onClick={() => { stage.setEdges(!edges); setEdges(!edges); }}>
                <PenLine className="h-4 w-4" />
              </ToolButton>
            )}
            <ToolButton label="网格" active={grid} onClick={() => { stage?.setGrid(!grid); setGrid(!grid); }}>
              <Grid2x2 className="h-4 w-4" />
            </ToolButton>
            <Tooltip label="颜色" side="top" disabled={palette}>
              <button
                type="button"
                aria-label="颜色"
                onClick={() => setPalette((v) => !v)}
                className={cn('flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg', palette && 'bg-surface-2 text-fg')}
              >
                {color ? <span className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ background: color }} /> : <Palette className="h-4 w-4" />}
              </button>
            </Tooltip>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <ToolButton label="保存截图" onClick={snapshot}>
              <Camera className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label={fullscreen ? '退出全屏' : '全屏'}
              onClick={() => (fullscreen ? void document.exitFullscreen() : void shellRef.current?.requestFullscreen())}
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </ToolButton>
          </div>

          {/* 颜色：直接放在工具条上方（全屏时弹层出不来） */}
          {palette && (
            <div className="absolute bottom-[60px] left-1/2 -translate-x-1/2 rounded-2xl border border-line bg-surface/90 p-2 shadow-float backdrop-blur-md animate-pop">
            <div className="flex items-center gap-1.5">
              {SWATCHES.filter((s) => s.color !== null || info.colored).map((s) => (
                <Tooltip key={s.name} label={s.name} side="top">
                  <button
                    type="button"
                    aria-label={s.name}
                    onClick={() => { setColor(s.color); stage?.setColor(s.color); }}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110',
                      color === s.color && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                    )}
                  >
                    {s.color ? (
                      <span className="h-6 w-6 rounded-full ring-1 ring-black/10" style={{ background: s.color }} />
                    ) : (
                      <span className="h-6 w-6 rounded-full bg-[conic-gradient(#e0795f,#e8c35f,#7fbf8a,#5f9fd8,#b77fd0,#e0795f)] ring-1 ring-black/10" />
                    )}
                  </button>
                </Tooltip>
              ))}
            </div>
            </div>
          )}

          <p
            className={cn(
              'pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11.5px] text-fg-faint transition-opacity duration-500',
              hint ? 'opacity-100' : 'opacity-0',
            )}
          >
            拖动旋转 · 滚轮缩放 · 右键拖动平移
          </p>
        </>
      )}
    </div>
  );
}
