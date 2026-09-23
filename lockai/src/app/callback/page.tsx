'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { handleSSOCallback } from '@/lib/auth';
import { LockMark } from '@/components/brand/LockMark';

function Status({ state, message }: { state: 'loading' | 'success' | 'error'; message: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <LockMark
        size={40}
        state={state === 'loading' ? 'busy' : 'idle'}
        snapKey={state === 'success' ? 1 : undefined}
        className={state === 'error' ? 'text-danger' : 'text-fg'}
      />
      <p className="text-[14px] text-fg-soft">{message}</p>
    </div>
  );
}

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');

  useEffect(() => {
    const result = handleSSOCallback(searchParams);
    if (result) {
      setState('success');
      const timer = window.setTimeout(() => router.replace('/chat'), 500);
      return () => window.clearTimeout(timer);
    }
    setState('error');
    const timer = window.setTimeout(() => router.replace('/'), 2000);
    return () => window.clearTimeout(timer);
  }, [searchParams, router]);

  return (
    <Status
      state={state}
      message={state === 'loading' ? '正在登录…' : state === 'success' ? '好了，这就进去' : '登录没有成功，正在返回'}
    />
  );
}

// 完全跳过 SSR，避免水合问题
const CallbackContentNoSSR = dynamic(() => Promise.resolve(CallbackContent), {
  ssr: false,
  loading: () => <Status state="loading" message="正在登录…" />,
});

export default function CallbackPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">
      <CallbackContentNoSSR />
    </div>
  );
}
