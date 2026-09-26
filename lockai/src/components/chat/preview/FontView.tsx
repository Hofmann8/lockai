'use client';

import { useEffect, useState } from 'react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, humanSize, Opening, PreviewFallback, ViewerBar } from './shared';

const SAMPLES = ['永和九年，岁在癸丑，暮春之初', 'The quick brown fox jumps over the lazy dog', '锁住每一个瞬间 LOCK 2026'];
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@#%?!¥$€（）《》“”，。、：；天地玄黄宇宙洪荒日月盈昃辰宿列张'.split('');
const SIZES = [14, 20, 28, 40, 56, 80];

/** 字体：像字体网站的样张页，能改示例文字、调字号，看常用字形 */
export default function FontView({ file }: { file: FileArtifact }) {
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [sample, setSample] = useState(SAMPLES[0]);
  const [size, setSize] = useState(40);

  useEffect(() => {
    if (!file.url) return;
    let cancelled = false;
    const name = `preview-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(name, `url(${JSON.stringify(file.url)})`);
    face.load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setFamily(name);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [file.url]);

  if (failed) return <PreviewFallback file={file} note="字体没能加载出来，可以下载后安装查看" />;
  if (!family) return <Opening label="正在加载字体" />;
  const font = { fontFamily: `"${family}", sans-serif` };
  const title = file.name.split('/').pop()!.replace(/\.[^.]+$/, '');

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <div className="flex items-center gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                className={cn('h-6 rounded-md px-1.5 text-[11.5px] tabular-nums transition-colors', size === s ? 'bg-surface-2 text-fg' : 'text-fg-faint hover:text-fg')}
              >
                {s}
              </button>
            ))}
          </div>
        }
      >
        <span className="font-medium text-fg-soft">{fileExt(file.name).toUpperCase()} 字体</span>
        {file.size ? (<><Dot /><span>{humanSize(file.size)}</span></>) : null}
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <p className="text-[12px] tracking-wide text-fg-faint">{title}</p>
          <p style={{ ...font, fontSize: 64, lineHeight: 1.15 }} className="mt-2 break-words text-fg">Aa 永</p>

          <div className="mt-8 flex flex-wrap gap-1.5">
            {SAMPLES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSample(s)}
                className={cn('rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors', sample === s ? 'border-line-strong text-fg' : 'border-line text-fg-faint hover:text-fg')}
              >
                {s.slice(0, 10)}…
              </button>
            ))}
          </div>
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            rows={2}
            spellCheck={false}
            style={{ ...font, fontSize: size, lineHeight: 1.3 }}
            className="mt-3 w-full resize-none rounded-2xl border border-transparent bg-transparent px-0 py-2 text-fg outline-none transition-colors focus:border-line focus:px-3"
          />

          <div className="mt-8 space-y-3 border-t border-line pt-6">
            {[12, 16, 24].map((s) => (
              <div key={s} className="flex items-baseline gap-4">
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-fg-faint">{s}</span>
                <p style={{ ...font, fontSize: s }} className="min-w-0 truncate text-fg">{sample || SAMPLES[0]}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1.5 border-t border-line pt-6">
            {GLYPHS.map((g, i) => (
              <span key={i} style={font} className="flex aspect-square items-center justify-center rounded-xl bg-surface-2/60 text-[26px] text-fg transition-colors hover:bg-surface-2">
                {g}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
