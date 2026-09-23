'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 顶部对齐（命令面板）还是居中 */
  align?: 'center' | 'top';
  hideClose?: boolean;
}

export function Dialog({ open, onClose, title, children, className, align = 'center', hideClose }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const focusTarget = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panelRef.current;
    focusTarget?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[250] flex justify-center px-4',
        align === 'top' ? 'items-start pt-[14vh]' : 'items-center',
      )}
    >
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px] animate-fade" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'relative w-full max-w-md rounded-3xl border border-line bg-surface shadow-pop outline-none animate-lock-in',
          className,
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between px-6 pb-1 pt-5">
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="-mr-2 rounded-xl p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
