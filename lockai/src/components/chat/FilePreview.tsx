'use client';

import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Markdown } from './Markdown';
import { PdfViewer, type PdfInfo } from './PdfViewer';
import { codeLanguage, fileKind, SHEET_EXT } from './preview/kinds';
import { KindIcon, kindTint } from './preview/icons';
import {
  BarSegmented,
  DataGrid,
  Dot,
  downloadFile,
  humanSize,
  kindLabel,
  Opening,
  PreviewFallback,
  useFetched,
  ViewerBar,
} from './preview/shared';
import { CodeView } from './preview/CodeView';

export { fileExt, fileKind, KindIcon, kindTint, humanSize, kindLabel, downloadFile, PreviewFallback };
export type { FileKind } from './preview/kinds';

/* ------------------------------------------------------------------ */
/* 各类阅读器按需加载：3D、数据库、压缩包这些库都不小，不进主包 */
/* ------------------------------------------------------------------ */

type Viewer = ComponentType<{ file: FileArtifact }>;
const ModelView = lazy(() => import('./preview/ModelView'));
const ImageView = lazy(() => import('./preview/ImageView'));
const AudioView = lazy(() => import('./preview/AudioView'));
const NotebookView = lazy(() => import('./preview/NotebookView'));
const ArchiveView = lazy(() => import('./preview/ArchiveView'));
const FontView = lazy(() => import('./preview/FontView'));
const SqliteView = lazy(() => import('./preview/SqliteView'));
const ParquetView = lazy(() => import('./preview/ParquetView'));
const CalendarView = lazy(() => import('./preview/CalendarView'));
const SubtitleView = lazy(() => import('./preview/SubtitleView'));
const EpubView = lazy(() => import('./preview/EpubView'));
const OutlineView = lazy(() => import('./preview/OutlineView'));
const SniffView = lazy(() => import('./preview/SniffView'));

/** 在新标签页里打开：OSS 默认域名会强制下载 pdf / html，所以先取回来转成本地地址再开 */
export async function openInNewTab(file: FileArtifact) {
  const target = file.preview && fileKind(file) === 'office' ? file.preview : file.url;
  if (!target) return;
  const tab = window.open('', '_blank');
  try {
    const res = await fetch(target, { mode: 'cors' });
    const blob = await res.blob();
    const type = target === file.preview || fileKind(file) === 'pdf' ? 'application/pdf'
      : fileKind(file) === 'html' ? 'text/html;charset=utf-8' : blob.type;
    const url = URL.createObjectURL(new Blob([blob], { type }));
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    if (tab) tab.location.href = target;
  }
}

/* ------------------------------------------------------------------ */
/* 表格 / Word（原来就有的两种） */
/* ------------------------------------------------------------------ */

const CSV_PREVIEW_ROWS = 2000;
const SHEET_PREVIEW_ROWS = 1000;
const SHEET_PREVIEW_COLS = 80;

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > CSV_PREVIEW_ROWS) return rows;
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function CsvPreview({ file, text, truncated }: { file: FileArtifact; text: string; truncated?: boolean }) {
  const ext = fileExt(file.name);
  // 分隔符：tsv 用制表符；csv 里分号更多（欧洲 Excel 导出）就用分号
  const newline = text.indexOf('\n');
  const firstLine = text.slice(0, newline < 0 ? 2000 : newline);
  const delimiter = ext === 'tsv' ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows = parseCsv(text.replace(/^﻿/, ''), delimiter);
  const [head, ...body] = rows;
  return (
    <DataGrid
      columns={head}
      rows={body.slice(0, CSV_PREVIEW_ROWS)}
      total={truncated || body.length > CSV_PREVIEW_ROWS ? undefined : body.length}
      meta={<span className="font-medium text-fg-soft">{ext.toUpperCase()}</span>}
    />
  );
}

/** 表格：浏览器里直接解析原文件，多个工作表可以切换 */
function SheetPreview({ file }: { file: FileArtifact }) {
  const { buffer, error } = useFetched(file.url, 'buffer');
  const [book, setBook] = useState<{ names: string[]; sheets: Record<string, { rows: string[][]; total: number }> } | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    import('xlsx')
      .then((XLSX) => {
        const wb = XLSX.read(buffer, { type: 'array', sheetRows: SHEET_PREVIEW_ROWS + 1 });
        const sheets: Record<string, { rows: string[][]; total: number }> = {};
        for (const name of wb.SheetNames) {
          const sheet = wb.Sheets[name];
          const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
          const range = sheet['!fullref'] ?? sheet['!ref'];
          const total = range ? XLSX.utils.decode_range(range).e.r + 1 : rows.length;
          sheets[name] = { rows: rows.map((r) => r.slice(0, SHEET_PREVIEW_COLS).map((c) => String(c ?? ''))), total };
        }
        if (!cancelled) setBook({ names: wb.SheetNames, sheets });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [buffer]);

  if (error || failed) return <PreviewFallback file={file} note="表格没能解析出来，可以下载后打开" />;
  if (!book) return <Opening />;
  const sheet = book.sheets[book.names[active]] ?? { rows: [], total: 0 };
  return (
    <DataGrid
      key={active}
      rows={sheet.rows.slice(0, SHEET_PREVIEW_ROWS)}
      total={sheet.total}
      meta={<span className="font-medium text-fg-soft">{book.names[active]}</span>}
      footer={book.names.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-line bg-surface-2 px-2 py-1.5">
          {book.names.map((name, i) => (
            <button
              key={name}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                'shrink-0 rounded-lg px-3 py-1 text-[12.5px] transition-colors',
                i === active ? 'bg-surface text-fg shadow-soft' : 'text-fg-soft hover:text-fg',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    />
  );
}

/** Word（用户上传的，没有现成 PDF）：浏览器里直接排版 */
function DocxPreview({ file }: { file: FileArtifact }) {
  const { buffer, error } = useFetched(file.url, 'buffer');
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');

  useEffect(() => {
    if (!buffer || !ref.current) return;
    let cancelled = false;
    const container = ref.current;
    import('docx-preview')
      .then(({ renderAsync }) => renderAsync(buffer, container, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true }))
      .then(() => { if (!cancelled) setState('done'); })
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [buffer]);

  if (error || state === 'failed') return <PreviewFallback file={file} note="文档没能解析出来，可以下载后打开" />;
  return (
    <div className="relative h-full overflow-auto bg-sunken">
      {state === 'loading' && <div className="absolute inset-0"><Opening /></div>}
      <div
        ref={ref}
        className="[&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-5 [&_.docx-wrapper>section.docx]:mb-4 [&_.docx-wrapper>section.docx]:rounded-[3px] [&_.docx-wrapper>section.docx]:shadow-[0_0_0_1px_oklch(0_0_0/0.06),0_2px_12px_-2px_oklch(0.2_0.01_60/0.18)]"
      />
    </div>
  );
}

/** Office：模型做的 Word / PPT 有沙箱里转好的 PDF；表格和用户上传的 Word 在浏览器里解析；其余列出文字大纲。不经过任何第三方 */
function OfficePreview({ file, onInfo }: { file: FileArtifact; onInfo?: (info: PdfInfo) => void }) {
  const ext = fileExt(file.name);
  if (file.preview) return <PdfViewer url={file.preview} onInfo={onInfo} />;
  if (SHEET_EXT.has(ext)) return <SheetPreview file={file} />;
  if (ext === 'docx') return <DocxPreview file={file} />;
  if (ext === 'pptx' || ext === 'odp' || ext === 'odt' || ext === 'rtf') return <OutlineView file={file} />;
  return <PreviewFallback file={file} note={`旧版 ${ext.toUpperCase()} 格式没法在网页里预览，下载后用 Office / WPS 打开；需要的话可以让我转成新格式`} />;
}

/* ------------------------------------------------------------------ */
/* 网页 / Markdown：预览和源码可以切换 */
/* ------------------------------------------------------------------ */

function HtmlPreview({ file, text, truncated }: { file: FileArtifact; text: string; truncated?: boolean }) {
  const [mode, setMode] = useState<'view' | 'source'>('view');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const toggle = <BarSegmented value={mode} onChange={setMode} options={[{ value: 'view', label: '预览' }, { value: 'source', label: '源码' }]} />;
  if (mode === 'source') return <CodeView code={text} language="markup" label="HTML" size={file.size} truncated={truncated} actions={toggle} />;
  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <>
            <BarSegmented value={device} onChange={setDevice} options={[{ value: 'desktop', label: '桌面' }, { value: 'mobile', label: '手机' }]} />
            {toggle}
          </>
        }
      >
        <span className="font-medium text-fg-soft">网页</span>
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
      </ViewerBar>
      <div className={cn('min-h-0 flex-1', device === 'mobile' && 'flex justify-center overflow-auto bg-sunken py-5')}>
        <iframe
          srcDoc={text}
          title={file.name}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className={cn(
            'bg-white transition-[width] duration-300',
            device === 'mobile' ? 'h-190 max-h-full w-97.5 shrink-0 rounded-[28px] shadow-pop ring-8 ring-ink/90' : 'h-full w-full',
          )}
        />
      </div>
    </div>
  );
}

function MarkdownPreview({ file, text, truncated }: { file: FileArtifact; text: string; truncated?: boolean }) {
  const [mode, setMode] = useState<'view' | 'source'>('view');
  const toggle = <BarSegmented value={mode} onChange={setMode} options={[{ value: 'view', label: '排版' }, { value: 'source', label: '源码' }]} />;
  if (mode === 'source') return <CodeView code={text} language="markdown" label="Markdown" size={file.size} truncated={truncated} actions={toggle} />;
  const words = text.replace(/\s+/g, '').length;
  return (
    <div className="flex h-full flex-col">
      <ViewerBar actions={toggle}>
        <span className="font-medium text-fg-soft">Markdown</span>
        <Dot />
        <span className="tabular-nums">约 {words.toLocaleString('zh-CN')} 字</span>
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-sunken px-5 py-5">
        <article className="mx-auto max-w-180 rounded-[3px] bg-surface px-10 py-9 shadow-[0_0_0_1px_oklch(0_0_0/0.05),0_2px_12px_-2px_oklch(0.2_0.01_60/0.14)]">
          <Markdown content={text} />
          {truncated && <p className="mt-4 text-xs text-fg-faint">文件较大，只显示了开头一部分</p>}
        </article>
      </div>
    </div>
  );
}

function VideoPreview({ file }: { file: FileArtifact }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PreviewFallback file={file} note={`浏览器放不了这种视频（${fileExt(file.name).toUpperCase()}），下载后用播放器打开；也可以让我转成 MP4`} />;
  return (
    <div className="flex h-full items-center justify-center bg-black">
      <video src={file.url} controls autoPlay playsInline onError={() => setFailed(true)} className="max-h-full max-w-full" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 入口 */
/* ------------------------------------------------------------------ */

const LAZY: Partial<Record<ReturnType<typeof fileKind>, Viewer>> = {
  image: ImageView,
  audio: AudioView,
  model: ModelView,
  notebook: NotebookView,
  archive: ArchiveView,
  font: FontView,
  sqlite: SqliteView,
  parquet: ParquetView,
  calendar: CalendarView,
  subtitle: SubtitleView,
  epub: EpubView,
  other: SniffView,
};

export function PreviewBody({ file, onInfo }: { file: FileArtifact; onInfo?: (info: PdfInfo) => void }) {
  const kind = fileKind(file);
  const fetchAs = kind === 'html' || kind === 'markdown' || kind === 'csv' || kind === 'text' ? 'text' : null;
  const { text, truncated, error } = useFetched(file.url, fetchAs, kind === 'csv' ? 4 * 1024 * 1024 : undefined);

  if (error) return <PreviewFallback file={file} note="文件没能加载出来，可以直接下载" />;
  if (fetchAs && text === undefined) return <Opening />;

  const Lazy = LAZY[kind];
  if (Lazy) {
    return (
      <Suspense fallback={<Opening />}>
        <Lazy file={file} />
      </Suspense>
    );
  }

  switch (kind) {
    case 'pdf':
      return <PdfViewer url={file.url!} onInfo={onInfo} />;
    case 'video':
      return <VideoPreview file={file} />;
    case 'html':
      return <HtmlPreview file={file} text={text ?? ''} truncated={truncated} />;
    case 'markdown':
      return <MarkdownPreview file={file} text={text ?? ''} truncated={truncated} />;
    case 'csv':
      return <CsvPreview file={file} text={text ?? ''} truncated={truncated} />;
    case 'text':
      return <CodeView code={text ?? ''} language={codeLanguage(file.name)} size={file.size} truncated={truncated} />;
    case 'office':
      return (
        <Suspense fallback={<Opening />}>
          <OfficePreview file={file} onInfo={onInfo} />
        </Suspense>
      );
    default:
      return <PreviewFallback file={file} note="这类文件没法在网页里预览，下载后打开" />;
  }
}
