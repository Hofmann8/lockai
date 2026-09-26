'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** 和 globals.css 里 duration 对应；收起后多等一点再卸载 */
const DURATION_MS = 240;

/**
 * 高度动画的展开 / 收起（grid-template-rows 0fr ↔ 1fr，不用量高度）。
 * 收起时内容淡出、高度收拢，动画结束才卸载；一开始就是展开的不做动画。
 * 高度逐帧变化，对话区的滚动锚定能每帧跟上，视口不会一下子跳。
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 先以收起的样子挂上，下一帧再展开，才有过渡
      const frame = window.requestAnimationFrame(() => setExpanded(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = window.setTimeout(() => setMounted(false), DURATION_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-[240ms]',
        // 展开干脆（先快后慢）；收起匀一些——在底部收起时上面的内容要往下挪，别在第一帧就挪一大截
        expanded ? 'grid-rows-[1fr] opacity-100 ease-[cubic-bezier(0.22,1,0.36,1)]' : 'grid-rows-[0fr] opacity-0 ease-[cubic-bezier(0.45,0,0.35,1)]',
      )}
      inert={!open}
    >
      <div className={cn('min-h-0 overflow-hidden', className)}>{children}</div>
    </div>
  );
}
