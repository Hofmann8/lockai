'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'top' | 'bottom';

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  placement?: Placement;
  offset?: number;
  className?: string;
  children: ReactNode;
}

interface Position {
  top: number;
  left: number;
  origin: string;
}

const EDGE = 8;

export function Popover({
  open,
  onOpenChange,
  anchor,
  placement = 'bottom-start',
  offset = 8,
  className,
  children,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    const panel = panelRef.current;
    if (!a || !panel) return;
    const r = a.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const wantTop = placement.startsWith('top');
    const roomAbove = r.top - offset - EDGE;
    const roomBelow = window.innerHeight - r.bottom - offset - EDGE;
    const top = wantTop
      ? (roomAbove >= h || roomAbove > roomBelow ? r.top - offset - h : r.bottom + offset)
      : (roomBelow >= h || roomBelow > roomAbove ? r.bottom + offset : r.top - offset - h);
    let left = placement.endsWith('end')
      ? r.right - w
      : placement === 'top' || placement === 'bottom'
        ? r.left + r.width / 2 - w / 2
        : r.left;
    left = Math.min(Math.max(EDGE, left), window.innerWidth - w - EDGE);
    const opensUp = top < r.top;
    const originX = placement.endsWith('end') ? 'right' : placement === 'top' || placement === 'bottom' ? 'center' : 'left';
    setPos({ top: Math.max(EDGE, top), left, origin: `${originX} ${opensUp ? 'bottom' : 'top'}` });
  }, [anchor, offset, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, onOpenChange, open, place]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        transformOrigin: pos?.origin,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-[200] rounded-2xl border border-line bg-surface p-1.5 shadow-pop',
        pos && 'animate-pop',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function MenuItem({ icon, label, hint, description, danger, active, disabled, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'group/item flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13.5px] transition-colors',
        'disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-surface-2',
        active && 'bg-surface-2',
      )}
    >
      {icon && <span className={cn('mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center', danger ? '' : 'text-fg-soft')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-snug text-fg-faint">{description}</span>}
      </span>
      {hint && <span className="mt-[1px] shrink-0 text-xs text-fg-faint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="mx-2 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium tracking-wide text-fg-faint">{children}</div>;
}
