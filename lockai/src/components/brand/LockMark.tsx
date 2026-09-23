'use client';

import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { cn } from '@/lib/cn';

gsap.registerPlugin(useGSAP);

export type LockMarkState = 'idle' | 'busy';

interface LockMarkProps {
  size?: number;
  state?: LockMarkState;
  /** 每次变化都会让锁梁"咔哒"合上一次再松开（比如一条回答结束时） */
  snapKey?: number | string;
  className?: string;
  title?: string;
}

/**
 * 品牌标：一把锁。
 * 锁孔换成了两道并行的细竖线；静止时锁梁微微抬着、没完全扣上。
 * 忙碌时锁梁按"抬起—停住—扣下—停住"的切分节奏动，不是匀速的呼吸。
 */
export function LockMark({ size = 24, state = 'idle', snapKey, className, title = 'LockAI' }: LockMarkProps) {
  const root = useRef<SVGSVGElement>(null);
  const shackle = useRef<SVGGElement>(null);
  const loop = useRef<gsap.core.Timeline | null>(null);
  const first = useRef(true);

  useGSAP(() => {
    gsap.set(shackle.current, { y: -1.6, transformOrigin: '11px 15px' });
  }, { scope: root });

  useGSAP(() => {
    loop.current?.kill();
    loop.current = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (state !== 'busy' || reduce) {
      gsap.to(shackle.current, { y: -1.6, rotation: 0, duration: 0.35, ease: 'power3.out' });
      return;
    }
    // 一小节：抬 → 停 → 扣下（带一点回弹）→ 停；每隔一小节加一次"腕花"式的小转
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(shackle.current, { y: -4, duration: 0.14, ease: 'power2.out' })
      .to(shackle.current, { y: -4, duration: 0.2 })
      .to(shackle.current, { y: 0, duration: 0.12, ease: 'back.out(3)' })
      .to(shackle.current, { y: 0, duration: 0.3 })
      .to(shackle.current, { y: -4, duration: 0.14, ease: 'power2.out' })
      .to(shackle.current, { rotation: -14, duration: 0.18, ease: 'power2.inOut' })
      .to(shackle.current, { rotation: 0, duration: 0.16, ease: 'power2.inOut' })
      .to(shackle.current, { y: 0, duration: 0.12, ease: 'back.out(3)' })
      .to(shackle.current, { y: 0, duration: 0.42 });
    loop.current = tl;
  }, { dependencies: [state], scope: root });

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (snapKey === undefined || state === 'busy') return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    gsap.timeline()
      .to(shackle.current, { y: 0.4, duration: 0.1, ease: 'power4.in' })
      .to(shackle.current, { y: 0, duration: 0.12, ease: 'back.out(4)' })
      .to(shackle.current, { y: -1.6, duration: 0.6, ease: 'power2.inOut', delay: 0.7 });
  }, [snapKey, state]);

  return (
    <svg
      ref={root}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={title}
      className={cn('shrink-0 overflow-visible', className)}
    >
      <g ref={shackle}>
        <path
          d="M11 15V11.5a5 5 0 0 1 10 0V13"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
        />
      </g>
      <rect x="6.5" y="14" width="19" height="14.5" rx="4.6" fill="currentColor" />
      <rect x="13.6" y="18" width="1.7" height="6.4" rx="0.85" fill="var(--bg)" />
      <rect x="16.7" y="18" width="1.7" height="6.4" rx="0.85" fill="var(--accent)" />
    </svg>
  );
}

/** 字标：LockAI。"Lock" 用柔软的 70 年代衬线，"AI" 收一点，不抢。 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn('font-display text-[19px] leading-none tracking-[-0.02em] text-fg', className)}
      style={{ fontVariationSettings: '"SOFT" 100, "WONK" 1, "opsz" 72' }}
    >
      <span className="italic">Lock</span>
      <span className="ml-[1px] text-fg-soft" style={{ fontVariationSettings: '"SOFT" 0, "WONK" 0, "opsz" 72' }}>AI</span>
    </span>
  );
}
