'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppWindow,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Files,
  FolderDown,
  Loader2,
  SquareTerminal,
  X,
} from 'lucide-react';
import type { FileArtifact, ShellToolTrace, TaskToolTrace } from '@/types';
import { cn } from '@/lib/cn';
import { canPreview, fileKey, formatLabel, groupFiles, type DocGroup } from '@/lib/chat/artifacts';
import { MenuItem, Popover } from '@/components/ui/Popover';
import { toast } from '@/components/ui/Toast';
import type { FileKind } from './FilePreview';
import { Collapse } from '@/components/ui/Collapse';
import { useHoldAnchor } from '@/lib/hooks/useScrollAnchor';
import { Seconds, useElapsed } from './ToolCards';
import { downloadFile, fileExt, fileKind, humanSize, KindIcon, kindTint } from './FilePreview';
import { DocModal, useArtifacts } from './ArtifactPanel';
import { compactCount } from './Thinking';

/** 写这一步超过这么久 / 这么多 token 才单独注明，一条短命令不必啰嗦 */
const PREP_NOTE_SECONDS = 5;
const PREP_NOTE_TOKENS = 400;

export { downloadFile, fileKind, humanSize };

/* ------------------------------------------------------------------ */
/* 文件卡片：同名的几种格式合成一张，点开在侧边面板里看 */
/* ------------------------------------------------------------------ */

/** 3D 模型卡片上的小渲染图：卡片进入视口才画，太大的模型不画 */
const MODEL_THUMB_LIMIT = 15 * 1024 * 1024;

function useModelThumb(file: FileArtifact) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const wanted = fileKind(file) === 'model' && Boolean(file.url) && !file.error && (file.size || 0) <= MODEL_THUMB_LIMIT;
  useEffect(() => {
    const el = ref.current;
    if (!wanted || !el) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void import('./preview/model3d')
        .then((m) => m.modelThumbnail(file.url!, fileExt(file.name)))
        .then((data) => { if (!cancelled && data) setSrc(data); });
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [file.name, file.url, wanted]);
  return { ref, src };
}

function FileThumb({ file }: { file: FileArtifact }) {
  const [failed, setFailed] = useState(false);
  const model = useModelThumb(file);
  if (fileKind(file) === 'model') {
    return (
      <span ref={model.ref} className={cn('relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg', model.src ? 'border border-line bg-[radial-gradient(circle_at_50%_40%,var(--surface),var(--surface-2))]' : kindTint(file))}>
        {model.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={model.src} alt="" className="h-full w-full object-contain animate-fade" />
        ) : (
          <KindIcon file={file} className="h-5 w-5" />
        )}
      </span>
    );
  }
  // TIFF / HEIC 浏览器画不出来（面板里另外解码），卡片上直接用图标，不闪一个空白框
  if (fileKind(file) === 'image' && file.url && !failed && !/^(tiff?|heic|heif)$/.test(fileExt(file.name))) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={file.url} alt="" onError={() => setFailed(true)} className="h-10 w-10 shrink-0 rounded-lg border border-line object-cover" />
    );
  }
  return (
    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', kindTint(file))}>
      <KindIcon file={file} className="h-5 w-5" />
    </span>
  );
}

/** 窄屏（或没有面板的地方）用全屏查看，宽屏在侧边面板打开 */
function useOpenDoc() {
  const artifacts = useArtifacts();
  const [modal, setModal] = useState<{ group: DocGroup; file?: FileArtifact } | null>(null);
  const open = (group: DocGroup, file?: FileArtifact) => {
    const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
    if (artifacts && wide && canPreview(file ?? group.primary)) artifacts.openDoc(group, file);
    else setModal({ group, file });
  };
  const node = modal ? <DocModal group={modal.group} initial={modal.file} onClose={() => setModal(null)} /> : null;
  return { open, node, activeKey: artifacts?.activeKey ?? null };
}

export function DocCard({ group }: { group: DocGroup }) {
  const { open, node, activeKey } = useOpenDoc();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const file = group.primary;
  const failed = Boolean(file.error) || !file.url;
  const active = activeKey === group.key;
  const formats = group.files.length > 1;

  const download = async (target: FileArtifact) => {
    if (!target.url) return;
    setBusy(true);
    await downloadFile(target.url, target.name);
    setBusy(false);
  };

  const meta = failed
    ? `没有交付成功：${file.error ?? '未知原因'}`
    : formats
      ? group.files.map(formatLabel).join(' · ')
      : [formatLabel(file), humanSize(file.size)].filter(Boolean).join(' · ');

  return (
    <>
      <div
        role="button"
        tabIndex={failed ? -1 : 0}
        aria-disabled={failed}
        aria-current={active || undefined}
        onClick={() => !failed && open(group)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !failed) {
            e.preventDefault();
            open(group);
          }
        }}
        className={cn(
          'group/file relative flex min-w-0 items-center gap-3 rounded-2xl border bg-surface px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-150',
          failed ? 'cursor-default border-line opacity-70' : 'cursor-pointer hover:border-line-strong hover:shadow-soft',
          active ? 'border-line-strong shadow-soft' : 'border-line',
        )}
      >
        {/* 正在面板里看：左边一道强调色细线 */}
        {active && <span className="absolute inset-y-3 left-0 w-[2px] rounded-full bg-accent animate-fade" aria-hidden />}
        <FileThumb file={file} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words text-[13.5px] leading-snug text-fg" title={formats ? group.title : file.name}>{formats ? group.title : file.name}</span>
          <span className={cn('mt-0.5 block truncate text-[11.5px]', failed ? 'text-danger' : 'text-fg-faint')}>{meta}</span>
        </span>
        {!failed && (
          <button
            ref={menuAnchor}
            type="button"
            aria-label="下载"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              if (formats) setMenu((v) => !v);
              else void download(file);
            }}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg',
              menu && 'bg-surface-2 text-fg',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </button>
        )}
      </div>
      {formats && (
        <Popover open={menu} onOpenChange={setMenu} anchor={menuAnchor} placement="bottom-end" className="w-56">
          {group.files.map((f) => (
            <MenuItem
              key={fileKey(f)}
              icon={<KindIcon file={f} className="h-4 w-4" />}
              label={`${formatLabel(f)} 文件`}
              description={[fileExt(f.name).toUpperCase(), humanSize(f.size)].filter(Boolean).join(' · ')}
              onSelect={() => {
                setMenu(false);
                void download(f);
              }}
            />
          ))}
        </Popover>
      )}
      {node}
    </>
  );
}

/** 交付物的排序：成品在前，数据其次，源码、日志、压缩包最后 */
const KIND_RANK: Partial<Record<FileKind, number>> = {
  office: 0, pdf: 0, epub: 0, html: 0,
  model: 1, video: 1,
  image: 2, audio: 2,
  notebook: 3, csv: 3, sqlite: 3, parquet: 3,
  markdown: 4, calendar: 4, subtitle: 4, font: 4,
  archive: 5,
};
/** 越小越是"成品"：排在前面，也是自动在侧边打开的首选 */
export const deliverableRank = (group: DocGroup) => KIND_RANK[fileKind(group.primary)] ?? 6;

/** 进行中只放最新的几个：高度很快就固定下来，不会把正在做的步骤越顶越远 */
const LIVE_SHOWN = 4;
/** 做完后先露出最要紧的几个，其余收在"显示全部"里 */
const DONE_SHOWN = 6;

/**
 * 一条回答交付的全部文件，放在工作过程之后、正文之前。
 * 同一路径改过几版只留最后一版；同一份东西的几种格式合成一张卡片。
 */
export function Deliverables({ files, live }: { files: FileArtifact[]; live: boolean }) {
  const groups = useMemo(() => groupFiles(files), [files]);
  const [showAll, setShowAll] = useState(false);
  const holdAnchor = useHoldAnchor();
  const ordered = useMemo(
    () => (live ? groups : groups.map((g, i) => ({ g, i })).sort((a, b) => deliverableRank(a.g) - deliverableRank(b.g) || a.i - b.i).map((x) => x.g)),
    [groups, live],
  );
  if (groups.length === 0) return null;

  const limit = live ? LIVE_SHOWN : DONE_SHOWN;
  const overflow = ordered.length > limit;
  const head = !overflow ? ordered : live ? ordered.slice(-limit) : ordered.slice(0, limit);
  const rest = overflow && !live ? ordered.slice(limit) : [];
  const downloadable = files.filter(canPreview);
  const grid = (list: DocGroup[]) => (
    <div className={cn('grid gap-2', groups.length > 1 ? '@lg:grid-cols-2' : 'max-w-[26rem]')}>
      {list.map((group) => <DocCard key={group.key} group={group} />)}
    </div>
  );

  return (
    // 按对话栏自身的宽度分栏：侧边面板打开时对话栏变窄，卡片也跟着改成单列
    <section aria-label="交付的文件" className="@container my-3 animate-rise">
      {groups.length > 1 && (
        <div className="mb-2 flex min-h-7 items-center gap-1.5 text-[12.5px] text-fg-faint">
          <Files className="h-3.5 w-3.5" />
          <span className="tabular-nums">{live ? `已产出 ${groups.length} 个文件` : `交付了 ${groups.length} 个文件`}</span>
          {live && overflow && <span>· 这里是最新的 {limit} 个</span>}
          {!live && downloadable.length > 1 && <ZipButton files={downloadable} />}
        </div>
      )}
      {grid(head)}
      {rest.length > 0 && (
        <>
          <Collapse open={showAll}>
            <div className="pt-2">{grid(rest)}</div>
          </Collapse>
          <button
            type="button"
            onClick={(e) => {
              holdAnchor(e.currentTarget);
              setShowAll((v) => !v);
            }}
            aria-expanded={showAll}
            className="mt-2 flex h-8 items-center gap-1 rounded-xl px-2.5 text-[12.5px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {showAll ? '收起' : `显示全部 ${ordered.length} 个`}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', showAll && 'rotate-180')} />
          </button>
        </>
      )}
    </section>
  );
}

/** 本身已经压缩过的格式，打包时不再压 */
const STORED_EXT = new Set([
  'zip', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'avif', 'mp4', 'mov', 'webm', 'mkv',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'woff', 'woff2', 'glb', '3mf', 'docx', 'xlsx', 'pptx', 'epub', 'parquet', 'pdf',
]);

/** 在浏览器里把这条回答的文件打成一个 zip（按沙箱里的相对路径放） */
function ZipButton({ files }: { files: FileArtifact[] }) {
  const [done, setDone] = useState<number | null>(null);

  const run = async () => {
    setDone(0);
    try {
      const { zip } = await import('fflate');
      const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
      let missed = 0;
      for (const [i, file] of files.entries()) {
        try {
          const res = await fetch(file.url!, { mode: 'cors' });
          if (!res.ok) throw new Error(String(res.status));
          const name = (file.path ?? file.name).replace(/^\/+/, '');
          entries[name] = [new Uint8Array(await res.arrayBuffer()), { level: STORED_EXT.has(fileExt(file.name)) ? 0 : 6 }];
        } catch {
          missed += 1;
        }
        setDone(i + 1);
      }
      const data = await new Promise<Uint8Array>((resolve, reject) => zip(entries, (err, out) => (err ? reject(err) : resolve(out))));
      const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[-: ]/g, '');
      const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `LockAI 交付文件 ${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (missed) toast(`有 ${missed} 个文件没取到，压缩包里少了它们`);
    } catch {
      toast('打包没成功，可以逐个下载');
    } finally {
      setDone(null);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={done !== null}
      className="ml-auto flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-default disabled:hover:bg-transparent"
    >
      {done !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderDown className="h-3.5 w-3.5" />}
      <span className="tabular-nums">{done !== null ? `打包中 ${done}/${files.length}` : '全部打包下载'}</span>
    </button>
  );
}

/** 用户消息里的附件：小胶囊，点开全屏查看 */
export function FileChip({ file, onRemove, status }: { file: FileArtifact | { name: string; size: number; mime?: string }; onRemove?: () => void; status?: 'uploading' | 'done' | 'error' }) {
  const [open, setOpen] = useState(false);
  const artifact = 'url' in file ? file : undefined;
  const canOpen = Boolean(artifact?.url) && status !== 'uploading';
  return (
    <>
      <div
        role={canOpen ? 'button' : undefined}
        tabIndex={canOpen ? 0 : undefined}
        className={cn(
          'group/chip relative flex max-w-[15rem] items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-1.5 pr-3 text-left transition-colors',
          canOpen && 'cursor-pointer hover:border-line-strong',
          status === 'error' && 'border-danger/40',
        )}
        onClick={() => canOpen && setOpen(true)}
        onKeyDown={(e) => {
          if (canOpen && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', kindTint(file))}>
          {status === 'uploading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KindIcon file={file} />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-fg">{file.name}</span>
          <span className={cn('block text-[11px]', status === 'error' ? 'text-danger' : 'text-fg-faint')}>
            {status === 'uploading' ? '上传中' : status === 'error' ? '上传失败' : [fileExt(file.name).toUpperCase(), humanSize(file.size)].filter(Boolean).join(' · ')}
          </span>
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label="移除"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-ink-fg opacity-0 shadow-soft transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {open && artifact && (
        <DocModal group={{ key: fileKey(artifact), title: artifact.name, files: [artifact], primary: artifact }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 沙箱里的工作过程 */
/* ------------------------------------------------------------------ */

/** 只是在准备环境、不说明在干什么的命令 */
const SETUP_RE = /^(cd|set|mkdir|export|source|\.|true)\b/;

/** 模型没给标题时，从命令里挑出最能说明意图的一行 */
export function commandTitle(command: string): string {
  const segments = command
    .split('\n')
    .flatMap((l) => l.split(/\s*(?:&&|;)\s*/))
    .map((l) => l.trim().replace(/^(\w+=\S+\s+)+/, ''))
    .filter((l) => l && !l.startsWith('#'));
  let line = segments.find((l) => !SETUP_RE.test(l)) ?? segments[0] ?? command.trim();
  const heredocFile = line.match(/^cat\s+>+\s*(\S+)\s*<</);
  if (heredocFile) return `写入 ${heredocFile[1].replace(/^['"]|['"]$/g, '')}`;
  if (/^python3?\s+-\s*<</.test(line)) return '运行 Python 脚本';
  if (/^node\s+-\s*<</.test(line)) return '运行 Node 脚本';
  if (/<<\s*['"]?\w+['"]?/.test(line)) line = `${line.replace(/<<.*$/, '').trim()} …`;
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function stepTitle(step: ShellToolTrace): string {
  return step.title?.trim() || step.preamble?.trim() || commandTitle(step.command);
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

/** 终端风格的输出框，运行中自动跟到最底 */
function Terminal({ command, output, running }: { command: string; output: string; running: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && running && stick.current) el.scrollTop = el.scrollHeight;
  }, [output, running]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="mt-1.5 max-h-72 overflow-auto rounded-xl bg-[oklch(0.2_0.006_60)] px-3.5 py-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all text-[oklch(0.86_0.006_80)]"
    >
      <span className="text-[oklch(0.745_0.138_56)]">$ </span>
      <span className="text-[oklch(0.95_0.004_80)]">{command.trim()}</span>
      {output && `\n${output.replace(/\s+$/, '')}`}
      {running && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-[oklch(0.86_0.006_80)]" />}
    </pre>
  );
}

function StepStatus({ step }: { step: ShellToolTrace }) {
  if (step.status === 'running') {
    return (
      <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-bg">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
      </span>
    );
  }
  if (step.success === false) {
    return (
      <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-danger-soft">
        <X className="h-2.5 w-2.5 text-danger" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span className="relative z-[1] flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 ring-1 ring-line">
      <Check className="h-2.5 w-2.5 text-fg-soft" strokeWidth={3} />
    </span>
  );
}

function ShellStep({ step, last }: { step: ShellToolTrace; last: boolean }) {
  const running = step.status === 'running';
  const [open, setOpen] = useState(false);
  const holdAnchor = useHoldAnchor();
  const elapsed = useElapsed(step.startedAtMs, running);
  const output = step.output ?? '';
  const tail = running && !open ? lastLines(output, 4) : '';
  const prep = step.prepSeconds ?? 0;
  const runSeconds = step.seconds ?? step.durationSeconds ?? 0;
  const notes: ReactNode[] = [];
  // 两步之间模型不出声的那段（想、写命令和正文、等上游）记在写出来的这一步上
  if (prep >= PREP_NOTE_SECONDS || (step.prepTokens ?? 0) >= PREP_NOTE_TOKENS) {
    notes.push(`准备 ${Math.max(1, Math.round(prep))} 秒${step.prepTokens ? ` · ${compactCount(step.prepTokens)} tokens` : ''}`);
  }
  if (step.env === 'created') notes.push('启动了新的工作环境');
  if (step.env === 'restored') notes.push('恢复了上次的工作区');
  if (step.background && step.status === 'done') notes.push(step.success === false ? '后台服务没起来' : '在后台运行');
  if (!running && step.exitCode !== undefined && step.exitCode !== 0) notes.push(`退出码 ${step.exitCode}`);
  if (step.shown) notes.push(`看了 ${step.shown} 张截图自检`);
  if (step.files?.length) notes.push(`交付 ${step.files.length} 个文件`);

  return (
    <li className="relative pb-3 pl-7 last:pb-0">
      {!last && <span className="absolute bottom-0 left-[7.5px] top-5 w-px bg-line" aria-hidden />}
      <span className="absolute left-0 top-[3px]"><StepStatus step={step} /></span>
      <button
        type="button"
        onClick={(e) => {
          holdAnchor(e.currentTarget);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="group/step flex w-full min-w-0 items-start gap-2 text-left"
      >
        <span
          className={cn(
            'min-w-0 flex-1 text-[13px] leading-[1.6]',
            step.title || step.preamble ? 'text-fg' : 'font-mono text-[12.5px] text-fg-soft',
            running && 'shimmer-text',
          )}
        >
          {stepTitle(step)}
          {/* 有标题时，模型顺口说的那句话作为补充说明 */}
          {step.title && step.preamble && (
            <span className="block text-[12.5px] leading-5 text-fg-faint">{step.preamble}</span>
          )}
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11.5px]"
          title={prep >= 1 && !running ? `准备 ${Math.round(prep)} 秒 · 运行 ${Math.round(runSeconds)} 秒` : undefined}
        >
          <Seconds value={running ? Math.round(prep) + elapsed : Math.round(prep + runSeconds)} />
          <ChevronDown className={cn('h-3.5 w-3.5 text-fg-faint opacity-0 transition-[opacity,transform] group-hover/step:opacity-100', open && 'rotate-180 opacity-100')} />
        </span>
      </button>
      {notes.length > 0 && (
        <p className="mt-0.5 text-[11.5px] text-fg-faint">{notes.map((n, i) => <span key={i}>{i > 0 && ' · '}{n}</span>)}</p>
      )}
      {step.previewUrl && (
        <a
          href={step.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] text-fg transition-colors hover:border-line-strong"
        >
          <AppWindow className="h-3.5 w-3.5 text-accent" /> 打开预览 <ExternalLink className="h-3 w-3 text-fg-faint" />
        </a>
      )}
      {tail && (
        <pre className="mt-1 max-h-24 overflow-hidden font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-all text-fg-faint [mask-image:linear-gradient(to_bottom,transparent,#000_1.2rem)]">
          {tail}
        </pre>
      )}
      <Collapse open={open}>
        <Terminal command={step.command} output={output} running={running} />
      </Collapse>
    </li>
  );
}

/** 进行中只露出最近这几步：卡片高度基本不变，正在做的那一步总在同一个位置 */
const LIVE_STEPS = 3;

const stepFailed = (s: ShellToolTrace) => s.status === 'done' && s.success === false;

/** 进行中的一步：一行标题；最新那步下面是固定高度的输出尾巴 */
function LiveStep({ step, current }: { step: ShellToolTrace; current: boolean }) {
  const running = step.status === 'running';
  const tail = current ? lastLines(step.output ?? '', 4) : '';
  return (
    <li className="relative pb-2 pl-7 last:pb-0 animate-rise">
      {!current && <span className="absolute bottom-0 left-[7.5px] top-5 w-px bg-line" aria-hidden />}
      <span className="absolute left-0 top-[3px]"><StepStatus step={step} /></span>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-[13px] leading-[1.6]', current ? 'text-fg' : 'text-fg-soft', running && 'shimmer-text')}>
          {stepTitle(step)}
        </span>
        {!running && (
          <span className="shrink-0 text-[11.5px]">
            <Seconds value={Math.round((step.prepSeconds ?? 0) + (step.seconds ?? step.durationSeconds ?? 0))} />
          </span>
        )}
      </div>
      {current && (
        // 固定高度的小终端：输出从底部往上滚，行数多少都不改变卡片高度
        <div className="mt-1.5 rounded-lg bg-surface-2/60 px-2.5 py-1.5">
          <pre className="flex h-[4.1rem] flex-col justify-end overflow-hidden font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap break-all text-fg-faint [mask-image:linear-gradient(to_bottom,transparent,#000_1.1rem)]">
            <span>{tail || (running ? '…' : '（没有输出）')}</span>
          </pre>
        </div>
      )}
    </li>
  );
}

function LiveSteps({ steps, onShowAll }: { steps: ShellToolTrace[]; onShowAll: () => void }) {
  const shown = steps.slice(-LIVE_STEPS);
  const older = steps.length - shown.length;
  const olderFailed = steps.slice(0, older).filter(stepFailed).length;
  return (
    <div className="mt-2 ml-[1px]">
      {older > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="relative flex h-7 w-full items-start pl-7 text-left text-[12px] text-fg-faint transition-colors hover:text-fg-soft"
        >
          <span className="absolute bottom-0 left-[7.5px] top-4 w-px bg-line" aria-hidden />
          <span className="absolute left-[4.5px] top-[6px] h-[7px] w-[7px] rounded-full bg-line-strong" aria-hidden />
          <span className="tabular-nums">
            前面 {older} 步{olderFailed > 0 && <span className="text-danger"> · {olderFailed} 步出错</span>}
          </span>
        </button>
      )}
      <ol>
        {shown.map((step, i) => <LiveStep key={step.id} step={step} current={i === shown.length - 1} />)}
      </ol>
    </div>
  );
}

/** 报告的第一句，收起时当副标题 */
function firstLine(text?: string): string {
  const line = (text ?? '').split('\n').map((l) => l.replace(/^[#>*\-\d.\s]+/, '').replace(/\*\*/g, '').trim()).find(Boolean);
  return line ?? '';
}

/**
 * 统筹模型派给执行助手的一块工作。
 * 进行中：标题行说在做第几步，下面滚动显示执行助手最近几步（和工作过程卡片同一套）；
 * 做完：收成一张小卡片，副标题是报告的第一句，点开看任务说明、每一步和完整报告。
 */
export function TaskCard({ task, steps, live = false }: { task: TaskToolTrace; steps: ShellToolTrace[]; live?: boolean }) {
  const running = task.status === 'running';
  const current = steps.find((s) => s.status === 'running');
  const [expanded, setExpanded] = useState(false);
  const holdAnchor = useHoldAnchor();
  const elapsed = useElapsed(task.startedAtMs, running);
  const failed = steps.filter(stepFailed).length;
  const unfinished = !running && task.success === false;

  const status = running
    ? current ? `正在执行第 ${steps.indexOf(current) + 1} 步` : steps.length ? '正在看结果，想下一步' : '正在读任务说明'
    : unfinished ? '没有做完' : '已完成';
  const subtitle = running ? status : firstLine(task.report) || status;
  const seconds = running ? elapsed : Math.round(task.seconds ?? 0);

  return (
    <div className="my-3 rounded-2xl border border-line bg-surface px-3.5 py-3 animate-rise">
      <button
        type="button"
        onClick={(e) => {
          holdAnchor(e.currentTarget);
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        className="group/task flex w-full min-w-0 items-center gap-3 text-left"
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
            running ? 'bg-accent-soft text-accent' : unfinished ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-fg-soft',
          )}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : unfinished ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{task.title}</span>
            {task.model && (
              <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-px text-[11px] text-fg-faint">{task.model} 执行</span>
            )}
          </span>
          <span className={cn('mt-0.5 block truncate text-[12px]', running ? 'shimmer-text' : 'text-fg-faint')}>{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-fg-faint">
          <Seconds value={seconds} />
          {steps.length > 0 && <span className="tabular-nums">{steps.length} 步</span>}
          {failed > 0 && <span className="text-danger">{failed} 步出错</span>}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', expanded && 'rotate-180')} />
        </span>
      </button>
      <Collapse open={live && running && !expanded && steps.length > 0}>
        <div className="pt-1">
          <LiveSteps steps={steps} onShowAll={() => setExpanded(true)} />
        </div>
      </Collapse>
      <Collapse open={expanded}>
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div>
            <p className="mb-1 text-[11.5px] font-medium text-fg-faint">任务说明</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg-soft">{task.task}</p>
          </div>
          {steps.length > 0 && (
            <ol className="ml-px">
              {steps.map((step, i) => <ShellStep key={step.id} step={step} last={i === steps.length - 1} />)}
            </ol>
          )}
          {task.report && (
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-fg-faint">执行报告</p>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">{task.report}</p>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * 连续几步沙箱命令收成一个"工作过程"。
 * 进行中（live）：标题行说正在做什么，下面只滚动显示最近几步，高度基本固定，页面不会被越撑越长、跳来跳去；
 * 做完：收成一行，点开看完整时间线和每一步的终端输出。
 */
export function ShellGroup({
  steps,
  live = false,
  idle,
}: {
  steps: ShellToolTrace[];
  live?: boolean;
  /** 两步之间模型在想 / 在写下一步：标题行显示这个，代替底部那行 */
  idle?: { label: string; seconds: number };
}) {
  const running = steps.find((s) => s.status === 'running');
  const [expanded, setExpanded] = useState(false);
  const holdAnchor = useHoldAnchor();
  const groupElapsed = useElapsed(steps[0]?.startedAtMs, Boolean(live && running)) + Math.round(steps[0]?.prepSeconds ?? 0);
  const totalSeconds = Math.round(
    steps.reduce((sum, s) => sum + (s.prepSeconds ?? 0) + (s.seconds ?? s.durationSeconds ?? 0), 0),
  );
  const failed = steps.filter(stepFailed).length;
  const busy = live && Boolean(running || idle);

  // 标题行说整体进度，具体在做哪一步看下面滚动的那几行，不重复
  let headline: string;
  let seconds: number;
  let count = '';
  if (live && running) {
    headline = `正在执行第 ${steps.indexOf(running) + 1} 步`;
    seconds = groupElapsed;
  } else if (live && idle) {
    headline = idle.label;
    seconds = idle.seconds;
    count = `已做 ${steps.length} 步`;
  } else if (steps.length === 1) {
    headline = failed ? `${stepTitle(steps[0])}（没有成功）` : stepTitle(steps[0]);
    seconds = totalSeconds;
  } else {
    headline = failed === steps.length ? '沙箱里的操作没有成功' : `完成了 ${steps.length} 步操作`;
    seconds = totalSeconds;
  }

  return (
    <div className="my-3 animate-rise">
      <button
        type="button"
        onClick={(e) => {
          holdAnchor(e.currentTarget);
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        className="group/sh flex min-h-7 max-w-full items-center gap-2 text-left text-[13.5px]"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <SquareTerminal className={cn('h-3.5 w-3.5 shrink-0', failed === steps.length ? 'text-danger' : 'text-fg-faint')} />
        )}
        <span className={cn('min-w-0 truncate', busy ? 'shimmer-text' : 'text-fg-soft group-hover/sh:text-fg')}>
          {headline}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-fg-faint">
          <Seconds value={seconds} />
          {count && <span className="tabular-nums">{count}</span>}
          {failed > 0 && failed < steps.length && <span className="text-danger">{failed} 步出错</span>}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform duration-200', expanded && 'rotate-180')} />
      </button>
      <Collapse open={live && !expanded}>
        <LiveSteps steps={steps} onShowAll={() => setExpanded(true)} />
      </Collapse>
      <Collapse open={expanded}>
        <ol className="mt-2 ml-[1px]">
          {steps.map((step, i) => <ShellStep key={step.id} step={step} last={i === steps.length - 1} />)}
        </ol>
      </Collapse>
    </div>
  );
}
