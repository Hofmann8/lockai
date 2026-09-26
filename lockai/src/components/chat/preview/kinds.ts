import type { FileArtifact } from '@/types';
import { fileExt } from '@/lib/chat/artifacts';

/**
 * 文件类型：决定用哪个阅读器。
 * 覆盖沙箱里常见工具能产出的文件（Office / PDF / LaTeX / 图表 / 音视频 / 3D 打印 / 数据 / 代码 / 压缩包 …）
 * 和用户常传的附件；认不出的按内容嗅探，文本当文本看，二进制给十六进制视图，总之都能打开看一眼。
 */
export type FileKind =
  | 'image' | 'pdf' | 'video' | 'audio' | 'html' | 'markdown' | 'csv' | 'text' | 'office'
  | 'archive' | 'model' | 'notebook' | 'font' | 'sqlite' | 'parquet' | 'calendar' | 'subtitle' | 'epub'
  | 'other';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng', 'tif', 'tiff', 'heic', 'heif', 'jfif']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi', 'wmv', 'flv']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'aiff', 'aif', 'amr', 'wma']);
export const MODEL_EXT = new Set(['stl', 'obj', 'ply', 'glb', 'gltf', '3mf', 'off']);
export const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);
export const SQLITE_EXT = new Set(['db', 'sqlite', 'sqlite3', 'db3']);
export const OFFICE_EXT = new Set(['docx', 'doc', 'xlsx', 'xlsm', 'xlsb', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf']);
export const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods']);
export const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'tbz2', 'txz']);

/** 扩展名 → 代码高亮语言（Prism 的名字）；在这里的都按文本 / 代码打开 */
export const CODE_LANG: Record<string, string> = {
  py: 'python', pyw: 'python', pyi: 'python', ipy: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  vue: 'markup', svelte: 'markup', astro: 'markup',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  json: 'json', jsonc: 'json', json5: 'json5', jsonl: 'json', ndjson: 'json', geojson: 'json', topojson: 'json', webmanifest: 'json', har: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', env: 'bash',
  xml: 'markup', xsd: 'markup', xsl: 'markup', plist: 'markup', kml: 'markup', gpx: 'markup', drawio: 'markup', rss: 'markup', atom: 'markup', xhtml: 'markup',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', prisma: 'graphql',
  tex: 'latex', sty: 'latex', cls: 'latex', bib: 'latex', typ: 'typst', rst: 'rest', adoc: 'asciidoc', org: 'text',
  r: 'r', rmd: 'markdown', jl: 'julia', m: 'matlab', lua: 'lua', rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', ino: 'cpp',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala', groovy: 'groovy', gradle: 'groovy', dart: 'dart',
  cs: 'csharp', fs: 'fsharp', vb: 'vbnet', hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', elm: 'elm',
  zig: 'zig', nim: 'nim', v: 'verilog', sv: 'verilog', vhd: 'vhdl', asm: 'nasm', s: 'nasm', wat: 'wasm', sol: 'solidity',
  proto: 'protobuf', thrift: 'text', tf: 'hcl', hcl: 'hcl', nix: 'nix', cmake: 'cmake', mk: 'makefile', dockerfile: 'docker',
  diff: 'diff', patch: 'diff', mmd: 'mermaid', mermaid: 'mermaid', dot: 'dot', gv: 'dot', puml: 'text', plantuml: 'text',
  scad: 'clike', gcode: 'gcode', nc: 'gcode', gco: 'gcode', step: 'text', stp: 'text', iges: 'text', igs: 'text', dxf: 'text', svgz: 'text',
  txt: 'text', text: 'text', log: 'log', out: 'text', nfo: 'text', me: 'text', lock: 'text', gitignore: 'ignore', gitattributes: 'text',
  editorconfig: 'ini', npmrc: 'ini', htaccess: 'apacheconf', nginx: 'nginx', ass: 'text', ssa: 'text', tsv: 'text',
};

/** 没有扩展名、但一看名字就知道是文本的文件 */
const TEXT_NAMES: Record<string, string> = {
  dockerfile: 'docker', makefile: 'makefile', readme: 'markdown', license: 'text', licence: 'text', changelog: 'markdown',
  procfile: 'text', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby', jenkinsfile: 'groovy', cmakelists: 'cmake',
  '.gitignore': 'ignore', '.env': 'bash', '.bashrc': 'bash', '.zshrc': 'bash', '.editorconfig': 'ini', '.npmrc': 'ini',
};

export function codeLanguage(name: string): string {
  const ext = fileExt(name);
  if (ext && CODE_LANG[ext]) return CODE_LANG[ext];
  const base = name.split('/').pop()!.toLowerCase().replace(/\.txt$/, '');
  return TEXT_NAMES[base] ?? TEXT_NAMES[base.split('.')[0]] ?? 'text';
}

export function fileKind(file: Pick<FileArtifact, 'name' | 'mime'>): FileKind {
  const ext = fileExt(file.name);
  const mime = (file.mime ?? '').toLowerCase();
  const base = file.name.split('/').pop()!.toLowerCase();
  if (IMAGE_EXT.has(ext) || (mime.startsWith('image/') && !ext)) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (VIDEO_EXT.has(ext) || (mime.startsWith('video/') && !ext)) return 'video';
  if (AUDIO_EXT.has(ext) || (mime.startsWith('audio/') && !ext)) return 'audio';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || ext === 'mkd') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (MODEL_EXT.has(ext)) return 'model';
  if (ext === 'ipynb') return 'notebook';
  if (FONT_EXT.has(ext)) return 'font';
  if (SQLITE_EXT.has(ext)) return 'sqlite';
  if (ext === 'parquet' || ext === 'pq') return 'parquet';
  if (ext === 'ics' || ext === 'ical' || ext === 'ifb') return 'calendar';
  if (ext === 'srt' || ext === 'vtt' || ext === 'lrc') return 'subtitle';
  if (ext === 'epub') return 'epub';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if ((ext && CODE_LANG[ext]) || TEXT_NAMES[base] || mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+xml')) return 'text';
  return 'other';
}

/** 类型的中文叫法：阅读器工具栏、文件卡片上用 */
export function kindName(file: Pick<FileArtifact, 'name' | 'mime'>): string {
  const ext = fileExt(file.name);
  switch (fileKind(file)) {
    case 'model': return '3D 模型';
    case 'notebook': return 'Jupyter 笔记本';
    case 'font': return '字体';
    case 'sqlite': return 'SQLite 数据库';
    case 'parquet': return 'Parquet 数据';
    case 'calendar': return '日历';
    case 'subtitle': return ext === 'lrc' ? '歌词' : '字幕';
    case 'epub': return '电子书';
    case 'archive': return '压缩包';
    default: return ext ? ext.toUpperCase() : '文件';
  }
}
