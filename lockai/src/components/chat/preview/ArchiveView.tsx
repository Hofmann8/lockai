'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Folder, FolderOpen } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { BarButton, Dot, formatCount, humanSize, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';
import { KindIcon, kindTint } from './icons';
import { PreviewBody } from '../FilePreview';

interface Entry {
  path: string;
  size: number;
  /** 压缩后的大小（zip 才有） */
  packed?: number;
}

interface Archive {
  entries: Entry[];
  read: (path: string) => Uint8Array | null;
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;

/* ------------------------------------------------------------------ */
/* 解包：zip 用 fflate 按需解压；tar / tar.gz 自己读头 */
/* ------------------------------------------------------------------ */

async function openZip(buffer: ArrayBuffer): Promise<Archive> {
  const { unzipSync } = await import('fflate');
  const bytes = new Uint8Array(buffer);
  const entries: Entry[] = [];
  // 先只读目录，不解压
  unzipSync(bytes, {
    filter: (f) => {
      if (!f.name.endsWith('/') && !JUNK.test(f.name)) entries.push({ path: f.name, size: f.originalSize, packed: f.size });
      return false;
    },
  });
  return {
    entries,
    read: (path) => unzipSync(bytes, { filter: (f) => f.name === path })[path] ?? null,
  };
}

function readTar(bytes: Uint8Array): Archive {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  const str = (from: number, len: number) => decoder.decode(bytes.subarray(from, from + len)).split('\0')[0];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length) {
    const name = str(offset, 100);
    if (!name) break;
    const size = parseInt(str(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[offset + 156]);
    const prefix = str(offset + 345, 155);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    let path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === 'L') longName = decoder.decode(body).split('\0')[0];
    else if (type === 'x') {
      const match = decoder.decode(body).match(/\d+ path=([^\n]+)\n/);
      if (match) longName = match[1];
    } else if (type === '0' || type === '\0' || type === '7') {
      path = path.replace(/^\.\//, '');
      if (!JUNK.test(path)) files.set(path, body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return {
    entries: [...files.entries()].map(([path, data]) => ({ path, size: data.byteLength })),
    read: (path) => files.get(path) ?? null,
  };
}

async function openArchive(buffer: ArrayBuffer, name: string): Promise<Archive> {
  const ext = fileExt(name);
  const bytes = new Uint8Array(buffer);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return openZip(buffer);
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gz) {
    const { gunzipSync } = await import('fflate');
    const inner = gunzipSync(bytes);
    // tar.gz / tgz；单个文件压成的 .gz 就只有它自己
    if (ext === 'tgz' || /\.tar\.gz$/i.test(name) || String.fromCharCode(...inner.subarray(257, 262)) === 'ustar') return readTar(inner);
    const innerName = name.split('/').pop()!.replace(/\.gz$/i, '');
    return { entries: [{ path: innerName, size: inner.byteLength }], read: () => inner };
  }
  if (ext === 'tar' || String.fromCharCode(...bytes.subarray(257, 262)) === 'ustar') return readTar(bytes);
  throw new Error('unsupported');
}

/* ------------------------------------------------------------------ */
/* 目录树 */
/* ------------------------------------------------------------------ */

interface Node {
  name: string;
  path: string;
  entry?: Entry;
  children: Map<string, Node>;
  size: number;
  count: number;
}

function buildTree(entries: Entry[]): Node {
  const root: Node = { name: '', path: '', children: new Map(), size: 0, count: 0 };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    let node = root;
    node.size += entry.size;
    node.count += 1;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), children: new Map(), size: 0, count: 0 };
        node.children.set(part, child);
      }
      child.size += entry.size;
      child.count += 1;
      if (i === parts.length - 1) child.entry = entry;
      node = child;
    });
  }
  // 只有一层外壳文件夹时直接展开它
  return root;
}

function sorted(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const af = a.entry ? 1 : 0;
    const bf = b.entry ? 1 : 0;
    return af - bf || a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
}

function TreeRows({ node, depth, open, toggle, onOpen }: {
  node: Node; depth: number; open: Set<string>; toggle: (path: string) => void; onOpen: (entry: Entry) => void;
}) {
  return (
    <>
      {sorted(node).map((child) => {
        const isDir = !child.entry;
        const expanded = open.has(child.path);
        const file = { name: child.name, size: child.size };
        return (
          <div key={child.path}>
            <button
              type="button"
              onClick={() => (isDir ? toggle(child.path) : onOpen(child.entry!))}
              className="group/row flex h-8 w-full items-center gap-2 rounded-lg pr-3 text-left text-[13px] transition-colors hover:bg-surface-2"
              style={{ paddingLeft: 8 + depth * 18 }}
            >
              {isDir ? (
                <>
                  <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform duration-150', expanded && 'rotate-90')} />
                  {expanded ? <FolderOpen className="h-4 w-4 shrink-0 text-[oklch(0.7_0.12_75)]" /> : <Folder className="h-4 w-4 shrink-0 text-[oklch(0.7_0.12_75)]" />}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md', kindTint(file))}>
                    <KindIcon file={file} className="h-3 w-3" />
                  </span>
                </>
              )}
              <span className="min-w-0 flex-1 truncate text-fg">{child.name}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-fg-faint">
                {isDir ? `${child.count} 项` : humanSize(child.size) || '0 B'}
              </span>
            </button>
            {isDir && expanded && <TreeRows node={child} depth={depth + 1} open={open} toggle={toggle} onOpen={onOpen} />}
          </div>
        );
      })}
    </>
  );
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', html: 'text/html',
};

/** 压缩包：像访达那样看目录，点里面的文件直接用对应的阅读器打开，也能单独下载 */
export default function ArchiveView({ file }: { file: FileArtifact }) {
  const ext = fileExt(file.name);
  const supported = !['7z', 'rar', 'bz2', 'xz', 'tbz2', 'txz'].includes(ext);
  const { buffer, error } = useFetched(supported ? file.url : undefined, 'buffer');
  const [archive, setArchive] = useState<Archive | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [inner, setInner] = useState<{ entry: Entry; file: FileArtifact } | null>(null);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    openArchive(buffer, file.name)
      .then((a) => {
        if (cancelled) return;
        setArchive(a);
        // 只有一个顶层文件夹（常见的打包方式）就先展开它
        const top = new Set(a.entries.map((e) => e.path.split('/')[0]));
        if (top.size === 1 && a.entries.length > 1) setOpen(new Set(top));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [buffer, file.name]);

  useEffect(() => () => { if (inner?.file.url) URL.revokeObjectURL(inner.file.url); }, [inner]);

  const tree = useMemo(() => (archive ? buildTree(archive.entries) : null), [archive]);

  if (!supported) {
    return <PreviewFallback file={file} note={`${ext.toUpperCase()} 压缩包要下载后用解压软件打开；想在这里直接看，可以让我改打成 zip`} />;
  }
  if (error || failed) return <PreviewFallback file={file} note="压缩包没能读出来（可能损坏或加了密码），可以下载后解压" />;
  if (!archive || !tree) return <Opening label="正在读取压缩包目录" />;

  const openEntry = (entry: Entry) => {
    const data = archive.read(entry.path);
    if (!data) return;
    const name = entry.path.split('/').pop()!;
    const blob = new Blob([data as BlobPart], { type: MIME[fileExt(name)] ?? 'application/octet-stream' });
    setInner({ entry, file: { name, size: entry.size, url: URL.createObjectURL(blob), mime: blob.type } });
  };

  if (inner) {
    const crumbs = inner.entry.path.split('/');
    return (
      <div className="flex h-full flex-col">
        <ViewerBar
          actions={
            <BarButton label="下载这个文件" onClick={() => {
              const a = document.createElement('a');
              a.href = inner.file.url!;
              a.download = inner.file.name;
              a.click();
            }}>
              <Download className="h-3.5 w-3.5" />
            </BarButton>
          }
        >
          <button type="button" onClick={() => setInner(null)} className="-ml-1 flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg">
            <ChevronLeft className="h-3.5 w-3.5" /> {file.name.split('/').pop()}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className={cn('flex min-w-0 items-center gap-2', i === crumbs.length - 1 ? 'text-fg' : '')}>
              <ChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
              <span className="truncate">{c}</span>
            </span>
          ))}
        </ViewerBar>
        <div className="relative min-h-0 flex-1">
          <PreviewBody key={inner.file.url} file={inner.file} />
        </div>
      </div>
    );
  }

  const packed = archive.entries.reduce((s, e) => s + (e.packed ?? 0), 0);
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span className="font-medium text-fg-soft">{/\.tar\.gz$/i.test(file.name) ? 'TAR.GZ' : ext.toUpperCase()} 压缩包</span>
        <Dot />
        <span className="tabular-nums">{formatCount(archive.entries.length)} 个文件</span>
        <Dot />
        <span>解压后 {humanSize(tree.size) || '0 B'}</span>
        {packed > 0 && tree.size > 0 && (<><Dot /><span>压缩率 {Math.round((1 - packed / tree.size) * 100)}%</span></>)}
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface px-2 py-2">
        {archive.entries.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-fg-faint">压缩包是空的</p>
        ) : (
          <TreeRows
            node={tree}
            depth={0}
            open={open}
            toggle={(path) => setOpen((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })}
            onOpen={openEntry}
          />
        )}
      </div>
    </div>
  );
}
