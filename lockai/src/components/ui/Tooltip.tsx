'use client';

import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'right';
  children: ReactNode;
  disabled?: boolean;
}

/** 悬停 400ms 后出现的小提示。不挡点击，不抢焦点。 */
export function Tooltip({ label, side = 'top', children, disabled }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    if (disabled) return;
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      if (side === 'right') setPos({ x: r.right + 8, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: side === 'top' ? r.top - 8 : r.bottom + 8 });
    }, 400);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  };

  // 被禁用（比如按钮打开了菜单）时立即收起
  if (disabled && pos) {
    setPos(null);
  }

  const transform =
    side === 'right' ? 'translate(0, -50%)' : side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';

  return (
    <span
      ref={ref}
      className="inline-flex"
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos && typeof document !== 'undefined' && createPortal(
        <span
          role="tooltip"
          style={{ position: 'fixed', left: pos.x, top: pos.y, transform }}
          className="pointer-events-none z-[400] whitespace-nowrap rounded-lg bg-ink px-2 py-1 text-xs text-ink-fg shadow-float animate-fade"
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}
