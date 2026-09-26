'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import type { CapacityPrompt } from '@/lib/chat/useChatController';
import { cn } from '@/lib/cn';

function elapsedLabel(startedAt: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60000);
  if (minutes < 1) return '刚开始';
  if (minutes < 60) return `已进行 ${minutes} 分钟`;
  return `已进行 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 同时回答的对话满了：选一条先停下，默认跑得最久的那条 */
export function RunPicker({
  prompt,
  onResolve,
}: {
  prompt: CapacityPrompt | null;
  onResolve: (sessionId: string | null) => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!prompt) return;
    setChoice(prompt.runs[0]?.session_id ?? null);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [prompt]);

  return (
    <Dialog open={Boolean(prompt)} onClose={() => onResolve(null)} title="同时进行的对话已满" className="max-w-[440px]">
      {prompt && (
        <div className="px-6 pb-5">
          <p className="text-[12.5px] leading-relaxed text-fg-soft">
            最多同时进行 {prompt.limit} 段对话。选一段先停下，已经做好的部分都会保留，之后回到那段对话说「继续」就能接着做。
          </p>
          <div role="radiogroup" className="mt-4 space-y-1.5">
            {prompt.runs.map((run, i) => {
              const active = choice === run.session_id;
              return (
                <button
                  key={run.session_id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-autofocus={i === 0 ? true : undefined}
                  onClick={() => setChoice(run.session_id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-line',
                    active ? 'border-line-strong bg-surface shadow-soft' : 'border-line hover:border-line-strong hover:bg-surface-2/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                      active ? 'border-ink bg-ink' : 'border-line-strong',
                    )}
                  >
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-ink-fg animate-pop" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">{run.title || '新对话'}</span>
                    <span className="mt-0.5 block text-[11.5px] tabular-nums text-fg-faint">
                      {elapsedLabel(run.started_at, now)}
                      {i === 0 && prompt.runs.length > 1 ? ' · 最久' : ''}
                    </span>
                  </span>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-breathe" aria-hidden />
                </button>
              );
            })}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onResolve(null)}
              className="rounded-full px-4 py-2 text-[13px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
            >
              先不发
            </button>
            <button
              type="button"
              disabled={!choice}
              onClick={() => onResolve(choice)}
              className="rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-ink-fg transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-40"
            >
              停下它，发送
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
