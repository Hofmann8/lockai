'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const CHAR_INTERVAL_MS = 12;
const CHARS_PER_STEP = 30;

export function useStreamBuffer() {
  const [displayedContent, setDisplayedContent] = useState('');
  const bufferRef = useRef('');
  const cursorRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const activeRef = useRef(false);

  const tick = useCallback((now: number) => {
    if (!activeRef.current) return;

    const pending = bufferRef.current.length - cursorRef.current;
    if (pending <= 0) {
      rafRef.current = null;
      return;
    }

    const elapsed = now - lastTickRef.current;
    if (elapsed >= CHAR_INTERVAL_MS) {
      const chars = Math.max(1, Math.floor(pending / CHARS_PER_STEP));
      const end = Math.min(cursorRef.current + chars, bufferRef.current.length);
      const slice = bufferRef.current.slice(cursorRef.current, end);
      cursorRef.current = end;
      setDisplayedContent((prev) => prev + slice);
      lastTickRef.current = now;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(() => {
    bufferRef.current = '';
    cursorRef.current = 0;
    activeRef.current = true;
    setDisplayedContent('');
  }, []);

  const push = useCallback((text: string) => {
    if (!text) return;
    bufferRef.current += text;
    if (!activeRef.current) {
      activeRef.current = true;
    }
    if (rafRef.current === null) {
      lastTickRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const flush = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const remaining = bufferRef.current.slice(cursorRef.current);
    if (remaining) {
      cursorRef.current = bufferRef.current.length;
      setDisplayedContent((prev) => prev + remaining);
    }
  }, []);

  const reset = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    bufferRef.current = '';
    cursorRef.current = 0;
    setDisplayedContent('');
  }, []);

  const getBufferedContent = useCallback(() => bufferRef.current, []);
  const getPendingCharCount = useCallback(
    () => Math.max(0, bufferRef.current.length - cursorRef.current),
    [],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return { displayedContent, push, start, flush, reset, getBufferedContent, getPendingCharCount };
}
