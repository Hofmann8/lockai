'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';
import { isAuthenticated, redirectToSSO } from '@/lib/auth';
import { LockOrb } from '@/components/brand/LockOrb';
import { Wordmark } from '@/components/brand/LockMark';

export default function LoginPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (isAuthenticated()) router.replace('/chat');
  }, [router]);

  const login = () => {
    setLoading(true);
    setTrigger((t) => t + 1);
    // 让锁先扣上，再跳走
    window.setTimeout(redirectToSSO, 650);
  };

  if (!mounted) return null;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-bg">
      {/* 两道并行的细线，从页面一侧纵贯下来 */}
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[9%] flex gap-[9px] max-sm:hidden">
        <span className="w-px bg-line" />
        <span className="w-px bg-[linear-gradient(to_bottom,transparent,var(--accent)_45%,transparent)] opacity-40" />
      </div>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6">
        <LockOrb size={230} trigger={trigger} followWindow className="animate-fade" />

        <div className="mt-4 flex flex-col items-center text-center">
          <Wordmark className="text-[52px] animate-rise" />
          <p className="mt-4 font-serif text-[17px] tracking-[0.2em] text-fg-soft animate-rise [animation-delay:90ms]">
            停一拍，再落下。
          </p>
        </div>

        <div className="mt-12 flex w-full max-w-[300px] flex-col items-center gap-3 animate-rise [animation-delay:180ms]">
          <button
            type="button"
            onClick={login}
            onPointerEnter={() => setTrigger((t) => t + 1)}
            disabled={loading}
            className="group flex h-12 w-full items-center justify-center gap-2 rounded-full bg-ink text-[14.5px] font-medium text-ink-fg shadow-float transition-[transform,box-shadow] duration-300 hover:shadow-pop active:scale-[0.98] disabled:opacity-70"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                使用 LockAuth 登录
                <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-[var(--ease-lock)] group-hover:translate-x-1" />
              </>
            )}
          </button>
          <p className="text-[12px] text-fg-faint">仅限 Funk&amp;Love 舞队成员使用</p>
        </div>
      </main>

      <footer className="relative z-10 pb-6 text-center text-[11.5px] text-fg-faint animate-fade [animation-delay:300ms]">
        © {new Date().getFullYear()} Funk&amp;Love · ZJU DFM
      </footer>
    </div>
  );
}
