'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';

interface Cue {
  start: number;
  end?: number;
  text: string;
}

function toSeconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function parseCues(text: string, ext: string): Cue[] {
  if (ext === 'lrc') {
    const cues: Cue[] = [];
    for (const line of text.split(/\r?\n/)) {
      const stamps = [...line.matchAll(/\[(\d+:\d+(?:\.\d+)?)\]/g)];
      const body = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const s of stamps) cues.push({ start: toSeconds(s[1]), text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  // SRT / VTT：空行分块，块里带 --> 的是时间行
  return text
    .replace(/^WEBVTT[^\n]*\n/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block): Cue | null => {
      const lines = block.split(/\r?\n/).filter(Boolean);
      const at = lines.findIndex((l) => l.includes('-->'));
      if (at < 0) return null;
      const [a, b] = lines[at].split('-->').map((s) => s.trim().split(/\s/)[0]);
      return { start: toSeconds(a), end: toSeconds(b), text: lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '') };
    })
    .filter((c): c is Cue => Boolean(c));
}

function stamp(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 字幕 / 歌词：时间码 + 文字，一条一行，可搜索 */
export default function SubtitleView({ file }: { file: FileArtifact }) {
  const ext = fileExt(file.name);
  const { text, error } = useFetched(file.url, 'text');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const cues = useMemo(() => (text === undefined ? [] : parseCues(text, ext)), [text, ext]);
  const shown = deferred ? cues.filter((c) => c.text.toLowerCase().includes(deferred)) : cues;

  if (error) return <PreviewFallback file={file} note="字幕文件没能加载出来" />;
  if (text === undefined) return <Opening />;
  const last = cues[cues.length - 1];

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <label className="flex h-7 w-40 items-center gap-1.5 rounded-lg bg-surface-2 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索台词" className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint" />
          </label>
        }
      >
        <span className="font-medium text-fg-soft">{ext === 'lrc' ? '歌词' : `${ext.toUpperCase()} 字幕`}</span>
        <Dot />
        <span className="tabular-nums">{cues.length} 条</span>
        {last && (<><Dot /><span className="tabular-nums">{stamp(last.end ?? last.start)}</span></>)}
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        <ol className="mx-auto max-w-2xl px-5 py-3">
          {shown.map((cue, i) => (
            <li key={i} className="flex gap-4 rounded-xl px-2 py-2 transition-colors hover:bg-surface-2/60">
              <span className={`${ext === 'lrc' ? 'w-12' : 'w-28'} shrink-0 pt-0.5 font-mono text-[11.5px] tabular-nums text-fg-faint`}>
                {stamp(cue.start)}{cue.end !== undefined ? ` → ${stamp(cue.end)}` : ''}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{cue.text || '♪'}</span>
            </li>
          ))}
          {shown.length === 0 && <p className="py-8 text-center text-[13px] text-fg-faint">{deferred ? '没有找到' : '没有读到字幕内容'}</p>}
        </ol>
      </div>
    </div>
  );
}
