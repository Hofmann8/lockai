'use client';

import { useState, useRef, useCallback, useEffect, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Send, Square, ChevronDown, Brain, Zap, ImagePlus, X, Mic } from 'lucide-react';
import { compressImage, ACCEPTED_IMAGE_TYPES } from '@/lib/image';
import {
  cancelRealtimeAsrSession,
  createRealtimeAsrSession,
  getRealtimeAsrStreamUrl,
  parseRealtimeAsrEvent,
  pushRealtimeAsrAudio,
} from '@/lib/api';
import { isLiveVoiceInputSupported, startLiveVoiceStream, type LiveVoiceStreamSession } from '@/lib/audio';
import type { ChatModel } from '@/types';

interface MessageInputProps {
  onSend: (message: string, images?: string[]) => void | Promise<void>;
  isStreaming: boolean;
  onStop: () => void;
  disabled?: boolean;
  models: ChatModel[];
  selectedModelId: string;
  onModelChange: (modelId: string) => void;
  thinkingEnabled: boolean;
  thinkingLocked: boolean;
  onThinkingToggle: () => void;
  defaultValue?: string;
  defaultImages?: string[];
}

const MODEL_NAME_FALLBACKS: Record<string, string> = {
  campbell: 'Campbell 1.5',
  scooby: 'Scooby 1.7',
  leo: 'Leo 1.7',
};

export function MessageInput({
  onSend,
  isStreaming,
  onStop,
  disabled = false,
  models,
  selectedModelId,
  onModelChange,
  thinkingEnabled,
  thinkingLocked,
  onThinkingToggle,
  defaultValue,
  defaultImages,
}: MessageInputProps) {
  const [value, setValue] = useState(defaultValue || '');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>(defaultImages || []);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceSessionRef = useRef<LiveVoiceStreamSession | null>(null);
  const realtimeSessionIdRef = useRef<string | null>(null);
  const realtimeSourceRef = useRef<EventSource | null>(null);

  const isVoiceBusy = isRecording;
  const hasSendableContent = value.trim().length > 0 || pendingImages.length > 0;
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedModelLabel = selectedModel?.name
    || MODEL_NAME_FALLBACKS[selectedModelId]
    || MODEL_NAME_FALLBACKS.campbell;

  useEffect(() => {
    if (defaultValue !== undefined) {
      setValue(defaultValue);
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        }
      }, 0);
    }
  }, [defaultValue]);

  useEffect(() => {
    if (defaultImages !== undefined) {
      setPendingImages(defaultImages);
    }
  }, [defaultImages]);

  useEffect(() => {
    setVoiceSupported(isLiveVoiceInputSupported());
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if ((!value.trim() && pendingImages.length === 0) || disabled || isStreaming || isVoiceBusy) return;
    onSend(value, pendingImages.length > 0 ? pendingImages : undefined);
    setValue('');
    setPendingImages([]);
    setVoiceError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, pendingImages, disabled, isStreaming, isVoiceBusy, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming && !isVoiceBusy) {
        handleSubmit();
      }
    }
  }, [handleSubmit, isStreaming, isVoiceBusy]);

  const handleImageSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newImages: string[] = [];
    for (const file of Array.from(files)) {
      if (pendingImages.length + newImages.length >= 4) break;
      const dataUrl = await compressImage(file);
      newImages.push(dataUrl);
    }
    setPendingImages((prev) => [...prev, ...newImages].slice(0, 4));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') && pendingImages.length < 4) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          compressImage(file).then((dataUrl) => {
            setPendingImages((prev) => [...prev, dataUrl].slice(0, 4));
          });
        }
        return;
      }
    }
  }, [pendingImages.length]);

  const syncTranscriptText = useCallback((text?: string) => {
    setValue(text || '');
    window.requestAnimationFrame(adjustHeight);
  }, [adjustHeight]);

  const clearRealtimeHandles = useCallback(() => {
    realtimeSourceRef.current?.close();
    realtimeSourceRef.current = null;
    realtimeSessionIdRef.current = null;
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (disabled || isStreaming || hasSendableContent || isVoiceBusy) return;

    setVoiceError(null);
    setValue('');

    const sessionResponse = await createRealtimeAsrSession();
    if (sessionResponse.error || !sessionResponse.session_id) {
      setVoiceError(sessionResponse.error || '创建实时语音会话失败');
      return;
    }

    const sessionId = sessionResponse.session_id;
    realtimeSessionIdRef.current = sessionId;

    let streamSettled = false;
    const source = new EventSource(getRealtimeAsrStreamUrl(sessionId));
    realtimeSourceRef.current = source;

    source.onmessage = (event) => {
      const payload = parseRealtimeAsrEvent(event);
      if (!payload || payload.type === 'heartbeat') return;

      if (payload.type === 'partial' || payload.type === 'final' || payload.type === 'complete' || payload.type === 'started') {
        syncTranscriptText(payload.text);
      }

      if (payload.type === 'error') {
        streamSettled = true;
        setVoiceError(payload.message || '语音识别失败，请重试');
        voiceSessionRef.current?.cancel();
        voiceSessionRef.current = null;
        setIsRecording(false);
        clearRealtimeHandles();
        void cancelRealtimeAsrSession(sessionId).catch(() => undefined);
        return;
      }

      if (payload.type === 'complete') {
        streamSettled = true;
        voiceSessionRef.current?.cancel();
        voiceSessionRef.current = null;
        setIsRecording(false);
        clearRealtimeHandles();
      }
    };

    source.onerror = () => {
      if (streamSettled) return;
      streamSettled = true;
      setVoiceError('语音识别连接中断，请重试');
      voiceSessionRef.current?.cancel();
      voiceSessionRef.current = null;
      setIsRecording(false);
      clearRealtimeHandles();
      void cancelRealtimeAsrSession(sessionId).catch(() => undefined);
    };

    try {
      const session = await startLiveVoiceStream({
        onChunk: async (chunk) => {
          await pushRealtimeAsrAudio(sessionId, chunk);
        },
      });
      voiceSessionRef.current = session;
      setIsRecording(true);
    } catch (error) {
      clearRealtimeHandles();
      source.close();
      void cancelRealtimeAsrSession(sessionId).catch(() => undefined);
      setVoiceError(error instanceof Error ? error.message : '启动实时语音失败，请重试');
    }
  }, [
    clearRealtimeHandles,
    disabled,
    hasSendableContent,
    isStreaming,
    isVoiceBusy,
    syncTranscriptText,
  ]);

  const handleStopRecording = useCallback(() => {
    const session = voiceSessionRef.current;
    const sessionId = realtimeSessionIdRef.current;
    if (!session || !sessionId) return;

    voiceSessionRef.current = null;
    setIsRecording(false);
    setVoiceError(null);
    session.cancel();
    clearRealtimeHandles();
    void cancelRealtimeAsrSession(sessionId).catch(() => undefined);
    textareaRef.current?.focus();
  }, [clearRealtimeHandles]);

  useEffect(() => () => {
    voiceSessionRef.current?.cancel();
    voiceSessionRef.current = null;
    const sessionId = realtimeSessionIdRef.current;
    clearRealtimeHandles();
    if (sessionId) {
      void cancelRealtimeAsrSession(sessionId).catch(() => undefined);
    }
  }, [clearRealtimeHandles]);

  const placeholder = isRecording
    ? '正在实时转写，点击右侧停止即可截断'
    : pendingImages.length > 0
      ? '添加描述... (Enter 发送)'
      : voiceSupported
        ? '输入消息，或在空白时点击麦克风说话...'
        : '输入消息... (Enter 发送, Shift+Enter 换行)';

  return (
    <div className="relative rounded-2xl border border-border bg-card">
      <div className="px-4 pt-4 pb-2">
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative h-16 w-16 overflow-hidden rounded-lg border border-border group/img">
                <img src={img} alt={`图片 ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity cursor-pointer group-hover/img:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (voiceError) setVoiceError(null);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled || isStreaming}
          readOnly={isRecording}
          rows={1}
          className="w-full resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        {voiceError && (
          <div className="mt-1 inline-flex items-center rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs text-destructive">
            <span>{voiceError}</span>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple
        className="hidden"
        onChange={handleImageSelect}
      />

      <div className="flex items-center justify-between gap-2 px-3 pb-3">
        <div className="flex items-center gap-2">
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowModelMenu((prev) => !prev)}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span>{selectedModelLabel}</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
            </button>

            {showModelMenu && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-xl border border-border bg-card py-1 shadow-lg animate-fade-in">
                {models.filter((model) => model.available).map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      onModelChange(model.id);
                      setShowModelMenu(false);
                    }}
                    disabled={isVoiceBusy}
                    className={`w-full cursor-pointer px-3 py-2 text-left text-sm transition-colors ${
                      selectedModelId === model.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{model.name}</span>
                      {model.is_default && <span className="text-[10px] text-primary">默认</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{model.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={thinkingLocked ? undefined : onThinkingToggle}
            disabled={thinkingLocked || isVoiceBusy}
            title={thinkingLocked ? '该模型不支持关闭思考' : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              thinkingLocked
                ? 'cursor-not-allowed text-primary/60 opacity-50'
                : thinkingEnabled
                  ? 'cursor-pointer bg-primary/10 text-primary'
                  : 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {thinkingEnabled ? <Brain className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
            <span>{thinkingLocked ? '深度思考' : thinkingEnabled ? '深度思考' : '快速思考'}</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isStreaming || isVoiceBusy || pendingImages.length >= 4}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title="添加图片 (最多4张)"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
        </div>

        {isStreaming ? (
          <button
            onClick={onStop}
            disabled={disabled}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="停止回答"
            title="停止回答"
            type="button"
          >
            <Square className="h-3.5 w-3.5" />
            <span>停止</span>
          </button>
        ) : isRecording ? (
          <button
            onClick={handleStopRecording}
            disabled={disabled}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-destructive/10 px-3 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="停止录音"
            title="停止录音"
            type="button"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/45" aria-hidden="true" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
            </span>
            <span>停止录音</span>
          </button>
        ) : hasSendableContent ? (
          <button
            onClick={handleSubmit}
            disabled={disabled || isVoiceBusy}
            className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="发送消息"
            title="发送消息"
            type="button"
          >
            <Send className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={handleStartRecording}
            disabled={disabled || !voiceSupported}
            className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="开始语音输入"
            title={!voiceSupported ? '当前浏览器不支持语音输入' : '开始语音输入'}
            type="button"
          >
            <Mic className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
