'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { Grid2x2, Maximize, Minus, Plus } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { BarButton, BarSegmented, Dot, humanSize, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';
import { CodeView } from './CodeView';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

/** TIFF 浏览器（除了 Safari）不认，先在本地解码成 PNG */
function useDecodedSource(file: FileArtifact) {
  const ext = fileExt(file.name);
  const needsDecode = ext === 'tif' || ext === 'tiff';
  const [src, setSrc] = useState<string | null>(needsDecode ? null : file.url ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!needsDecode || !file.url) return;
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      const [{ default: UTIF }, buffer] = await Promise.all([
        import('utif'),
        fetch(file.url!, { mode: 'cors' }).then((r) => r.arrayBuffer()),
      ]);
      const ifds = UTIF.decode(buffer);
      UTIF.decodeImage(buffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      const canvas = document.createElement('canvas');
      canvas.width = ifds[0].width;
      canvas.height = ifds[0].height;
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (cancelled || !blob) return;
      revoked = URL.createObjectURL(blob);
      setSrc(revoked);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [file.url, needsDecode]);
  return { src, failed };
}

/** 图片：滚轮 / 双指缩放、拖动平移、双击在"适应窗口"和"原始大小"之间切换；透明图可以开棋盘格底 */
export default function ImageView({ file }: { file: FileArtifact }) {
  const ext = fileExt(file.name);
  const isSvg = ext === 'svg';
  const [mode, setMode] = useState<'view' | 'source'>('view');
  const { src, failed } = useDecodedSource(file);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null); // null = 适应窗口
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [checker, setChecker] = useState(false);
  const [broken, setBroken] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scale = zoom ?? fit;

  const measureFit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const pad = 48;
    setFit(Math.min(1, (stage.clientWidth - pad) / natural.w, (stage.clientHeight - pad) / natural.h));
  }, [natural]);

  useEffect(() => {
    measureFit();
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(measureFit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [measureFit]);

  const zoomTo = (next: number | null, origin?: { x: number; y: number }) => {
    if (next === null) {
      setZoom(null);
      setPan({ x: 0, y: 0 });
      return;
    }
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    // 以指针为中心缩放：指针下面那个像素保持不动
    if (origin) {
      const ratio = clamped / scale;
      setPan((p) => ({ x: origin.x - (origin.x - p.x) * ratio, y: origin.y - (origin.y - p.y) * ratio }));
    }
    setZoom(clamped);
  };

  const onWheel = (e: WheelEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const origin = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), origin);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const source = useFetched(isSvg && mode === 'source' ? file.url : undefined, 'text');

  if (failed || broken) {
    return (
      <PreviewFallback
        file={file}
        note={ext === 'heic' || ext === 'heif' ? 'HEIC 照片只有 Safari 能直接显示，下载后在相册或预览里打开' : '图片没能显示出来，可以下载后查看'}
      />
    );
  }

  const toggle = isSvg ? (
    <BarSegmented value={mode} onChange={setMode} options={[{ value: 'view', label: '图片' }, { value: 'source', label: '源码' }]} />
  ) : null;

  if (mode === 'source') {
    return source.text === undefined ? <Opening /> : <CodeView code={source.text} language="markup" label="SVG" size={file.size} truncated={source.truncated} actions={toggle} />;
  }

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <>
            {toggle}
            <>
                <BarButton label="透明底棋盘格" active={checker} onClick={() => setChecker((v) => !v)}>
                  <Grid2x2 className="h-3.5 w-3.5" />
                </BarButton>
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                <BarButton label="缩小" onClick={() => zoomTo(scale / 1.25)}>
                  <Minus className="h-3.5 w-3.5" />
                </BarButton>
                <button
                  type="button"
                  onClick={() => zoomTo(zoom === null ? 1 : null)}
                  title={zoom === null ? '原始大小' : '适应窗口'}
                  className="h-7 min-w-12 rounded-lg px-1 text-[12px] tabular-nums text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  {Math.round(scale * 100)}%
                </button>
                <BarButton label="放大" onClick={() => zoomTo(scale * 1.25)}>
                  <Plus className="h-3.5 w-3.5" />
                </BarButton>
                <BarButton label="适应窗口" active={zoom === null} onClick={() => zoomTo(null)}>
                  <Maximize className="h-3.5 w-3.5" />
                </BarButton>
                <BarButton label="原始大小" active={zoom === 1} onClick={() => zoomTo(1)}>
                  <span className="text-[11px] font-semibold tabular-nums">1:1</span>
                </BarButton>
            </>
          </>
        }
      >
        <span className="font-medium text-fg-soft">{ext.toUpperCase() || '图片'}</span>
        {natural && (<><Dot /><span className="tabular-nums">{natural.w} × {natural.h}</span></>)}
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
      </ViewerBar>

        <div
          ref={stageRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            zoomTo(zoom === null ? Math.max(1, fit * 2) : null, { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 });
          }}
          className={cn(
            'relative min-h-0 flex-1 touch-none select-none overflow-hidden',
            checker
              ? 'bg-[repeating-conic-gradient(var(--surface-2)_0%_25%,var(--surface)_0%_50%)] bg-size-[18px_18px]'
              : 'bg-sunken',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
        >
          {!natural && src && <div className="absolute inset-0"><Opening /></div>}
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={file.name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
              onError={() => setBroken(true)}
              style={{
                width: natural ? natural.w : undefined,
                height: natural ? natural.h : undefined,
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                imageRendering: scale >= 3 ? 'pixelated' : 'auto',
              }}
              className={cn(
                'absolute left-1/2 top-1/2 max-w-none origin-center rounded-xs shadow-pop',
                !natural && 'opacity-0',
                !dragging && 'transition-transform duration-150 ease-out',
              )}
            />
          )}
        </div>
    </div>
  );
}
