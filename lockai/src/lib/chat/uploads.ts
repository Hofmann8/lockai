/**
 * 文件上传的几个小工具：拖进来的文件夹展开成带相对路径的文件、按顶层文件夹分组、限制并发。
 * 文件夹里的相对路径会带到后端，沙箱 inputs/ 里按原来的目录结构放好。
 */

/** 带相对路径的文件（从文件夹里来的 path 形如 活动照片/day1/a.jpg；单个文件没有 path） */
export interface PickedFile {
  file: File;
  path?: string;
}

/** 顶层文件夹名；不在文件夹里的返回空 */
export function topFolder(path?: string): string {
  const i = path ? path.indexOf('/') : -1;
  return i > 0 ? path!.slice(0, i) : '';
}

/** 按顶层文件夹分组，保持出现的顺序；不在文件夹里的放进 loose */
export function groupByFolder<T>(items: T[], pathOf: (item: T) => string | undefined) {
  const folders = new Map<string, T[]>();
  const loose: T[] = [];
  for (const item of items) {
    const top = topFolder(pathOf(item));
    if (!top) {
      loose.push(item);
      continue;
    }
    const list = folders.get(top);
    if (list) list.push(item);
    else folders.set(top, [item]);
  }
  return { folders, loose };
}

/** 选文件夹的 input（webkitdirectory）给的文件，webkitRelativePath 就是相对路径 */
export function fromDirectoryInput(files: File[]): PickedFile[] {
  return files.map((file) => ({ file, path: file.webkitRelativePath || undefined }));
}

// 系统生成的杂文件不传
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)/i;
export const isJunk = (path: string) => JUNK.test(path);

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries 一次最多给 100 个，要读到空为止
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(out);
      else {
        out.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isJunk(path)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path });
  } else if (entry.isDirectory) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, path, out);
  }
}

/**
 * 拖进来的东西：单个文件放 loose（图片还能走"直接给模型看"），文件夹展开成带路径的文件放 nested。
 * 必须在 drop 事件里同步取 entry，await 之后 DataTransfer 就被清空了。
 */
export async function readDropped(dt: DataTransfer): Promise<{ loose: File[]; nested: PickedFile[] }> {
  const entries = Array.from(dt.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.some((e) => e === null)) {
    return { loose: Array.from(dt.files), nested: [] };
  }
  const loose: PickedFile[] = [];
  const nested: PickedFile[] = [];
  for (const entry of entries) {
    await walk(entry!, '', entry!.isDirectory ? nested : loose);
  }
  return { loose: loose.map((p) => p.file), nested };
}

/** 同时最多跑 n 个的队列：一次拖进几百个文件时不把浏览器和后端挤爆 */
export function createLimiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
