import type { ChatMessage, FileArtifact } from '@/types';

/** 同一份文档的几种格式（论文.pdf + 论文.docx）合成一组，界面上是一张卡片、面板里能切换格式 */
export interface DocGroup {
  key: string;
  title: string;
  files: FileArtifact[];
  /** 默认打开的格式：PDF 优先 */
  primary: FileArtifact;
}

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const FORMAT_ORDER = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'html', 'htm', 'md', '3mf', 'stl', 'glb', 'gltf', 'obj', 'ply'];

/**
 * 同名文件只有"同一类东西的不同格式"才合成一张卡片：论文.pdf + 论文.docx、模型.stl + 模型.3mf。
 * 脚本和它画出来的图（design.py + design.png）是两样东西，分开放。
 */
const FAMILIES: Record<string, string> = {
  pdf: 'doc', docx: 'doc', doc: 'doc', odt: 'doc', md: 'doc', html: 'doc', htm: 'doc', tex: 'doc', epub: 'doc', rtf: 'doc',
  pptx: 'doc', ppt: 'doc', odp: 'doc', xlsx: 'doc', xls: 'doc', ods: 'doc', csv: 'doc',
  stl: 'model', '3mf': 'model', obj: 'model', ply: 'model', glb: 'model', gltf: 'model', off: 'model',
};

function familyOf(file: FileArtifact): string {
  const ext = fileExt(file.name);
  return FAMILIES[ext] ?? `ext:${ext}`;
}

function formatRank(file: FileArtifact): number {
  const i = FORMAT_ORDER.indexOf(fileExt(file.name));
  return i < 0 ? FORMAT_ORDER.length : i;
}

/** 格式的叫法：切换格式、下载菜单里用 */
export function formatLabel(file: Pick<FileArtifact, 'name'>): string {
  const ext = fileExt(file.name);
  switch (ext) {
    case 'pdf': return 'PDF';
    case 'docx': case 'doc': case 'odt': return 'Word';
    case 'pptx': case 'ppt': case 'odp': return 'PPT';
    case 'xlsx': case 'xls': case 'ods': return 'Excel';
    case 'csv': return 'CSV';
    case 'html': case 'htm': return '网页';
    case 'md': case 'markdown': return 'Markdown';
    default: return ext ? ext.toUpperCase() : '文件';
  }
}

export function fileKey(file: FileArtifact): string {
  return file.url ?? file.path ?? file.name;
}

export function groupFiles(files: FileArtifact[]): DocGroup[] {
  const groups = new Map<string, FileArtifact[]>();
  for (const file of files) {
    const base = file.path ?? file.name;
    const key = `${stem(base)}|${familyOf(file)}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => formatRank(a) - formatRank(b));
    const ok = sorted.filter((f) => f.url && !f.error);
    const primary = ok[0] ?? sorted[0];
    return { key, title: sorted.length > 1 ? stem(primary.name) : primary.name, files: ok.length ? ok : sorted, primary };
  });
}

/** 交付后自动在侧边面板打开的：文档、表格、幻灯片、网页、3D 模型、笔记本。图片音视频在对话里就能看，不自动弹 */
const PANEL_EXT = new Set([
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'md', 'html', 'htm', 'odt', 'odp', 'ods',
  'stl', '3mf', 'obj', 'ply', 'glb', 'gltf', 'ipynb', 'epub',
]);

export function isPanelDoc(file: FileArtifact): boolean {
  return canPreview(file) && PANEL_EXT.has(fileExt(file.name));
}

/** 能打开看的（交付成功、有地址）：点开都在侧边面板里看 */
export function canPreview(file: FileArtifact): boolean {
  return Boolean(file.url) && !file.error;
}

/** 一条回答里交付的文件（后交付的同名文件覆盖先交付的） */
export function messageFiles(message: ChatMessage): FileArtifact[] {
  const byPath = new Map<string, FileArtifact>();
  for (const trace of message.tool_trace ?? []) {
    if (trace.kind !== 'shell') continue;
    for (const f of trace.files ?? []) byPath.set(f.path ?? f.name, f);
  }
  return [...byPath.values()];
}

/** 整段对话里交付过的文件，最新的在前（面板里切换文件用） */
export function conversationDocs(messages: ChatMessage[]): DocGroup[] {
  const seen = new Set<string>();
  const out: DocGroup[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    for (const group of groupFiles(messageFiles(message).filter(canPreview)).reverse()) {
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      out.push(group);
    }
  }
  return out;
}
