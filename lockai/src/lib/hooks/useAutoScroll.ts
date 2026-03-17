'use client';

import { useEffect, type RefObject } from 'react';

export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  deps: unknown[] = [],
  behavior: ScrollBehavior = 'smooth',
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
