import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Grid2x2, Maximize, Minus, MonitorPlay, Plus, Search } from 'lucide-react';
import { cn, Dot, PanelHeader, Segmented, ViewerBar, type Kind } from './kit';

/*
 * 文件面板里的几种阅读器：结构和 className 取自 lockai/src/components/chat/preview 与 PdfViewer。
 * 内容由外面按帧给（滚动位置、单元格高亮、表单填写进度）。
 */

export const PANEL_W = 760;
export const PANEL_BODY_H = 960 - 56;

/** 面板外壳：头部 + 主体 */
export function Panel({ kind, title, meta, tabs, active, children }: {
  kind: Kind; title: string; meta: string; tabs?: string[]; active?: string; children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PanelHeader kind={kind} title={title} meta={meta} tabs={tabs} active={active} />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

const BarBtn = ({ children, active }: { children: ReactNode; active?: boolean }) => (
  <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', active ? 'bg-surface-2 text-fg' : 'text-fg-soft')}>{children}</span>
);

/** 图片：适应窗口，四周留 24px */
export function ImageViewer({ w, h, label, size, children, hide }: { w: number; h: number; label: string; size: string; children: ReactNode; hide?: boolean }) {
  const stageW = PANEL_W;
  const stageH = PANEL_BODY_H - 40;
  const fit = Math.min(1, (stageW - 48) / w, (stageH - 48) / h);
  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <>
            <BarBtn><Grid2x2 className="h-3.5 w-3.5" /></BarBtn>
            <span className="mx-1 h-4 w-px bg-line" />
            <BarBtn><Minus className="h-3.5 w-3.5" /></BarBtn>
            <span className="flex h-7 min-w-12 items-center justify-center rounded-lg px-1 text-[12px] tabular-nums text-fg-soft">{Math.round(fit * 100)}%</span>
            <BarBtn><Plus className="h-3.5 w-3.5" /></BarBtn>
            <BarBtn active><Maximize className="h-3.5 w-3.5" /></BarBtn>
            <BarBtn><span className="text-[11px] font-semibold tabular-nums">1:1</span></BarBtn>
          </>
        }
      >
        <span className="font-medium text-fg-soft">{label}</span>
        <Dot />
        <span className="tabular-nums">{w} × {h}</span>
        <Dot />
        <span>{size}</span>
      </ViewerBar>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-sunken">
        <div
          style={{
            position: 'absolute', left: '50%', top: '50%', width: w, height: h, transform: `translate(-50%, -50%) scale(${fit})`,
            boxShadow: '0 1px 2px oklch(0 0 0 / 0.08), 0 8px 30px -8px oklch(0.2 0.01 60 / 0.25)', opacity: hide ? 0 : 1,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
/** 图片在面板主体里的位置（面板坐标，给镜头和"弹出来"的图层用） */
export function imageFit(w: number, h: number) {
  const stageH = PANEL_BODY_H - 40;
  const fit = Math.min(1, (PANEL_W - 48) / w, (stageH - 48) / h);
  return { fit, cx: PANEL_W / 2, cy: 56 + 40 + stageH / 2 };
}

/** PDF / PPT：页面竖排，底部悬浮页码条 */
export const PAGE_W = PANEL_W - 40;
export function PdfPages({ pages, pageW = 1600, pageH = 900, scroll, current, total, zoom = 100 }: {
  pages: ReactNode[]; pageW?: number; pageH?: number; scroll: number; current: number; total: number; zoom?: number;
}) {
  const s = PAGE_W / pageW;
  return (
    <div className="group/pdf relative flex h-full min-h-0 flex-col bg-sunken">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-fit flex-col items-center px-5 pb-20 pt-5" style={{ gap: 16, transform: `translateY(${-scroll}px)` }}>
          {pages.map((p, i) => (
            <div
              key={i}
              className="relative mx-auto overflow-hidden rounded-[3px] bg-white shadow-[0_0_0_1px_oklch(0_0_0/0.06),0_2px_12px_-2px_oklch(0.2_0.01_60/0.18)]"
              style={{ width: PAGE_W, height: pageH * s }}
            >
              <div style={{ width: pageW, height: pageH, transform: `scale(${s})`, transformOrigin: '0 0' }}>{p}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface/90 px-1.5 py-1 shadow-float">
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-fg-soft"><ChevronLeft className="h-4 w-4" /></span>
          <span className="flex items-center gap-1 px-1 text-[12.5px] tabular-nums text-fg-soft">
            <span className="flex h-6 w-8 items-center justify-center rounded-md text-fg">{current}</span>
            <span className="text-fg-faint">/ {total}</span>
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-fg-soft"><ChevronRight className="h-4 w-4" /></span>
          <span className="mx-1 h-4 w-px bg-line" />
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-fg-soft"><Minus className="h-4 w-4" /></span>
          <span className="flex h-7 min-w-12 items-center justify-center rounded-full px-1.5 text-[12px] tabular-nums text-fg-soft">{zoom}%</span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-fg-soft"><Plus className="h-4 w-4" /></span>
          <span className="mx-1 h-4 w-px bg-line" />
          <span className="flex h-7 w-7 items-center justify-center rounded-full text-fg-soft"><MonitorPlay className="h-4 w-4" /></span>
        </div>
      </div>
    </div>
  );
}
/** 第 k 页顶部在滚动容器里的 y（面板主体坐标） */
export const pageTop = (k: number, pageW = 1600, pageH = 900) => 20 + k * (pageH * (PAGE_W / pageW) + 16);

/** 表格（xlsx）：列头是字母，第一行是表头；数字列右对齐 */
export interface GridCellStyle { row: number; col: number; style: CSSProperties }
export function SheetGrid({ rows, numeric, total, sheet, sheets, rowIn, cellStyle, scroll = 0, cols }: {
  rows: string[][]; numeric: boolean[]; total: number; sheet: string; sheets: string[];
  rowIn?: (i: number) => number; cellStyle?: (r: number, c: number) => CSSProperties | undefined; scroll?: number; cols: number;
}) {
  const letters = 'ABCDEFGH'.split('').slice(0, cols);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      <ViewerBar actions={<BarBtn><Search className="h-3.5 w-3.5" /></BarBtn>}>
        <span className="font-medium text-fg-soft">{sheet}</span>
        <Dot />
        <span className="tabular-nums">{total} 行 × {cols} 列</span>
      </ViewerBar>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <table className="border-separate border-spacing-0 text-[12.5px]" style={{ transform: `translateY(${-scroll}px)` }}>
          <thead>
            <tr>
              <th className="min-w-10 border-b border-r border-line bg-surface-2 px-2 py-1.5" />
              {letters.map((l) => (
                <th key={l} className="border-b border-r border-line bg-surface-2 px-3 py-1.5 text-center font-normal whitespace-nowrap text-fg-faint">{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p = rowIn ? rowIn(i) : 1;
              return (
                <tr key={i} style={{ opacity: p, transform: `translateY(${(1 - p) * 8}px)` }}>
                  <td className="border-b border-r border-line bg-surface-2 px-2 py-1 text-right text-[11px] tabular-nums text-fg-faint">{i + 1}</td>
                  {Array.from({ length: cols }, (_, j) => (
                    <td
                      key={j}
                      className={cn('max-w-[22rem] truncate border-b border-r border-line px-3 py-1 whitespace-nowrap text-fg', numeric[j] && i > 0 && 'text-right tabular-nums', i === 0 && 'font-medium')}
                      style={{ minWidth: j === 0 ? 150 : 96, ...cellStyle?.(i, j) }}
                    >
                      {r[j] ?? ''}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-surface-2 px-2 py-1.5">
        {sheets.map((name) => (
          <span key={name} className={cn('shrink-0 rounded-lg px-3 py-1 text-[12.5px]', name === sheet ? 'bg-surface text-fg shadow-soft' : 'text-fg-soft')}>{name}</span>
        ))}
      </div>
    </div>
  );
}

/** 网页：手机预览 */
export function HtmlPhone({ children, size }: { children: ReactNode; size: string }) {
  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <>
            <Segmented options={['桌面', '手机']} active="手机" />
            <Segmented options={['预览', '源码']} active="预览" />
          </>
        }
      >
        <span className="font-medium text-fg-soft">网页</span>
        <Dot />
        <span>{size}</span>
      </ViewerBar>
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-sunken py-5">
        <div className="shrink-0 overflow-hidden rounded-[28px] bg-white shadow-pop ring-8 ring-ink/90" style={{ width: 390, height: 760 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
