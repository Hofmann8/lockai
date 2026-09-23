'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Copy, CornerDownRight, MessageCircleQuestion } from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/components/ui/Toast';

interface SelectionPopoverProps {
  container: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
  onAsk: (text: string) => void;
}

/** 在回答里划词后浮出的小工具条：引用回复 / 顺便问 / 复制 */
export function SelectionPopover({ container, onQuote, onAsk }: SelectionPopoverProps) {
  const [state, setState] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    const read = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setState(null);
        return;
      }
      const text = selection.toString().trim();
      const range = selection.getRangeAt(0);
      const host = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!text || !host || !root.contains(host) || !host.closest('[data-message-id]') || host.closest('textarea, input')) {
        setState(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const below = rect.top < 72;
      setState({
        text: text.slice(0, 2000),
        x: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
        y: below ? rect.bottom + 10 : rect.top - 10,
        below,
      });
    };

    const onUp = (e: Event) => {
      if (barRef.current?.contains(e.target as Node)) return;
      // 等浏览器把选区定下来
      window.setTimeout(read, 0);
    };
    const onDown = (e: Event) => {
      if (barRef.current?.contains(e.target as Node)) return;
      setState(null);
    };
    const onScroll = () => setState(null);

    root.addEventListener('mouseup', onUp);
    root.addEventListener('keyup', onUp);
    root.addEventListener('touchend', onUp);
    document.addEventListener('mousedown', onDown);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('mouseup', onUp);
      root.removeEventListener('keyup', onUp);
      root.removeEventListener('touchend', onUp);
      document.removeEventListener('mousedown', onDown);
      root.removeEventListener('scroll', onScroll);
    };
  }, [container]);

  if (!state || typeof document === 'undefined') return null;

  const done = () => {
    window.getSelection()?.removeAllRanges();
    setState(null);
  };

  const btn = 'flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[13px] text-ink-fg/90 transition-colors hover:bg-ink-fg/10 hover:text-ink-fg';

  return createPortal(
    <div
      ref={barRef}
      style={{
        position: 'fixed',
        left: state.x,
        top: state.y,
        transform: state.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
      className="z-[220] flex items-center gap-0.5 rounded-2xl bg-ink p-1 shadow-pop animate-pop"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className={btn} onClick={() => { onQuote(state.text); done(); }}>
        <CornerDownRight className="h-3.5 w-3.5" /> 引用
      </button>
      <button type="button" className={btn} onClick={() => { onAsk(state.text); done(); }}>
        <MessageCircleQuestion className="h-3.5 w-3.5" /> 顺便问
      </button>
      <span className="mx-0.5 h-4 w-px bg-ink-fg/15" />
      <button
        type="button"
        className={btn}
        aria-label="复制"
        onClick={async () => {
          if (await copyText(state.text)) toast('已复制');
          done();
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>,
    document.body,
  );
}
