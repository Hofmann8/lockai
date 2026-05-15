'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChatMessage, ChatModel, ChatState, ThinkingLevel, ToolTrace } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { sendChatMessageStream, getModels, uploadImage } from '@/lib/api';
import { getSession, createSession, addMessage, truncateMessages } from '@/lib/chat-history';
import { getAuthState } from '@/lib/auth';
import { useAppShell } from '@/components/AppShell';
import { getSettings, saveSettings } from '@/lib/settings';
import { useStreamBuffer } from '@/lib/hooks/useStreamBuffer';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const TOOL_CARD_MIN_VISIBLE_MS = 450;
const DEFAULT_CHAT_MODEL_ID = 'campbell';

const initialState: ChatState = {
  messages: [],
  isLoading: false,
  error: null,
};

function resolveAvailableModelId(
  modelId: string | null | undefined,
  availableModels: ChatModel[],
): string {
  const target = (modelId || '').trim();
  if (target && availableModels.some((model) => model.id === target)) {
    return target;
  }
  return availableModels.find((model) => model.is_default)?.id || availableModels[0]?.id || '';
}

function findLatestRunningToolTraceIndex(trace: ToolTrace[] | undefined, kind: ToolTrace['kind']): number {
  if (!Array.isArray(trace)) return -1;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const item = trace[i];
    if (item.kind === kind && item.status === 'running') {
      return i;
    }
  }
  return -1;
}

function upsertRunningSearchTrace(trace: ToolTrace[] | undefined, query: string): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  const last = next[next.length - 1];
  if (last && last.kind === 'search' && last.status === 'running') {
    next[next.length - 1] = { ...last, query: query.trim() || last.query };
    return next;
  }
  next.push({
    kind: 'search',
    query: query.trim(),
    status: 'running',
    startedAtMs: Date.now(),
  });
  return next;
}

function finalizeSearchTrace(trace: ToolTrace[] | undefined, query: string, success: boolean): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const item = next[i];
    if (item.kind === 'search' && item.status === 'running') {
      const startedAtMs = item.startedAtMs ?? Date.now();
      next[i] = {
        ...item,
        query: query.trim() || item.query,
        status: 'done',
        success,
        durationSeconds: Math.max(1, Math.round((Date.now() - startedAtMs) / 1000)),
      };
      return next;
    }
  }
  next.push({
    kind: 'search',
    query: query.trim(),
    status: 'done',
    success,
    durationSeconds: 1,
  });
  return next;
}

function upsertRunningImageTrace(trace: ToolTrace[] | undefined, patch: Partial<Extract<ToolTrace, { kind: 'image_gen' }>> & { prompt: string }): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  const last = next[next.length - 1];
  if (last && last.kind === 'image_gen' && last.status === 'running') {
    next[next.length - 1] = { ...last, ...patch };
    return next;
  }
  next.push({
    kind: 'image_gen',
    ...patch,
    status: 'running',
    startedAtMs: Date.now(),
    prompt: patch.prompt,
    mode: patch.mode,
  });
  return next;
}

function patchLatestImageTrace(trace: ToolTrace[] | undefined, patch: Partial<Extract<ToolTrace, { kind: 'image_gen' }>>): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].kind === 'image_gen') {
      const existing = next[i] as Extract<ToolTrace, { kind: 'image_gen' }>;
      const startedAtMs = existing.startedAtMs ?? Date.now();
      next[i] = {
        ...existing,
        ...patch,
        durationSeconds: patch.status === 'done'
          ? Math.max(1, Math.round((Date.now() - startedAtMs) / 1000))
          : existing.durationSeconds,
      } as Extract<ToolTrace, { kind: 'image_gen' }>;
      return next;
    }
  }
  return next;
}

function patchImageTraceByAssetId(
  trace: ToolTrace[] | undefined,
  assetId: string | undefined,
  patch: Partial<Extract<ToolTrace, { kind: 'image_gen' }>>,
): ToolTrace[] {
  if (!assetId) {
    return patchLatestImageTrace(trace, patch);
  }
  const next = Array.isArray(trace) ? [...trace] : [];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const item = next[i];
    if (item.kind !== 'image_gen' || item.assetId !== assetId) continue;
    const existing = item as Extract<ToolTrace, { kind: 'image_gen' }>;
    const startedAtMs = existing.startedAtMs ?? Date.now();
    next[i] = {
      ...existing,
      ...patch,
      durationSeconds: patch.status === 'done'
        ? Math.max(1, Math.round((Date.now() - startedAtMs) / 1000))
        : existing.durationSeconds,
    } as Extract<ToolTrace, { kind: 'image_gen' }>;
    return next;
  }
  return patchLatestImageTrace(next, patch);
}

function finalizeInterruptedToolTrace(trace: ToolTrace[] | undefined): ToolTrace[] | undefined {
  if (!Array.isArray(trace) || trace.length === 0) return trace;

  let changed = false;
  const next = trace.map((item) => {
    if (item.status !== 'running') return item;
    changed = true;
    return {
      ...item,
      status: 'done',
      success: false,
    } as ToolTrace;
  });

  return changed ? next : trace;
}

function appendToolMarker(content: string, toolIndex: number): string {
  const marker = `<!--tool:${toolIndex}-->`;
  return content.includes(marker) ? content : `${content}${marker}`;
}

function isAwaitingToolFollowup(message: ChatMessage | null): boolean {
  if (!message || message.role !== 'assistant') return false;
  const trace = message.tool_trace ?? [];
  if (trace.length === 0 || trace.some((item) => item.status === 'running')) return false;

  const content = message.content || '';
  const markerRe = /<!--tool:(\d+)-->/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = null;

  while ((match = markerRe.exec(content)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return !content.trim();
  }

  const tail = content.slice(lastMatch.index + lastMatch[0].length);
  return !tail.trim();
}

type PendingToolAction = () => void;
type PendingToolFinalization = (trace: ToolTrace[] | undefined) => ToolTrace[] | undefined;
type PendingImageReveal = {
  assetId?: string;
  apply: PendingToolFinalization;
};

async function updateSessionMetadata(sessionId: string, payload: { title?: string; model_id?: string }) {
  await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export default function ChatPage() {
  const { currentSessionId, setCurrentSessionId, loadSessions } = useAppShell();
  const settings = getSettings();

  const [state, setState] = useState<ChatState>(initialState);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(settings.selectedModelId || DEFAULT_CHAT_MODEL_ID);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(settings.thinkingLevel);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const [searchSeconds, setSearchSeconds] = useState(0);
  const [imageGenSeconds, setImageGenSeconds] = useState(0);
  const [toolFollowupSeconds, setToolFollowupSeconds] = useState(0);
  const [recallText, setRecallText] = useState<string | undefined>(undefined);
  const [recallImages, setRecallImages] = useState<string[] | undefined>(undefined);
  const [recallTick, setRecallTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const skipHydrateSessionRef = useRef<string | null>(null);
  const latestMessagesRef = useRef<ChatMessage[]>([]);
  const streamEndedRef = useRef(false);
  const streamTargetMessageIdRef = useRef<string | null>(null);
  const streamCommittedContentRef = useRef('');
  const pendingToolActionsRef = useRef<PendingToolAction[]>([]);
  const pendingToolFinalizationsRef = useRef<PendingToolFinalization[]>([]);
  const pendingImageRevealsRef = useRef<PendingImageReveal[]>([]);
  const toolVisibleUntilRef = useRef(0);
  const toolFinalizationTimerRef = useRef<number | null>(null);
  const {
    displayedContent: bufferedAssistantContent,
    push: pushStreamBuffer,
    start: startStreamBuffer,
    flush: flushStreamBuffer,
    reset: resetStreamBuffer,
    getBufferedContent,
    getPendingCharCount,
  } = useStreamBuffer();

  useEffect(() => {
    latestMessagesRef.current = state.messages;
  }, [state.messages]);

  const bindStreamTarget = useCallback((messageId: string | null, initialContent = '') => {
    streamTargetMessageIdRef.current = messageId;
    streamCommittedContentRef.current = initialContent;
    pendingToolActionsRef.current = [];
    pendingToolFinalizationsRef.current = [];
    pendingImageRevealsRef.current = [];
    streamEndedRef.current = false;
    setStreamRenderTick((tick) => tick + 1);
    if (messageId) {
      startStreamBuffer();
      if (initialContent) {
        pushStreamBuffer(initialContent);
      }
      return;
    }
    resetStreamBuffer();
  }, [pushStreamBuffer, resetStreamBuffer, startStreamBuffer]);

  const commitBufferedAssistantContent = useCallback(() => {
    const targetId = streamTargetMessageIdRef.current;
    if (!targetId) {
      return streamCommittedContentRef.current;
    }

    const bufferedSegment = getBufferedContent();
    if (!bufferedSegment) {
      return streamCommittedContentRef.current;
    }

    flushStreamBuffer();
    const nextContent = `${streamCommittedContentRef.current}${bufferedSegment}`;
    streamCommittedContentRef.current = nextContent;

    setState((prev) => {
      let changed = false;
      const nextMessages = prev.messages.map((msg) => {
        if (msg.id !== targetId || msg.content === nextContent) {
          return msg;
        }
        changed = true;
        return { ...msg, content: nextContent };
      });
      return changed ? { ...prev, messages: nextMessages } : prev;
    });

    startStreamBuffer();
    return nextContent;
  }, [flushStreamBuffer, getBufferedContent, startStreamBuffer]);

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

  const markToolUiStarted = useCallback(() => {
    toolVisibleUntilRef.current = performance.now() + TOOL_CARD_MIN_VISIBLE_MS;
    if (toolFinalizationTimerRef.current !== null) {
      window.clearTimeout(toolFinalizationTimerRef.current);
      toolFinalizationTimerRef.current = null;
    }
  }, []);

  const updateStreamTargetMessage = useCallback((updater: (message: ChatMessage) => ChatMessage) => {
    const targetId = streamTargetMessageIdRef.current;
    if (!targetId) return;
    setState((prev) => {
      let changed = false;
      const nextMessages = prev.messages.map((msg) => {
        if (msg.id !== targetId) return msg;
        const nextMessage = updater(msg);
        if (nextMessage === msg) return msg;
        changed = true;
        return nextMessage;
      });
      return changed ? { ...prev, messages: nextMessages } : prev;
    });
  }, []);

  const flushPendingToolActions = useCallback(() => {
    const actions = pendingToolActionsRef.current;
    if (actions.length === 0) return;
    pendingToolActionsRef.current = [];
    for (const action of actions) {
      action();
    }
  }, []);

  const applyPendingToolFinalizations = useCallback(() => {
    const pending = pendingToolFinalizationsRef.current;
    if (pending.length === 0) return;
    pendingToolFinalizationsRef.current = [];
    updateStreamTargetMessage((msg) => {
      let nextTrace = msg.tool_trace;
      for (const apply of pending) {
        nextTrace = apply(nextTrace);
      }
      return nextTrace === msg.tool_trace ? msg : { ...msg, tool_trace: nextTrace };
    });
  }, [updateStreamTargetMessage]);

  const revealPendingImages = useCallback(() => {
    const pending = pendingImageRevealsRef.current;
    if (pending.length === 0) return;
    pendingImageRevealsRef.current = [];
    updateStreamTargetMessage((msg) => {
      let nextTrace = msg.tool_trace;
      for (const item of pending) {
        nextTrace = item.apply(nextTrace);
      }
      return nextTrace === msg.tool_trace ? msg : { ...msg, tool_trace: nextTrace };
    });
  }, [updateStreamTargetMessage]);

  const finalizeStreamingIfReady = useCallback(() => {
    if (!streamEndedRef.current) return;
    if (pendingToolActionsRef.current.length > 0) return;
    if (pendingToolFinalizationsRef.current.length > 0) return;
    if (getPendingCharCount() > 0) return;

    revealPendingImages();
    commitBufferedAssistantContent();
    streamEndedRef.current = false;
    setState((prev) => (prev.isLoading ? { ...prev, isLoading: false } : prev));
    void loadSessions();
  }, [commitBufferedAssistantContent, getPendingCharCount, loadSessions, revealPendingImages]);

  const processPendingStreamTransitions = useCallback(() => {
    if (getPendingCharCount() > 0) {
      return;
    }
    if (pendingToolFinalizationsRef.current.length > 0) {
      const waitMs = toolVisibleUntilRef.current - performance.now();
      if (waitMs > 0) {
        if (toolFinalizationTimerRef.current !== null) {
          window.clearTimeout(toolFinalizationTimerRef.current);
        }
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
  }, [
    applyPendingToolFinalizations,
    finalizeStreamingIfReady,
    flushPendingToolActions,
    getPendingCharCount,
  ]);

  const scheduleToolAction = useCallback((action: PendingToolAction) => {
    const wrappedAction = () => {
      revealPendingImages();
      action();
      markToolUiStarted();
    };
    if (
      pendingToolActionsRef.current.length === 0
      && pendingToolFinalizationsRef.current.length === 0
    ) {
      wrappedAction();
      processPendingStreamTransitions();
      return;
    }
    pendingToolActionsRef.current.push(wrappedAction);
  }, [markToolUiStarted, processPendingStreamTransitions, revealPendingImages]);

  const queueToolFinalization = useCallback((apply: PendingToolFinalization) => {
    pendingToolFinalizationsRef.current.push(apply);
    processPendingStreamTransitions();
  }, [processPendingStreamTransitions]);

  useEffect(() => {
    if (streamEndedRef.current && getPendingCharCount() === 0) {
      processPendingStreamTransitions();
    }
  }, [bufferedAssistantContent, getPendingCharCount, processPendingStreamTransitions]);

  useEffect(() => {
    let mounted = true;
    void getModels().then((data) => {
      if (!mounted) return;
      setModels(data);
      const preferredModelId = resolveAvailableModelId(settings.selectedModelId, data);
      if (preferredModelId) {
        setSelectedModelId(preferredModelId);
        saveSettings({ selectedModelId: preferredModelId });
      }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!currentSessionId) {
      bindStreamTarget(null);
      setState(initialState);
      return;
    }
    if (skipHydrateSessionRef.current === currentSessionId) {
      skipHydrateSessionRef.current = null;
      return;
    }
    void getSession(currentSessionId).then((session) => {
      if (!session) return;
      setState((prev) => ({ ...prev, messages: session.messages, isLoading: false, error: null }));
      if (session.model_id && models.length > 0) {
        const resolvedModelId = resolveAvailableModelId(session.model_id, models);
        setSelectedModelId(resolvedModelId);
        saveSettings({ selectedModelId: resolvedModelId });
        if (resolvedModelId !== session.model_id) {
          void updateSessionMetadata(currentSessionId, { model_id: resolvedModelId }).then(() => loadSessions());
        }
      }
    });
  }, [bindStreamTarget, currentSessionId, loadSessions, models]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );
  const [streamRenderTick, setStreamRenderTick] = useState(0);
  const streamingContentOverride = useMemo(() => {
    const targetId = streamTargetMessageIdRef.current;
    if (!targetId) return undefined;
    return `${streamCommittedContentRef.current}${bufferedAssistantContent}`;
  }, [bufferedAssistantContent, streamRenderTick]);

  const thinkingLocked = !selectedModel || selectedModel.thinking_mode !== 'optional';
  const thinkingLockReason = thinkingLocked ? '该模型不支持关闭思考' : undefined;
  const supportsReasoningEffort = Boolean(selectedModel?.supports_reasoning_effort);
  const thinkingOn = thinkingLevel !== 'fast';
  const effectiveThinking = selectedModel?.thinking_mode === 'always'
    ? true
    : selectedModel?.thinking_mode === 'never'
      ? false
      : thinkingOn;
  const effectiveReasoningEffort: 'high' | 'max' | undefined = supportsReasoningEffort && effectiveThinking
    ? thinkingLevel === 'deep' ? 'max' : 'high'
    : undefined;

  useEffect(() => {
    saveSettings({ selectedModelId, thinkingLevel });
  }, [selectedModelId, thinkingLevel]);

  useEffect(() => () => {
    resetStreamBuffer();
  }, [resetStreamBuffer]);

  const handleReasoningModeToggle = useCallback(() => {
    if (thinkingLocked) return;
    if (supportsReasoningEffort) {
      setThinkingLevel((prev) => prev === 'fast' ? 'standard' : prev === 'standard' ? 'deep' : 'fast');
      return;
    }
    setThinkingLevel((prev) => prev === 'fast' ? 'deep' : 'fast');
  }, [supportsReasoningEffort, thinkingLocked]);

  const lastAssistantMessage = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      if (state.messages[i].role === 'assistant') return state.messages[i];
    }
    return null;
  }, [state.messages]);

  const lastAssistantToolTrace = lastAssistantMessage?.tool_trace ?? [];
  const isWaitingOnlyState = Boolean(
    state.isLoading
    && lastAssistantMessage
    && !lastAssistantMessage.content.trim()
    && lastAssistantToolTrace.length === 0,
  );
  const isSearchRunning = state.isLoading && findLatestRunningToolTraceIndex(lastAssistantToolTrace, 'search') >= 0;
  const isImageRunning = state.isLoading && findLatestRunningToolTraceIndex(lastAssistantToolTrace, 'image_gen') >= 0;
  const isAwaitingToolFollowupState = Boolean(
    state.isLoading
    && lastAssistantMessage
    && !isWaitingOnlyState
    && !isSearchRunning
    && !isImageRunning
    && isAwaitingToolFollowup(lastAssistantMessage)
  );

  useEffect(() => {
    if (!isWaitingOnlyState) {
      setWaitingSeconds(0);
      return;
    }
    setWaitingSeconds(0);
    const timer = window.setInterval(() => setWaitingSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isWaitingOnlyState]);

  useEffect(() => {
    if (!isSearchRunning) {
      setSearchSeconds(0);
      return;
    }
    setSearchSeconds(0);
    const timer = window.setInterval(() => setSearchSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isSearchRunning]);

  useEffect(() => {
    if (!isImageRunning) {
      setImageGenSeconds(0);
      return;
    }
    setImageGenSeconds(0);
    const timer = window.setInterval(() => setImageGenSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isImageRunning]);

  useEffect(() => {
    if (!isAwaitingToolFollowupState) {
      setToolFollowupSeconds(0);
      return;
    }
    setToolFollowupSeconds(0);
    const timer = window.setInterval(() => setToolFollowupSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isAwaitingToolFollowupState]);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    if (currentSessionId) {
      void updateSessionMetadata(currentSessionId, { model_id: modelId }).then(() => loadSessions());
    }
  }, [currentSessionId, loadSessions]);

  const stopStreaming = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    flushPendingToolActions();
    applyPendingToolFinalizations();
    clearPendingToolQueues();
    streamEndedRef.current = false;

    const sessionId = currentSessionId;
    const messages = latestMessagesRef.current;
    const draft = messages[messages.length - 1];
    const committedContent = commitBufferedAssistantContent();
    const finalizedDraft = draft && draft.role === 'assistant'
      ? {
          ...draft,
          content: draft.id === streamTargetMessageIdRef.current ? committedContent : draft.content,
          tool_trace: finalizeInterruptedToolTrace(draft.tool_trace),
        }
      : draft;

    setState((prev) => ({
      ...prev,
      isLoading: false,
      messages: prev.messages.map((msg, index) => (
        finalizedDraft && index === prev.messages.length - 1 && msg.id === finalizedDraft.id
          ? finalizedDraft
          : msg
      )),
    }));

    if (sessionId && finalizedDraft && finalizedDraft.role === 'assistant' && (finalizedDraft.content.trim() || (finalizedDraft.tool_trace?.length ?? 0) > 0)) {
      await addMessage(sessionId, finalizedDraft);
      await loadSessions();
    }
  }, [
    applyPendingToolFinalizations,
    clearPendingToolQueues,
    commitBufferedAssistantContent,
    currentSessionId,
    flushPendingToolActions,
    loadSessions,
  ]);

  const discardStreamingDraft = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearPendingToolQueues();
    bindStreamTarget(null);
    streamEndedRef.current = false;
    setState((prev) => {
      if (!prev.isLoading) {
        return prev.error ? { ...prev, error: null } : prev;
      }

      const lastMessage = prev.messages[prev.messages.length - 1];
      const nextMessages = lastMessage?.role === 'assistant'
        ? prev.messages.slice(0, -1)
        : prev.messages;

      return {
        ...prev,
        messages: nextMessages,
        isLoading: false,
        error: null,
      };
    });
  }, [bindStreamTarget, clearPendingToolQueues]);

  const handleSendMessage = useCallback(async (content: string, images?: string[]) => {
    if ((!content.trim() && (!images || images.length === 0)) || state.isLoading) return;

    let sessionId = currentSessionId;
    let createdSession = false;
    if (!sessionId) {
      const session = await createSession(selectedModelId || undefined);
      if (!session) {
        setState((prev) => ({ ...prev, error: '创建会话失败' }));
        return;
      }
      sessionId = session.id;
      createdSession = true;
      skipHydrateSessionRef.current = session.id;
      setCurrentSessionId(session.id);
      await loadSessions();
    }

    let imageUrls: string[] | undefined;
    if (images && images.length > 0) {
      const userId = getAuthState().user?.id;
      const urls = await Promise.all(
        images.map((img) => img.startsWith('http') ? Promise.resolve(img) : uploadImage(img, userId, sessionId!)),
      );
      imageUrls = urls.filter((url): url is string => url !== null);
      if (imageUrls.length === 0) imageUrls = undefined;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content.trim() || '(图片)',
      images: imageUrls,
      timestamp: new Date(),
    };

    const assistantPlaceholderId = `temp-${Date.now()}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantPlaceholderId,
      role: 'assistant',
      content: '',
      tool_trace: [],
      timestamp: new Date(),
    };
    clearPendingToolQueues();
    bindStreamTarget(assistantPlaceholderId);

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistantPlaceholder],
      isLoading: true,
      error: null,
    }));

    await addMessage(sessionId!, userMessage);
    if (createdSession) {
      await loadSessions();
    }

    const controller = new AbortController();
    abortRef.current = controller;
    streamEndedRef.current = false;

    try {
      await sendChatMessageStream(
        {
          message: content.trim() || '(图片)',
          images: imageUrls,
          history: state.messages,
          model_id: selectedModelId,
          user_id: getAuthState().user?.id,
          session_id: sessionId,
          thinking: effectiveThinking,
          reasoning_effort: effectiveReasoningEffort,
          current_message_id: userMessage.id,
          image_quality: getSettings().imageQuality,
        },
        (event) => {
          switch (event.type) {
            case 'message_start':
              // Keep the optimistic id stable during streaming to avoid remount flicker.
              streamTargetMessageIdRef.current = assistantPlaceholderId;
              break;
            case 'content_delta':
              revealPendingImages();
              processPendingStreamTransitions();
              pushStreamBuffer(event.delta);
              break;
            case 'search_start':
              scheduleToolAction(() => {
                const baseContent = commitBufferedAssistantContent();
                updateStreamTargetMessage((msg) => {
                  const nextTrace = upsertRunningSearchTrace(msg.tool_trace, event.query);
                  const nextContent = appendToolMarker(baseContent, nextTrace.length - 1);
                  streamCommittedContentRef.current = nextContent;
                  return {
                    ...msg,
                    content: nextContent,
                    tool_trace: nextTrace,
                  };
                });
              });
              break;
            case 'search_end':
              queueToolFinalization((trace) => finalizeSearchTrace(trace, event.query, event.success));
              break;
            case 'image_gen_start':
              scheduleToolAction(() => {
                const baseContent = commitBufferedAssistantContent();
                updateStreamTargetMessage((msg) => {
                  const nextTrace = upsertRunningImageTrace(msg.tool_trace, {
                    prompt: event.prompt,
                    mode: event.mode,
                    assetId: event.assetId,
                    request: event.request,
                    editRequest: event.editRequest,
                    modelLabel: event.modelLabel,
                  });
                  const nextContent = appendToolMarker(baseContent, nextTrace.length - 1);
                  streamCommittedContentRef.current = nextContent;
                  return {
                    ...msg,
                    content: nextContent,
                    tool_trace: nextTrace,
                  };
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
              streamEndedRef.current = true;
              processPendingStreamTransitions();
              break;
            case 'error':
              {
                flushPendingToolActions();
                applyPendingToolFinalizations();
                clearPendingToolQueues();
                streamEndedRef.current = false;
                const committedContent = commitBufferedAssistantContent();
                setState((prev) => ({
                  ...prev,
                  isLoading: false,
                  error: event.message || '发送消息失败',
                  messages: prev.messages.map((msg) => (
                    msg.id === streamTargetMessageIdRef.current
                      ? {
                          ...msg,
                          content: msg.id === streamTargetMessageIdRef.current ? committedContent : msg.content,
                          tool_trace: finalizeInterruptedToolTrace(msg.tool_trace),
                        }
                      : msg
                  )),
                }));
              }
              break;
          }
        },
        controller.signal,
      );
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        flushPendingToolActions();
        applyPendingToolFinalizations();
        clearPendingToolQueues();
        streamEndedRef.current = false;
        const committedContent = commitBufferedAssistantContent();
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: (error as Error).message || '发送消息失败',
          messages: prev.messages.map((msg) => (
            msg.id === streamTargetMessageIdRef.current
              ? {
                  ...msg,
                  content: msg.id === streamTargetMessageIdRef.current ? committedContent : msg.content,
                  tool_trace: finalizeInterruptedToolTrace(msg.tool_trace),
                }
              : msg
          )),
        }));
      }
    } finally {
      abortRef.current = null;
      if (!streamEndedRef.current) {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    }
  }, [
    bindStreamTarget,
    applyPendingToolFinalizations,
    clearPendingToolQueues,
    commitBufferedAssistantContent,
    flushPendingToolActions,
    processPendingStreamTransitions,
    pushStreamBuffer,
    queueToolFinalization,
    scheduleToolAction,
    state.isLoading,
    state.messages,
    currentSessionId,
    selectedModelId,
    effectiveThinking,
    effectiveReasoningEffort,
    setCurrentSessionId,
    loadSessions,
    updateStreamTargetMessage,
  ]);

  const handleRecall = useCallback(async (message: ChatMessage) => {
    if (!currentSessionId) return;

    if (state.isLoading) {
      discardStreamingDraft();
    }

    const truncated = await truncateMessages(currentSessionId, message.id);
    if (!truncated) {
      setState((prev) => ({ ...prev, error: '撤回失败，请重试' }));
      return;
    }

    setState((prev) => {
      const idx = prev.messages.findIndex((m) => m.id === message.id);
      return {
        ...prev,
        isLoading: false,
        messages: idx > 0 ? prev.messages.slice(0, idx) : [],
      };
    });
    setRecallText(message.content === '(图片)' ? '' : message.content);
    setRecallImages(message.images);
    setRecallTick((tick) => tick + 1);
    await loadSessions();
  }, [currentSessionId, discardStreamingDraft, loadSessions, state.isLoading]);

  return (
    <div className="flex flex-col h-screen pt-12">
      {state.error && (
        <div className="mx-4 mt-4 p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-center justify-between animate-slide-up">
          <span>{state.error}</span>
          <button
            onClick={clearError}
            className="ml-4 text-sm underline hover:no-underline cursor-pointer"
          >
            关闭
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <MessageList
          messages={state.messages}
          isLoading={state.isLoading}
          streamingMessageId={streamTargetMessageIdRef.current}
          streamingContentOverride={streamingContentOverride}
          waitingSeconds={waitingSeconds}
          searchSeconds={searchSeconds}
          imageGenSeconds={imageGenSeconds}
          toolFollowupSeconds={toolFollowupSeconds}
          thinkingEnabled={effectiveThinking}
          onRecall={handleRecall}
        />
      </div>

      <div className="relative max-w-4xl mx-auto w-full px-4 pb-4">
        <div className="absolute -top-4 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        <MessageInput
          onSend={handleSendMessage}
          isStreaming={state.isLoading}
          onStop={stopStreaming}
          disabled={models.length === 0}
          models={models}
          selectedModelId={selectedModelId}
          onModelChange={handleModelChange}
          thinkingLevel={thinkingLevel}
          effectiveThinking={effectiveThinking}
          supportsReasoningEffort={supportsReasoningEffort}
          thinkingLocked={thinkingLocked}
          thinkingLockReason={thinkingLockReason}
          onReasoningModeToggle={handleReasoningModeToggle}
          defaultValue={recallText}
          defaultImages={recallImages}
          key={recallTick}
        />
        <p className="text-xs text-muted-foreground text-center mt-3">
          LockAI 可能会出错，请核实重要信息
        </p>
      </div>
    </div>
  );
}
