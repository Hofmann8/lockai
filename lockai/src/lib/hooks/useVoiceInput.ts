'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelRealtimeAsrSession,
  createRealtimeAsrSession,
  getRealtimeAsrStreamUrl,
  parseRealtimeAsrEvent,
  pushRealtimeAsrAudio,
} from '@/lib/api';
import { isLiveVoiceInputSupported, startLiveVoiceStream, type LiveVoiceStreamSession } from '@/lib/audio';

/** 实时语音转写：边说边把文字写进输入框，点停止即截断 */
export function useVoiceInput(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<LiveVoiceStreamSession | null>(null);
  const asrIdRef = useRef<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const transcriptRef = useRef(onTranscript);

  useEffect(() => {
    transcriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    setSupported(isLiveVoiceInputSupported());
  }, []);

  const clearHandles = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    asrIdRef.current = null;
  }, []);

  const abort = useCallback((message: string | null, asrId: string | null) => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    setRecording(false);
    clearHandles();
    if (message) setError(message);
    if (asrId) void cancelRealtimeAsrSession(asrId).catch(() => undefined);
  }, [clearHandles]);

  const start = useCallback(async () => {
    if (recording) return;
    setError(null);
    const created = await createRealtimeAsrSession();
    if (created.error || !created.session_id) {
      setError(created.error || '语音服务暂时不可用');
      return;
    }
    const asrId = created.session_id;
    asrIdRef.current = asrId;
    let settled = false;
    const source = new EventSource(getRealtimeAsrStreamUrl(asrId));
    sourceRef.current = source;

    source.onmessage = (event) => {
      const payload = parseRealtimeAsrEvent(event);
      if (!payload || payload.type === 'heartbeat') return;
      if (payload.type === 'error') {
        settled = true;
        abort(payload.message || '语音识别失败，请重试', asrId);
        return;
      }
      if (payload.text !== undefined) transcriptRef.current(payload.text || '');
      if (payload.type === 'complete') {
        settled = true;
        abort(null, null);
      }
    };
    source.onerror = () => {
      if (settled) return;
      settled = true;
      abort('语音连接中断了，请重试', asrId);
    };

    try {
      sessionRef.current = await startLiveVoiceStream({
        onChunk: async (chunk) => {
          await pushRealtimeAsrAudio(asrId, chunk);
        },
      });
      setRecording(true);
    } catch (err) {
      source.close();
      abort(err instanceof Error ? err.message : '无法打开麦克风', asrId);
    }
  }, [abort, recording]);

  const stop = useCallback(() => {
    const asrId = asrIdRef.current;
    if (!sessionRef.current) return;
    abort(null, asrId);
  }, [abort]);

  useEffect(() => () => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    const asrId = asrIdRef.current;
    sourceRef.current?.close();
    if (asrId) void cancelRealtimeAsrSession(asrId).catch(() => undefined);
  }, []);

  return { supported, recording, error, clearError: () => setError(null), start, stop };
}
