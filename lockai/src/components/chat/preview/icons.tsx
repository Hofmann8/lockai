import {
  AppWindow,
  Binary,
  BookOpen,
  Box,
  CalendarDays,
  Captions,
  Database,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  NotebookText,
  Presentation,
  Type,
} from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { fileKind } from './kinds';

const SLIDE_EXT = new Set(['pptx', 'ppt', 'odp', 'key']);
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers']);

export function KindIcon({ file, className }: { file: Pick<FileArtifact, 'name' | 'mime'>; className?: string }) {
  const ext = fileExt(file.name);
  const kind = fileKind(file);
  const props = { className: cn('h-4 w-4', className) };
  if (SLIDE_EXT.has(ext)) return <Presentation {...props} />;
  if (SHEET_EXT.has(ext) || kind === 'csv') return <FileSpreadsheet {...props} />;
  switch (kind) {
    case 'office': case 'pdf': case 'markdown': return <FileText {...props} />;
    case 'image': return <FileImage {...props} />;
    case 'video': return <FileVideo {...props} />;
    case 'audio': return <FileAudio {...props} />;
    case 'html': return <AppWindow {...props} />;
    case 'archive': return <FileArchive {...props} />;
    case 'text': return <FileCode {...props} />;
    case 'model': return <Box {...props} />;
    case 'notebook': return <NotebookText {...props} />;
    case 'font': return <Type {...props} />;
    case 'sqlite': case 'parquet': return <Database {...props} />;
    case 'calendar': return <CalendarDays {...props} />;
    case 'subtitle': return <Captions {...props} />;
    case 'epub': return <BookOpen {...props} />;
    default: return ext ? <Binary {...props} /> : <FileIcon {...props} />;
  }
}

/** 图标底色：按类型给一点点颜色，扫一眼就知道是什么 */
export function kindTint(file: Pick<FileArtifact, 'name' | 'mime'>): string {
  const ext = fileExt(file.name);
  const kind = fileKind(file);
  if (SLIDE_EXT.has(ext)) return 'bg-[oklch(0.68_0.15_40/0.14)] text-[oklch(0.58_0.16_40)]';
  if (SHEET_EXT.has(ext) || kind === 'csv' || kind === 'parquet' || kind === 'sqlite') return 'bg-[oklch(0.65_0.13_150/0.14)] text-[oklch(0.52_0.12_150)]';
  switch (kind) {
    case 'office': case 'epub': return 'bg-[oklch(0.62_0.13_255/0.14)] text-[oklch(0.52_0.14_255)]';
    case 'pdf': return 'bg-[oklch(0.6_0.18_27/0.13)] text-[oklch(0.56_0.18_27)]';
    case 'video': case 'audio': case 'subtitle': return 'bg-[oklch(0.62_0.14_300/0.14)] text-[oklch(0.55_0.15_300)]';
    case 'html': return 'bg-[oklch(0.66_0.12_200/0.14)] text-[oklch(0.52_0.11_200)]';
    case 'model': return 'bg-[oklch(0.7_0.12_75/0.16)] text-[oklch(0.56_0.12_70)]';
    case 'notebook': return 'bg-[oklch(0.7_0.14_55/0.15)] text-[oklch(0.58_0.15_50)]';
    case 'calendar': return 'bg-[oklch(0.62_0.17_20/0.12)] text-[oklch(0.57_0.17_22)]';
    case 'font': return 'bg-[oklch(0.3_0.01_60/0.08)] text-fg';
    default: return 'bg-surface-2 text-fg-soft';
  }
}
