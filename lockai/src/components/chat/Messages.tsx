'use client';

import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import type { ChatMessage, ChatModel, SearchToolTrace, ShellToolTrace, TaskToolTrace, ToolTrace } from '@/types';
import { cn } from '@/lib/cn';
import { copyRich, copyText, markdownToPlain, messageMarkdown } from '@/lib/clipboard';
import { decomposeMessage } from '@/lib/chat/compose';
import { splitAssistantParts, type AssistantPart } from '@/lib/chat/traces';
import { messageFiles } from '@/lib/chat/artifacts';
import { Markdown } from './Markdown';
import { ImageCard, Lightbox, SearchCard, SearchGroup, Seconds, useElapsed } from './ToolCards';
import { Deliverables, ShellGroup, TaskCard } from './WorkCards';
import { UploadList } from './UploadTree';
import { ThinkingChip } from './Thinking';
import type { LiveThinking } from '@/lib/chat/useChatController';
import { LockMark } from '@/components/brand/LockMark';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { useHoldAnchor } from '@/lib/hooks/useScrollAnchor';

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

const STALL_MS = 2500;

/** signal 上一次变化到现在过了多久（毫秒），active 时每半秒刷新 */
function useQuietFor(signal: string | number, active: boolean): number {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setSince(at);
    setNow(at);
  }, [signal]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);
  return active ? Math.max(0, now - since) : 0;
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
  const holdAnchor = useHoldAnchor();
  const text = parts.text === '(图片)' || parts.text === '(附件)' ? '' : parts.text;
  const images = message.images ?? [];
  const files = message.files ?? [];

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

      {files.length > 0 && (
        <div className="mb-2 flex max-w-[80%] flex-wrap justify-end gap-2">
          <UploadList files={files} />
        </div>
      )}

      {editing ? (
        <EditBox initial={text ? message.content : ''} onCancel={onEditCancel} onSubmit={onEditSubmit} />
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
              onClick={(e) => {
                holdAnchor(e.currentTarget);
                setOpenPaste((v) => (v === paste.id ? null : paste.id));
              }}
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
/* 助手回答 */

type Block =
  | { type: 'text'; value: string; index: number }
  | { type: 'tool'; traceIdx: number; index: number }
  | { type: 'searches'; traceIdxs: number[]; index: number }
  | { type: 'shells'; traceIdxs: number[]; index: number }
  /** 派给执行助手的一块工作，连同它做的每一步 */
  | { type: 'task'; traceIdx: number; stepIdxs: number[]; index: number };

/**
 * 连着的几次搜索合成一组，不然模型连搜五六次会把回答顶得老长；
 * 沙箱命令哪怕只有一步也放进"工作过程"，连着的几步是一条时间线。
 */
function groupTools(parts: AssistantPart[], trace: ToolTrace[]): Block[] {
  const blocks: Block[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      blocks.push({ type: 'text', value: part.value, index });
      return;
    }
    const item = trace[part.traceIdx];
    const kind = item?.kind;
    const prev = blocks[blocks.length - 1];
    if (kind === 'task') {
      blocks.push({ type: 'task', traceIdx: part.traceIdx, stepIdxs: [], index });
      return;
    }
    // 执行助手的步骤收进它所属的那块工作
    if (item?.kind === 'shell' && item.taskId) {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const b = blocks[i];
        if (b.type === 'task' && (trace[b.traceIdx] as TaskToolTrace | undefined)?.id === item.taskId) {
          blocks[i] = { ...b, stepIdxs: [...b.stepIdxs, part.traceIdx] };
          return;
        }
      }
    }
    if (kind === 'shell') {
      if (prev?.type === 'shells') blocks[blocks.length - 1] = { ...prev, traceIdxs: [...prev.traceIdxs, part.traceIdx], index };
      else blocks.push({ type: 'shells', traceIdxs: [part.traceIdx], index });
      return;
    }
    if (kind === 'search' && prev && (prev.type === 'searches' || (prev.type === 'tool' && trace[prev.traceIdx]?.kind === 'search'))) {
      const idxs = prev.type === 'searches' ? prev.traceIdxs : [prev.traceIdx];
      blocks[blocks.length - 1] = { type: 'searches', traceIdxs: [...idxs, part.traceIdx], index };
      return;
    }
    blocks.push({ type: 'tool', traceIdx: part.traceIdx, index });
  });
  return blocks;
}

function blockKey(block: Block): string {
  if (block.type === 'text') return `t-${block.index}`;
  if (block.type === 'tool') return `tool-${block.traceIdx}`;
  if (block.type === 'task') return `task-${block.traceIdx}`;
  return `${block.type === 'shells' ? 'sh' : 's'}-${block.traceIdxs[0]}`;
}

/* ------------------------------------------------------------------ */

function settlingLabel(trace: ToolTrace): string {
  if (trace.kind === 'task') return trace.success === false ? '这块工作没做完，正在想办法' : '正在看执行报告，想下一步';
  if (trace.kind === 'search') return trace.success === false ? '搜索没成功，先按已知的回答' : '正在读搜索结果';
  if (trace.kind === 'shell') return trace.success === false ? '这一步出错了，正在排查' : '正在看结果，想下一步';
  if (trace.success === false) return '这张没画成，正在整理说明';
  return '主体已经出来了，正在补细节';
}

interface AssistantMessageProps {
  message: ChatMessage;
  streaming: boolean;
  /** 流式时还没提交进 message.content 的尾巴 */
  buffer?: string;
  liveThinking?: LiveThinking | null;
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
  liveThinking = null,
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
  const waiting = streaming && !content.trim() && trace.length === 0;
  const waitingSince = useStartedAt(waiting);
  const waitingSeconds = useElapsed(waitingSince, waiting);

  // 思考：生成中看实时状态，生成完看存下来的用时 / token 数
  const live = streaming ? liveThinking : null;
  const thinkingNow = Boolean(live && live.endedAt === null);
  const thoughtSeconds = streaming
    ? live?.stats?.seconds ?? (live?.sawReasoning && live.endedAt ? Math.round((live.endedAt - live.startedAt) / 1000) : undefined)
    : message.reasoning_seconds;
  const thoughtTokens = streaming ? live?.stats?.tokens : message.reasoning_tokens;
  const showThought = !thinkingNow && Boolean(thoughtSeconds || thoughtTokens);

  const blocks = useMemo(() => groupTools(parts, trace), [parts, trace]);
  const lastBlock = blocks[blocks.length - 1];
  // 最后一块是工具、后面还没有文字：模型在消化工具结果、写下一步
  const settling = streaming && !hasRunningTool && lastBlock?.type !== 'text';
  const lastTool = lastBlock && lastBlock.type !== 'text'
    ? trace[lastBlock.type === 'tool' || lastBlock.type === 'task' ? lastBlock.traceIdx : lastBlock.traceIdxs[lastBlock.traceIdxs.length - 1]]
    : undefined;
  // 两步之间模型不出声的那段（在想、或者在把一大段正文写进下一条命令，中转会攒到最后一起发）：
  // 底部一行持续计时，别让界面看起来停住了。这段时间事后记到写出来的那一步上（prepSeconds）
  const doneCount = trace.filter((t) => t.status === 'done').length;
  const quietMs = useQuietFor(`${content.length}:${trace.length}:${doneCount}`, streaming && !waiting);
  const imageSettling = settling && lastTool?.kind === 'image_gen';
  const idle = streaming && !waiting && !hasRunningTool && !imageSettling && (settling || quietMs >= STALL_MS);
  const idleLabel = settling && lastTool ? settlingLabel(lastTool) : '正在准备下一步';

  // 这条回答交付的全部文件放在最后一个工具块后面（工作过程 → 交付物 → 正文），不再跟着每一组走
  const files = useMemo(() => messageFiles({ ...message, tool_trace: trace }), [message, trace]);
  let lastToolAt = -1;
  blocks.forEach((b, i) => { if (b.type !== 'text') lastToolAt = i; });
  // 回答还在进行时，最后一个工具块如果是沙箱工作过程 / 派出去的一块工作，就是"正在做"的那张卡
  const liveType = streaming ? blocks[lastToolAt]?.type : undefined;
  const liveShellsAt = liveType === 'shells' ? lastToolAt : -1;
  const liveTaskAt = liveType === 'task' ? lastToolAt : -1;
  // 它后面还没有正文时，"在想下一步"显示在卡片标题上，不在底部另起一行
  const idleInCard = liveShellsAt >= 0 && liveShellsAt === blocks.length - 1;

  const copyRichAnswer = async () => {
    const md = messageMarkdown(content);
    const nodes = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(':scope > [data-part="text"] > .md') ?? []);
    const html = nodes
      .map((node) => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[data-copy-skip]').forEach((el) => el.remove());
        // 渲染时为了让粗体认得中文标点插过零宽空格，复制出去不要带上
        return clone.outerHTML.replace(/​/g, '');
      })
      .join('');
    const ok = html ? await copyRich(html, markdownToPlain(md)) : await copyText(markdownToPlain(md));
    if (ok) markCopied();
  };

  const otherModels = models.filter((m) => m.available && m.id !== currentModelId);
  const showActions = !streaming && (content.trim() || trace.length > 0);

  const renderBlock = (block: Block, at: number): ReactNode => {
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
    if (block.type === 'searches') {
      const items = block.traceIdxs.map((i) => trace[i]).filter((t): t is SearchToolTrace => t?.kind === 'search');
      return (
        <div key={`s-${block.traceIdxs[0]}`} data-part="tool">
          <SearchGroup traces={items} />
        </div>
      );
    }
    if (block.type === 'shells') {
      const steps = block.traceIdxs.map((i) => trace[i]).filter((t): t is ShellToolTrace => t?.kind === 'shell');
      return (
        <div key={`sh-${block.traceIdxs[0]}`} data-part="tool">
          <ShellGroup
            steps={steps}
            live={at === liveShellsAt}
            idle={at === liveShellsAt && idleInCard && idle ? { label: idleLabel, seconds: Math.floor(quietMs / 1000) } : undefined}
          />
        </div>
      );
    }
    if (block.type === 'task') {
      const task = trace[block.traceIdx];
      if (task?.kind !== 'task') return null;
      const steps = block.stepIdxs.map((i) => trace[i]).filter((t): t is ShellToolTrace => t?.kind === 'shell');
      return (
        <div key={`task-${block.traceIdx}`} data-part="tool">
          <TaskCard task={task} steps={steps} live={at === liveTaskAt} />
        </div>
      );
    }
    const item = trace[block.traceIdx];
    if (!item || item.kind === 'shell' || item.kind === 'task') return null;
    return (
      <div key={`tool-${block.traceIdx}`} data-part="tool">
        {item.kind === 'search' ? (
          <SearchCard trace={item} />
        ) : (
          // 画图有自己的收尾状态（先出主体再补细节），不走底部那行
          <ImageCard trace={item} settlingLabel={imageSettling && block === lastBlock ? settlingLabel(item) : undefined} />
        )}
      </div>
    );
  };

  return (
    <div className="group/assistant relative" data-message-id={message.id} data-role="assistant">
      {waiting && thinkingNow ? (
        <ThinkingChip active startedAt={live?.startedAt} />
      ) : waiting ? (
        <div className="flex h-8 items-center gap-2.5 text-[13.5px]">
          <LockMark size={18} state="busy" className="text-fg" />
          <span className="shimmer-text">{thinking ? '思考中' : '正在组织回答'}</span>
          <Seconds value={waitingSeconds} />
        </div>
      ) : (
        <>
          {showThought && <ThinkingChip active={false} seconds={thoughtSeconds} tokens={thoughtTokens} />}
          <div ref={bodyRef}>
            {blocks.map((block, at) => (
              <Fragment key={blockKey(block)}>
                {renderBlock(block, at)}
                {at === lastToolAt && files.length > 0 && <Deliverables files={files} live={streaming} />}
              </Fragment>
            ))}
          </div>
          {idle && !idleInCard && (
            <div className="mt-1 flex h-8 items-center gap-2.5 text-[13.5px] animate-fade">
              <LockMark size={18} state="busy" className="text-fg" />
              <span className="shimmer-text">{idleLabel}</span>
              <Seconds value={Math.floor(quietMs / 1000)} />
            </div>
          )}
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
