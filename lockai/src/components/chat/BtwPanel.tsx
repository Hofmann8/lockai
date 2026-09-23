'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CornerDownRight, Loader2, Square, X } from 'lucide-react';
import type { ChatMessage } from '@/types';
import { sendChatMessageStream } from '@/lib/api';
import { getAuthState } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { Markdown } from './Markdown';
import { LockMark } from '@/components/brand/LockMark';

interface Exchange {
  id: string;
  question: string;
  answer: string;
  status: 'streaming' | 'done' | 'error';
  note?: string;
}

interface BtwPanelProps {
  open: boolean;
  onClose: () => void;
  /** 划词带过来的上下文 */
  context: string | null;
  onClearContext: () => void;
  /** 主对话，作为背景一起发给模型（不会被修改） */
  history: ChatMessage[];
  modelId: string;
  /** 把旁支里的回答引用回主输入框 */
  onBringBack: (text: string) => void;
}

const HISTORY_LIMIT = 12;

/**
 * "顺便问一句"：在侧边小窗里问个旁支问题。
 * 不传 session_id，后端不会落库；关掉就没了，主对话完全不受影响。
 */
export function BtwPanel({ open, onClose, context, onClearContext, history, modelId, onBringBack }: BtwPanelProps) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [value, setValue] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streaming = exchanges.some((e) => e.status === 'streaming');

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, context]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback((id: string, fn: (e: Exchange) => Exchange) => {
    setExchanges((list) => list.map((e) => (e.id === id ? fn(e) : e)));
  }, []);

  const ask = async () => {
    const question = value.trim();
    if (!question || streaming) return;
    const id = crypto.randomUUID();
    const message = context
      ? `我在看你前面回答里的这段内容：\n\n> ${context.split('\n').join('\n> ')}\n\n顺便问一下：${question}`
      : question;
    // 旁支自己的来回也当作上下文
    const sideHistory: ChatMessage[] = exchanges
      .filter((e) => e.status === 'done')
      .flatMap((e) => [
        { id: `${e.id}-q`, role: 'user' as const, content: e.question, timestamp: new Date() },
        { id: `${e.id}-a`, role: 'assistant' as const, content: e.answer, timestamp: new Date() },
      ]);
    setExchanges((list) => [...list, { id, question, answer: '', status: 'streaming' }]);
    setValue('');

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await sendChatMessageStream(
        {
          message,
          history: [...history.slice(-HISTORY_LIMIT), ...sideHistory],
          model_id: modelId,
          user_id: getAuthState().user?.id,
          thinking: false,
        },
        (event) => {
          if (event.type === 'content_delta') patch(id, (e) => ({ ...e, answer: e.answer + event.delta, note: undefined }));
          else if (event.type === 'search_start') patch(id, (e) => ({ ...e, note: `正在搜索 ${event.query}` }));
          else if (event.type === 'search_end') patch(id, (e) => ({ ...e, note: undefined }));
          else if (event.type === 'image_gen_start') patch(id, (e) => ({ ...e, note: '正在画图' }));
          else if (event.type === 'image_gen_end' && event.success && event.url) {
            patch(id, (e) => ({ ...e, answer: `${e.answer}\n\n![图片](${event.url})\n\n`, note: undefined }));
          } else if (event.type === 'error') patch(id, (e) => ({ ...e, status: 'error', note: event.message }));
          else if (event.type === 'message_end') patch(id, (e) => (e.status === 'streaming' ? { ...e, status: 'done' } : e));
        },
        controller.signal,
      );
      patch(id, (e) => (e.status === 'streaming' ? { ...e, status: 'done' } : e));
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      patch(id, (e) => ({ ...e, status: aborted ? 'done' : 'error', note: aborted ? '已停止' : '网络出错了' }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="顺便问一句"
      className={cn(
        'fixed z-[120] flex flex-col overflow-hidden border border-line bg-surface shadow-pop',
        'inset-x-0 bottom-0 h-[78dvh] rounded-t-[28px] animate-rise',
        'md:inset-x-auto md:bottom-3 md:right-3 md:top-3 md:h-auto md:w-[400px] md:rounded-[28px] md:animate-lock-in',
      )}
    >
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">顺便问一句</h2>
          <p className="mt-0.5 text-xs text-fg-faint">小窗里聊，不打断、也不写进当前对话</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="-mr-1.5 rounded-xl p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4">
        {context && (
          <div className="flex items-start gap-2 rounded-2xl bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-fg-soft">
            <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="line-clamp-5 min-w-0 flex-1 whitespace-pre-wrap">{context}</span>
            <button type="button" aria-label="去掉引用" onClick={onClearContext} className="rounded-md p-0.5 text-fg-faint hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {exchanges.length === 0 && !context && (
          <p className="pt-6 text-center text-[13px] leading-relaxed text-fg-faint">
            看回答时冒出来的小问题，
            <br />
            在这里问掉就好。
          </p>
        )}
        {exchanges.map((e) => (
          <div key={e.id} className="space-y-2.5 animate-rise">
            <div className="flex justify-end">
              <p className="max-w-[88%] whitespace-pre-wrap rounded-[18px] rounded-br-md bg-surface-2 px-3.5 py-2 text-[14px] leading-relaxed text-fg">
                {e.question}
              </p>
            </div>
            {e.answer ? (
              <Markdown content={e.answer} streaming={e.status === 'streaming'} className="text-[14.5px]" />
            ) : e.status === 'streaming' ? (
              <div className="flex items-center gap-2 text-[13px]">
                <LockMark size={15} state="busy" className="text-fg" />
                <span className="shimmer-text">{e.note ?? '想一下'}</span>
              </div>
            ) : null}
            {e.note && e.answer && <p className="text-xs text-fg-faint">{e.note}</p>}
            {e.status === 'error' && <p className="text-xs text-danger">{e.note ?? '出错了'}</p>}
            {e.status === 'done' && e.answer && (
              <button
                type="button"
                onClick={() => onBringBack(e.answer)}
                className="flex items-center gap-1 text-[12px] text-fg-faint transition-colors hover:text-fg"
              >
                <CornerDownRight className="h-3 w-3" /> 引用到主对话
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-[20px] border border-line bg-bg px-3 py-2 focus-within:border-line-strong">
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={1}
            placeholder={context ? '关于这段，想问什么？' : '问点什么…'}
            className="min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-faint"
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="停止"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void ask()}
              disabled={!value.trim()}
              aria-label="发送"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg transition-opacity disabled:opacity-30"
            >
              {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
