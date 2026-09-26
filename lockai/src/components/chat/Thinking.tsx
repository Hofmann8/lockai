'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';
import { useElapsed } from './ToolCards';

/** 1284 → "1.3k"，842 → "842" */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

/** 数字变化时从旧值滚到新值（token 数是一轮轮累加上来的） */
function useTweened(target: number | undefined, duration = 520): number | undefined {
  const [shown, setShown] = useState(target);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target === undefined) return;
    const start = performance.now();
    const origin = from.current;
    if (origin === target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const value = Math.round(origin + (target - origin) * eased);
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, target]);
  return shown;
}

/** 两道并行细竖线（锁孔的母题）：想的时候按"抬—停—落—停"的切分节奏起伏 */
function ThinkBars({ active }: { active: boolean }) {
  return (
    <span className="think-bars" data-active={active} aria-hidden>
      <span />
      <span />
    </span>
  );
}

interface ThinkingChipProps {
  /** 正在想：显示实时秒数 */
  active: boolean;
  /** 开始想的时刻（active 时用来走秒） */
  startedAt?: number;
  seconds?: number;
  tokens?: number;
}

/**
 * 思考只显示用时和 token 数，不展开思考内容。
 * 想的时候是"思考中 8s"，想完定格成"思考 12 秒 · 1.3k tokens"，token 数后到时从旧值滚上来。
 */
export function ThinkingChip({ active, startedAt, seconds, tokens }: ThinkingChipProps) {
  const elapsed = useElapsed(startedAt, active);
  const shownTokens = useTweened(tokens);
  const finalSeconds = Math.max(1, seconds ?? 0);

  if (active) {
    return (
      <div className="mb-2.5 flex h-6 items-center gap-2 text-[13px]" role="status" aria-live="polite">
        <ThinkBars active />
        <span className="shimmer-text">思考中</span>
        {elapsed > 0 && <span className="tabular-nums text-fg-faint">{elapsed}s</span>}
      </div>
    );
  }

  const detail = [`思考用时 ${finalSeconds} 秒`, tokens ? `${tokens.toLocaleString('zh-CN')} 个思考 token` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mb-2.5 flex h-6 items-center">
      <Tooltip label={detail} side="bottom">
        <span className="flex items-center gap-2 text-[13px] text-fg-faint">
          <ThinkBars active={false} />
          <span>
            思考 <span className="tabular-nums">{finalSeconds}</span> 秒
          </span>
          {shownTokens !== undefined && shownTokens > 0 && (
            <>
              <span className="h-[3px] w-[3px] rounded-full bg-line-strong" aria-hidden />
              <span className={cn('tabular-nums animate-fade')}>{compactCount(shownTokens)} tokens</span>
            </>
          )}
        </span>
      </Tooltip>
    </div>
  );
}
