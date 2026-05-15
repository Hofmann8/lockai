'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const BASE_INTERVAL_MS = 16;
const MIN_CHARS_PER_STEP = 6;
const MAX_CHARS_PER_STEP = 120;

export function useStreamBuffer() {
  const [displayedContent, setDisplayedContent] = useState('');
  const bufferRef = useRef('');
  const cursorRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    if (!activeRef.current) return;

    const pending = bufferRef.current.length - cursorRef.current;
    if (pending <= 0) {
      return;
    }

    const chars = Math.max(
      MIN_CHARS_PER_STEP,
      Math.min(MAX_CHARS_PER_STEP, Math.ceil(pending / 12)),
    );
    const end = Math.min(cursorRef.current + chars, bufferRef.current.length);
    const slice = bufferRef.current.slice(cursorRef.current, end);
    cursorRef.current = end;
    if (slice) {
      setDisplayedContent((prev) => prev + slice);
    }

    if (bufferRef.current.length - cursorRef.current > 0) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        tick();
      }, BASE_INTERVAL_MS);
    }
  }, []);

  const start = useCallback(() => {
    clearTimer();
    bufferRef.current = '';
    cursorRef.current = 0;
    activeRef.current = true;
    setDisplayedContent('');
  }, [clearTimer]);

  const push = useCallback((text: string) => {
    if (!text) return;
    bufferRef.current += text;
    if (!activeRef.current) {
      activeRef.current = true;
    }
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        tick();
      }, BASE_INTERVAL_MS);
    }
  }, [tick]);

  const flush = useCallback(() => {
    activeRef.current = false;
    clearTimer();
    const remaining = bufferRef.current.slice(cursorRef.current);
    if (remaining) {
      cursorRef.current = bufferRef.current.length;
      setDisplayedContent((prev) => prev + remaining);
    }
  }, [clearTimer]);

  const reset = useCallback(() => {
    activeRef.current = false;
    clearTimer();
    bufferRef.current = '';
    cursorRef.current = 0;
    setDisplayedContent('');
  }, [clearTimer]);

  const getBufferedContent = useCallback(() => bufferRef.current, []);
  const getPendingCharCount = useCallback(
    () => Math.max(0, bufferRef.current.length - cursorRef.current),
    [],
  );

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  return { displayedContent, push, start, flush, reset, getBufferedContent, getPendingCharCount };
}
