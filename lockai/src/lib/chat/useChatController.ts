'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatModel, ThinkingLevel, ToolTrace } from '@/types';
import { fetchSuggestions, getModels, sendChatMessageStream, uploadImage } from '@/lib/api';
import { addMessage, branchSession, createSession, getSession, truncateMessages, updateSession } from '@/lib/chat-history';
import { getAuthState } from '@/lib/auth';
import { getSettings, saveSettings } from '@/lib/settings';
import { useStreamBuffer } from '@/lib/hooks/useStreamBuffer';
import { toast } from '@/components/ui/Toast';
import { composeMessage, type ComposerDraft } from './compose';
import {
  appendToolMarker,
  finalizeInterruptedToolTrace,
  finalizeSearchTrace,
  patchLatestImageTrace,
  stripToolMarkers,
  upsertRunningImageTrace,
  upsertRunningSearchTrace,
} from './traces';

const TOOL_CARD_MIN_VISIBLE_MS = 450;
const DEFAULT_CHAT_MODEL_ID = 'campbell';

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

interface ReasoningTrack {
  text: string;
  activeSince: number | null;
  accumulatedMs: number;
}

function resolveAvailableModelId(modelId: string | null | undefined, models: ChatModel[]): string {
  const target = (modelId || '').trim();
  if (target && models.some((m) => m.id === target)) return target;
  return models.find((m) => m.is_default)?.id || models[0]?.id || '';
}

function draftFrom(input: ComposerDraft | string): ComposerDraft {
  return typeof input === 'string' ? { text: input, images: [], quotes: [], pastes: [] } : input;
}

interface ControllerDeps {
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<unknown>;
}

export function useChatController({ currentSessionId, setCurrentSessionId, loadSessions }: ControllerDeps) {
  const initialSettings = useMemo(() => getSettings(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(initialSettings.selectedModelId || DEFAULT_CHAT_MODEL_ID);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(initialSettings.thinkingLevel);
  const [liveReasoning, setLiveReasoning] = useState('');
  const [reasoningActive, setReasoningActive] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [suggestions, setSuggestions] = useState<{ messageId: string; items: string[] } | null>(null);
  const [snapKey, setSnapKey] = useState(0);
  const [sentTick, setSentTick] = useState(0);
  const [streamTargetId, setStreamTargetId] = useState<string | null>(null);

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
  const reasoningRef = useRef<ReasoningTrack>({ text: '', activeSince: null, accumulatedMs: 0 });
  const reasoningFlushRef = useRef<number | null>(null);
  const lastUserTextRef = useRef('');
  const dispatchingQueueRef = useRef(false);

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

  const setMessagesNow = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const setLoadingNow = useCallback((value: boolean) => {
    loadingRef.current = value;
    setIsLoading(value);
  }, []);

  /* ---------------- 思考过程 ---------------- */

  const resetReasoning = useCallback(() => {
    reasoningRef.current = { text: '', activeSince: null, accumulatedMs: 0 };
    if (reasoningFlushRef.current !== null) cancelAnimationFrame(reasoningFlushRef.current);
    reasoningFlushRef.current = null;
    setLiveReasoning('');
    setReasoningActive(false);
  }, []);

  const pauseReasoning = useCallback(() => {
    const track = reasoningRef.current;
    if (track.activeSince !== null) {
      track.accumulatedMs += performance.now() - track.activeSince;
      track.activeSince = null;
      setReasoningActive(false);
    }
  }, []);

  const pushReasoning = useCallback((delta: string) => {
    const track = reasoningRef.current;
    if (track.activeSince === null) {
      // 工具调用后的新一轮思考，和上一段隔开
      if (track.text && !track.text.endsWith('\n')) track.text += '\n\n';
      track.activeSince = performance.now();
      setReasoningActive(true);
    }
    track.text += delta;
    if (reasoningFlushRef.current === null) {
      reasoningFlushRef.current = requestAnimationFrame(() => {
        reasoningFlushRef.current = null;
        setLiveReasoning(reasoningRef.current.text);
      });
    }
  }, []);

  const reasoningSnapshot = useCallback(() => {
    pauseReasoning();
    const track = reasoningRef.current;
    const text = track.text.trim();
    return text
      ? { reasoning: text, reasoning_seconds: Math.max(1, Math.round(track.accumulatedMs / 1000)) }
      : {};
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
      toolVisibleUntilRef.current = performance.now() + TOOL_CARD_MIN_VISIBLE_MS;
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

  /* ---------------- 会话切换 ---------------- */

  useEffect(() => {
    suggestAbortRef.current?.abort();
    setSuggestions(null);
    if (!currentSessionId) {
      // 会话被删除或新建对话：中止还在跑的流，否则它会继续往已删除的会话里写
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
      if (session.model_id && models.length > 0) {
        const resolved = resolveAvailableModelId(session.model_id, models);
        setSelectedModelId(resolved);
        if (resolved !== session.model_id) {
          void updateSession(currentSessionId, { model_id: resolved }).then(() => loadSessions());
        }
      }
    });
    return () => { cancelled = true; };
    // models 变化时不重新拉取会话
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  /* ---------------- 发送 ---------------- */

  const failStream = useCallback((message: string) => {
    flushPendingToolActions();
    applyPendingToolFinalizations();
    clearPendingToolQueues();
    streamEndedRef.current = false;
    const committed = commitBufferedAssistantContent();
    const reasoning = reasoningSnapshot();
    setError(message);
    updateStreamTargetMessage((msg) => ({
      ...msg,
      ...reasoning,
      content: committed,
      tool_trace: finalizeInterruptedToolTrace(msg.tool_trace),
    }));
    setLoadingNow(false);
  }, [applyPendingToolFinalizations, clearPendingToolQueues, commitBufferedAssistantContent, flushPendingToolActions, reasoningSnapshot, setLoadingNow, updateStreamTargetMessage]);

  const send = useCallback(async (input: ComposerDraft | string, options: SendOptions = {}) => {
    const draft = draftFrom(input);
    const content = composeMessage(draft);
    const images = draft.images;
    if ((!content.trim() && images.length === 0) || loadingRef.current) return;

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
      content: content.trim() || '(图片)',
      images: imageUrls,
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
    clearPendingToolQueues();
    resetReasoning();
    serverMessageIdRef.current = null;
    bindStreamTarget(placeholderId);
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
    if (createdSession) void loadSessions();

    const controller = new AbortController();
    abortRef.current = controller;
    streamEndedRef.current = false;

    try {
      await sendChatMessageStream(
        {
          message: userMessage.content,
          images: imageUrls,
          history,
          model_id: modelId,
          user_id: getAuthState().user?.id,
          session_id: sessionId,
          thinking: thinking.effective,
          reasoning_effort: thinking.effort,
          current_message_id: userMessage.id,
          image_quality: getSettings().imageQuality,
        },
        (event) => {
          switch (event.type) {
            case 'message_start':
              serverMessageIdRef.current = event.message_id;
              break;
            case 'reasoning_delta':
              pushReasoning(event.delta);
              break;
            case 'content_delta':
              pauseReasoning();
              revealPendingImages();
              processPendingStreamTransitions();
              pushStreamBuffer(event.delta);
              break;
            case 'search_start':
              pauseReasoning();
              scheduleToolAction(() => {
                const base = commitBufferedAssistantContent();
                updateStreamTargetMessage((msg) => {
                  const nextTrace = upsertRunningSearchTrace(msg.tool_trace, event.query);
                  const nextContent = appendToolMarker(base, nextTrace.length - 1);
                  streamCommittedContentRef.current = nextContent;
                  return { ...msg, content: nextContent, tool_trace: nextTrace };
                });
              });
              break;
            case 'search_end':
              queueToolFinalization((trace) => finalizeSearchTrace(trace, event.query, event.success, event.sources));
              break;
            case 'image_gen_start':
              pauseReasoning();
              scheduleToolAction(() => {
                const base = commitBufferedAssistantContent();
                updateStreamTargetMessage((msg) => {
                  const nextTrace = upsertRunningImageTrace(msg.tool_trace, {
                    prompt: event.prompt,
                    mode: event.mode,
                    assetId: event.assetId,
                    request: event.request,
                    editRequest: event.editRequest,
                    modelLabel: event.modelLabel,
                  });
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
              }));
              break;
            case 'title_update':
              void loadSessions();
              break;
            case 'message_end':
              pauseReasoning();
              streamEndedRef.current = true;
              processPendingStreamTransitions();
              break;
            case 'error':
              failStream(event.message || '发送消息失败');
              break;
          }
        },
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
    bindStreamTarget, clearPendingToolQueues, commitBufferedAssistantContent, failStream, loadSessions, models,
    pauseReasoning, processPendingStreamTransitions, pushReasoning, pushStreamBuffer, queueToolFinalization,
    resetReasoning, resolveThinking, revealPendingImages, scheduleToolAction, selectedModel, selectedModelId,
    setCurrentSessionId, setLoadingNow, setMessagesNow, setModel, updateStreamTargetMessage,
  ]);

  /** 停止生成：已经写出来的部分保留并存档 */
  const stop = useCallback(async () => {
    if (!loadingRef.current) return;
    abortRef.current?.abort();
    abortRef.current = null;
    flushPendingToolActions();
    applyPendingToolFinalizations();
    clearPendingToolQueues();
    streamEndedRef.current = false;

    const sessionId = sessionIdRef.current;
    const committed = commitBufferedAssistantContent();
    const reasoning = reasoningSnapshot();
    const current = messagesRef.current;
    const draft = current[current.length - 1];
    const finalized = draft && draft.role === 'assistant'
      ? {
          ...draft,
          ...reasoning,
          content: draft.id === streamTargetMessageIdRef.current ? committed : draft.content,
          tool_trace: finalizeInterruptedToolTrace(draft.tool_trace),
        }
      : null;
    if (finalized) setMessagesNow([...current.slice(0, -1), finalized]);
    setLoadingNow(false);
    setSnapKey((k) => k + 1);

    if (sessionId && finalized && (finalized.content.trim() || (finalized.tool_trace?.length ?? 0) > 0)) {
      await addMessage(sessionId, finalized);
      void loadSessions();
    }
  }, [applyPendingToolFinalizations, clearPendingToolQueues, commitBufferedAssistantContent, flushPendingToolActions, loadSessions, reasoningSnapshot, setLoadingNow, setMessagesNow]);

  /** 丢掉当前还在生成的回答（重试 / 编辑前用） */
  const discardStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearPendingToolQueues();
    bindStreamTarget(null);
    streamEndedRef.current = false;
    resetReasoning();
    if (loadingRef.current) {
      const current = messagesRef.current;
      const last = current[current.length - 1];
      if (last?.role === 'assistant') setMessagesNow(current.slice(0, -1));
      setLoadingNow(false);
    }
  }, [bindStreamTarget, clearPendingToolQueues, resetReasoning, setLoadingNow, setMessagesNow]);

  /** 截断到某条用户消息之前（含这条），返回截断后的历史；失败返回 null */
  const truncateBefore = useCallback(async (userMessageId: string): Promise<ChatMessage[] | null> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return null;
    discardStreaming();
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

  /** 重新生成某条回答；可以指定换一个模型 */
  const regenerate = useCallback(async (assistantMessageId: string, modelId?: string) => {
    const current = messagesRef.current;
    const idx = current.findIndex((m) => m.id === assistantMessageId || m.clientKey === assistantMessageId);
    let userIdx = idx - 1;
    while (userIdx >= 0 && current[userIdx].role !== 'user') userIdx -= 1;
    if (userIdx < 0) return;
    const userMessage = current[userIdx];
    const history = await truncateBefore(userMessage.id);
    if (!history) return;
    await send(
      { text: userMessage.content === '(图片)' ? '' : userMessage.content, images: userMessage.images ?? [], quotes: [], pastes: [] },
      { modelId, history },
    );
  }, [send, truncateBefore]);

  /** 改写某条用户消息并重新发送（之后的对话会被替换） */
  const editAndResend = useCallback(async (userMessageId: string, text: string, images?: string[]) => {
    const current = messagesRef.current;
    const original = current.find((m) => m.id === userMessageId);
    if (!original) return;
    const history = await truncateBefore(userMessageId);
    if (!history) return;
    await send({ text, images: images ?? original.images ?? [], quotes: [], pastes: [] }, { history });
  }, [send, truncateBefore]);

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
    liveReasoning,
    reasoningActive,
    queue,
    enqueue,
    removeQueued,
    sendQueuedNow,
    suggestions,
    send,
    stop,
    steer,
    regenerate,
    editAndResend,
    branchFrom,
    snapKey,
    sentTick,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
