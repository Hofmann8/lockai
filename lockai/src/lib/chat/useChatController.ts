'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatModel, ChatSession, FileArtifact, ShellToolTrace, ThinkingLevel, TimedStreamEvent, ToolTrace } from '@/types';
import {
  fetchSuggestions, getModels, getRunningChats, resumeChatStream, sendChatMessageStream, stopChatRun, uploadImage,
  type RunningChat,
} from '@/lib/api';
import { addMessage, branchSession, createSession, getSession, truncateMessages, updateSession } from '@/lib/chat-history';
import { getAuthState } from '@/lib/auth';
import { getSettings, saveSettings } from '@/lib/settings';
import { useStreamBuffer } from '@/lib/hooks/useStreamBuffer';
import { toast } from '@/components/ui/Toast';
import { composeMessage, draftAttachments, type ComposerDraft, type DraftFile } from './compose';
import {
  appendShellOutput,
  appendToolMarker,
  finalizeInterruptedToolTrace,
  finalizeSearchTrace,
  patchLatestImageTrace,
  patchShellTrace,
  patchTaskTrace,
  startShellTrace,
  startTaskTrace,
  stripToolMarkers,
  takePreamble,
  upsertRunningImageTrace,
  upsertRunningSearchTrace,
} from './traces';

const TOOL_CARD_MIN_VISIBLE_MS = 450;
const DEFAULT_CHAT_MODEL_ID = 'scooby';

type PendingToolAction = () => void;
type PendingToolFinalization = (trace: ToolTrace[] | undefined) => ToolTrace[] | undefined;

export interface QueuedMessage {
  id: string;
  draft: ComposerDraft;
}

export interface SendOptions {
  /** 用另一个模型发（"换个模型重试"），同时切换当前模型 */
  modelId?: string;
  /** 发送前的历史（重试 / 编辑时是截断后的历史） */
  history?: ChatMessage[];
}

/** 思考文字只攒着（停止生成时随消息存档），界面上只显示用时和 token 数 */
interface ReasoningTrack {
  text: string;
}

/** 正在生成的回答的思考状态：从发出到第一段输出算"在想"，之后以后端每轮的统计为准 */
export interface LiveThinking {
  startedAt: number;
  endedAt: number | null;
  /** 收到过思考内容（没收到的话，就算开了思考也可能根本没想，比如很简单的问题） */
  sawReasoning: boolean;
  stats: { seconds: number; tokens: number } | null;
}

function resolveAvailableModelId(modelId: string | null | undefined, models: ChatModel[]): string {
  const target = (modelId || '').trim();
  if (target && models.some((m) => m.id === target)) return target;
  return models.find((m) => m.is_default)?.id || models[0]?.id || '';
}

function draftFrom(input: ComposerDraft | string): ComposerDraft {
  return typeof input === 'string' ? { text: input, images: [], quotes: [], pastes: [], files: [] } : input;
}

/** 已发出的附件放回草稿（重试 / 编辑重发时沿用） */
function draftFilesFrom(files: FileArtifact[] | undefined): DraftFile[] {
  return (files ?? []).map((artifact) => ({
    id: crypto.randomUUID(), name: artifact.name, size: artifact.size, status: 'done', artifact,
  }));
}

/** 没写字只发了图 / 附件时，消息正文用的占位 */
const IMAGE_ONLY_TEXT = '(图片)';
const FILES_ONLY_TEXT = '(附件)';

/** 一步命令在卡片出现之前就到达的输出 / 结果，先攒着，卡片建好时一起放进去 */
interface ShellLive {
  started: boolean;
  output: string;
  env?: 'created' | 'restored';
  end?: (step: ShellToolTrace) => Partial<ShellToolTrace>;
}

interface ControllerDeps {
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<unknown>;
  /** 侧栏的会话列表：看有没有别的对话在后台回答，决定发送前要不要先问一下停哪条 */
  sessions?: ChatSession[];
}

/** 同时回答的对话满了：请用户选一条停下（默认跑得最久的那条） */
export interface CapacityPrompt {
  limit: number;
  runs: RunningChat[];
}

export function useChatController({ currentSessionId, setCurrentSessionId, loadSessions, sessions }: ControllerDeps) {
  const initialSettings = useMemo(() => getSettings(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(initialSettings.selectedModelId || DEFAULT_CHAT_MODEL_ID);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(initialSettings.thinkingLevel);
  const [liveThinking, setLiveThinking] = useState<LiveThinking | null>(null);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [suggestions, setSuggestions] = useState<{ messageId: string; items: string[] } | null>(null);
  const [snapKey, setSnapKey] = useState(0);
  const [sentTick, setSentTick] = useState(0);
  const [streamTargetId, setStreamTargetId] = useState<string | null>(null);
  const [capacityPrompt, setCapacityPrompt] = useState<CapacityPrompt | null>(null);

  const messagesRef = useRef<ChatMessage[]>([]);
  const loadingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(currentSessionId);
  const abortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const skipHydrateSessionRef = useRef<string | null>(null);
  const streamEndedRef = useRef(false);
  const streamTargetMessageIdRef = useRef<string | null>(null);
  const serverMessageIdRef = useRef<string | null>(null);
  const streamCommittedContentRef = useRef('');
  const pendingToolActionsRef = useRef<PendingToolAction[]>([]);
  const pendingToolFinalizationsRef = useRef<PendingToolFinalization[]>([]);
  const pendingImageRevealsRef = useRef<PendingToolFinalization[]>([]);
  const toolVisibleUntilRef = useRef(0);
  const toolFinalizationTimerRef = useRef<number | null>(null);
  const reasoningRef = useRef<ReasoningTrack>({ text: '' });
  const thinkingRef = useRef<LiveThinking | null>(null);
  const lastUserTextRef = useRef('');
  const dispatchingQueueRef = useRef(false);
  const shellLiveRef = useRef(new Map<string, ShellLive>());
  /** 正在重放后台回答已有的部分：一次性铺出来，不走逐字和工具卡片的最短停留 */
  const replayingRef = useRef(false);
  /** 接上后台回答时，本机时钟减服务端时钟；事件时间戳加上它就是本机时间 */
  const clockOffsetRef = useRef<number | null>(null);
  const sessionsRef = useRef<ChatSession[] | undefined>(sessions);
  const capacityResolveRef = useRef<((choice: string | null) => void) | null>(null);

  const {
    displayedContent: bufferedAssistantContent,
    push: pushStreamBuffer,
    start: startStreamBuffer,
    flush: flushStreamBuffer,
    reset: resetStreamBuffer,
    getBufferedContent,
    getPendingCharCount,
  } = useStreamBuffer();

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { loadingRef.current = isLoading; }, [isLoading]);
  useEffect(() => { sessionIdRef.current = currentSessionId; }, [currentSessionId]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  const setMessagesNow = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const setLoadingNow = useCallback((value: boolean) => {
    loadingRef.current = value;
    setIsLoading(value);
  }, []);

  /* ---------------- 思考：只记用时和 token 数 ---------------- */

  const updateThinking = useCallback((patch: (current: LiveThinking) => LiveThinking | null) => {
    const current = thinkingRef.current;
    if (!current) return;
    const next = patch(current);
    if (next === current) return;
    thinkingRef.current = next;
    setLiveThinking(next);
  }, []);

  const resetReasoning = useCallback((thinking = false) => {
    reasoningRef.current = { text: '' };
    const next = thinking ? { startedAt: Date.now(), endedAt: null, sawReasoning: false, stats: null } : null;
    thinkingRef.current = next;
    setLiveThinking(next);
  }, []);

  /** 第一段正文 / 第一次调工具：这一段"在想"结束了 */
  const pauseReasoning = useCallback((at = Date.now()) => {
    updateThinking((t) => (t.endedAt === null ? { ...t, endedAt: at } : t));
  }, [updateThinking]);

  const pushReasoning = useCallback((delta: string) => {
    const track = reasoningRef.current;
    // 工具调用后的新一轮思考，和上一段隔开
    if (thinkingRef.current?.endedAt && track.text && !track.text.endsWith('\n')) track.text += '\n\n';
    track.text += delta;
    updateThinking((t) => (t.sawReasoning ? t : { ...t, sawReasoning: true }));
  }, [updateThinking]);

  const reasoningSnapshot = useCallback(() => {
    pauseReasoning();
    const t = thinkingRef.current;
    const text = reasoningRef.current.text.trim();
    const seconds = t?.stats?.seconds
      ?? (t?.sawReasoning && t.endedAt ? Math.max(1, Math.round((t.endedAt - t.startedAt) / 1000)) : undefined);
    return {
      ...(text ? { reasoning: text } : {}),
      ...(seconds ? { reasoning_seconds: seconds } : {}),
      ...(t?.stats?.tokens ? { reasoning_tokens: t.stats.tokens } : {}),
    };
  }, [pauseReasoning]);

  /* ---------------- 流式正文 + 工具卡片的节奏控制（沿用原来调好的逻辑） ---------------- */

  const bindStreamTarget = useCallback((messageId: string | null, initialContent = '') => {
    streamTargetMessageIdRef.current = messageId;
    streamCommittedContentRef.current = initialContent;
    pendingToolActionsRef.current = [];
    pendingToolFinalizationsRef.current = [];
    pendingImageRevealsRef.current = [];
    streamEndedRef.current = false;
    setStreamTargetId(messageId);
    if (messageId) {
      startStreamBuffer();
      if (initialContent) pushStreamBuffer(initialContent);
      return;
    }
    resetStreamBuffer();
  }, [pushStreamBuffer, resetStreamBuffer, startStreamBuffer]);

  const updateStreamTargetMessage = useCallback((updater: (message: ChatMessage) => ChatMessage) => {
    const targetId = streamTargetMessageIdRef.current;
    if (!targetId) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((msg) => {
        if (msg.id !== targetId) return msg;
        const updated = updater(msg);
        if (updated !== msg) changed = true;
        return updated;
      });
      if (!changed) return prev;
      messagesRef.current = next;
      return next;
    });
  }, []);

  const commitBufferedAssistantContent = useCallback(() => {
    const targetId = streamTargetMessageIdRef.current;
    if (!targetId) return streamCommittedContentRef.current;
    const bufferedSegment = getBufferedContent();
    if (!bufferedSegment) return streamCommittedContentRef.current;
    flushStreamBuffer();
    const nextContent = `${streamCommittedContentRef.current}${bufferedSegment}`;
    streamCommittedContentRef.current = nextContent;
    updateStreamTargetMessage((msg) => (msg.content === nextContent ? msg : { ...msg, content: nextContent }));
    startStreamBuffer();
    return nextContent;
  }, [flushStreamBuffer, getBufferedContent, startStreamBuffer, updateStreamTargetMessage]);

  const clearPendingToolQueues = useCallback(() => {
    pendingToolActionsRef.current = [];
    pendingToolFinalizationsRef.current = [];
    pendingImageRevealsRef.current = [];
    toolVisibleUntilRef.current = 0;
    if (toolFinalizationTimerRef.current !== null) {
      window.clearTimeout(toolFinalizationTimerRef.current);
      toolFinalizationTimerRef.current = null;
    }
  }, []);

  const applyTraceUpdates = useCallback((updates: PendingToolFinalization[]) => {
    if (updates.length === 0) return;
    updateStreamTargetMessage((msg) => {
      let nextTrace = msg.tool_trace;
      for (const apply of updates) nextTrace = apply(nextTrace);
      return nextTrace === msg.tool_trace ? msg : { ...msg, tool_trace: nextTrace };
    });
  }, [updateStreamTargetMessage]);

  const flushPendingToolActions = useCallback(() => {
    const actions = pendingToolActionsRef.current;
    if (actions.length === 0) return;
    pendingToolActionsRef.current = [];
    for (const action of actions) action();
  }, []);

  const applyPendingToolFinalizations = useCallback(() => {
    const pending = pendingToolFinalizationsRef.current;
    pendingToolFinalizationsRef.current = [];
    applyTraceUpdates(pending);
  }, [applyTraceUpdates]);

  const revealPendingImages = useCallback(() => {
    const pending = pendingImageRevealsRef.current;
    pendingImageRevealsRef.current = [];
    applyTraceUpdates(pending);
  }, [applyTraceUpdates]);

  const requestSuggestions = useCallback((messageId: string, assistantContent: string) => {
    suggestAbortRef.current?.abort();
    setSuggestions(null);
    if (!getSettings().suggestions) return;
    const answer = stripToolMarkers(assistantContent);
    const question = lastUserTextRef.current;
    if (!answer || !question) return;
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    void fetchSuggestions(question, answer, controller.signal).then((items) => {
      if (controller.signal.aborted || items.length === 0) return;
      setSuggestions({ messageId, items });
    });
  }, []);

  const finalizeStreamingIfReady = useCallback(() => {
    if (!streamEndedRef.current) return;
    if (pendingToolActionsRef.current.length > 0) return;
    if (pendingToolFinalizationsRef.current.length > 0) return;
    if (getPendingCharCount() > 0) return;

    revealPendingImages();
    const finalContent = commitBufferedAssistantContent();
    streamEndedRef.current = false;
    const placeholderId = streamTargetMessageIdRef.current;
    const serverId = serverMessageIdRef.current;
    const reasoning = reasoningSnapshot();
    const finalId = serverId || placeholderId;
    if (placeholderId) {
      setMessages((prev) => {
        const next = prev.map((msg) => (
          msg.id === placeholderId
            ? { ...msg, ...reasoning, id: finalId || msg.id, clientKey: msg.clientKey ?? placeholderId }
            : msg
        ));
        messagesRef.current = next;
        return next;
      });
    }
    streamTargetMessageIdRef.current = finalId;
    setStreamTargetId(finalId);
    setLoadingNow(false);
    setSnapKey((k) => k + 1);
    if (finalId) requestSuggestions(finalId, finalContent);
    void loadSessions();
  }, [commitBufferedAssistantContent, getPendingCharCount, loadSessions, reasoningSnapshot, requestSuggestions, revealPendingImages, setLoadingNow]);

  const processPendingStreamTransitions = useCallback(() => {
    if (getPendingCharCount() > 0) return;
    if (pendingToolFinalizationsRef.current.length > 0) {
      const waitMs = toolVisibleUntilRef.current - performance.now();
      if (waitMs > 0) {
        if (toolFinalizationTimerRef.current !== null) window.clearTimeout(toolFinalizationTimerRef.current);
        toolFinalizationTimerRef.current = window.setTimeout(() => {
          toolFinalizationTimerRef.current = null;
          processPendingStreamTransitions();
        }, waitMs);
        return;
      }
      applyPendingToolFinalizations();
      return;
    }
    if (pendingToolActionsRef.current.length > 0) {
      flushPendingToolActions();
      return;
    }
    finalizeStreamingIfReady();
  }, [applyPendingToolFinalizations, finalizeStreamingIfReady, flushPendingToolActions, getPendingCharCount]);

  const scheduleToolAction = useCallback((action: PendingToolAction) => {
    const wrapped = () => {
      revealPendingImages();
      action();
      toolVisibleUntilRef.current = performance.now() + (replayingRef.current ? 0 : TOOL_CARD_MIN_VISIBLE_MS);
      if (toolFinalizationTimerRef.current !== null) {
        window.clearTimeout(toolFinalizationTimerRef.current);
        toolFinalizationTimerRef.current = null;
      }
    };
    if (pendingToolActionsRef.current.length === 0 && pendingToolFinalizationsRef.current.length === 0) {
      wrapped();
      processPendingStreamTransitions();
      return;
    }
    pendingToolActionsRef.current.push(wrapped);
  }, [processPendingStreamTransitions, revealPendingImages]);

  const queueToolFinalization = useCallback((apply: PendingToolFinalization) => {
    pendingToolFinalizationsRef.current.push(apply);
    processPendingStreamTransitions();
  }, [processPendingStreamTransitions]);

  useEffect(() => {
    if (streamEndedRef.current && getPendingCharCount() === 0) processPendingStreamTransitions();
  }, [bufferedAssistantContent, getPendingCharCount, processPendingStreamTransitions]);

  /* ---------------- 模型与思考档位 ---------------- */

  useEffect(() => {
    let mounted = true;
    void getModels().then((data) => {
      if (!mounted) return;
      setModels(data);
      const preferred = resolveAvailableModelId(getSettings().selectedModelId, data);
      if (preferred) {
        setSelectedModelId(preferred);
        saveSettings({ selectedModelId: preferred });
      }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    saveSettings({ selectedModelId, thinkingLevel });
  }, [selectedModelId, thinkingLevel]);

  const selectedModel = useMemo(() => models.find((m) => m.id === selectedModelId) ?? null, [models, selectedModelId]);
  const thinkingLocked = !selectedModel || selectedModel.thinking_mode !== 'optional';
  const supportsReasoningEffort = Boolean(selectedModel?.supports_reasoning_effort);

  const resolveThinking = useCallback((model: ChatModel | null) => {
    const effective = model?.thinking_mode === 'always'
      ? true
      : model?.thinking_mode === 'never'
        ? false
        : thinkingLevel !== 'fast';
    const effort: 'high' | 'max' | undefined = model?.supports_reasoning_effort && effective
      ? (thinkingLevel === 'deep' ? 'max' : 'high')
      : undefined;
    return { effective, effort };
  }, [thinkingLevel]);

  const effectiveThinking = resolveThinking(selectedModel).effective;

  const setModel = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    const sessionId = sessionIdRef.current;
    if (sessionId) void updateSession(sessionId, { model_id: modelId }).then(() => loadSessions());
  }, [loadSessions]);

  /* ---------------- 发送 ---------------- */

  const failStream = useCallback((message: string) => {
    replayingRef.current = false;
    flushPendingToolActions();
    applyPendingToolFinalizations();
    clearPendingToolQueues();
    streamEndedRef.current = false;
    const committed = commitBufferedAssistantContent();
    const reasoning = reasoningSnapshot();
    const serverId = serverMessageIdRef.current;
    setError(message);
    // 做了一半的服务端会存下来：换成存档的 id，之后分支 / 重试都认得它
    updateStreamTargetMessage((msg) => ({
      ...msg,
      ...reasoning,
      ...(serverId ? { id: serverId, clientKey: msg.clientKey ?? msg.id } : {}),
      content: committed,
      tool_trace: finalizeInterruptedToolTrace(msg.tool_trace),
    }));
    if (serverId) streamTargetMessageIdRef.current = serverId;
    setLoadingNow(false);
  }, [applyPendingToolFinalizations, clearPendingToolQueues, commitBufferedAssistantContent, flushPendingToolActions, reasoningSnapshot, setLoadingNow, updateStreamTargetMessage]);

  /** 事件发生的本机时间：接上后台回答时按服务端时间戳还原，实时的就是现在 */
  const eventTime = useCallback((event: TimedStreamEvent) => {
    const offset = clockOffsetRef.current;
    return offset !== null && event.ts ? event.ts + offset : Date.now();
  }, []);

  /** 一轮回答的事件：新发的和接上后台回答的共用 */
  const handleStreamEvent = useCallback((event: TimedStreamEvent) => {
    const at = eventTime(event);
    switch (event.type) {
      case 'resume': {
        clockOffsetRef.current = Date.now() - event.now;
        replayingRef.current = true;
        const startedAt = event.started_at + clockOffsetRef.current;
        updateThinking((t) => ({ ...t, startedAt }));
        break;
      }
      case 'replay_done':
        replayingRef.current = false;
        commitBufferedAssistantContent();
        processPendingStreamTransitions();
        break;
      case 'notice':
        toast(event.message, { duration: 8000 });
        break;
      case 'message_start': {
        serverMessageIdRef.current = event.message_id;
        // 刚好在回答存好、还没收尾时回来：列表里已经有这条了，以正在接的这条为准
        const targetId = streamTargetMessageIdRef.current;
        const current = messagesRef.current;
        if (current.some((m) => m.id === event.message_id && m.id !== targetId)) {
          setMessagesNow(current.filter((m) => m.id !== event.message_id || m.id === targetId));
        }
        break;
      }
      case 'reasoning_delta':
        pushReasoning(event.delta);
        break;
      case 'reasoning_stats':
        updateThinking((t) => ({ ...t, stats: { seconds: event.seconds, tokens: event.tokens } }));
        break;
      case 'content_delta':
        pauseReasoning(at);
        revealPendingImages();
        processPendingStreamTransitions();
        pushStreamBuffer(event.delta);
        if (replayingRef.current) commitBufferedAssistantContent();
        break;
      case 'search_start':
        pauseReasoning(at);
        scheduleToolAction(() => {
          const { content: base, preamble } = takePreamble(commitBufferedAssistantContent(), event.preamble);
          updateStreamTargetMessage((msg) => {
            const nextTrace = upsertRunningSearchTrace(msg.tool_trace, event.query, event.engine, preamble, at);
            const nextContent = appendToolMarker(base, nextTrace.length - 1);
            streamCommittedContentRef.current = nextContent;
            return { ...msg, content: nextContent, tool_trace: nextTrace };
          });
        });
        break;
      case 'search_end':
        queueToolFinalization((trace) => finalizeSearchTrace(trace, event.query, event.success, event.sources, at));
        break;
      case 'image_gen_start':
        pauseReasoning(at);
        scheduleToolAction(() => {
          const { content: base, preamble } = takePreamble(commitBufferedAssistantContent(), event.preamble);
          updateStreamTargetMessage((msg) => {
            const nextTrace = upsertRunningImageTrace(msg.tool_trace, {
              ...(preamble ? { preamble } : {}),
              prompt: event.prompt,
              mode: event.mode,
              assetId: event.assetId,
              request: event.request,
              editRequest: event.editRequest,
              modelLabel: event.modelLabel,
            }, at);
            const nextContent = appendToolMarker(base, nextTrace.length - 1);
            streamCommittedContentRef.current = nextContent;
            return { ...msg, content: nextContent, tool_trace: nextTrace };
          });
        });
        break;
      case 'image_gen_end':
        queueToolFinalization((trace) => patchLatestImageTrace(trace, {
          status: 'done',
          success: event.success,
          prompt: event.prompt,
          mode: event.mode,
          assetId: event.assetId,
          request: event.request,
          editRequest: event.editRequest,
          resolvedEditRequest: event.resolvedEditRequest,
          sourceLabel: event.sourceLabel,
          sourceImageId: event.sourceImageId,
          sourceImageUrl: event.sourceImageUrl,
          outputWidth: event.outputWidth,
          outputHeight: event.outputHeight,
          outputAspectRatio: event.outputAspectRatio,
          url: event.success && event.url ? event.url : undefined,
          blurredUrl: event.success && event.blurredUrl ? event.blurredUrl : undefined,
          modelLabel: event.modelLabel,
        }, at));
        break;
      case 'shell_start': {
        pauseReasoning(at);
        const live: ShellLive = { started: false, output: '' };
        shellLiveRef.current.set(event.id, live);
        scheduleToolAction(() => {
          live.started = true;
          const { content: base, preamble } = takePreamble(commitBufferedAssistantContent(), event.preamble);
          updateStreamTargetMessage((msg) => {
            let nextTrace: ToolTrace[] | undefined = startShellTrace(msg.tool_trace, {
              id: event.id,
              command: event.command,
              title: event.title,
              background: event.background,
              preamble,
              output: live.output,
              prepSeconds: event.prepSeconds,
              prepTokens: event.prepTokens,
              startedAtMs: at,
              taskId: event.taskId,
            });
            const markerIndex = nextTrace.length - 1;
            if (live.env) nextTrace = patchShellTrace(nextTrace, event.id, () => ({ env: live.env }));
            if (live.end) nextTrace = patchShellTrace(nextTrace, event.id, live.end);
            const nextContent = appendToolMarker(base, markerIndex);
            streamCommittedContentRef.current = nextContent;
            return { ...msg, content: nextContent, tool_trace: nextTrace };
          });
        });
        break;
      }
      case 'shell_env': {
        const live = shellLiveRef.current.get(event.id);
        if (live && !live.started) {
          live.env = event.state;
          break;
        }
        updateStreamTargetMessage((msg) => ({
          ...msg, tool_trace: patchShellTrace(msg.tool_trace, event.id, () => ({ env: event.state })),
        }));
        break;
      }
      case 'shell_output': {
        const live = shellLiveRef.current.get(event.id);
        if (live && !live.started) {
          live.output += event.delta;
          break;
        }
        updateStreamTargetMessage((msg) => ({
          ...msg, tool_trace: patchShellTrace(msg.tool_trace, event.id, (step) => appendShellOutput(step, event.delta)),
        }));
        break;
      }
      case 'shell_end': {
        const finish = (step: ShellToolTrace): Partial<ShellToolTrace> => ({
          status: 'done',
          success: event.success,
          output: event.output ?? step.output,
          exitCode: event.exitCode,
          seconds: event.seconds,
          files: event.files,
          previewUrl: event.previewUrl,
          shown: event.shown,
          durationSeconds: Math.max(1, Math.round((at - (step.startedAtMs ?? at)) / 1000)),
        });
        const live = shellLiveRef.current.get(event.id);
        if (live && !live.started) {
          // 卡片还排在队里没出来：建卡片时直接带上结果，免得结束事件先落空
          live.end = finish;
          break;
        }
        queueToolFinalization((trace) => patchShellTrace(trace, event.id, finish));
        break;
      }
      case 'task_start':
        // 派给执行助手的一块工作：卡片先出来，它的每一步随后带着 taskId 进来
        pauseReasoning(at);
        scheduleToolAction(() => {
          const base = commitBufferedAssistantContent();
          updateStreamTargetMessage((msg) => {
            const nextTrace = startTaskTrace(msg.tool_trace, {
              id: event.id, title: event.title, task: event.task, model: event.model, startedAtMs: at,
            });
            const nextContent = appendToolMarker(base, nextTrace.length - 1);
            streamCommittedContentRef.current = nextContent;
            return { ...msg, content: nextContent, tool_trace: nextTrace };
          });
        });
        break;
      case 'task_end':
        queueToolFinalization((trace) => patchTaskTrace(trace, event.id, () => ({
          status: 'done', success: event.success, report: event.report, seconds: event.seconds,
        })));
        break;
      case 'title_update':
        void loadSessions();
        break;
      case 'message_end':
        pauseReasoning(at);
        // 中途停下（被新回答挤掉、超时）：还亮着的步骤一并收尾
        if (event.stopped) queueToolFinalization((trace) => finalizeInterruptedToolTrace(trace));
        replayingRef.current = false;
        streamEndedRef.current = true;
        processPendingStreamTransitions();
        break;
      case 'error':
        failStream(event.message || '发送消息失败');
        break;
    }
  }, [
    commitBufferedAssistantContent, eventTime, failStream, loadSessions, pauseReasoning, processPendingStreamTransitions,
    pushReasoning, pushStreamBuffer, queueToolFinalization, revealPendingImages, scheduleToolAction, setMessagesNow,
    updateStreamTargetMessage, updateThinking,
  ]);

  /** 给一轮新回答 / 接上的回答铺好占位 */
  const beginStreamTarget = useCallback((placeholderId: string, thinking: boolean) => {
    clearPendingToolQueues();
    resetReasoning(thinking);
    shellLiveRef.current.clear();
    serverMessageIdRef.current = null;
    replayingRef.current = false;
    clockOffsetRef.current = null;
    bindStreamTarget(placeholderId);
  }, [bindStreamTarget, clearPendingToolQueues, resetReasoning]);

  /** 同时回答的对话满了就先问用户停哪条。返回要停的会话；undefined 表示不用停，null 表示用户取消了 */
  const confirmCapacity = useCallback(async (sessionId: string | null): Promise<string | null | undefined> => {
    const userId = getAuthState().user?.id;
    const known = sessionsRef.current;
    // 列表里别的对话都没在跑，就不多问服务端一次
    if (!userId || (known && !known.some((s) => s.running && s.id !== sessionId))) return undefined;
    const { limit, runs } = await getRunningChats(userId);
    const others = runs.filter((r) => r.session_id !== sessionId);
    if (others.length < limit) return undefined;
    return new Promise<string | null>((resolve) => {
      capacityResolveRef.current = resolve;
      setCapacityPrompt({ limit, runs: others });
    });
  }, []);

  const resolveCapacity = useCallback((choice: string | null) => {
    capacityResolveRef.current?.(choice);
    capacityResolveRef.current = null;
    setCapacityPrompt(null);
  }, []);

  /**
   * 发一条消息。用户在"停哪条"的提示里取消时返回 'cancelled'（输入框据此把草稿放回去）。
   */
  const send = useCallback(async (input: ComposerDraft | string, options: SendOptions = {}): Promise<'cancelled' | void> => {
    const draft = draftFrom(input);
    const content = composeMessage(draft);
    const images = draft.images;
    const attachments = draftAttachments(draft);
    if ((!content.trim() && images.length === 0 && attachments.length === 0) || loadingRef.current) return;

    const evict = await confirmCapacity(sessionIdRef.current);
    if (evict === null) return 'cancelled';
    if (loadingRef.current) return;

    const modelId = options.modelId || selectedModelId;
    const model = models.find((m) => m.id === modelId) ?? selectedModel;
    if (options.modelId && options.modelId !== selectedModelId) setModel(options.modelId);
    const thinking = resolveThinking(model);

    setError(null);
    suggestAbortRef.current?.abort();
    setSuggestions(null);
    setLoadingNow(true);

    let sessionId = sessionIdRef.current;
    let createdSession = false;
    if (!sessionId) {
      const session = await createSession(modelId || undefined);
      if (!session) {
        setLoadingNow(false);
        setError('创建会话失败，请检查网络后重试');
        return;
      }
      sessionId = session.id;
      createdSession = true;
      skipHydrateSessionRef.current = session.id;
      sessionIdRef.current = session.id;
      setCurrentSessionId(session.id);
    }

    let imageUrls: string[] | undefined;
    if (images.length > 0) {
      const userId = getAuthState().user?.id;
      const urls = await Promise.all(
        images.map((img) => (img.startsWith('http') ? Promise.resolve(img) : uploadImage(img, userId, sessionId!))),
      );
      imageUrls = urls.filter((url): url is string => url !== null);
      if (imageUrls.length === 0) imageUrls = undefined;
      if (imageUrls === undefined || imageUrls.length < images.length) {
        toast('有图片上传失败，已跳过', { tone: 'danger' });
      }
    }

    const history = options.history ?? messagesRef.current;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content.trim() || (images.length > 0 ? IMAGE_ONLY_TEXT : FILES_ONLY_TEXT),
      images: imageUrls,
      ...(attachments.length > 0 ? { files: attachments } : {}),
      timestamp: new Date(),
    };
    lastUserTextRef.current = userMessage.content;
    const placeholderId = `temp-${Date.now()}`;
    const placeholder: ChatMessage = {
      id: placeholderId,
      clientKey: placeholderId,
      role: 'assistant',
      content: '',
      tool_trace: [],
      timestamp: new Date(),
    };
    beginStreamTarget(placeholderId, thinking.effective);
    setMessagesNow([...history, userMessage, placeholder]);
    setSentTick((t) => t + 1);

    const stored = await addMessage(sessionId, userMessage);
    if (!stored && !createdSession) {
      // 会话已被删除（本端或另一个标签页删的），就地补一个新会话，用户不用重发
      const fallback = await createSession(modelId || undefined);
      if (!fallback) {
        setLoadingNow(false);
        setError('创建会话失败，请检查网络后重试');
        return;
      }
      sessionId = fallback.id;
      createdSession = true;
      skipHydrateSessionRef.current = fallback.id;
      sessionIdRef.current = fallback.id;
      setCurrentSessionId(fallback.id);
      await addMessage(sessionId, userMessage);
    }
    // 回答在后台跑：列表马上标出"在回答"，离开这段对话也看得到
    void loadSessions();

    const controller = new AbortController();
    abortRef.current = controller;
    streamEndedRef.current = false;

    try {
      await sendChatMessageStream(
        {
          message: userMessage.content,
          images: imageUrls,
          files: attachments.length > 0 ? attachments : undefined,
          history,
          model_id: modelId,
          user_id: getAuthState().user?.id,
          session_id: sessionId,
          thinking: thinking.effective,
          reasoning_effort: thinking.effort,
          current_message_id: userMessage.id,
          image_quality: getSettings().imageQuality,
          delivery: getSettings().delivery,
          ...(evict ? { evict } : {}),
        },
        handleStreamEvent,
        controller.signal,
      );
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        failStream((err as Error).message || '网络中断，回答没有完整返回');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!streamEndedRef.current && loadingRef.current && streamTargetMessageIdRef.current === placeholderId) {
        // 流结束但既没有 message_end 也没报错（比如连接被代理切断）
        if (!controller.signal.aborted) failStream('连接提前结束了，回答可能不完整');
      }
    }
  }, [
    beginStreamTarget, confirmCapacity, failStream, handleStreamEvent, loadSessions, models, resolveThinking,
    selectedModel, selectedModelId, setCurrentSessionId, setLoadingNow, setMessagesNow, setModel,
  ]);

  /** 回到一段正在后台回答的对话：先把已经做了的一次性铺出来，再接着实时看 */
  const resume = useCallback(async (sessionId: string, thinking: boolean) => {
    const placeholderId = `temp-${Date.now()}`;
    const placeholder: ChatMessage = {
      id: placeholderId,
      clientKey: placeholderId,
      role: 'assistant',
      content: '',
      tool_trace: [],
      timestamp: new Date(),
    };
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user');
    lastUserTextRef.current = lastUser?.content ?? '';
    beginStreamTarget(placeholderId, thinking);
    setMessagesNow([...messagesRef.current, placeholder]);
    setLoadingNow(true);

    const controller = new AbortController();
    abortRef.current = controller;
    streamEndedRef.current = false;
    try {
      const found = await resumeChatStream(sessionId, handleStreamEvent, controller.signal);
      if (!found && !controller.signal.aborted) {
        // 刚好做完了：直接读存好的
        const session = await getSession(sessionId);
        if (controller.signal.aborted || sessionIdRef.current !== sessionId) return;
        bindStreamTarget(null);
        resetReasoning();
        setLoadingNow(false);
        if (session) setMessagesNow(session.messages);
      }
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        failStream((err as Error).message || '网络中断，没能接上正在进行的回答');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!streamEndedRef.current && loadingRef.current && streamTargetMessageIdRef.current === placeholderId) {
        if (!controller.signal.aborted) failStream('连接提前结束了，刷新一下看看最新进度');
      }
    }
  }, [beginStreamTarget, bindStreamTarget, failStream, handleStreamEvent, resetReasoning, setLoadingNow, setMessagesNow]);

  /* ---------------- 会话切换 ---------------- */

  useEffect(() => {
    suggestAbortRef.current?.abort();
    setSuggestions(null);
    // 离开一段对话只是不看了：断开连接，回答在后台照样做完
    if (!currentSessionId) {
      abortRef.current?.abort();
      abortRef.current = null;
      streamEndedRef.current = false;
      bindStreamTarget(null);
      resetReasoning();
      setMessagesNow([]);
      setLoadingNow(false);
      setError(null);
      setQueue([]);
      return;
    }
    if (skipHydrateSessionRef.current === currentSessionId) {
      skipHydrateSessionRef.current = null;
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    bindStreamTarget(null);
    resetReasoning();
    setLoadingNow(false);
    setQueue([]);
    setHydrating(true);
    let cancelled = false;
    void getSession(currentSessionId).then((session) => {
      if (cancelled) return;
      setHydrating(false);
      if (!session) {
        setError('这段对话已经不存在了');
        return;
      }
      setMessagesNow(session.messages);
      setError(null);
      let model = selectedModel;
      if (session.model_id && models.length > 0) {
        const resolved = resolveAvailableModelId(session.model_id, models);
        model = models.find((m) => m.id === resolved) ?? model;
        setSelectedModelId(resolved);
        if (resolved !== session.model_id) {
          void updateSession(currentSessionId, { model_id: resolved }).then(() => loadSessions());
        }
      }
      if (session.running) void resume(currentSessionId, resolveThinking(model).effective);
    });
    return () => { cancelled = true; };
    // models 变化时不重新拉取会话
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  /** 停止生成：已经写出来的部分由服务端保存（它手里的比界面上的全） */
  const stop = useCallback(async () => {
    if (!loadingRef.current) return;
    abortRef.current?.abort();
    abortRef.current = null;
    replayingRef.current = false;
    flushPendingToolActions();
    applyPendingToolFinalizations();
    clearPendingToolQueues();
    streamEndedRef.current = false;

    const sessionId = sessionIdRef.current;
    const committed = commitBufferedAssistantContent();
    const reasoning = reasoningSnapshot();
    const current = messagesRef.current;
    const draft = current[current.length - 1];
    const serverId = serverMessageIdRef.current;
    const finalized = draft && draft.role === 'assistant'
      ? {
          ...draft,
          ...reasoning,
          ...(serverId && draft.id === streamTargetMessageIdRef.current ? { id: serverId, clientKey: draft.clientKey ?? draft.id } : {}),
          content: draft.id === streamTargetMessageIdRef.current ? committed : draft.content,
          tool_trace: finalizeInterruptedToolTrace(draft.tool_trace),
        }
      : null;
    if (finalized) setMessagesNow([...current.slice(0, -1), finalized]);
    streamTargetMessageIdRef.current = finalized?.id ?? null;
    setLoadingNow(false);
    setSnapKey((k) => k + 1);

    if (sessionId) {
      await stopChatRun(sessionId);
      void loadSessions();
    }
  }, [applyPendingToolFinalizations, clearPendingToolQueues, commitBufferedAssistantContent, flushPendingToolActions, loadSessions, reasoningSnapshot, setLoadingNow, setMessagesNow]);

  /** 丢掉当前还在生成的回答（重试 / 编辑前用），服务端也不保存 */
  const discardStreaming = useCallback(async () => {
    const wasLoading = loadingRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    replayingRef.current = false;
    clearPendingToolQueues();
    bindStreamTarget(null);
    streamEndedRef.current = false;
    resetReasoning();
    if (wasLoading) {
      const current = messagesRef.current;
      const last = current[current.length - 1];
      if (last?.role === 'assistant') setMessagesNow(current.slice(0, -1));
      setLoadingNow(false);
      const sessionId = sessionIdRef.current;
      if (sessionId) await stopChatRun(sessionId, true);
    }
  }, [bindStreamTarget, clearPendingToolQueues, resetReasoning, setLoadingNow, setMessagesNow]);

  /** 截断到某条用户消息之前（含这条），返回截断后的历史；失败返回 null */
  const truncateBefore = useCallback(async (userMessageId: string): Promise<ChatMessage[] | null> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return null;
    await discardStreaming();
    const ok = await truncateMessages(sessionId, userMessageId);
    if (!ok) {
      setError('操作失败，请重试');
      return null;
    }
    const current = messagesRef.current;
    const idx = current.findIndex((m) => m.id === userMessageId);
    const history = idx >= 0 ? current.slice(0, idx) : current;
    setMessagesNow(history);
    return history;
  }, [discardStreaming, setMessagesNow]);

  /**
   * 从某条用户消息起重来（重试 / 改写重发）：分出一段新对话再发，原来的回答和它做了一半的产物都留在原对话里。
   * 这条之后什么都还没有（比如一发出去就报错），就原地重发，免得多出一段空对话。
   */
  const redoFrom = useCallback(async (userMessageId: string, draft: ComposerDraft, modelId?: string) => {
    const sessionId = sessionIdRef.current;
    const current = messagesRef.current;
    const idx = current.findIndex((m) => m.id === userMessageId);
    if (!sessionId || idx < 0) return;
    const worthKeeping = current.slice(idx + 1).some((m) => m.content.trim() || (m.tool_trace?.length ?? 0) > 0);
    if (!worthKeeping) {
      const history = await truncateBefore(userMessageId);
      if (history) await send(draft, { modelId, history });
      return;
    }
    // 还在生成的那条不动它，让它在原对话里接着做完
    if (loadingRef.current) return;
    const branchId = await branchSession(sessionId, userMessageId, true);
    if (!branchId) {
      toast('没能新开对话重来，原对话保持不变', { tone: 'danger' });
      return;
    }
    const history = current.slice(0, idx);
    // 直接切过去发，不再从服务端拉一遍历史
    skipHydrateSessionRef.current = branchId;
    sessionIdRef.current = branchId;
    setCurrentSessionId(branchId);
    setError(null);
    setMessagesNow(history);
    toast('在新对话里重来，原来的回答和产物都留在原对话里');
    await send(draft, { modelId, history });
  }, [send, setCurrentSessionId, setMessagesNow, truncateBefore]);

  /** 重新生成某条回答；可以指定换一个模型 */
  const regenerate = useCallback(async (assistantMessageId: string, modelId?: string) => {
    const current = messagesRef.current;
    const idx = current.findIndex((m) => m.id === assistantMessageId || m.clientKey === assistantMessageId);
    let userIdx = idx - 1;
    while (userIdx >= 0 && current[userIdx].role !== 'user') userIdx -= 1;
    if (userIdx < 0) return;
    const userMessage = current[userIdx];
    await redoFrom(
      userMessage.id,
      {
        text: userMessage.content === IMAGE_ONLY_TEXT || userMessage.content === FILES_ONLY_TEXT ? '' : userMessage.content,
        images: userMessage.images ?? [],
        quotes: [],
        pastes: [],
        files: draftFilesFrom(userMessage.files),
      },
      modelId,
    );
  }, [redoFrom]);

  /** 改写某条用户消息并重新发送（之后有内容的话在新对话里发，原对话不动） */
  const editAndResend = useCallback(async (userMessageId: string, text: string, images?: string[], files?: FileArtifact[]) => {
    const original = messagesRef.current.find((m) => m.id === userMessageId);
    if (!original) return;
    await redoFrom(
      userMessageId,
      { text, images: images ?? original.images ?? [], quotes: [], pastes: [], files: draftFilesFrom(files ?? original.files) },
    );
  }, [redoFrom]);

  /** 回答进行中插话：停掉当前回答（保留已写部分），马上按新指令继续 */
  const steer = useCallback(async (draft: ComposerDraft) => {
    await stop();
    await send(draft);
  }, [send, stop]);

  /* ---------------- 排队 ---------------- */

  const enqueue = useCallback((draft: ComposerDraft) => {
    setQueue((q) => [...q, { id: crypto.randomUUID(), draft }]);
  }, []);

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((item) => item.id !== id));
  }, []);

  const sendQueuedNow = useCallback(async (id: string) => {
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    setQueue((q) => q.filter((x) => x.id !== id));
    await steer(item.draft);
  }, [queue, steer]);

  useEffect(() => {
    if (isLoading || queue.length === 0 || dispatchingQueueRef.current) return;
    const [next, ...rest] = queue;
    dispatchingQueueRef.current = true;
    setQueue(rest);
    void send(next.draft).finally(() => { dispatchingQueueRef.current = false; });
  }, [isLoading, queue, send]);

  /* ---------------- 分支 ---------------- */

  const branchFrom = useCallback(async (messageId: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || loadingRef.current) return;
    const newId = await branchSession(sessionId, messageId);
    if (!newId) {
      toast('分支创建失败', { tone: 'danger' });
      return;
    }
    await loadSessions();
    setCurrentSessionId(newId);
    toast('已在新对话里接着聊，原对话保持不变');
  }, [loadSessions, setCurrentSessionId]);

  useEffect(() => () => {
    resetStreamBuffer();
    suggestAbortRef.current?.abort();
  }, [resetStreamBuffer]);

  return {
    messages,
    isLoading,
    hydrating,
    error,
    clearError: () => setError(null),
    models,
    selectedModel,
    selectedModelId,
    setModel,
    thinkingLevel,
    setThinkingLevel,
    thinkingLocked,
    supportsReasoningEffort,
    effectiveThinking,
    /** 正在流式输出的那条回答；它的实时正文 = message.content + streamBuffer */
    streamingMessageId: isLoading ? streamTargetId : null,
    streamBuffer: bufferedAssistantContent,
    liveThinking,
    queue,
    enqueue,
    removeQueued,
    sendQueuedNow,
    suggestions,
    send,
    stop,
    /** 同时回答满了、等用户选停哪条；resolveCapacity(会话 id) 停那条，resolveCapacity(null) 取消发送 */
    capacityPrompt,
    resolveCapacity,
    steer,
    regenerate,
    editAndResend,
    branchFrom,
    snapKey,
    sentTick,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
