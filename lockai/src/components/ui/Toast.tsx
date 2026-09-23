'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface ToastItem {
  id: number;
  message: string;
  tone?: 'default' | 'danger';
  action?: { label: string; onClick: () => void };
  duration?: number;
  /** 超时（没点 action）后执行，常用于"延迟删除" */
  onExpire?: () => void;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function toast(message: string, options: Omit<ToastItem, 'id' | 'message'> = {}) {
  const id = ++seq;
  // 被挤掉的旧提示也算"到期"，保证延迟删除之类的回调一定会执行
  const dropped = items.slice(0, -2);
  items = [...items.slice(-2), { id, message, ...options }];
  emit();
  for (const item of dropped) item.onExpire?.();
  return id;
}

export function dismissToast(id: number, { runExpire = false } = {}) {
  const item = items.find((t) => t.id === id);
  items = items.filter((t) => t.id !== id);
  emit();
  if (runExpire) item?.onExpire?.();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(item.id, { runExpire: true }), item.duration ?? 4200);
    return () => window.clearTimeout(timer);
  }, [item.id, item.duration]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pl-4 pr-2 text-sm shadow-pop animate-lock-in',
        item.tone === 'danger' && 'text-danger',
      )}
    >
      <span className="min-w-0 flex-1">{item.message}</span>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
          className="rounded-lg px-2.5 py-1 text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent-soft"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="关闭"
        onClick={() => dismissToast(item.id, { runExpire: true })}
        className="rounded-lg p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[300] flex flex-col items-center gap-2 px-4">
      {list.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
