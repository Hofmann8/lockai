'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Loader2, X } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileKey } from '@/lib/chat/artifacts';
import { groupByFolder } from '@/lib/chat/uploads';
import { Collapse } from '@/components/ui/Collapse';
import { humanSize, KindIcon, kindTint } from './FilePreview';
import { DocModal } from './ArtifactPanel';
import { FileChip } from './WorkCards';

/*
 * 用户上传的文件：单个文件是文件卡片，整个文件夹按目录树显示（和沙箱 inputs/ 里的结构一样）。
 */

/** 一个目录里一次最多列这么多文件，其余点"还有 N 个"再展开 */
const ROWS_PER_DIR = 50;

interface DirNode {
  name: string;
  dirs: Map<string, DirNode>;
  files: FileArtifact[];
  count: number;
  size: number;
}

function buildTree(name: string, files: FileArtifact[]): DirNode {
  const root: DirNode = { name, dirs: new Map(), files: [], count: 0, size: 0 };
  for (const file of files) {
    // 路径的第一段是顶层文件夹本身
    const segments = (file.path ?? file.name).split('/').slice(1, -1);
    let node = root;
    node.count += 1;
    node.size += file.size || 0;
    for (const seg of segments) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = { name: seg, dirs: new Map(), files: [], count: 0, size: 0 };
        node.dirs.set(seg, child);
      }
      node = child;
      node.count += 1;
      node.size += file.size || 0;
    }
    node.files.push(file);
  }
  return root;
}

const summary = (count: number, size: number) => [`${count} 个文件`, size ? humanSize(size) : ''].filter(Boolean).join(' · ');

/** 消息里的附件：文件夹在前（目录树），单个文件在后（卡片） */
export function UploadList({ files }: { files: FileArtifact[] }) {
  const { folders, loose } = useMemo(() => groupByFolder(files, (f) => f.path), [files]);
  return (
    <>
      {[...folders].map(([name, list]) => <FolderCard key={name} name={name} files={list} />)}
      {loose.map((file, i) => <FileChip key={`${fileKey(file)}-${i}`} file={file} />)}
    </>
  );
}

function FolderCard({ name, files }: { name: string; files: FileArtifact[] }) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => buildTree(name, files), [name, files]);
  return (
    <div className="w-[22rem] max-w-full overflow-hidden rounded-xl border border-line bg-surface text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-1.5 pl-1.5 pr-3 transition-colors hover:bg-surface-2"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          {open ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-fg">{name}</span>
          <span className="block text-[11px] text-fg-faint">{summary(tree.count, tree.size)}</span>
        </span>
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-fg-faint transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <Collapse open={open}>
        <div className="max-h-80 overflow-y-auto border-t border-line py-1">
          <DirRows node={tree} depth={0} />
        </div>
      </Collapse>
    </div>
  );
}

function DirRows({ node, depth }: { node: DirNode; depth: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? node.files : node.files.slice(0, ROWS_PER_DIR);
  return (
    <>
      {[...node.dirs.values()].map((dir) => <SubDir key={dir.name} node={dir} depth={depth} />)}
      {shown.map((file, i) => <FileRow key={`${fileKey(file)}-${i}`} file={file} depth={depth} />)}
      {node.files.length > shown.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full py-1 text-left text-[11.5px] text-fg-faint transition-colors hover:text-fg"
          style={{ paddingLeft: 12 + depth * 14 + 22 }}
        >
          还有 {node.files.length - shown.length} 个文件
        </button>
      )}
    </>
  );
}

function SubDir({ node, depth }: { node: DirNode; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-[12px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform duration-200', open && 'rotate-90')} />
        <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 text-[11px] text-fg-faint">{node.count}</span>
      </button>
      {open && <DirRows node={node} depth={depth + 1} />}
    </>
  );
}

function FileRow({ file, depth }: { file: FileArtifact; depth: number }) {
  const [open, setOpen] = useState(false);
  const canOpen = Boolean(file.url);
  return (
    <>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 py-1 pr-3 text-[12px] text-fg-soft transition-colors enabled:hover:bg-surface-2 enabled:hover:text-fg"
        style={{ paddingLeft: 12 + depth * 14 + 20 }}
      >
        <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded [&_svg]:h-3 [&_svg]:w-3', kindTint(file))}>
          <KindIcon file={file} />
        </span>
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        {file.size ? <span className="shrink-0 text-[11px] text-fg-faint">{humanSize(file.size)}</span> : null}
      </button>
      {open && (
        <DocModal group={{ key: fileKey(file), title: file.name, files: [file], primary: file }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** 输入框里还没发出去的文件夹：一个卡片，显示上传进度 */
export function FolderChip({ name, total, done, failed, size, onRemove }: {
  name: string;
  total: number;
  done: number;
  failed: number;
  size: number;
  onRemove: () => void;
}) {
  const uploading = done + failed < total;
  return (
    <div className="group/chip relative flex max-w-[15rem] items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-1.5 pr-3 text-left">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-fg">{name}</span>
        <span className={cn('block text-[11px]', failed ? 'text-danger' : 'text-fg-faint')}>
          {uploading ? `上传中 ${done}/${total}` : failed ? `${total} 个文件 · ${failed} 个没传上` : summary(total, size)}
        </span>
      </span>
      <button
        type="button"
        aria-label="移除文件夹"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-ink-fg opacity-0 shadow-soft transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
