'use client';

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  GitBranch,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import type { ChatMessage, ChatModel, SearchToolTrace, ToolTrace } from '@/types';
import { cn } from '@/lib/cn';
import { copyRich, copyText, markdownToPlain, messageMarkdown } from '@/lib/clipboard';
import { decomposeMessage } from '@/lib/chat/compose';
import { splitAssistantParts, type AssistantPart } from '@/lib/chat/traces';
import { Markdown } from './Markdown';
import { ImageCard, Lightbox, SearchCard, SearchGroup, Seconds, useElapsed } from './ToolCards';
import { LockMark } from '@/components/brand/LockMark';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';

/* ------------------------------------------------------------------ */
/* 小按钮 */
/* ------------------------------------------------------------------ */

function IconButton({
  label,
  onClick,
  children,
  active,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip label={label} side="bottom" disabled={active}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-xl text-fg-faint transition-[color,background-color,transform] duration-150 hover:bg-surface-2 hover:text-fg active:scale-90',
          active && 'bg-surface-2 text-fg',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function CopiedIcon({ copied }: { copied: boolean }) {
  return copied ? <Check className="h-4 w-4 text-ok animate-pop" /> : <Copy className="h-4 w-4" />;
}

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  return [
    copied,
    () => {
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    },
  ];
}

/** 某个状态第一次变成 true 的时刻（之后不再变） */
function useStartedAt(active: boolean): number | undefined {
  const [at, setAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (active && at === undefined) setAt(Date.now());
  }, [active, at]);
  return at;
}

function formatTime(value: Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ */
/* 用户消息 */
/* ------------------------------------------------------------------ */

interface UserMessageProps {
  message: ChatMessage;
  editing: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSubmit: (text: string) => void;
}

function UserMessageImpl({ message, editing, onEditStart, onEditCancel, onEditSubmit }: UserMessageProps) {
  const parts = useMemo(() => decomposeMessage(message.content), [message.content]);
  const [copied, markCopied] = useCopied();
  const [preview, setPreview] = useState<string | null>(null);
  const [openPaste, setOpenPaste] = useState<string | null>(null);
  const text = parts.text === '(图片)' ? '' : parts.text;
  const images = message.images ?? [];

  return (
    <div className="group/user flex flex-col items-end" data-message-id={message.id} data-role="user">
      {images.length > 0 && (
        <div className="mb-2 flex max-w-[80%] flex-wrap justify-end gap-2">
          {images.map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              onClick={() => setPreview(src)}
              className="overflow-hidden rounded-2xl border border-line transition-transform duration-200 hover:scale-[1.02]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`图片 ${i + 1}`} className="h-28 w-28 object-cover sm:h-36 sm:w-36" />
            </button>
          ))}
        </div>
      )}

      {editing ? (
        <EditBox initial={message.content === '(图片)' ? '' : message.content} onCancel={onEditCancel} onSubmit={onEditSubmit} />
      ) : (
        <>
          {parts.quotes.map((quote, i) => (
            <div
              key={i}
              className="mb-1.5 flex max-w-[80%] items-start gap-2 rounded-xl px-3 py-1.5 text-[13px] leading-relaxed text-fg-soft"
            >
              <CornerDownRight className="mt-[3px] h-3.5 w-3.5 shrink-0 text-fg-faint" />
              <span className="line-clamp-3 whitespace-pre-wrap">{quote}</span>
            </div>
          ))}
          {parts.pastes.map((paste) => (
            <button
              key={paste.id}
              type="button"
              onClick={() => setOpenPaste((v) => (v === paste.id ? null : paste.id))}
              className="mb-1.5 max-w-[80%] rounded-2xl border border-line bg-surface px-3.5 py-2 text-left text-[13px] text-fg-soft transition-colors hover:border-line-strong"
            >
              <span className="flex items-center gap-1.5">
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', openPaste === paste.id && 'rotate-90')} />
                粘贴的内容 · {paste.text.length} 字
              </span>
              {openPaste === paste.id ? (
                <span className="mt-2 block max-h-80 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fg">
                  {paste.text}
                </span>
              ) : (
                <span className="mt-1 line-clamp-2 block text-fg-faint">{paste.text.slice(0, 200)}</span>
              )}
            </button>
          ))}
          {text && (
            <div className="max-w-[85%] rounded-[22px] rounded-br-lg bg-surface-2 px-4 py-2.5 text-[15px] leading-[1.7] text-fg sm:max-w-[80%]">
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </div>
          )}
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
            <span className="mr-1 text-[11px] text-fg-faint">{formatTime(message.timestamp)}</span>
            <IconButton
              label="复制"
              onClick={async () => {
                if (await copyText(message.content)) markCopied();
              }}
            >
              <CopiedIcon copied={copied} />
            </IconButton>
            <IconButton label="编辑后重新发送" onClick={onEditStart}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </>
      )}
      {preview && <Lightbox url={preview} alt="图片" onClose={() => setPreview(null)} />}
    </div>
  );
}

function EditBox({ initial, onCancel, onSubmit }: { initial: string; onCancel: () => void; onSubmit: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [value]);

  const submit = () => {
    if (!value.trim()) return;
    onSubmit(value.trim());
  };

  return (
    <div className="w-full max-w-[85%] rounded-[22px] border border-line-strong bg-surface p-3 shadow-float animate-lock-in sm:max-w-[80%]">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        className="w-full resize-none bg-transparent px-1 text-[15px] leading-[1.7] text-fg outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="pl-1 text-[11.5px] text-fg-faint">之后的对话会被新的回答替换</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-xl px-3 text-[13px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="h-8 rounded-xl bg-ink px-3.5 text-[13px] font-medium text-ink-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

export const UserMessage = memo(UserMessageImpl);

/* ------------------------------------------------------------------ */
/* 思考过程 */
/* ------------------------------------------------------------------ */

function ReasoningBlock({ text, active, seconds }: { text: string; active: boolean; seconds?: number }) {
  const [open, setOpen] = useState(false);
  const startedAt = useStartedAt(active);
  const elapsed = useElapsed(startedAt, active);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 思考时自动跟到最新一行
  useEffect(() => {
    if (active && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [active, text]);

  if (!text && !active) return null;
  const expanded = active || open;
  const finalSeconds = seconds ?? 0;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => !active && setOpen((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          'flex items-center gap-1.5 text-[13.5px] transition-colors',
          active ? 'cursor-default' : 'text-fg-faint hover:text-fg-soft',
        )}
      >
        {active ? (
          <>
            <span className="shimmer-text">思考中</span>
            <Seconds value={elapsed} />
          </>
        ) : (
          <>
            <span>{finalSeconds > 0 ? `思考了 ${finalSeconds} 秒` : '思考过程'}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} />
          </>
        )}
      </button>
      {expanded && text && (
        <div
          ref={bodyRef}
          className={cn(
            'mt-2 border-l-2 border-line pl-4 text-[13.5px] leading-[1.75] text-fg-faint whitespace-pre-wrap animate-fade',
            active && 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_2.5rem)]',
            !active && 'max-h-[28rem] overflow-y-auto',
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 助手回答 */

type Block =
  | { type: 'text'; value: string; index: number }
  | { type: 'tool'; traceIdx: number; index: number }
  | { type: 'searches'; traceIdxs: number[]; index: number };

/** 连着的几次搜索合成一组，不然模型连搜五六次会把回答顶得老长 */
function groupSearches(parts: AssistantPart[], trace: ToolTrace[]): Block[] {
  const blocks: Block[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      blocks.push({ type: 'text', value: part.value, index });
      return;
    }
    const isSearch = trace[part.traceIdx]?.kind === 'search';
    const prev = blocks[blocks.length - 1];
    if (isSearch && prev && (prev.type === 'searches' || (prev.type === 'tool' && trace[prev.traceIdx]?.kind === 'search'))) {
      const idxs = prev.type === 'searches' ? prev.traceIdxs : [prev.traceIdx];
      blocks[blocks.length - 1] = { type: 'searches', traceIdxs: [...idxs, part.traceIdx], index };
      return;
    }
    blocks.push({ type: 'tool', traceIdx: part.traceIdx, index });
  });
  return blocks;
}

/* ------------------------------------------------------------------ */

function settlingLabel(trace: ToolTrace): string {
  if (trace.kind === 'search') return trace.success === false ? '搜索没成功，先按已知的回答' : '正在读搜索结果';
  if (trace.success === false) return '这张没画成，正在整理说明';
  return '主体已经出来了，正在补细节';
}

interface AssistantMessageProps {
  message: ChatMessage;
  streaming: boolean;
  /** 流式时还没提交进 message.content 的尾巴 */
  buffer?: string;
  liveReasoning?: string;
  reasoningActive?: boolean;
  thinking: boolean;
  isLast: boolean;
  models: ChatModel[];
  currentModelId: string;
  suggestions?: string[];
  onRegenerate: (modelId?: string) => void;
  onBranch: () => void;
  onSuggestion: (text: string) => void;
}

function AssistantMessageImpl({
  message,
  streaming,
  buffer = '',
  liveReasoning = '',
  reasoningActive = false,
  thinking,
  isLast,
  models,
  currentModelId,
  suggestions,
  onRegenerate,
  onBranch,
  onSuggestion,
}: AssistantMessageProps) {
  const content = streaming ? `${message.content}${buffer}` : message.content;
  const trace = useMemo(() => message.tool_trace ?? [], [message.tool_trace]);
  const parts = useMemo(() => splitAssistantParts(content, trace), [content, trace]);
  const reasoning = streaming ? liveReasoning : message.reasoning ?? '';
  const bodyRef = useRef<HTMLDivElement>(null);
  const copyAnchor = useRef<HTMLButtonElement>(null);
  const retryAnchor = useRef<HTMLButtonElement>(null);
  const [copyMenu, setCopyMenu] = useState(false);
  const [retryMenu, setRetryMenu] = useState(false);
  const [copied, markCopied] = useCopied();

  const hiddenImages = useMemo(
    () => trace.flatMap((t) => (t.kind === 'image_gen' && t.url ? [t.url] : [])),
    [trace],
  );

  const hasRunningTool = trace.some((t) => t.status === 'running');
  const waiting = streaming && !content.trim() && trace.length === 0 && !reasoning;
  const waitingSince = useStartedAt(waiting);
  const waitingSeconds = useElapsed(waitingSince, waiting);

  // 工具卡片后面还没有文字：说明模型在消化工具结果
  const lastTextIndex = parts.reduce((acc, p, i) => (p.type === 'text' ? i : acc), -1);
  const blocks = useMemo(() => groupSearches(parts, trace), [parts, trace]);

  const copyRichAnswer = async () => {
    const md = messageMarkdown(content);
    const nodes = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(':scope > [data-part="text"] > .md') ?? []);
    const html = nodes
      .map((node) => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[data-copy-skip]').forEach((el) => el.remove());
        return clone.outerHTML;
      })
      .join('');
    const ok = html ? await copyRich(html, markdownToPlain(md)) : await copyText(markdownToPlain(md));
    if (ok) markCopied();
  };

  const otherModels = models.filter((m) => m.available && m.id !== currentModelId);
  const showActions = !streaming && (content.trim() || trace.length > 0);

  return (
    <div className="group/assistant relative" data-message-id={message.id} data-role="assistant">
      {waiting ? (
        <div className="flex h-8 items-center gap-2.5 text-[13.5px]">
          <LockMark size={18} state="busy" className="text-fg" />
          <span className="shimmer-text">{thinking ? '思考中' : '正在组织回答'}</span>
          <Seconds value={waitingSeconds} />
        </div>
      ) : (
        <>
          {reasoning && <ReasoningBlock text={reasoning} active={streaming && reasoningActive} seconds={message.reasoning_seconds} />}
          {streaming && reasoning && !reasoningActive && !content.trim() && trace.length === 0 && (
            <div className="flex h-7 items-center gap-2.5 text-[13.5px]">
              <LockMark size={16} state="busy" className="text-fg" />
              <span className="shimmer-text">正在组织回答</span>
            </div>
          )}
          <div ref={bodyRef}>
            {blocks.map((block) => {
              if (block.type === 'text') {
                return (
                  <div key={`t-${block.index}`} data-part="text">
                    <Markdown
                      content={block.value}
                      streaming={streaming && block.index === parts.length - 1}
                      hiddenImageUrls={hiddenImages}
                    />
                  </div>
                );
              }
              const settlingFor = (item: ToolTrace) =>
                streaming && !hasRunningTool && block.index > lastTextIndex ? settlingLabel(item) : undefined;
              if (block.type === 'searches') {
                const items = block.traceIdxs.map((i) => trace[i]).filter((t): t is SearchToolTrace => t?.kind === 'search');
                const last = items[items.length - 1];
                return (
                  <div key={`s-${block.traceIdxs[0]}`} data-part="tool">
                    <SearchGroup traces={items} settlingLabel={last ? settlingFor(last) : undefined} />
                  </div>
                );
              }
              const item = trace[block.traceIdx];
              if (!item) return null;
              return (
                <div key={`tool-${block.traceIdx}`} data-part="tool">
                  {item.kind === 'search' ? (
                    <SearchCard trace={item} settlingLabel={settlingFor(item)} />
                  ) : (
                    <ImageCard trace={item} settlingLabel={settlingFor(item)} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {showActions && (
        <div
          className={cn(
            'mt-2 flex items-center gap-0.5 transition-opacity duration-200',
            isLast ? 'opacity-100' : 'opacity-0 group-hover/assistant:opacity-100 focus-within:opacity-100 max-md:opacity-100',
          )}
        >
          <IconButton label="复制" onClick={copyRichAnswer}>
            <CopiedIcon copied={copied} />
          </IconButton>
          <button
            ref={copyAnchor}
            type="button"
            aria-label="更多复制方式"
            onClick={() => setCopyMenu((v) => !v)}
            className="-ml-1 flex h-8 w-4 items-center justify-center rounded-lg text-fg-faint transition-colors hover:text-fg"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
          <Popover open={copyMenu} onOpenChange={setCopyMenu} anchor={copyAnchor} placement="bottom-start" className="w-52">
            <MenuItem
              label="复制（保留格式）"
              description="粘到文档、飞书里带排版"
              onSelect={() => {
                setCopyMenu(false);
                void copyRichAnswer();
              }}
            />
            <MenuItem
              label="复制 Markdown"
              description="原始 markdown 源"
              onSelect={async () => {
                setCopyMenu(false);
                if (await copyText(messageMarkdown(content))) toast('已复制 Markdown');
              }}
            />
          </Popover>

          <IconButton label="重新回答" onClick={() => setRetryMenu((v) => !v)} buttonRef={retryAnchor} active={retryMenu}>
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
          <Popover open={retryMenu} onOpenChange={setRetryMenu} anchor={retryAnchor} placement="bottom-start" className="w-60">
            <MenuItem
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label="重新回答"
              onSelect={() => {
                setRetryMenu(false);
                onRegenerate();
              }}
            />
            {otherModels.length > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>换个模型再答</MenuLabel>
                {otherModels.map((m) => (
                  <MenuItem
                    key={m.id}
                    label={m.name}
                    description={m.description}
                    onSelect={() => {
                      setRetryMenu(false);
                      onRegenerate(m.id);
                    }}
                  />
                ))}
              </>
            )}
          </Popover>

          <IconButton label="从这里分出新对话" onClick={onBranch}>
            <GitBranch className="h-3.5 w-3.5" />
          </IconButton>
          <span className="ml-1.5 text-[11px] text-fg-faint opacity-0 transition-opacity group-hover/assistant:opacity-100">
            {formatTime(message.timestamp)}
          </span>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-4 flex flex-col items-start gap-1.5">
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              style={{ animationDelay: `${i * 70}ms` }}
              className="group/sug flex max-w-full items-center gap-2 rounded-2xl border border-line px-3.5 py-1.5 text-left text-[13.5px] text-fg-soft transition-[color,border-color,background-color] duration-150 hover:border-line-strong hover:bg-surface hover:text-fg animate-rise"
            >
              <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-fg-faint transition-colors group-hover/sug:text-accent" />
              <span className="truncate">{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
