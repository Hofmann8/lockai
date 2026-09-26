'use client';

import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, Search, X } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Tooltip } from '@/components/ui/Tooltip';
import { KindIcon, kindTint } from './icons';

/* ------------------------------------------------------------------ */
/* 工具函数 */
/* ------------------------------------------------------------------ */

export function humanSize(size: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function kindLabel(file: FileArtifact): string {
  const ext = fileExt(file.name);
  return [ext ? ext.toUpperCase() : '文件', humanSize(file.size)].filter(Boolean).join(' · ');
}

export async function downloadFile(url: string, name: string) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

export const formatCount = (n: number) => n.toLocaleString('zh-CN');

/* ------------------------------------------------------------------ */
/* 取文件 */
/* ------------------------------------------------------------------ */

export const TEXT_PREVIEW_LIMIT = 512 * 1024;

export interface Fetched {
  text?: string;
  buffer?: ArrayBuffer;
  truncated?: boolean;
  error?: boolean;
}

/**
 * 按需把文件拉下来：text 读成字符串（太大只读开头）、buffer 读成 ArrayBuffer、
 * head 只读开头 limit 字节（嗅探类型用，读够了就断开）
 */
export function useFetched(url: string | undefined, as: 'text' | 'buffer' | 'head' | null, limit = TEXT_PREVIEW_LIMIT): Fetched {
  const [state, setState] = useState<Fetched>({});
  useEffect(() => {
    if (!url || !as) return;
    let cancelled = false;
    const controller = new AbortController();
    setState({});
    (async () => {
      const res = await fetch(url, { mode: 'cors', signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      if (as === 'buffer') {
        const buffer = await res.arrayBuffer();
        if (!cancelled) setState({ buffer });
        return;
      }
      // 边读边数，够了就停，大文件不必整个下下来
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total > limit) {
          truncated = true;
          void reader.cancel();
          break;
        }
      }
      const bytes = new Uint8Array(Math.min(total, limit));
      let offset = 0;
      for (const chunk of chunks) {
        const room = bytes.length - offset;
        if (room <= 0) break;
        bytes.set(chunk.subarray(0, room), offset);
        offset += Math.min(room, chunk.byteLength);
      }
      if (cancelled) return;
      if (as === 'head') setState({ buffer: bytes.buffer, truncated });
      else setState({ text: new TextDecoder('utf-8').decode(bytes), truncated });
    })().catch(() => { if (!cancelled) setState({ error: true }); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, as, limit]);
  return state;
}

/* ------------------------------------------------------------------ */
/* 阅读器外观 */
/* ------------------------------------------------------------------ */

export function Opening({ label }: { label?: string }) {
  return (
    <div className="flex h-full flex-col gap-3 p-6" aria-label={label ?? '正在打开'}>
      {[72, 96, 88, 60].map((w, i) => (
        <div key={i} className="h-3 animate-pulse rounded-full bg-surface-2" style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }} />
      ))}
      {label && <p className="mt-1 text-[12px] text-fg-faint">{label}</p>}
    </div>
  );
}

/** 阅读器顶上的细工具栏：左边是说明，右边是操作 */
export function ViewerBar({ children, actions, className }: { children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-10 shrink-0 items-center gap-2 border-b border-line bg-bg px-3', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-[12px] text-fg-faint">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function BarButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 text-[12px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-35',
          active && 'bg-surface-2 text-fg',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 两三个选项的切换（预览 / 源码） */
export function BarSegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-lg px-2.5 text-[12px] transition-[background-color,color,box-shadow] duration-150',
            value === o.value ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dot() {
  return <span className="text-line-strong" aria-hidden>·</span>;
}

export function PreviewFallback({ file, note, children }: { file: FileArtifact; note: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-sunken p-6 text-center">
      <span className={cn('flex h-20 w-20 items-center justify-center rounded-3xl', kindTint(file))}>
        <KindIcon file={file} className="h-9 w-9" />
      </span>
      <div>
        <p className="max-w-md break-all text-[15px] font-medium text-fg">{file.name.split('/').pop()}</p>
        <p className="mt-1 text-[13px] text-fg-faint">{kindLabel(file)}</p>
      </div>
      <p className="max-w-sm text-[13px] leading-relaxed text-fg-soft">{note}</p>
      <div className="flex items-center gap-2">
        {children}
        {file.url && (
          <button
            type="button"
            onClick={() => void downloadFile(file.url!, file.name.split('/').pop()!)}
            className="flex h-9 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-medium text-ink-fg transition-opacity hover:opacity-90"
          >
            <Download className="h-4 w-4" /> 下载
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 数据表格：CSV / Excel / SQLite / Parquet 共用 */
/* ------------------------------------------------------------------ */

/** 数字、金额、百分比靠右对齐，和 Excel 里看到的一样 */
const NUMERIC_CELL = /^[-+]?[¥$€£]?\s?\d[\d,]*(\.\d+)?(e[-+]?\d+)?\s?%?$/i;

export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

interface DataGridProps {
  /** 列名；不给就用 A B C（表格文件第一行本身就是数据） */
  columns?: string[];
  /** 列类型（数据库 / Parquet 有） */
  types?: string[];
  rows: string[][];
  /** 实际总行数（只取了前面一部分时） */
  total?: number;
  /** 工具栏左边额外的说明 */
  meta?: ReactNode;
  /** 工具栏右边额外的操作 */
  actions?: ReactNode;
  /** 表格下面（比如 Excel 的工作表切换） */
  footer?: ReactNode;
}

/** 表格阅读器：列头吸顶、行号吸左、数字右对齐、边打边筛选 */
export function DataGrid({ columns, types, rows, total, meta, actions, footer }: DataGridProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const width = Math.max(columns?.length ?? 0, rows.reduce((max, r) => Math.max(max, r.length), 0));
  const visible = useMemo(() => {
    const indexed = rows.map((r, i) => [i, r] as const);
    if (!deferred) return indexed;
    return indexed.filter(([, r]) => r.some((c) => c.toLowerCase().includes(deferred)));
  }, [deferred, rows]);
  const numeric = useMemo(() => {
    // 一列里大部分是数字才靠右，免得编号、电话之类的被当成数字
    return Array.from({ length: width }, (_, j) => {
      let num = 0;
      let seen = 0;
      for (const r of rows.slice(0, 200)) {
        const v = r[j];
        if (!v) continue;
        seen += 1;
        if (NUMERIC_CELL.test(v)) num += 1;
      }
      return seen > 0 && num / seen > 0.8;
    });
  }, [rows, width]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      <ViewerBar
        actions={
          <>
            {searching ? (
              <label className="flex h-7 w-44 items-center gap-1.5 rounded-lg bg-surface-2 px-2 animate-fade">
                <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setSearching(false))}
                  placeholder="筛选行"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint"
                />
                <button type="button" aria-label="清除" onClick={() => { setQuery(''); setSearching(false); }} className="text-fg-faint hover:text-fg">
                  <X className="h-3.5 w-3.5" />
                </button>
              </label>
            ) : (
              <BarButton label="筛选" onClick={() => setSearching(true)}>
                <Search className="h-3.5 w-3.5" />
              </BarButton>
            )}
            {actions}
          </>
        }
      >
        {meta}
        {meta && <Dot />}
        <span className="tabular-nums">
          {deferred ? `${formatCount(visible.length)} / ` : ''}
          {formatCount(total ?? rows.length)} 行 × {width} 列
        </span>
        {total !== undefined && total > rows.length && (
          <>
            <Dot />
            <span>显示前 {formatCount(rows.length)} 行</span>
          </>
        )}
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-[2]">
            <tr>
              <th className="sticky left-0 z-[3] min-w-10 border-b border-r border-line bg-surface-2 px-2 py-1.5" />
              {Array.from({ length: width }, (_, i) => (
                <th
                  key={i}
                  className={cn(
                    'border-b border-r border-line bg-surface-2 px-3 py-1.5 font-medium whitespace-nowrap',
                    columns ? 'text-left text-fg' : 'text-center font-normal text-fg-faint',
                  )}
                >
                  {columns ? columns[i] ?? '' : columnName(i)}
                  {types?.[i] && <span className="ml-1.5 font-mono text-[10.5px] font-normal text-fg-faint">{types[i]}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(([index, r]) => (
              <tr key={index} className="group/row">
                <td className="sticky left-0 z-[1] border-b border-r border-line bg-surface-2 px-2 py-1 text-right text-[11px] tabular-nums text-fg-faint group-hover/row:text-fg-soft">
                  {index + 1}
                </td>
                {Array.from({ length: width }, (_, j) => {
                  const value = r[j] ?? '';
                  return (
                    <td
                      key={j}
                      title={value.length > 40 ? value : undefined}
                      className={cn(
                        'max-w-[22rem] truncate border-b border-r border-line px-3 py-1 whitespace-nowrap text-fg group-hover/row:bg-surface-2/50',
                        numeric[j] && 'text-right tabular-nums',
                        value === 'NULL' && 'text-fg-faint italic',
                      )}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="px-4 py-6 text-center text-[12.5px] text-fg-faint">{deferred ? '没有匹配的行' : '没有数据'}</p>}
      </div>
      {footer}
    </div>
  );
}
