'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { getAuthState, getToken, redirectToSSO } from '@/lib/auth';
import { LockMark } from '@/components/brand/LockMark';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

type Phase = 'loading' | 'ready' | 'approving' | 'redirecting' | 'denied' | 'invalid';

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

function AuthorizeContent() {
  const searchParams = useSearchParams();
  const authorizeId = searchParams.get('id') ?? '';
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('');
  const name = getAuthState().user?.name;

  useEffect(() => {
    if (!authorizeId) {
      setPhase('invalid');
      setMessage('链接不完整');
      return;
    }
    if (!getToken()) {
      redirectToSSO(`/desktop/authorize?id=${encodeURIComponent(authorizeId)}`);
      return;
    }
    fetch(`${API_BASE_URL}/api/desktop/auth/requests/${encodeURIComponent(authorizeId)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
        if (res.ok && data.status === 'pending') {
          setPhase('ready');
        } else {
          setPhase('invalid');
          setMessage(data.status === 'expired' ? '链接已过期' : data.status ? '这个请求已经处理过了' : data.error || '链接无效');
        }
      })
      .catch(() => {
        setPhase('invalid');
        setMessage('网络不通，请稍后再试');
      });
  }, [authorizeId]);

  const approve = useCallback(async () => {
    const token = getToken();
    if (!token) {
      redirectToSSO(`/desktop/authorize?id=${encodeURIComponent(authorizeId)}`);
      return;
    }
    setPhase('approving');
    try {
      const { ok, data } = await postJson('/api/desktop/auth/approve', { authorize_id: authorizeId, token });
      if (ok && typeof data.redirect_url === 'string') {
        setPhase('redirecting');
        window.location.href = data.redirect_url;
        return;
      }
      setPhase('invalid');
      setMessage(typeof data.error === 'string' ? data.error : '授权没有成功');
    } catch {
      setPhase('ready');
      setMessage('网络不通，请再试一次');
    }
  }, [authorizeId]);

  const deny = useCallback(async () => {
    setPhase('denied');
    await postJson('/api/desktop/auth/deny', { authorize_id: authorizeId }).catch(() => undefined);
  }, [authorizeId]);

  if (phase === 'loading') {
    return <LockMark size={40} state="busy" className="text-fg" />;
  }

  if (phase === 'invalid' || phase === 'denied') {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <LockMark size={40} className={phase === 'invalid' ? 'text-danger' : 'text-fg'} />
        <p className="text-[15px] text-fg">{phase === 'denied' ? '已取消' : message}</p>
        <p className="text-[13px] text-fg-soft">可以关闭这个页面，回到 LockAI Desktop 重新登录。</p>
      </div>
    );
  }

  if (phase === 'redirecting') {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <LockMark size={40} snapKey={1} className="text-fg" />
        <p className="text-[15px] text-fg">正在回到 LockAI Desktop…</p>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[300px] flex-col items-center text-center animate-rise">
      <LockMark size={40} className="text-fg" />
      <h1 className="mt-6 whitespace-nowrap font-display text-[26px] tracking-[-0.01em] text-fg">
        登录 LockAI Desktop
      </h1>
      <p className="mt-2 text-balance text-[13.5px] leading-relaxed text-fg-soft">
        用量和网页版共用额度。
      </p>
      {name && (
        <div className="mt-6 flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-3.5 shadow-sm">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[12px] font-medium text-accent-ink">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="max-w-[180px] truncate text-[13px] text-fg">{name}</span>
        </div>
      )}
      {message && <p className="mt-4 text-[13px] text-danger">{message}</p>}
      <div className="mt-9 flex w-full flex-col gap-2">
        <button
          type="button"
          onClick={approve}
          disabled={phase === 'approving'}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-ink text-[14.5px] font-medium text-ink-fg shadow-float transition-[transform,box-shadow] duration-300 hover:shadow-pop active:scale-[0.98] disabled:opacity-70"
        >
          {phase === 'approving' ? <Loader2 className="h-4 w-4 animate-spin" /> : '允许'}
        </button>
        <button
          type="button"
          onClick={deny}
          disabled={phase === 'approving'}
          className="h-11 w-full rounded-full text-[14px] text-fg-soft transition-colors hover:text-fg disabled:opacity-50"
        >
          取消
        </button>
      </div>
      <p className="mt-6 text-[12px] text-fg-faint">只在你自己的电脑上允许。</p>
    </div>
  );
}

const AuthorizeContentNoSSR = dynamic(() => Promise.resolve(AuthorizeContent), {
  ssr: false,
  loading: () => <LockMark size={40} state="busy" className="text-fg" />,
});

export default function DesktopAuthorizePage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <AuthorizeContentNoSSR />
    </div>
  );
}
