'use client';

import { useMemo, useState } from 'react';
import type { FileArtifact } from '@/types';
import { BarSegmented, Dot, humanSize, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';
import { CodeView } from './CodeView';
import { PreviewBody } from '../FilePreview';

const HEAD_BYTES = 64 * 1024;

/** 按文件头认出真实类型（扩展名不对或没有扩展名时）→ 对应的扩展名 */
function sniff(bytes: Uint8Array, size: number): { ext: string; label: string } | null {
  const ascii = (from: number, len: number) => String.fromCharCode(...bytes.subarray(from, from + len));
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (ascii(0, 5) === '%PDF-') return { ext: 'pdf', label: 'PDF' };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { ext: 'png', label: 'PNG 图片' };
  if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', label: 'JPEG 图片' };
  if (ascii(0, 4) === 'GIF8') return { ext: 'gif', label: 'GIF 图片' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: 'webp', label: 'WebP 图片' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { ext: 'wav', label: 'WAV 音频' };
  if (ascii(0, 3) === 'ID3' || starts(0xff, 0xfb)) return { ext: 'mp3', label: 'MP3 音频' };
  if (ascii(0, 4) === 'fLaC') return { ext: 'flac', label: 'FLAC 音频' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', label: 'Ogg 音频' };
  if (ascii(4, 4) === 'ftyp') return { ext: 'mp4', label: 'MP4 视频' };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return { ext: 'webm', label: 'WebM 视频' };
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { ext: 'zip', label: 'ZIP 压缩包' };
  if (starts(0x1f, 0x8b)) return { ext: 'gz', label: 'GZIP 压缩' };
  if (ascii(257, 5) === 'ustar') return { ext: 'tar', label: 'TAR 包' };
  if (ascii(0, 15) === 'SQLite format 3') return { ext: 'sqlite', label: 'SQLite 数据库' };
  if (ascii(0, 4) === 'PAR1') return { ext: 'parquet', label: 'Parquet 数据' };
  if (ascii(0, 4) === 'glTF') return { ext: 'glb', label: 'glTF 模型' };
  if (ascii(0, 4) === 'wOFF') return { ext: 'woff', label: 'WOFF 字体' };
  if (ascii(0, 4) === 'wOF2') return { ext: 'woff2', label: 'WOFF2 字体' };
  if (ascii(0, 4) === 'OTTO') return { ext: 'otf', label: 'OpenType 字体' };
  if (starts(0x00, 0x01, 0x00, 0x00, 0x00)) return { ext: 'ttf', label: 'TrueType 字体' };
  if (ascii(0, 15) === 'BEGIN:VCALENDAR') return { ext: 'ics', label: '日历' };
  // 二进制 STL：80 字节头 + 三角形数，文件长度能对上
  if (bytes.length > 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
    if (count > 0 && 84 + count * 50 === size) return { ext: 'stl', label: 'STL 模型' };
  }
  if (/^solid\s/.test(ascii(0, 6)) && /facet\s+normal/.test(ascii(0, 512))) return { ext: 'stl', label: 'STL 模型' };
  return null;
}

/** 看起来是不是文本：没有 NUL、控制字符很少、能按 UTF-8 解开 */
function asText(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return null;
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  if (control / Math.max(1, sample.length) > 0.02) return null;
  try {
    // stream：只读了开头时，末尾被截断的半个字不算错
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    try {
      return new TextDecoder('gbk', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ');
    const right = hex.slice(8).join(' ');
    const chars = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  ${chars}`);
  }
  return lines.join('\n');
}

/**
 * 认不出类型的文件：先看文件头，是已知格式就交给对应的阅读器；
 * 是文本就当文本看；都不是就给十六进制视图（像 Hex Fiend 那样），至少能看到里面是什么。
 */
export default function SniffView({ file }: { file: FileArtifact }) {
  const { buffer, truncated, error } = useFetched(file.url, 'head', HEAD_BYTES);
  const bytes = useMemo(() => (buffer ? new Uint8Array(buffer) : null), [buffer]);
  const detected = useMemo(() => (bytes ? sniff(bytes, file.size || bytes.byteLength) : null), [bytes, file.size]);
  const text = useMemo(() => (bytes && !detected ? asText(bytes) : null), [bytes, detected]);
  const [mode, setMode] = useState<'text' | 'hex'>('text');

  if (error) return <PreviewFallback file={file} note="文件没能加载出来，可以直接下载" />;
  if (!bytes) return <Opening />;
  if (detected) {
    // 按真实类型打开（名字只在这里换，下载时还是原名）
    return <PreviewBody file={{ ...file, name: `${file.name}.${detected.ext}` }} />;
  }
  if (text !== null && mode === 'text') {
    return (
      <CodeView
        code={text}
        language="text"
        size={file.size}
        truncated={truncated}
        label="文本"
        actions={<BarSegmented value={mode} onChange={setMode} options={[{ value: 'text', label: '文本' }, { value: 'hex', label: '十六进制' }]} />}
      />
    );
  }
  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={text !== null ? <BarSegmented value={mode} onChange={setMode} options={[{ value: 'text', label: '文本' }, { value: 'hex', label: '十六进制' }]} /> : undefined}
      >
        <span className="font-medium text-fg-soft">二进制文件</span>
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
        {truncated && (<><Dot /><span>只显示前 {HEAD_BYTES / 1024} KB</span></>)}
      </ViewerBar>
      <pre className="min-h-0 flex-1 overflow-auto bg-(--code-bg) px-4 py-3 font-mono text-[12px] leading-[1.65] whitespace-pre text-fg-soft">
        {hexDump(bytes)}
      </pre>
    </div>
  );
}
