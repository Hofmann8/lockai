'use client';

import { createContext, useCallback, useContext, useEffect, useRef, type RefObject } from 'react';

/**
 * 对话区的滚动锚定。
 *
 * 两种状态：
 * - 跟随：停在底部时，回答往下长，视口跟着到底。
 * - 阅读：往上翻过之后，视口里正在看的那一块钉住不动——上方的卡片自动收起 / 展开、图片加载出来，
 *   都由这里补偿滚动位置，不让内容在眼前跳（不依赖浏览器的 overflow-anchor，Safari 也一样）。
 *
 * 用户自己点开 / 收起某个卡片时，被点的那个标题钉在指针下面（hold），动画期间不跟随到底；
 * 动画结束后离底部足够近就重新跟随，否则留在阅读状态。
 *
 * 所有补偿都在 ResizeObserver 回调里做（布局之后、绘制之前），所以没有中间帧的闪动。
 */

/** 离底部多近算"停在底部"（像素） */
export const STICK_THRESHOLD = 48;
/** 用户点开 / 收起后钉住标题的时长：盖过折叠动画 */
const HOLD_MS = 420;

interface Anchor {
  el: Element;
  top: number;
}

type Hold = (el: Element | null | undefined) => void;

const ScrollAnchorContext = createContext<Hold>(() => {});
export const ScrollAnchorProvider = ScrollAnchorContext.Provider;

/** 点开 / 收起卡片前调用：把被点的元素钉在原处，展开或收起都从它往下变化 */
export function useHoldAnchor(): Hold {
  return useContext(ScrollAnchorContext);
}

export function useScrollAnchor({
  scrollRef,
  contentRef,
  onDistance,
  enabled,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** 每次滚动或内容变化后离底部的距离（控制"回到最新"按钮） */
  onDistance: (distance: number) => void;
  /** 对话区是否在显示（空状态时没有对话区） */
  enabled: boolean;
}) {
  const stickRef = useRef(true);
  const holdRef = useRef<(Anchor & { until: number }) | null>(null);
  const readingRef = useRef<Anchor | null>(null);
  const distanceRef = useRef(onDistance);
  useEffect(() => { distanceRef.current = onDistance; }, [onDistance]);

  const distanceOf = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

  /** 记下视口上部三分之一处正在看的元素，之后的布局变化以它为准 */
  const captureReading = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const box = scroller.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    const x = inner.left + inner.width / 2;
    for (const ratio of [0.3, 0.15, 0.5, 0.7]) {
      const hit = document.elementFromPoint(x, box.top + box.height * ratio);
      if (hit && hit !== content && content.contains(hit)) {
        readingRef.current = { el: hit, top: hit.getBoundingClientRect().top };
        return;
      }
    }
    readingRef.current = null;
  }, [contentRef, scrollRef]);

  /** 把 anchor 挪回原来的位置；它已经不在页面上了就返回 false */
  const restore = (scroller: HTMLElement, anchor: Anchor | null) => {
    if (!anchor || !anchor.el.isConnected) return false;
    const dy = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(dy) >= 0.5) scroller.scrollTop += dy;
    return true;
  };

  const hold = useCallback<Hold>((el) => {
    if (!el) return;
    holdRef.current = { el, top: el.getBoundingClientRect().top, until: performance.now() + HOLD_MS };
    stickRef.current = false;
  }, []);

  /** 内容高度变了：按当前状态补偿 */
  const settle = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const held = holdRef.current;
    if (held && performance.now() < held.until && restore(scroller, held)) {
      // 钉住期间照样记阅读锚点，结束后无缝接上
    } else {
      if (held) {
        holdRef.current = null;
        stickRef.current = distanceOf(scroller) < STICK_THRESHOLD;
      }
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight;
      else restore(scroller, readingRef.current);
    }
    captureReading();
    distanceRef.current(distanceOf(scroller));
  }, [captureReading, scrollRef]);

  useEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content) return;
    const observer = new ResizeObserver(settle);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, enabled, settle]);

  /** 用户滚动：更新跟随 / 阅读状态和阅读锚点 */
  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distance = distanceOf(scroller);
    // 钉住期间的滚动是自己补偿出来的，不改状态
    if (!holdRef.current || performance.now() >= holdRef.current.until) {
      stickRef.current = distance < STICK_THRESHOLD;
    }
    captureReading();
    distanceRef.current(distance);
  }, [captureReading, scrollRef]);

  const scrollToBottom = useCallback((smooth = false) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    holdRef.current = null;
    stickRef.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [scrollRef]);

  /** 程序主动滚到某处（比如发出新问题后把它顶到上沿）：先进入阅读状态 */
  const release = useCallback(() => {
    holdRef.current = null;
    stickRef.current = false;
  }, []);

  return { hold, onScroll, scrollToBottom, release, stickRef };
}
