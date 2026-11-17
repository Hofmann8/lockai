'use client';

import { createContext, useCallback, useContext, useEffect, useRef, type RefObject } from 'react';

/**
 * 对话区的滚动锚定。
 *
 * 三种状态：
 * - 跟随：停在底部时，回答往下长，视口跟着到底。
 * - 置顶：刚发出的问题钉在视口上沿（pin），回答在它下面长出来；回答里的文字、卡片、进度条怎么变都只往下长，
 *   问题不动。用户自己滚动或回到最新时解除。
 * - 阅读：往上翻过之后，视口最上面那一块钉住不动——上方的卡片自动收起 / 展开、图片加载出来，
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

interface Pin {
  el: Element;
  /** 离视口上沿的距离（像素） */
  offset: number;
  /** 正在平滑滚过去：这段时间不补偿，免得打断滚动 */
  animating: boolean;
}

/** 阅读锚点取视口最上面的内容：上沿的渐隐（20px）下面一点 */
const READ_POINT_PX = 40;
/** 平滑滚动没有 scrollend 事件时，最多等这么久 */
const PIN_SCROLL_MS = 900;

const distanceOf = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

/** 把 anchor 挪回原来的位置；它已经不在页面上了就返回 false */
function restore(scroller: HTMLElement, anchor: Anchor | null) {
  if (!anchor || !anchor.el.isConnected) return false;
  const dy = anchor.el.getBoundingClientRect().top - anchor.top;
  if (Math.abs(dy) >= 0.5) scroller.scrollTop += dy;
  return true;
}

/** 钉住的元素离该在的位置差多少（正数：在下面） */
function pinDelta(scroller: HTMLElement, pin: Pin) {
  return pin.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pin.offset;
}

function keepPinned(scroller: HTMLElement, pin: Pin) {
  const dy = pinDelta(scroller, pin);
  if (Math.abs(dy) >= 0.5) scroller.scrollTop += dy;
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
  const pinRef = useRef<Pin | null>(null);
  const readingRef = useRef<Anchor | null>(null);
  const distanceRef = useRef(onDistance);
  useEffect(() => { distanceRef.current = onDistance; }, [onDistance]);

  /**
   * 记下视口最上面的那块内容，之后的布局变化以它为准：它下面的东西怎么长都不该把它推走。
   * 取最上面而不是中间：中间那块的上方常常就是正在变化的内容（思考、卡片、进度条），以它为准会把上面的推上去
   */
  const captureReading = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const box = scroller.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    const x = inner.left + inner.width / 2;
    for (const y of [READ_POINT_PX, box.height * 0.15, box.height * 0.3, box.height * 0.5]) {
      const hit = document.elementFromPoint(x, box.top + Math.min(y, box.height - 1));
      if (hit && hit !== content && content.contains(hit)) {
        readingRef.current = { el: hit, top: hit.getBoundingClientRect().top };
        return;
      }
    }
    readingRef.current = null;
  }, [contentRef, scrollRef]);

  const hold = useCallback<Hold>((el) => {
    // 置顶时被点的卡片都在问题下面：问题不动，它也就不动
    if (!el || pinRef.current) return;
    holdRef.current = { el, top: el.getBoundingClientRect().top, until: performance.now() + HOLD_MS };
    stickRef.current = false;
  }, []);

  /** 内容高度变了：按当前状态补偿 */
  const settle = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const pin = pinRef.current;
    if (pin && !pin.el.isConnected) pinRef.current = null;
    const held = holdRef.current;
    if (pinRef.current) {
      if (!pin!.animating) keepPinned(scroller, pin!);
    } else if (held && performance.now() < held.until && restore(scroller, held)) {
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
    const pin = pinRef.current;
    if (pin) {
      // 不是我们滚过去的位置：用户（键盘、拖滚动条）自己挪了，解除置顶
      if (!pin.animating && Math.abs(pinDelta(scroller, pin)) > 2) pinRef.current = null;
      else {
        distanceRef.current(distance);
        return;
      }
    }
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
    pinRef.current = null;
    holdRef.current = null;
    stickRef.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [scrollRef]);

  /** 程序主动滚到某处：先进入阅读状态 */
  const release = useCallback(() => {
    pinRef.current = null;
    holdRef.current = null;
    stickRef.current = false;
  }, []);

  /** 把 el 钉在离视口上沿 offset 的地方（发出新问题时用），直到用户自己滚动 */
  const pin = useCallback((el: Element, offset: number, smooth = true) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    holdRef.current = null;
    stickRef.current = false;
    const state: Pin = { el, offset, animating: smooth };
    pinRef.current = state;
    const top = scroller.scrollTop + pinDelta(scroller, state);
    if (!smooth) {
      scroller.scrollTop = top;
      return;
    }
    const done = () => {
      scroller.removeEventListener('scrollend', done);
      window.clearTimeout(timer);
      if (pinRef.current !== state) return;
      state.animating = false;
      keepPinned(scroller, state);
      captureReading();
    };
    const timer = window.setTimeout(done, PIN_SCROLL_MS);
    scroller.addEventListener('scrollend', done);
    scroller.scrollTo({ top, behavior: 'smooth' });
  }, [captureReading, scrollRef]);

  // 用户动了滚轮、触屏或按住滚动条：马上解除置顶（平滑滚动途中也算）
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller) return;
    const unpin = () => {
      if (!pinRef.current) return;
      pinRef.current = null;
      stickRef.current = distanceOf(scroller) < STICK_THRESHOLD;
    };
    const onPointer = (e: PointerEvent) => { if (e.target === scroller) unpin(); };
    scroller.addEventListener('wheel', unpin, { passive: true });
    scroller.addEventListener('touchstart', unpin, { passive: true });
    scroller.addEventListener('pointerdown', onPointer);
    return () => {
      scroller.removeEventListener('wheel', unpin);
      scroller.removeEventListener('touchstart', unpin);
      scroller.removeEventListener('pointerdown', onPointer);
    };
  }, [enabled, scrollRef]);

  return { hold, onScroll, scrollToBottom, release, pin, stickRef };
}
