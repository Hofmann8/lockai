'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Download, ExternalLink, Loader2, X } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileKey, formatLabel, type DocGroup } from '@/lib/chat/artifacts';
import { MenuItem, MenuLabel, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { downloadFile, fileKind, humanSize, KindIcon, kindTint, openInNewTab, PreviewBody, PreviewFallback } from './FilePreview';
import type { PdfInfo } from './PdfViewer';

/* ------------------------------------------------------------------ */
/* 打开文档的入口：对话里的文件卡片通过它打开侧边面板 */
/* ------------------------------------------------------------------ */

interface ArtifactsContextValue {
  /** 在侧边面板打开（窄屏上是全屏查看） */
  openDoc: (group: DocGroup, format?: FileArtifact) => void;
  /** 面板里正在看的那份文档 */
  activeKey: string | null;
}

const ArtifactsContext = createContext<ArtifactsContextValue | null>(null);

export function ArtifactsProvider({ value, children }: { value: ArtifactsContextValue; children: ReactNode }) {
  return <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>;
}

export function useArtifacts() {
  return useContext(ArtifactsContext);
}

/* ------------------------------------------------------------------ */
/* 文档视图：标题栏（切换文档 / 格式、下载、新标签页）+ 预览 */
/* ------------------------------------------------------------------ */

function HeaderButton({ label, onClick, children, busy }: { label: string; onClick: () => void; children: ReactNode; busy?: boolean }) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
      </button>
    </Tooltip>
  );
}

interface DocViewProps {
  group: DocGroup;
  /** 当前看的格式（受控）；不传就是组里的主格式 */
  file: FileArtifact;
  onFileChange: (file: FileArtifact) => void;
  /** 对话里的其他文档，可以在标题上切换 */
  docs?: DocGroup[];
  onSelectDoc?: (group: DocGroup) => void;
  onClose: () => void;
}

export function DocView({ group, file, onFileChange, docs = [], onSelectDoc, onClose }: DocViewProps) {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [downloads, setDownloads] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const others = docs.filter((d) => d.key !== group.key);
  const failed = !file.url || Boolean(file.error);

  useEffect(() => { setInfo(null); }, [file.url]);

  const meta = [
    formatLabel(file),
    info ? `${info.pages} 页` : null,
    humanSize(file.size),
  ].filter(Boolean).join(' · ');

  const download = async (target: FileArtifact) => {
    if (!target.url) return;
    setBusy(true);
    await downloadFile(target.url, target.name);
    setBusy(false);
  };

  const canOpenTab = fileKind(file) === 'pdf' || fileKind(file) === 'html' || Boolean(file.preview);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', kindTint(file))}>
          <KindIcon file={file} />
        </span>
        <div className="min-w-0 flex-1">
          <button
            ref={titleRef}
            type="button"
            disabled={others.length === 0}
            onClick={() => setSwitcher((v) => !v)}
            className={cn(
              'flex max-w-full items-center gap-1 rounded-md text-left text-[13.5px] font-medium text-fg',
              others.length > 0 && 'hover:text-fg-soft',
            )}
          >
            <span className="truncate">{group.title}</span>
            {others.length > 0 && <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform', switcher && 'rotate-180')} />}
          </button>
          <p className="truncate text-[11.5px] text-fg-faint">{meta}</p>
          <Popover open={switcher} onOpenChange={setSwitcher} anchor={titleRef} placement="bottom-start" className="w-72">
            <MenuLabel>这段对话里的文件</MenuLabel>
            {docs.map((d) => (
              <MenuItem
                key={d.key}
                active={d.key === group.key}
                icon={<KindIcon file={d.primary} className="h-4 w-4" />}
                label={<span className="block truncate">{d.title}</span>}
                description={d.files.map(formatLabel).join(' · ')}
                hint={d.key === group.key ? <Check className="h-3.5 w-3.5" /> : undefined}
                onSelect={() => {
                  setSwitcher(false);
                  onSelectDoc?.(d);
                }}
              />
            ))}
          </Popover>
        </div>

        {group.files.length > 1 && (
          <div className="flex shrink-0 gap-0.5 rounded-xl bg-surface-2 p-0.5" role="tablist" aria-label="格式">
            {group.files.map((f) => (
              <button
                key={fileKey(f)}
                type="button"
                role="tab"
                aria-selected={fileKey(f) === fileKey(file)}
                onClick={() => onFileChange(f)}
                className={cn(
                  'h-7 rounded-[10px] px-2.5 text-[12.5px] transition-colors',
                  fileKey(f) === fileKey(file) ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint hover:text-fg',
                )}
              >
                {formatLabel(f)}
              </button>
            ))}
          </div>
        )}

        <div className="flex shrink-0 items-center">
          {group.files.length > 1 ? (
            <>
              <Tooltip label="下载" side="bottom" disabled={downloads}>
                <button
                  ref={downloadRef}
                  type="button"
                  aria-label="下载"
                  onClick={() => setDownloads((v) => !v)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg',
                    downloads && 'bg-surface-2 text-fg',
                  )}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </button>
              </Tooltip>
              <Popover open={downloads} onOpenChange={setDownloads} anchor={downloadRef} placement="bottom-end" className="w-56">
                {group.files.map((f) => (
                  <MenuItem
                    key={fileKey(f)}
                    icon={<KindIcon file={f} className="h-4 w-4" />}
                    label={`${formatLabel(f)} 文件`}
                    description={[f.name, humanSize(f.size)].filter(Boolean).join(' · ')}
                    onSelect={() => {
                      setDownloads(false);
                      void download(f);
                    }}
                  />
                ))}
              </Popover>
            </>
          ) : (
            !failed && (
              <HeaderButton label="下载" onClick={() => void download(file)} busy={busy}>
                <Download className="h-4 w-4" />
              </HeaderButton>
            )
          )}
          {canOpenTab && !failed && (
            <HeaderButton label="在新标签页打开" onClick={() => void openInNewTab(file)}>
              <ExternalLink className="h-4 w-4" />
            </HeaderButton>
          )}
          <HeaderButton label="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </HeaderButton>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {failed ? <PreviewFallback file={file} note={`没有交付成功：${file.error ?? '未知原因'}`} /> : <PreviewBody key={fileKey(file)} file={file} onInfo={setInfo} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 侧边面板：宽度可拖，记住上次的宽度 */
/* ------------------------------------------------------------------ */

const WIDTH_KEY = 'lockai_panel_width';
const MIN_WIDTH = 380;
/** 给对话区至少留这么宽 */
const MIN_CHAT = 420;

function defaultWidth() {
  if (typeof window === 'undefined') return 640;
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  const fallback = Math.round(window.innerWidth * 0.46);
  return clampWidth(stored > 0 ? stored : fallback);
}

function clampWidth(width: number) {
  if (typeof window === 'undefined') return width;
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth - MIN_CHAT - 64)));
}

interface ArtifactPanelProps extends Omit<DocViewProps, 'onClose'> {
  onClose: () => void;
}

const SLIDE_MS = 320;

export function ArtifactPanel({ onClose, ...props }: ArtifactPanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  // 打开时宽度从 0 展开、关闭时收回；里面的内容始终按最终宽度排，不跟着挤
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const close = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    setShown(false);
    window.setTimeout(onClose, SLIDE_MS);
  };

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(clampWidth(startW + (startX - ev.clientX)));
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside
      className={cn(
        'relative h-dvh shrink-0 overflow-hidden border-l bg-bg',
        shown ? 'border-line' : 'border-transparent',
        !dragging && 'transition-[width,border-color] duration-300 ease-out',
      )}
      style={{ width: shown ? width : 0 }}
      aria-label="文件预览"
    >
      {/* 拖动改宽度；拖的时候盖一层，免得 iframe / 画布吞掉指针事件 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整宽度"
        onPointerDown={startDrag}
        onDoubleClick={() => {
          const w = clampWidth(Math.round(window.innerWidth * 0.46));
          setWidth(w);
          localStorage.setItem(WIDTH_KEY, String(w));
        }}
        className="group/resize absolute left-0 top-0 z-20 flex h-full w-2 cursor-col-resize justify-start"
      >
        <span className={cn('h-full w-px transition-colors', dragging ? 'bg-accent' : 'bg-transparent group-hover/resize:bg-line-strong')} />
      </div>
      {dragging && <div className="fixed inset-0 z-10 cursor-col-resize" />}
      <div className={cn('h-full transition-opacity duration-300', shown ? 'opacity-100' : 'opacity-0')} style={{ width }}>
        <DocView {...props} onClose={close} />
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 全屏查看：窄屏、以及用户自己上传的附件 */
/* ------------------------------------------------------------------ */

export function DocModal({ group, initial, onClose }: { group: DocGroup; initial?: FileArtifact; onClose: () => void }) {
  const [file, setFile] = useState<FileArtifact>(initial ?? group.primary);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[260] flex bg-scrim backdrop-blur-sm animate-fade sm:p-6" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden bg-bg shadow-pop animate-lock-in sm:rounded-2xl sm:border sm:border-line"
        onClick={(e) => e.stopPropagation()}
      >
        <DocView group={group} file={file} onFileChange={setFile} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
