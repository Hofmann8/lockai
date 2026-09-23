'use client';

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  CornerDownRight,
  FileText,
  ImagePlus,
  ListPlus,
  Mic,
  MessageCircleQuestion,
  Plus,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import type { ChatModel, ThinkingLevel } from '@/types';
import { cn, modKey } from '@/lib/cn';
import { ACCEPTED_IMAGE_TYPES, compressImage } from '@/lib/image';
import { EMPTY_DRAFT, isDraftEmpty, LONG_PASTE_THRESHOLD, type ComposerDraft } from '@/lib/chat/compose';
import type { QueuedMessage } from '@/lib/chat/useChatController';
import { useVoiceInput } from '@/lib/hooks/useVoiceInput';
import { MenuItem, MenuLabel, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';

const MAX_IMAGES = 4;

export interface ComposerHandle {
  focus: () => void;
  addQuote: (text: string) => void;
  addFiles: (files: File[]) => void;
  setText: (text: string) => void;
}

interface ComposerProps {
  handleRef?: Ref<ComposerHandle>;
  variant: 'hero' | 'dock';
  busy: boolean;
  models: ChatModel[];
  selectedModelId: string;
  onModelChange: (id: string) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  thinkingLocked: boolean;
  supportsReasoningEffort: boolean;
  effectiveThinking: boolean;
  queue: QueuedMessage[];
  onSend: (draft: ComposerDraft) => void;
  onQueue: (draft: ComposerDraft) => void;
  onSteer: (draft: ComposerDraft) => void;
  onStop: () => void;
  onRemoveQueued: (id: string) => void;
  onSendQueuedNow: (id: string) => void;
  onEditLast: () => void;
  onOpenBtw: () => void;
}

function queuePreview(draft: ComposerDraft) {
  return draft.text.trim() || draft.quotes[0] || (draft.images.length ? `${draft.images.length} 张图片` : '粘贴的内容');
}

export function Composer({
  handleRef,
  variant,
  busy,
  models,
  selectedModelId,
  onModelChange,
  thinkingLevel,
  onThinkingChange,
  thinkingLocked,
  supportsReasoningEffort,
  effectiveThinking,
  queue,
  onSend,
  onQueue,
  onSteer,
  onStop,
  onRemoveQueued,
  onSendQueuedNow,
  onEditLast,
  onOpenBtw,
}: ComposerProps) {
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [modelMenu, setModelMenu] = useState(false);
  const [thinkMenu, setThinkMenu] = useState(false);
  const [plusMenu, setPlusMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelAnchor = useRef<HTMLButtonElement>(null);
  const thinkAnchor = useRef<HTMLButtonElement>(null);
  const plusAnchor = useRef<HTMLButtonElement>(null);

  const voice = useVoiceInput(useCallback((text: string) => setDraft((d) => ({ ...d, text })), []));
  const empty = isDraftEmpty(draft);
  const selectedModel = models.find((m) => m.id === selectedModelId);
  const alwaysThinks = selectedModel?.thinking_mode === 'always';
  const neverThinks = selectedModel?.thinking_mode === 'never';

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft.text, variant]);

  useEffect(() => {
    // 桌面端进来就能打字；手机上不抢焦点，避免弹键盘
    if (window.matchMedia('(pointer: fine)').matches) textRef.current?.focus();
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const room = MAX_IMAGES - draft.images.length;
    if (room <= 0) {
      toast(`一次最多 ${MAX_IMAGES} 张图片`);
      return;
    }
    if (images.length > room) toast(`一次最多 ${MAX_IMAGES} 张图片，多出来的没有加上`);
    const urls = await Promise.all(images.slice(0, room).map((f) => compressImage(f)));
    setDraft((d) => ({ ...d, images: [...d.images, ...urls].slice(0, MAX_IMAGES) }));
    textRef.current?.focus();
  }, [draft.images.length]);

  useImperativeHandle(handleRef, () => ({
    focus: () => textRef.current?.focus(),
    addQuote: (text: string) => {
      setDraft((d) => (d.quotes.includes(text) ? d : { ...d, quotes: [...d.quotes, text] }));
      window.requestAnimationFrame(() => textRef.current?.focus());
    },
    addFiles: (files: File[]) => void addFiles(files),
    setText: (text: string) => {
      setDraft((d) => ({ ...d, text }));
      window.requestAnimationFrame(() => textRef.current?.focus());
    },
  }), [addFiles]);

  const reset = () => setDraft(EMPTY_DRAFT);

  const submit = (mode: 'auto' | 'steer' = 'auto') => {
    if (empty || voice.recording) return;
    if (busy) {
      if (mode === 'steer') onSteer(draft);
      else onQueue(draft);
    } else {
      onSend(draft);
    }
    reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey ? 'steer' : 'auto');
      return;
    }
    if (e.key === 'ArrowUp' && empty && !busy) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key === 'Backspace' && !draft.text && (draft.quotes.length || draft.pastes.length)) {
      // 输入框空时退格先删掉最后一个附件块
      e.preventDefault();
      setDraft((d) => (d.pastes.length ? { ...d, pastes: d.pastes.slice(0, -1) } : { ...d, quotes: d.quotes.slice(0, -1) }));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.length > LONG_PASTE_THRESHOLD) {
      e.preventDefault();
      setDraft((d) => ({ ...d, pastes: [...d.pastes, { id: crypto.randomUUID(), text }] }));
      toast(`长文本已收成附件（${text.length} 字）`);
    }
  };

  const thinkingLabel = !effectiveThinking ? '快速' : supportsReasoningEffort && thinkingLevel === 'deep' ? '深度思考' : '思考';
  const hero = variant === 'hero';

  const hint = busy
    ? empty
      ? `回答中 · Esc 停止`
      : `Enter 排队 · ${modKey()} Enter 打断并发送`
    : voice.recording
      ? '正在听…说完点右边停止'
      : 'Enter 发送 · Shift Enter 换行';

  return (
    <div className="relative">
      {queue.length > 0 && (
        <div className="mx-3 mb-[-1px] space-y-1 rounded-t-2xl border border-b-0 border-line bg-surface/80 px-3 pb-2 pt-2.5 backdrop-blur-sm animate-rise">
          {queue.map((item, i) => (
            <div key={item.id} className="flex items-center gap-2 text-[13px]">
              <span className="shrink-0 text-[11px] text-fg-faint">{i === 0 ? '下一条' : `第 ${i + 1} 条`}</span>
              <span className="min-w-0 flex-1 truncate text-fg-soft">{queuePreview(item.draft)}</span>
              <button
                type="button"
                onClick={() => onSendQueuedNow(item.id)}
                className="shrink-0 rounded-lg px-2 py-0.5 text-[12px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
              >
                现在就发
              </button>
              <button
                type="button"
                aria-label="移出队列"
                onClick={() => onRemoveQueued(item.id)}
                className="shrink-0 rounded-lg p-1 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          'relative rounded-[26px] border bg-surface transition-[border-color,box-shadow] duration-200',
          focused ? 'border-line-strong shadow-pop' : 'border-line shadow-float',
        )}
      >
        {(draft.images.length > 0 || draft.quotes.length > 0 || draft.pastes.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {draft.quotes.map((quote, i) => (
              <div key={`q-${i}`} className="flex max-w-full items-start gap-2 rounded-2xl bg-surface-2 py-1.5 pl-2.5 pr-1.5 text-[13px] text-fg-soft animate-pop">
                <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="line-clamp-2 min-w-0 flex-1">{quote}</span>
                <button
                  type="button"
                  aria-label="移除引用"
                  onClick={() => setDraft((d) => ({ ...d, quotes: d.quotes.filter((_, j) => j !== i) }))}
                  className="rounded-lg p-0.5 text-fg-faint hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {draft.pastes.map((paste) => (
              <div key={paste.id} className="flex items-center gap-2 rounded-2xl border border-line py-1.5 pl-2.5 pr-1.5 text-[13px] text-fg-soft animate-pop">
                <FileText className="h-3.5 w-3.5 text-fg-faint" />
                <span>粘贴的内容 · {paste.text.length} 字</span>
                <button
                  type="button"
                  aria-label="移除"
                  onClick={() => setDraft((d) => ({ ...d, pastes: d.pastes.filter((p) => p.id !== paste.id) }))}
                  className="rounded-lg p-0.5 text-fg-faint hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {draft.images.map((src, i) => (
              <div key={`${i}-${src.slice(-16)}`} className="group/thumb relative h-16 w-16 overflow-hidden rounded-2xl border border-line animate-pop">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`图片 ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label="移除图片"
                  onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/thumb:opacity-100 max-md:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textRef}
          value={draft.text}
          onChange={(e) => {
            setDraft((d) => ({ ...d, text: e.target.value }));
            if (voice.error) voice.clearError();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          readOnly={voice.recording}
          rows={1}
          placeholder={voice.recording ? '在听…' : busy ? '补充点什么，或者换个方向…' : hero ? '想聊点什么？' : '继续说…'}
          aria-label="输入消息"
          className={cn(
            'block w-full resize-none bg-transparent px-5 text-[15.5px] leading-[1.65] text-fg outline-none placeholder:text-fg-faint',
            hero ? 'min-h-[88px] pt-4' : 'min-h-[52px] pt-3.5',
          )}
        />
        {voice.error && (
          <div className="mx-5 mb-1 inline-flex rounded-full bg-danger-soft px-2.5 py-0.5 text-xs text-danger">{voice.error}</div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES}
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />

        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          <Tooltip label="添加">
            <button
              ref={plusAnchor}
              type="button"
              aria-label="添加"
              onClick={() => setPlusMenu((v) => !v)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full text-fg-soft transition-[background-color,color,transform] duration-200 hover:bg-surface-2 hover:text-fg',
                plusMenu && 'rotate-45 bg-surface-2 text-fg',
              )}
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
          <Popover open={plusMenu} onOpenChange={setPlusMenu} anchor={plusAnchor} placement="top-start" className="w-64">
            <MenuItem
              icon={<ImagePlus className="h-4 w-4" />}
              label="上传图片"
              hint={`${draft.images.length}/${MAX_IMAGES}`}
              disabled={draft.images.length >= MAX_IMAGES}
              onSelect={() => {
                setPlusMenu(false);
                fileRef.current?.click();
              }}
            />
            <MenuItem
              icon={<MessageCircleQuestion className="h-4 w-4" />}
              label="顺便问一句"
              description="开个小窗问，不打断、也不写进这段对话"
              onSelect={() => {
                setPlusMenu(false);
                onOpenBtw();
              }}
            />
          </Popover>

          <button
            ref={modelAnchor}
            type="button"
            onClick={() => setModelMenu((v) => !v)}
            className="flex h-9 items-center gap-1 rounded-full px-3 text-[13.5px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <span>{selectedModel?.name ?? '模型'}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', modelMenu && 'rotate-180')} />
          </button>
          <Popover open={modelMenu} onOpenChange={setModelMenu} anchor={modelAnchor} placement="top-start" className="w-72">
            <MenuLabel>模型</MenuLabel>
            {models.filter((m) => m.available).map((m) => (
              <MenuItem
                key={m.id}
                label={
                  <span className="flex items-center gap-2">
                    {m.name}
                    {m.is_default && <span className="text-[10.5px] text-fg-faint">默认</span>}
                  </span>
                }
                description={m.description}
                active={m.id === selectedModelId}
                hint={m.id === selectedModelId ? <Check className="h-4 w-4 text-accent" /> : undefined}
                onSelect={() => {
                  onModelChange(m.id);
                  setModelMenu(false);
                  textRef.current?.focus();
                }}
              />
            ))}
          </Popover>

          {!neverThinks && (
            <>
              <Tooltip label={alwaysThinks ? '这个模型每次都会先想一想' : '思考强度'}>
                <button
                  ref={thinkAnchor}
                  type="button"
                  disabled={thinkingLocked}
                  onClick={() => setThinkMenu((v) => !v)}
                  className={cn(
                    'flex h-9 items-center gap-1.5 rounded-full px-3 text-[13.5px] transition-colors',
                    effectiveThinking ? 'text-fg' : 'text-fg-soft',
                    !thinkingLocked && 'hover:bg-surface-2 hover:text-fg',
                    thinkingLocked && 'cursor-default',
                  )}
                >
                  {effectiveThinking ? (
                    thinkingLabel === '深度思考' ? <Sparkles className="h-3.5 w-3.5 text-accent" /> : <Brain className="h-3.5 w-3.5" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  <span className="max-sm:hidden">{thinkingLabel}</span>
                </button>
              </Tooltip>
              <Popover open={thinkMenu} onOpenChange={setThinkMenu} anchor={thinkAnchor} placement="top-start" className="w-64">
                <MenuItem
                  icon={<Zap className="h-4 w-4" />}
                  label="快速"
                  description="不展开思考，直接回答"
                  active={thinkingLevel === 'fast'}
                  onSelect={() => {
                    onThinkingChange('fast');
                    setThinkMenu(false);
                  }}
                />
                <MenuItem
                  icon={<Brain className="h-4 w-4" />}
                  label="思考"
                  description="先想一想再回答"
                  active={thinkingLevel === 'standard' || (!supportsReasoningEffort && thinkingLevel === 'deep')}
                  onSelect={() => {
                    onThinkingChange('standard');
                    setThinkMenu(false);
                  }}
                />
                {supportsReasoningEffort && (
                  <MenuItem
                    icon={<Sparkles className="h-4 w-4" />}
                    label="深度思考"
                    description="想得更久，适合难题"
                    active={thinkingLevel === 'deep'}
                    onSelect={() => {
                      onThinkingChange('deep');
                      setThinkMenu(false);
                    }}
                  />
                )}
              </Popover>
            </>
          )}

          <div className="ml-auto flex items-center gap-1">
            {voice.recording ? (
              <button
                type="button"
                onClick={voice.stop}
                className="flex h-9 items-center gap-2 rounded-full bg-danger-soft px-3.5 text-[13px] font-medium text-danger transition-colors"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/50" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
                </span>
                停止
              </button>
            ) : busy && empty ? (
              <Tooltip label="停止 (Esc)">
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="停止回答"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ink-fg transition-transform duration-200 hover:scale-105 active:scale-95"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              </Tooltip>
            ) : !empty ? (
              <Tooltip label={busy ? `排队发送 · ${modKey()} Enter 打断` : '发送'}>
                <button
                  type="button"
                  onClick={() => submit()}
                  aria-label={busy ? '排队发送' : '发送'}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-ink-fg transition-transform duration-200 hover:scale-105 active:scale-95 animate-pop"
                >
                  {busy ? <ListPlus className="h-4 w-4" /> : <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />}
                </button>
              </Tooltip>
            ) : (
              <Tooltip label={voice.supported ? '语音输入' : '当前浏览器不支持语音输入'}>
                <button
                  type="button"
                  onClick={() => void voice.start()}
                  disabled={!voice.supported}
                  aria-label="语音输入"
                  className="flex h-9 w-9 items-center justify-center rounded-full text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                >
                  <Mic className="h-[18px] w-[18px]" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {!hero && (
        <p className="mt-2 text-center text-[11px] text-fg-faint max-sm:hidden">{hint}</p>
      )}
    </div>
  );
}
