'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Globe, ImageIcon, PenLine } from 'lucide-react';
import { LockOrb } from '@/components/brand/LockOrb';
import { getAuthState } from '@/lib/auth';

function greeting(hour: number) {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function EmptyHero({ trigger }: { trigger: number }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const name = getAuthState().user?.name?.trim();
    setText(`${greeting(new Date().getHours())}${name ? `，${name}` : ''}`);
  }, []);

  return (
    <div className="mx-auto mb-7 flex w-full max-w-[46rem] flex-col items-center text-center">
      <LockOrb size={150} trigger={trigger} followWindow className="mb-3 animate-fade" />
      <h1 className="min-h-[1.3em] font-serif text-[28px] font-medium leading-tight tracking-tight text-fg sm:text-[32px] animate-rise">
        {text}
      </h1>
      <p className="mt-2 text-[14.5px] text-fg-faint animate-rise [animation-delay:80ms]">今天想聊点什么？</p>
    </div>
  );
}

const STARTERS = [
  { icon: PenLine, label: '写点东西', prompt: '帮我写一段社团活动的招新文案，语气轻松一点，别太官方' },
  { icon: ImageIcon, label: '画张图', prompt: '画一张七十年代复古风的海报：周末夜晚的街头派对，暖色调，有胶片颗粒感' },
  { icon: Globe, label: '查一查', prompt: '搜一下这周有什么值得关注的科技新闻，挑三条讲讲' },
  { icon: CalendarCheck, label: '排个计划', prompt: '帮我排一份每周练四次、每次一小时的基本功训练计划' },
];

export function StarterChips({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto mt-5 flex w-full max-w-[46rem] flex-wrap justify-center gap-2">
      {STARTERS.map(({ icon: Icon, label, prompt }, i) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(prompt)}
          style={{ animationDelay: `${160 + i * 60}ms` }}
          className="group flex items-center gap-2 rounded-full border border-line px-3.5 py-2 text-[13.5px] text-fg-soft transition-[color,border-color,background-color,transform] duration-200 hover:-translate-y-px hover:border-line-strong hover:bg-surface hover:text-fg animate-rise"
        >
          <Icon className="h-3.5 w-3.5 text-fg-faint transition-colors group-hover:text-accent" />
          {label}
        </button>
      ))}
    </div>
  );
}
