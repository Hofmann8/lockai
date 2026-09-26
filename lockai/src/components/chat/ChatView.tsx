'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import gsap from 'gsap';
import { Flip } from 'gsap/Flip';
import { ArrowDown, Download, ImagePlus, Menu, MessageCircleQuestion, MoreHorizontal, Pin, PinOff, RotateCcw, Trash2, X } from 'lucide-react';
import type { ChatMessage, FileArtifact } from '@/types';
import { useAppShell } from '@/components/AppShell';
import { useChatController } from '@/lib/chat/useChatController';
import { conversationDocs, fileExt, fileKey, groupFiles, isPanelDoc, messageFiles, type DocGroup } from '@/lib/chat/artifacts';
import { ArtifactPanel, ArtifactsProvider } from './ArtifactPanel';
import { conversationToMarkdown, safeFilename } from '@/lib/chat/export';
import { copyText, downloadFile, messageMarkdown } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { AssistantMessage, UserMessage } from './Messages';
import { deliverableRank } from './WorkCards';
import { Composer, type ComposerHandle } from './Composer';
import { SelectionPopover } from './SelectionPopover';
import { BtwPanel } from './BtwPanel';
import { RunPicker } from './RunPicker';
import { ScrollAnchorProvider, useScrollAnchor } from '@/lib/hooks/useScrollAnchor';
import { EmptyHero, StarterChips } from './EmptyState';
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { readDropped } from '@/lib/chat/uploads';

gsap.registerPlugin(Flip);

/** 按"一问 + 若干回答"分组，最后一组在刚发送时撑满视口，让新问题顶到上面 */
function groupTurns(messages: ChatMessage[]) {
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}

/** 这个宽度以上文档在侧边面板里打开，以下全屏查看 */
const PANEL_MEDIA = '(min-width: 1024px)';

interface PanelState {
  group: DocGroup;
  /** 当前看的格式（扩展名）；模型交付新版本时同一格式自动换成新文件 */
  format: string;
}

export function ChatView() {
  const shell = useAppShell();
  const { currentSessionId, setCurrentSessionId, loadSessions, sessions } = shell;
  const chat = useChatController({ currentSessionId, setCurrentSessionId, loadSessions, sessions });
  const {
    messages, isLoading, hydrating, error, models, selectedModelId, streamingMessageId, streamBuffer,
    liveThinking, suggestions, queue, sentTick, snapKey,
  } = chat;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const flipState = useRef<Flip.FlipState | null>(null);
  const [pinned, setPinned] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [btw, setBtw] = useState<{ open: boolean; context: string | null }>({ open: false, context: null });
  const [dragging, setDragging] = useState(false);
  const [orbTrigger, setOrbTrigger] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);

  const session = sessions.find((s) => s.id === currentSessionId);
  const title = session?.title || '新对话';
  const empty = messages.length === 0 && !hydrating;
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === 'assistant') return messages[i].id;
    return null;
  }, [messages]);

  /* ---------------- 侧边文档面板 ---------------- */

  const [panel, setPanel] = useState<PanelState | null>(null);
  const docs = useMemo(() => conversationDocs(messages), [messages]);
  // 面板里的文档跟着对话更新（模型改了一版再交付，面板里自动换成新版）
  const panelGroup = panel ? docs.find((d) => d.key === panel.group.key) ?? panel.group : null;
  const panelFile: FileArtifact | null = panelGroup
    ? panelGroup.files.find((f) => fileExt(f.name) === panel?.format) ?? panelGroup.primary
    : null;

  const openDoc = useCallback((group: DocGroup, file?: FileArtifact) => {
    setPanel({ group, format: fileExt((file ?? group.primary).name) });
  }, []);

  // 自动打开：这一轮回答第一次交付文档时在侧边展开，一轮最多一次、面板已经开着就不动。
  // 大任务一轮会交付几十个文件，每来一个就切一次、对话栏跟着变宽变窄，眼前的内容会来回跳。
  // 面板里正在看的那份改出新版本，由下面的 panelGroup 原地换成新版。用户这一轮关过面板就不再弹
  const seenDocsRef = useRef<Set<string>>(new Set());
  const panelDismissedRef = useRef(false);
  const autoOpenedRef = useRef(false);
  useLayoutEffect(() => {
    setPanel(null);
    seenDocsRef.current = new Set();
  }, [currentSessionId]);
  useEffect(() => {
    // 翻开历史对话时已有的文档不算新交付
    if (!hydrating) for (const d of conversationDocs(messages)) for (const f of d.files) seenDocsRef.current.add(fileKey(f));
    // 只在加载完成的那一刻记一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrating]);
  useEffect(() => {
    panelDismissedRef.current = false;
    autoOpenedRef.current = false;
  }, [sentTick]);
  useEffect(() => {
    if (!streamingMessageId) return;
    const message = messages.find((m) => m.id === streamingMessageId);
    if (!message) return;
    const fresh = groupFiles(messageFiles(message).filter(isPanelDoc)).filter((g) => g.files.some((f) => !seenDocsRef.current.has(fileKey(f))));
    if (fresh.length === 0) return;
    for (const g of fresh) for (const f of g.files) seenDocsRef.current.add(fileKey(f));
    if (autoOpenedRef.current || panelDismissedRef.current || !window.matchMedia(PANEL_MEDIA).matches) return;
    autoOpenedRef.current = true;
    // 同一批里挑最像"成品"的（Excel 优先于它的压测 CSV，PPT 优先于源码）
    const best = fresh.reduce((a, b) => (deliverableRank(b) < deliverableRank(a) ? b : a));
    setPanel((current) => current ?? { group: best, format: fileExt(best.primary.name) });
  }, [messages, streamingMessageId]);

  const closePanel = useCallback(() => {
    if (isLoading) panelDismissedRef.current = true;
    setPanel(null);
  }, [isLoading]);

  const artifacts = useMemo(() => ({ openDoc, activeKey: panelGroup?.key ?? null }), [openDoc, panelGroup?.key]);
  const panelOpen = panel !== null;

  // 把"正在回答"同步给外壳，让侧栏的锁标跟着动
  const { setChatActivity } = shell;
  useEffect(() => {
    setChatActivity({ busy: isLoading, snapKey });
  }, [isLoading, snapKey, setChatActivity]);

  /* ---------------- 滚动 ---------------- */

  // 停在底部时跟着回答往下走；翻上去看时眼前的内容钉住不动；点开 / 收起卡片时被点的标题不动
  const onDistance = useCallback((distance: number) => setShowJump(distance > 240), []);
  const { hold, onScroll, scrollToBottom, release } = useScrollAnchor({
    scrollRef, contentRef, onDistance, enabled: !empty,
  });

  // 换会话：取消置顶效果，直接落到底部
  useLayoutEffect(() => {
    setPinned(false);
    setEditingId(null);
  }, [currentSessionId]);

  const wasHydrating = useRef(false);
  useLayoutEffect(() => {
    if (wasHydrating.current && !hydrating) scrollToBottom(false);
    wasHydrating.current = hydrating;
  }, [hydrating, scrollToBottom]);

  // 刚发出去：新问题顶到视口上沿，回答在下面长出来
  useLayoutEffect(() => {
    if (sentTick === 0) return;
    setPinned(true);
    const el = scrollRef.current;
    if (!el) return;
    window.requestAnimationFrame(() => {
      const users = el.querySelectorAll<HTMLElement>('[data-role="user"]');
      const last = users[users.length - 1];
      if (!last) return;
      release();
      el.scrollTo({ top: Math.max(0, last.offsetTop - 20), behavior: 'smooth' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentTick]);

  // 视口高度：最后一组的最小高度要用它
  const [threadH, setThreadH] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setThreadH(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);


  /* ---------------- 空状态 → 对话：输入框从中间落到底部 ---------------- */

  useLayoutEffect(() => {
    const state = flipState.current;
    if (!state || empty) return;
    flipState.current = null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    Flip.from(state, { duration: 0.6, ease: 'power3.inOut', scale: false });
  }, [empty]);

  const captureFlip = () => {
    if (empty && dockRef.current) flipState.current = Flip.getState(dockRef.current);
  };

  /* ---------------- 动作 ---------------- */

  const send: typeof chat.send = (draft, options) => {
    captureFlip();
    if (empty) setOrbTrigger((t) => t + 1);
    setEditingId(null);
    return chat.send(draft, options);
  };

  const editLast = () => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        setEditingId(messages[i].id);
        scrollRef.current?.querySelector(`[data-message-id="${messages[i].id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
  };

  const exportConversation = () => {
    if (messages.length === 0) return;
    downloadFile(`${safeFilename(title)}.md`, conversationToMarkdown(title, messages), 'text/markdown;charset=utf-8');
  };

  const copyLastAnswer = useCallback(async () => {
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    if (last && (await copyText(messageMarkdown(last.content)))) toast('已复制最后一条回答');
  }, [chat.messages]);

  // 快捷键：Esc 停止、⌘⇧C 复制最后回答
  const stop = chat.stop;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isLoading && !e.defaultPrevented) {
        e.preventDefault();
        void stop();
        return;
      }
      // 没在生成时，Esc 收起侧边面板（焦点在输入框、菜单等地方时它们自己先处理）
      if (e.key === 'Escape' && !isLoading && panelOpen && !e.defaultPrevented && !document.fullscreenElement) {
        const target = e.target as HTMLElement | null;
        if (!target?.closest('input, textarea, [role="dialog"], [role="menu"]')) {
          e.preventDefault();
          setPanel(null);
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void copyLastAnswer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [copyLastAnswer, isLoading, panelOpen, stop]);

  /* ---------------- 拖入文件 ---------------- */

  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    // 拖进来的文件夹展开成带相对路径的文件，零散文件照旧（图片还能直接给模型看）
    void readDropped(e.dataTransfer).then(({ loose, nested }) => {
      if (loose.length) composerRef.current?.addFiles(loose);
      if (nested.length) composerRef.current?.addPicked(nested);
    });
  };

  const openBtw = (context: string | null) => setBtw({ open: true, context });

  return (
    <ArtifactsProvider value={artifacts}>
    <ScrollAnchorProvider value={hold}>
    <div className="flex h-dvh min-w-0 flex-1">
    <div
      className="relative flex h-dvh min-w-0 flex-1 flex-col"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* 顶栏 */}
      <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 px-3 sm:px-4">
        <button
          type="button"
          onClick={shell.openSidebar}
          aria-label="打开侧栏"
          className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg md:hidden"
        >
          <Menu className="h-[18px] w-[18px]" />
        </button>
        <div className="min-w-0 flex-1">
          {session && !empty && (
            renaming ? (
              <input
                autoFocus
                defaultValue={title}
                onBlur={(e) => {
                  setRenaming(false);
                  const next = e.target.value.trim();
                  if (next && next !== title) void shell.renameSession(session.id, next);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.currentTarget.value = title;
                    e.currentTarget.blur();
                  }
                }}
                className="h-8 w-full max-w-md rounded-lg border border-line-strong bg-surface px-2.5 text-[14px] text-fg outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setRenaming(true)}
                title="点击重命名"
                className="max-w-full truncate rounded-lg px-2 py-1 text-[14px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg animate-fade"
              >
                {title}
              </button>
            )
          )}
        </div>
        {!empty && (
          <div className="flex items-center gap-0.5">
            <Tooltip label="顺便问一句" side="bottom">
              <button
                type="button"
                onClick={() => openBtw(null)}
                aria-label="顺便问一句"
                className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <MessageCircleQuestion className="h-[18px] w-[18px]" />
              </button>
            </Tooltip>
            <button
              ref={menuAnchor}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="更多"
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg',
                menuOpen && 'bg-surface-2 text-fg',
              )}
            >
              <MoreHorizontal className="h-[18px] w-[18px]" />
            </button>
            <Popover open={menuOpen} onOpenChange={setMenuOpen} anchor={menuAnchor} placement="bottom-end" className="w-56">
              {session && (
                <MenuItem
                  icon={session.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  label={session.pinned ? '取消置顶' : '置顶'}
                  onSelect={() => {
                    setMenuOpen(false);
                    void shell.togglePin(session.id);
                  }}
                />
              )}
              <MenuItem
                icon={<Download className="h-4 w-4" />}
                label="导出为 Markdown"
                onSelect={() => {
                  setMenuOpen(false);
                  exportConversation();
                }}
              />
              {session && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 className="h-4 w-4" />}
                    label="删除对话"
                    danger
                    onSelect={() => {
                      setMenuOpen(false);
                      shell.removeSession(session.id);
                    }}
                  />
                </>
              )}
            </Popover>
          </div>
        )}
      </header>

      {/* 对话 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          // 锚定由 useScrollAnchor 自己做，关掉浏览器的，免得两边各补一次
          'relative min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]',
          '[mask-image:linear-gradient(to_bottom,transparent,#000_20px,#000_calc(100%-24px),transparent)]',
          empty ? 'hidden' : 'flex-1',
        )}
      >
        <div
          ref={contentRef}
          className={cn(
            'mx-auto w-full max-w-[46rem] px-4 pb-10 pt-4 transition-opacity duration-300 sm:px-6',
            hydrating && 'opacity-40',
          )}
        >
          {turns.map((turn, index) => {
            const isLastTurn = index === turns.length - 1;
            return (
              <section
                key={turn[0].clientKey ?? turn[0].id}
                className="flex flex-col gap-6 pb-8"
                style={isLastTurn && pinned && threadH > 0 ? { minHeight: threadH - 24 } : undefined}
              >
                {turn.map((message) => {
                  const key = message.clientKey ?? message.id;
                  if (message.role === 'user') {
                    return (
                      <UserMessage
                        key={key}
                        message={message}
                        editing={editingId === message.id}
                        onEditStart={() => setEditingId(message.id)}
                        onEditCancel={() => setEditingId(null)}
                        onEditSubmit={(text) => {
                          setEditingId(null);
                          void chat.editAndResend(message.id, text);
                        }}
                      />
                    );
                  }
                  const streaming = message.id === streamingMessageId;
                  return (
                    <AssistantMessage
                      key={key}
                      message={message}
                      streaming={streaming}
                      buffer={streaming ? streamBuffer : undefined}
                      liveThinking={streaming ? liveThinking : null}
                      thinking={chat.effectiveThinking}
                      isLast={message.id === lastAssistantId}
                      models={models}
                      currentModelId={selectedModelId}
                      suggestions={suggestions?.messageId === message.id && !isLoading ? suggestions.items : undefined}
                      onRegenerate={(modelId) => void chat.regenerate(message.id, modelId)}
                      onBranch={() => void chat.branchFrom(message.id)}
                      onSuggestion={(text) => void send(text)}
                    />
                  );
                })}
              </section>
            );
          })}

          {error && !isLoading && (
            <div className="mb-6 flex items-center gap-3 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-2.5 text-[13.5px] text-danger animate-rise">
              <span className="min-w-0 flex-1">{error}</span>
              {lastAssistantId && (
                <button
                  type="button"
                  onClick={() => {
                    chat.clearError();
                    void chat.regenerate(lastAssistantId);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium hover:bg-danger/10"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> 重试
                </button>
              )}
              <button type="button" aria-label="关闭" onClick={chat.clearError} className="rounded-lg p-1 hover:bg-danger/10">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 输入区：空状态时居中，发出第一句后落到底部 */}
      <div className={cn('relative shrink-0 px-3 sm:px-6', empty ? 'flex flex-1 flex-col justify-center pb-[12vh]' : 'pb-3')}>
        {empty && <EmptyHero trigger={orbTrigger} />}
        <div ref={dockRef} className="relative mx-auto w-full max-w-[46rem]">
          {showJump && !empty && (
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              aria-label="回到最新"
              className="absolute -top-12 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] text-fg-soft shadow-float transition-colors hover:text-fg animate-pop"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {isLoading ? '正在回答' : '最新'}
            </button>
          )}
          <Composer
            handleRef={composerRef}
            variant={empty ? 'hero' : 'dock'}
            sessionId={currentSessionId}
            busy={isLoading}
            models={models}
            selectedModelId={selectedModelId}
            onModelChange={chat.setModel}
            thinkingLevel={chat.thinkingLevel}
            onThinkingChange={chat.setThinkingLevel}
            thinkingLocked={chat.thinkingLocked}
            supportsReasoningEffort={chat.supportsReasoningEffort}
            effectiveThinking={chat.effectiveThinking}
            queue={queue}
            onSend={(draft) => {
              void send(draft).then((result) => {
                if (result === 'cancelled') composerRef.current?.restore(draft);
              });
            }}
            onQueue={chat.enqueue}
            onSteer={(draft) => void chat.steer(draft)}
            onStop={() => void chat.stop()}
            onRemoveQueued={chat.removeQueued}
            onSendQueuedNow={(id) => void chat.sendQueuedNow(id)}
            onEditLast={editLast}
            onOpenBtw={() => openBtw(null)}
          />
        </div>
        {empty && <StarterChips onPick={(prompt) => composerRef.current?.setText(prompt)} />}
      </div>

      <SelectionPopover
        container={scrollRef}
        onQuote={(text) => composerRef.current?.addQuote(text)}
        onAsk={(text) => openBtw(text)}
      />

      <BtwPanel
        open={btw.open}
        onClose={() => setBtw({ open: false, context: null })}
        context={btw.context}
        onClearContext={() => setBtw((b) => ({ ...b, context: null }))}
        history={messages}
        modelId={selectedModelId}
        onBringBack={(text) => composerRef.current?.addQuote(text)}
      />

      <RunPicker prompt={chat.capacityPrompt} onResolve={chat.resolveCapacity} />

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-[28px] border-2 border-dashed border-accent/60 bg-bg/80 backdrop-blur-sm animate-fade">
          <div className="flex flex-col items-center gap-2 text-fg-soft">
            <ImagePlus className="h-7 w-7 text-accent" />
            <span className="text-[14px]">松手，把文件放进来</span>
          </div>
        </div>
      )}
    </div>

    {/* 侧边文档面板：窄屏不占位（那时文档全屏查看） */}
    {panelGroup && panelFile && (
      <div className="hidden lg:flex">
        <ArtifactPanel
          group={panelGroup}
          file={panelFile}
          onFileChange={(f) => setPanel({ group: panelGroup, format: fileExt(f.name) })}
          docs={docs}
          onSelectDoc={(g) => openDoc(g)}
          onClose={closePanel}
        />
      </div>
    )}
    </div>
    </ScrollAnchorProvider>
    </ArtifactsProvider>
  );
}
